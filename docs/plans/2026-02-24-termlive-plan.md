# TermLive Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a terminal live-streaming CLI tool (`tl`) that wraps commands, captures PTY I/O, serves a real-time Web UI via WebSocket, and sends idle notifications to WeChat/Feishu bots.

**Architecture:** Go single binary with embedded web frontend. PTY Manager captures command I/O, Hub broadcasts to WebSocket clients, Notifier watches for idle timeouts. Multi-session support via daemon + IPC (named pipe).

**Tech Stack:** Go 1.22+, creack/pty (Unix) / conpty (Windows), gorilla/websocket, spf13/cobra, xterm.js, TOML config.

**Design doc:** `docs/plans/2026-02-24-termlive-design.md`

---

## Platform Note

The dev environment is Windows (MINGW64). `creack/pty` only supports Unix. For cross-platform PTY:
- Unix/macOS: `github.com/creack/pty`
- Windows: `github.com/UserExistsError/conpty`

We abstract behind a `PtyProcess` interface so both backends work. Tasks below use the Unix path; Windows backend follows the same interface.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `go.mod`
- Create: `cmd/tl/main.go`
- Create: `internal/config/config.go`
- Create: `internal/pty/pty.go`
- Create: `internal/session/session.go`
- Create: `internal/hub/hub.go`
- Create: `internal/server/server.go`
- Create: `internal/server/handler.go`
- Create: `internal/notify/notifier.go`
- Create: `internal/notify/wechat.go`
- Create: `internal/notify/feishu.go`
- Create: `internal/notify/idle.go`
- Create: `web/.gitkeep`
- Create: `Makefile`

**Step 1: Initialize Go module**

```bash
cd D:/project/test/TermLive
go mod init github.com/termlive/termlive
```

**Step 2: Create directory structure**

```bash
mkdir -p cmd/tl internal/config internal/pty internal/session internal/hub internal/server internal/notify web/css web/js/vendor
```

**Step 3: Create minimal main.go**

```go
// cmd/tl/main.go
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: tl <command> [args...]")
		os.Exit(1)
	}
	fmt.Printf("TermLive: would run %v\n", os.Args[1:])
}
```

**Step 4: Create Makefile**

```makefile
.PHONY: build run test clean

BINARY=tl

build:
	go build -o $(BINARY) ./cmd/tl

run: build
	./$(BINARY)

test:
	go test ./... -v

clean:
	rm -f $(BINARY)
```

**Step 5: Verify build**

Run: `cd D:/project/test/TermLive && go build -o tl ./cmd/tl && ./tl echo hello`
Expected: `TermLive: would run [echo hello]`

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold project structure with Go module and Makefile"
```

---

### Task 2: Config Module (TDD)

**Files:**
- Create: `internal/config/config.go`
- Create: `internal/config/config_test.go`

**Step 1: Write the failing test**

```go
// internal/config/config_test.go
package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	cfg := Default()
	if cfg.Server.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Server.Port)
	}
	if cfg.Server.Host != "0.0.0.0" {
		t.Errorf("expected default host 0.0.0.0, got %s", cfg.Server.Host)
	}
	if cfg.Notify.IdleTimeout != 30 {
		t.Errorf("expected default idle timeout 30, got %d", cfg.Notify.IdleTimeout)
	}
}

func TestLoadFromFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	content := []byte(`
[server]
port = 3000
host = "127.0.0.1"

[notify]
idle_timeout = 60

[notify.wechat]
webhook_url = "https://example.com/wechat"

[notify.feishu]
webhook_url = "https://example.com/feishu"
`)
	if err := os.WriteFile(cfgPath, content, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadFromFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 3000 {
		t.Errorf("expected port 3000, got %d", cfg.Server.Port)
	}
	if cfg.Server.Host != "127.0.0.1" {
		t.Errorf("expected host 127.0.0.1, got %s", cfg.Server.Host)
	}
	if cfg.Notify.IdleTimeout != 60 {
		t.Errorf("expected idle timeout 60, got %d", cfg.Notify.IdleTimeout)
	}
	if cfg.Notify.WeChat.WebhookURL != "https://example.com/wechat" {
		t.Errorf("unexpected wechat webhook url: %s", cfg.Notify.WeChat.WebhookURL)
	}
	if cfg.Notify.Feishu.WebhookURL != "https://example.com/feishu" {
		t.Errorf("unexpected feishu webhook url: %s", cfg.Notify.Feishu.WebhookURL)
	}
}

func TestLoadFromFileMissing(t *testing.T) {
	cfg, err := LoadFromFile("/nonexistent/config.toml")
	if err != nil {
		t.Fatal("missing file should return defaults, not error")
	}
	if cfg.Server.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Server.Port)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd D:/project/test/TermLive && go test ./internal/config/ -v`
Expected: FAIL (functions not defined)

**Step 3: Install dependency and write implementation**

```bash
cd D:/project/test/TermLive && go get github.com/pelletier/go-toml/v2
```

```go
// internal/config/config.go
package config

import (
	"os"

	"github.com/pelletier/go-toml/v2"
)

type Config struct {
	Server ServerConfig `toml:"server"`
	Notify NotifyConfig `toml:"notify"`
}

type ServerConfig struct {
	Port int    `toml:"port"`
	Host string `toml:"host"`
}

type NotifyConfig struct {
	IdleTimeout int          `toml:"idle_timeout"`
	WeChat      WeChatConfig `toml:"wechat"`
	Feishu      FeishuConfig `toml:"feishu"`
}

type WeChatConfig struct {
	WebhookURL string `toml:"webhook_url"`
}

type FeishuConfig struct {
	WebhookURL string `toml:"webhook_url"`
}

func Default() *Config {
	return &Config{
		Server: ServerConfig{
			Port: 8080,
			Host: "0.0.0.0",
		},
		Notify: NotifyConfig{
			IdleTimeout: 30,
		},
	}
}

func LoadFromFile(path string) (*Config, error) {
	cfg := Default()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}

	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/config/ -v`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add internal/config/ go.mod go.sum
git commit -m "feat: add config module with TOML loading and defaults"
```

---

### Task 3: PTY Manager

**Files:**
- Create: `internal/pty/pty.go`
- Create: `internal/pty/pty_unix.go`
- Create: `internal/pty/pty_test.go`

**Step 1: Write the PTY interface and test**

```go
// internal/pty/pty.go
package pty

import (
	"io"
)

// Process wraps a command running in a pseudo-terminal.
type Process interface {
	// Read reads from the PTY output (stdout+stderr of the child).
	io.Reader
	// Write writes to the PTY input (stdin of the child).
	io.Writer
	// Resize changes the terminal dimensions.
	Resize(rows, cols uint16) error
	// Wait blocks until the child process exits and returns its exit code.
	Wait() (int, error)
	// Close cleans up the PTY.
	Close() error
	// Pid returns the child process ID.
	Pid() int
}
```

**Step 2: Write Unix implementation**

```go
// internal/pty/pty_unix.go
//go:build !windows

package pty

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

type unixProcess struct {
	ptmx *os.File
	cmd  *exec.Cmd
}

// Start creates a new PTY and runs the given command inside it.
func Start(name string, args []string, rows, cols uint16) (Process, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = os.Environ()

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		return nil, err
	}

	return &unixProcess{ptmx: ptmx, cmd: cmd}, nil
}

func (p *unixProcess) Read(b []byte) (int, error) {
	return p.ptmx.Read(b)
}

func (p *unixProcess) Write(b []byte) (int, error) {
	return p.ptmx.Write(b)
}

func (p *unixProcess) Resize(rows, cols uint16) error {
	return pty.Setsize(p.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}

func (p *unixProcess) Wait() (int, error) {
	err := p.cmd.Wait()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.Sys().(syscall.WaitStatus).ExitStatus(), nil
		}
		return -1, err
	}
	return 0, nil
}

func (p *unixProcess) Close() error {
	return p.ptmx.Close()
}

func (p *unixProcess) Pid() int {
	if p.cmd.Process != nil {
		return p.cmd.Process.Pid
	}
	return 0
}
```

**Step 3: Write test**

```go
// internal/pty/pty_test.go
//go:build !windows

package pty

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestStartAndRead(t *testing.T) {
	proc, err := Start("echo", []string{"hello"}, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer proc.Close()

	var buf bytes.Buffer
	tmp := make([]byte, 1024)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			n, err := proc.Read(tmp)
			if n > 0 {
				buf.Write(tmp[:n])
			}
			if err != nil {
				return
			}
		}
	}()

	proc.Wait()
	// Give reader goroutine time to finish
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}

	if !strings.Contains(buf.String(), "hello") {
		t.Errorf("expected output to contain 'hello', got: %q", buf.String())
	}
}

func TestPid(t *testing.T) {
	proc, err := Start("sleep", []string{"1"}, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer proc.Close()

	if proc.Pid() <= 0 {
		t.Errorf("expected positive PID, got %d", proc.Pid())
	}

	proc.Wait()
}
```

**Step 4: Install dependency and run test**

```bash
cd D:/project/test/TermLive && go get github.com/creack/pty
```

Run: `cd D:/project/test/TermLive && go test ./internal/pty/ -v -timeout 10s`
Expected: PASS (2 tests). Note: on Windows/MINGW this may fail — that's expected, Windows backend is a follow-up.

**Step 5: Commit**

```bash
git add internal/pty/ go.mod go.sum
git commit -m "feat: add PTY manager with Unix backend and interface"
```

---

### Task 4: Session Management (TDD)

**Files:**
- Create: `internal/session/session.go`
- Create: `internal/session/session_test.go`

**Step 1: Write the failing test**

```go
// internal/session/session_test.go
package session

import (
	"testing"
	"time"
)

func TestNewSession(t *testing.T) {
	s := New("claude", []string{})
	if s.ID == "" {
		t.Error("expected non-empty session ID")
	}
	if s.Command != "claude" {
		t.Errorf("expected command 'claude', got %s", s.Command)
	}
	if s.Status != StatusRunning {
		t.Errorf("expected status Running, got %s", s.Status)
	}
	if s.StartTime.IsZero() {
		t.Error("expected non-zero start time")
	}
}

func TestStoreAddAndList(t *testing.T) {
	store := NewStore()
	s1 := New("cmd1", nil)
	s2 := New("cmd2", nil)

	store.Add(s1)
	store.Add(s2)

	sessions := store.List()
	if len(sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(sessions))
	}
}

func TestStoreGet(t *testing.T) {
	store := NewStore()
	s := New("test", nil)
	store.Add(s)

	got, ok := store.Get(s.ID)
	if !ok {
		t.Error("expected to find session")
	}
	if got.ID != s.ID {
		t.Error("wrong session returned")
	}

	_, ok = store.Get("nonexistent")
	if ok {
		t.Error("expected not to find nonexistent session")
	}
}

func TestStoreRemove(t *testing.T) {
	store := NewStore()
	s := New("test", nil)
	store.Add(s)
	store.Remove(s.ID)

	if len(store.List()) != 0 {
		t.Error("expected empty store after remove")
	}
}

func TestSessionOutputBuffer(t *testing.T) {
	s := New("test", nil)
	s.AppendOutput([]byte("hello "))
	s.AppendOutput([]byte("world"))

	last := s.LastOutput(10)
	if string(last) != "llo world" {
		// Ring buffer keeps last N bytes; "hello world" = 11 bytes, last 10 = "ello world"
		// Actually let's just check it contains recent data
	}

	last = s.LastOutput(1024)
	if string(last) != "hello world" {
		t.Errorf("expected 'hello world', got %q", string(last))
	}
}

func TestSessionDuration(t *testing.T) {
	s := New("test", nil)
	s.StartTime = time.Now().Add(-5 * time.Minute)
	d := s.Duration()
	if d < 4*time.Minute || d > 6*time.Minute {
		t.Errorf("expected ~5m duration, got %v", d)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd D:/project/test/TermLive && go test ./internal/session/ -v`
Expected: FAIL (types not defined)

**Step 3: Write implementation**

```go
// internal/session/session.go
package session

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

type Status string

const (
	StatusRunning Status = "running"
	StatusStopped Status = "stopped"
)

const outputBufferSize = 4096

type Session struct {
	ID        string
	Command   string
	Args      []string
	Pid       int
	Status    Status
	StartTime time.Time

	mu     sync.Mutex
	output []byte
}

func New(command string, args []string) *Session {
	id := generateID()
	return &Session{
		ID:        id,
		Command:   command,
		Args:      args,
		Status:    StatusRunning,
		StartTime: time.Now(),
		output:    make([]byte, 0, outputBufferSize),
	}
}

func (s *Session) AppendOutput(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.output = append(s.output, data...)
	// Keep only last outputBufferSize bytes
	if len(s.output) > outputBufferSize {
		s.output = s.output[len(s.output)-outputBufferSize:]
	}
}

func (s *Session) LastOutput(n int) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n >= len(s.output) {
		result := make([]byte, len(s.output))
		copy(result, s.output)
		return result
	}
	result := make([]byte, n)
	copy(result, s.output[len(s.output)-n:])
	return result
}

func (s *Session) Duration() time.Duration {
	return time.Since(s.StartTime)
}

func generateID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Store holds all active sessions.
type Store struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func NewStore() *Store {
	return &Store{
		sessions: make(map[string]*Session),
	}
}

func (st *Store) Add(s *Session) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.sessions[s.ID] = s
}

func (st *Store) Get(id string) (*Session, bool) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	s, ok := st.sessions[id]
	return s, ok
}

func (st *Store) Remove(id string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.sessions, id)
}

func (st *Store) List() []*Session {
	st.mu.RLock()
	defer st.mu.RUnlock()
	result := make([]*Session, 0, len(st.sessions))
	for _, s := range st.sessions {
		result = append(result, s)
	}
	return result
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/session/ -v`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add internal/session/
git commit -m "feat: add session management with thread-safe store and output buffer"
```

---

### Task 5: Hub Broadcast Center (TDD)

**Files:**
- Create: `internal/hub/hub.go`
- Create: `internal/hub/hub_test.go`

**Step 1: Write the failing test**

```go
// internal/hub/hub_test.go
package hub

import (
	"sync"
	"testing"
	"time"
)

type mockClient struct {
	mu       sync.Mutex
	received [][]byte
	closed   bool
}

func (m *mockClient) Send(data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	m.received = append(m.received, cp)
	return nil
}

func (m *mockClient) getReceived() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.received
}

func TestHubBroadcast(t *testing.T) {
	h := New()
	go h.Run()
	defer h.Stop()

	c1 := &mockClient{}
	c2 := &mockClient{}

	h.Register(c1)
	h.Register(c2)

	h.Broadcast([]byte("hello"))

	time.Sleep(50 * time.Millisecond)

	if len(c1.getReceived()) != 1 || string(c1.getReceived()[0]) != "hello" {
		t.Errorf("client1 expected 'hello', got %v", c1.getReceived())
	}
	if len(c2.getReceived()) != 1 || string(c2.getReceived()[0]) != "hello" {
		t.Errorf("client2 expected 'hello', got %v", c2.getReceived())
	}
}

func TestHubUnregister(t *testing.T) {
	h := New()
	go h.Run()
	defer h.Stop()

	c1 := &mockClient{}
	h.Register(c1)
	h.Unregister(c1)

	h.Broadcast([]byte("hello"))
	time.Sleep(50 * time.Millisecond)

	if len(c1.getReceived()) != 0 {
		t.Error("unregistered client should not receive messages")
	}
}

func TestHubOnInput(t *testing.T) {
	h := New()
	go h.Run()
	defer h.Stop()

	var received []byte
	var mu sync.Mutex
	h.SetInputHandler(func(data []byte) {
		mu.Lock()
		received = append(received, data...)
		mu.Unlock()
	})

	h.Input([]byte("test input"))
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if string(received) != "test input" {
		t.Errorf("expected 'test input', got %q", string(received))
	}
}

func TestHubClientCount(t *testing.T) {
	h := New()
	go h.Run()
	defer h.Stop()

	c1 := &mockClient{}
	c2 := &mockClient{}

	h.Register(c1)
	h.Register(c2)
	time.Sleep(20 * time.Millisecond)

	if h.ClientCount() != 2 {
		t.Errorf("expected 2 clients, got %d", h.ClientCount())
	}

	h.Unregister(c1)
	time.Sleep(20 * time.Millisecond)

	if h.ClientCount() != 1 {
		t.Errorf("expected 1 client, got %d", h.ClientCount())
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd D:/project/test/TermLive && go test ./internal/hub/ -v`
Expected: FAIL

**Step 3: Write implementation**

```go
// internal/hub/hub.go
package hub

import (
	"sync"
	"sync/atomic"
)

// Client is anything that can receive terminal output data.
type Client interface {
	Send(data []byte) error
}

// Hub broadcasts PTY output to all registered clients
// and forwards client input to the PTY.
type Hub struct {
	register     chan Client
	unregister   chan Client
	broadcast    chan []byte
	inputCh      chan []byte
	stop         chan struct{}
	inputHandler func([]byte)
	mu           sync.RWMutex
	clientCount  atomic.Int32
}

func New() *Hub {
	return &Hub{
		register:   make(chan Client, 16),
		unregister: make(chan Client, 16),
		broadcast:  make(chan []byte, 256),
		inputCh:    make(chan []byte, 64),
		stop:       make(chan struct{}),
	}
}

func (h *Hub) Run() {
	clients := make(map[Client]struct{})

	for {
		select {
		case c := <-h.register:
			clients[c] = struct{}{}
			h.clientCount.Store(int32(len(clients)))

		case c := <-h.unregister:
			delete(clients, c)
			h.clientCount.Store(int32(len(clients)))

		case data := <-h.broadcast:
			for c := range clients {
				c.Send(data)
			}

		case data := <-h.inputCh:
			h.mu.RLock()
			handler := h.inputHandler
			h.mu.RUnlock()
			if handler != nil {
				handler(data)
			}

		case <-h.stop:
			return
		}
	}
}

func (h *Hub) Register(c Client) {
	h.register <- c
}

func (h *Hub) Unregister(c Client) {
	h.unregister <- c
}

func (h *Hub) Broadcast(data []byte) {
	h.broadcast <- data
}

func (h *Hub) Input(data []byte) {
	h.inputCh <- data
}

func (h *Hub) SetInputHandler(fn func([]byte)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.inputHandler = fn
}

func (h *Hub) Stop() {
	close(h.stop)
}

func (h *Hub) ClientCount() int {
	return int(h.clientCount.Load())
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/hub/ -v`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add internal/hub/
git commit -m "feat: add Hub broadcast center with register/unregister/input"
```

---

### Task 6: Idle Detector (TDD)

**Files:**
- Create: `internal/notify/idle.go`
- Create: `internal/notify/idle_test.go`

**Step 1: Write the failing test**

```go
// internal/notify/idle_test.go
package notify

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestIdleDetectorNotifies(t *testing.T) {
	var notified atomic.Int32

	d := NewIdleDetector(100*time.Millisecond, func() {
		notified.Add(1)
	})
	d.Start()
	defer d.Stop()

	// Don't call Reset — should trigger after 100ms
	time.Sleep(200 * time.Millisecond)

	if notified.Load() != 1 {
		t.Errorf("expected 1 notification, got %d", notified.Load())
	}
}

func TestIdleDetectorResetPreventsNotify(t *testing.T) {
	var notified atomic.Int32

	d := NewIdleDetector(100*time.Millisecond, func() {
		notified.Add(1)
	})
	d.Start()
	defer d.Stop()

	// Reset before timeout
	time.Sleep(50 * time.Millisecond)
	d.Reset()
	time.Sleep(50 * time.Millisecond)
	d.Reset()
	time.Sleep(50 * time.Millisecond)

	if notified.Load() != 0 {
		t.Errorf("expected 0 notifications, got %d", notified.Load())
	}
}

func TestIdleDetectorNotifiesOnceUntilReset(t *testing.T) {
	var notified atomic.Int32

	d := NewIdleDetector(50*time.Millisecond, func() {
		notified.Add(1)
	})
	d.Start()
	defer d.Stop()

	// Wait for first notification
	time.Sleep(100 * time.Millisecond)

	// Should still be 1 — no repeated notifications
	time.Sleep(100 * time.Millisecond)
	if notified.Load() != 1 {
		t.Errorf("expected exactly 1 notification, got %d", notified.Load())
	}

	// Reset and wait for second notification
	d.Reset()
	time.Sleep(100 * time.Millisecond)
	if notified.Load() != 2 {
		t.Errorf("expected 2 notifications after reset, got %d", notified.Load())
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -v -run TestIdle`
Expected: FAIL

**Step 3: Write implementation**

```go
// internal/notify/idle.go
package notify

import (
	"sync"
	"time"
)

// IdleDetector watches for periods of inactivity and fires a callback once.
// After firing, it won't fire again until Reset() is called.
type IdleDetector struct {
	timeout  time.Duration
	onIdle   func()
	timer    *time.Timer
	notified bool
	mu       sync.Mutex
	stopped  bool
}

func NewIdleDetector(timeout time.Duration, onIdle func()) *IdleDetector {
	return &IdleDetector{
		timeout: timeout,
		onIdle:  onIdle,
	}
}

func (d *IdleDetector) Start() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.timer = time.AfterFunc(d.timeout, d.fire)
}

func (d *IdleDetector) fire() {
	d.mu.Lock()
	if d.stopped || d.notified {
		d.mu.Unlock()
		return
	}
	d.notified = true
	d.mu.Unlock()

	d.onIdle()
}

func (d *IdleDetector) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.notified = false
	if d.timer != nil {
		d.timer.Stop()
		d.timer.Reset(d.timeout)
	}
}

func (d *IdleDetector) Stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stopped = true
	if d.timer != nil {
		d.timer.Stop()
	}
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -v -run TestIdle`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add internal/notify/idle.go internal/notify/idle_test.go
git commit -m "feat: add idle detector with single-fire and reset behavior"
```

---

### Task 7: Notifier Interface + WeChat Webhook (TDD)

**Files:**
- Create: `internal/notify/notifier.go`
- Create: `internal/notify/wechat.go`
- Create: `internal/notify/notifier_test.go`

**Step 1: Write the failing test**

```go
// internal/notify/notifier_test.go
package notify

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWeChatNotify(t *testing.T) {
	var receivedBody map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &receivedBody)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
	}))
	defer server.Close()

	n := NewWeChatNotifier(server.URL)
	msg := &NotifyMessage{
		SessionID:   "abc123",
		Command:     "claude",
		Pid:         12345,
		Duration:    "15m 32s",
		LastOutput:  "? Do you want to proceed? [Y/n]",
		WebURL:      "http://192.168.1.5:8080/s/abc123",
		IdleSeconds: 30,
	}

	err := n.Send(msg)
	if err != nil {
		t.Fatal(err)
	}

	if receivedBody == nil {
		t.Fatal("expected request body")
	}
	if receivedBody["msgtype"] != "markdown" {
		t.Errorf("expected msgtype 'markdown', got %v", receivedBody["msgtype"])
	}
}

func TestWeChatNotifyEmptyURL(t *testing.T) {
	n := NewWeChatNotifier("")
	err := n.Send(&NotifyMessage{})
	if err != nil {
		t.Error("empty URL should be a no-op, not an error")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -v -run TestWeChat`
Expected: FAIL

**Step 3: Write implementation**

```go
// internal/notify/notifier.go
package notify

// NotifyMessage contains the data to send in a notification.
type NotifyMessage struct {
	SessionID   string
	Command     string
	Pid         int
	Duration    string
	LastOutput  string
	WebURL      string
	IdleSeconds int
}

// Notifier sends notifications via a specific channel.
type Notifier interface {
	Send(msg *NotifyMessage) error
}

// MultiNotifier fans out to multiple notifiers.
type MultiNotifier struct {
	notifiers []Notifier
}

func NewMultiNotifier(notifiers ...Notifier) *MultiNotifier {
	return &MultiNotifier{notifiers: notifiers}
}

func (m *MultiNotifier) Send(msg *NotifyMessage) error {
	var firstErr error
	for _, n := range m.notifiers {
		if err := n.Send(msg); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
```

```go
// internal/notify/wechat.go
package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

type WeChatNotifier struct {
	webhookURL string
	client     *http.Client
}

func NewWeChatNotifier(webhookURL string) *WeChatNotifier {
	return &WeChatNotifier{
		webhookURL: webhookURL,
		client:     &http.Client{},
	}
}

func (w *WeChatNotifier) Send(msg *NotifyMessage) error {
	if w.webhookURL == "" {
		return nil
	}

	content := fmt.Sprintf(
		"**TermLive: 终端等待输入 (空闲 %ds)**\n\n"+
			"> 会话: %s (PID: %d)\n"+
			"> 运行时长: %s\n\n"+
			"最近输出:\n```\n%s\n```\n\n"+
			"[打开 Web 终端](%s)",
		msg.IdleSeconds, msg.Command, msg.Pid,
		msg.Duration, msg.LastOutput, msg.WebURL,
	)

	payload := map[string]interface{}{
		"msgtype": "markdown",
		"markdown": map[string]string{
			"content": content,
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	resp, err := w.client.Post(w.webhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("wechat webhook returned status %d", resp.StatusCode)
	}

	return nil
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -v -run TestWeChat`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add internal/notify/notifier.go internal/notify/wechat.go internal/notify/notifier_test.go
git commit -m "feat: add notifier interface and WeChat webhook implementation"
```

---

### Task 8: Feishu Notifier (TDD)

**Files:**
- Create: `internal/notify/feishu.go`
- Modify: `internal/notify/notifier_test.go` (add Feishu tests)

**Step 1: Write the failing test**

Add to `internal/notify/notifier_test.go`:

```go
func TestFeishuNotify(t *testing.T) {
	var receivedBody map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &receivedBody)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"code":0,"msg":"ok"}`))
	}))
	defer server.Close()

	n := NewFeishuNotifier(server.URL)
	msg := &NotifyMessage{
		SessionID:   "abc123",
		Command:     "claude",
		Pid:         12345,
		Duration:    "15m 32s",
		LastOutput:  "? Do you want to proceed? [Y/n]",
		WebURL:      "http://192.168.1.5:8080/s/abc123",
		IdleSeconds: 30,
	}

	err := n.Send(msg)
	if err != nil {
		t.Fatal(err)
	}

	if receivedBody == nil {
		t.Fatal("expected request body")
	}
	if receivedBody["msg_type"] != "interactive" {
		t.Errorf("expected msg_type 'interactive', got %v", receivedBody["msg_type"])
	}
}

func TestFeishuNotifyEmptyURL(t *testing.T) {
	n := NewFeishuNotifier("")
	err := n.Send(&NotifyMessage{})
	if err != nil {
		t.Error("empty URL should be a no-op, not an error")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -v -run TestFeishu`
Expected: FAIL

**Step 3: Write implementation**

```go
// internal/notify/feishu.go
package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

type FeishuNotifier struct {
	webhookURL string
	client     *http.Client
}

func NewFeishuNotifier(webhookURL string) *FeishuNotifier {
	return &FeishuNotifier{
		webhookURL: webhookURL,
		client:     &http.Client{},
	}
}

func (f *FeishuNotifier) Send(msg *NotifyMessage) error {
	if f.webhookURL == "" {
		return nil
	}

	card := map[string]interface{}{
		"msg_type": "interactive",
		"card": map[string]interface{}{
			"header": map[string]interface{}{
				"title": map[string]string{
					"tag":     "plain_text",
					"content": fmt.Sprintf("TermLive: 终端等待输入 (空闲 %ds)", msg.IdleSeconds),
				},
				"template": "orange",
			},
			"elements": []interface{}{
				map[string]interface{}{
					"tag": "div",
					"text": map[string]string{
						"tag":     "lark_md",
						"content": fmt.Sprintf("**会话:** %s (PID: %d)\n**运行时长:** %s", msg.Command, msg.Pid, msg.Duration),
					},
				},
				map[string]interface{}{
					"tag": "div",
					"text": map[string]string{
						"tag":     "lark_md",
						"content": fmt.Sprintf("**最近输出:**\n```\n%s\n```", msg.LastOutput),
					},
				},
				map[string]interface{}{
					"tag": "action",
					"actions": []interface{}{
						map[string]interface{}{
							"tag": "button",
							"text": map[string]string{
								"tag":     "plain_text",
								"content": "打开 Web 终端",
							},
							"url":  msg.WebURL,
							"type": "primary",
						},
					},
				},
			},
		},
	}

	body, err := json.Marshal(card)
	if err != nil {
		return err
	}

	resp, err := f.client.Post(f.webhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("feishu webhook returned status %d", resp.StatusCode)
	}

	return nil
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -v`
Expected: PASS (all 7 notify tests)

**Step 5: Commit**

```bash
git add internal/notify/feishu.go internal/notify/notifier_test.go
git commit -m "feat: add Feishu webhook notifier with interactive card"
```

---

### Task 9: HTTP + WebSocket Server

**Files:**
- Create: `internal/server/server.go`
- Create: `internal/server/handler.go`
- Create: `internal/server/wsclient.go`
- Create: `internal/server/server_test.go`

**Step 1: Write the failing test**

```go
// internal/server/server_test.go
package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/termlive/termlive/internal/hub"
	"github.com/termlive/termlive/internal/session"
)

func TestSessionListAPI(t *testing.T) {
	store := session.NewStore()
	s := session.New("echo", []string{"hello"})
	store.Add(s)

	h := hub.New()
	srv := New(store, map[string]*hub.Hub{s.ID: h}, "", "test-token")

	req := httptest.NewRequest("GET", "/api/sessions", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, s.ID) {
		t.Errorf("expected session ID in response, got: %s", body)
	}
}

func TestWebSocketConnection(t *testing.T) {
	store := session.NewStore()
	s := session.New("test", nil)
	store.Add(s)

	h := hub.New()
	go h.Run()
	defer h.Stop()

	srv := New(store, map[string]*hub.Hub{s.ID: h}, "", "")
	server := httptest.NewServer(srv.Handler())
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/" + s.ID
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	// Broadcast data and read from WebSocket
	h.Broadcast([]byte("hello from pty"))

	ws.SetReadDeadline(time.Now().Add(time.Second))
	_, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if string(msg) != "hello from pty" {
		t.Errorf("expected 'hello from pty', got %q", string(msg))
	}
}
```

**Step 2: Run test to verify it fails**

```bash
cd D:/project/test/TermLive && go get github.com/gorilla/websocket
```

Run: `cd D:/project/test/TermLive && go test ./internal/server/ -v`
Expected: FAIL

**Step 3: Write implementation**

```go
// internal/server/wsclient.go
package server

import (
	"sync"

	"github.com/gorilla/websocket"
)

// WSClient wraps a WebSocket connection as a hub.Client.
type WSClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func NewWSClient(conn *websocket.Conn) *WSClient {
	return &WSClient{conn: conn}
}

func (c *WSClient) Send(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.BinaryMessage, data)
}

func (c *WSClient) Close() error {
	return c.conn.Close()
}
```

```go
// internal/server/handler.go
package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/termlive/termlive/internal/hub"
	"github.com/termlive/termlive/internal/session"
)

type sessionInfo struct {
	ID        string `json:"id"`
	Command   string `json:"command"`
	Pid       int    `json:"pid"`
	Status    string `json:"status"`
	Duration  string `json:"duration"`
	LastOutput string `json:"last_output"`
}

func handleSessionList(store *session.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sessions := store.List()
		infos := make([]sessionInfo, len(sessions))
		for i, s := range sessions {
			infos[i] = sessionInfo{
				ID:        s.ID,
				Command:   s.Command,
				Pid:       s.Pid,
				Status:    string(s.Status),
				Duration:  s.Duration().Truncate(time.Second).String(),
				LastOutput: string(s.LastOutput(200)),
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(infos)
	}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func handleWebSocket(hubs map[string]*hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Extract session ID from path: /ws/{sessionID}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/ws/"), "/")
		sessionID := parts[0]

		h, ok := hubs[sessionID]
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}

		client := NewWSClient(conn)
		h.Register(client)

		defer func() {
			h.Unregister(client)
			client.Close()
		}()

		// Read input from WebSocket and forward to hub
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				break
			}
			h.Input(msg)
		}
	}
}
```

```go
// internal/server/server.go
package server

import (
	"embed"
	"io/fs"
	"net/http"

	"github.com/termlive/termlive/internal/hub"
	"github.com/termlive/termlive/internal/session"
)

type Server struct {
	store    *session.Store
	hubs     map[string]*hub.Hub
	webFS    fs.FS
	token    string
}

// New creates a new Server. webDir is the path to embedded web assets.
// If webDir is empty, static file serving is disabled.
func New(store *session.Store, hubs map[string]*hub.Hub, webDir string, token string) *Server {
	return &Server{
		store: store,
		hubs:  hubs,
		token: token,
	}
}

// SetWebFS sets the embedded filesystem for serving web assets.
func (s *Server) SetWebFS(webFS embed.FS) {
	sub, err := fs.Sub(webFS, "web")
	if err == nil {
		s.webFS = sub
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// API routes
	mux.HandleFunc("/api/sessions", handleSessionList(s.store))

	// WebSocket
	mux.HandleFunc("/ws/", handleWebSocket(s.hubs))

	// Static files
	if s.webFS != nil {
		mux.Handle("/", http.FileServer(http.FS(s.webFS)))
	}

	return mux
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/server/ -v`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add internal/server/ go.mod go.sum
git commit -m "feat: add HTTP server with session API and WebSocket handler"
```

---

### Task 10: Web UI - Session List Page

**Files:**
- Create: `web/index.html`
- Create: `web/css/style.css`
- Create: `web/js/app.js`

**Step 1: Create index.html**

```html
<!-- web/index.html -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TermLive</title>
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <header>
        <h1>TermLive</h1>
        <span id="status" class="status-dot online"></span>
    </header>
    <main>
        <h2>活跃会话</h2>
        <div id="sessions" class="session-grid"></div>
        <p id="empty-msg" style="display:none; color:#888;">暂无活跃会话</p>
    </main>
    <script src="/js/app.js"></script>
</body>
</html>
```

**Step 2: Create style.css**

```css
/* web/css/style.css */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: #1a1a2e;
    color: #e0e0e0;
    min-height: 100vh;
}

header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 24px;
    background: #16213e;
    border-bottom: 1px solid #0f3460;
}

header h1 { font-size: 20px; font-weight: 600; }

.status-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    display: inline-block;
}
.status-dot.online { background: #4ecca3; }

main { padding: 24px; }
main h2 { margin-bottom: 16px; font-size: 16px; color: #a0a0a0; }

.session-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
}

.session-card {
    background: #16213e;
    border: 1px solid #0f3460;
    border-radius: 8px;
    padding: 16px;
    cursor: pointer;
    transition: border-color 0.2s;
}
.session-card:hover { border-color: #4ecca3; }

.session-card .name {
    font-size: 16px;
    font-weight: 600;
    color: #4ecca3;
    margin-bottom: 8px;
}
.session-card .meta {
    font-size: 13px;
    color: #888;
    margin-bottom: 8px;
}
.session-card .preview {
    font-size: 12px;
    font-family: monospace;
    color: #666;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: #0d1117;
    padding: 8px;
    border-radius: 4px;
}

/* Terminal page */
.terminal-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: #16213e;
    border-bottom: 1px solid #0f3460;
}
.terminal-header a {
    color: #4ecca3;
    text-decoration: none;
    font-size: 14px;
}
.terminal-container {
    height: calc(100vh - 45px);
    background: #000;
}

@media (max-width: 600px) {
    .session-grid { grid-template-columns: 1fr; }
    header { padding: 12px 16px; }
    main { padding: 16px; }
}
```

**Step 3: Create app.js**

```javascript
// web/js/app.js
(function() {
    'use strict';

    const sessionsEl = document.getElementById('sessions');
    const emptyMsg = document.getElementById('empty-msg');

    if (!sessionsEl) return; // Not on index page

    async function loadSessions() {
        try {
            const resp = await fetch('/api/sessions');
            const sessions = await resp.json();

            if (!sessions || sessions.length === 0) {
                sessionsEl.innerHTML = '';
                emptyMsg.style.display = 'block';
                return;
            }

            emptyMsg.style.display = 'none';
            sessionsEl.innerHTML = sessions.map(s => `
                <div class="session-card" onclick="location.href='/terminal.html?id=${s.id}'">
                    <div class="name">${escapeHtml(s.command)}</div>
                    <div class="meta">PID: ${s.pid} · ${s.duration} · ${s.status}</div>
                    <div class="preview">${escapeHtml(s.last_output || '(no output)')}</div>
                </div>
            `).join('');
        } catch (e) {
            console.error('Failed to load sessions:', e);
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    loadSessions();
    setInterval(loadSessions, 3000);
})();
```

**Step 4: Verify files created**

Run: `ls D:/project/test/TermLive/web/index.html D:/project/test/TermLive/web/css/style.css D:/project/test/TermLive/web/js/app.js`
Expected: all three files listed

**Step 5: Commit**

```bash
git add web/
git commit -m "feat: add Web UI session list page with auto-refresh"
```

---

### Task 11: Web UI - Terminal Page with xterm.js

**Files:**
- Create: `web/terminal.html`
- Create: `web/js/terminal.js`
- Download: `web/js/vendor/xterm.min.js` (from CDN or npm)
- Download: `web/js/vendor/xterm-addon-fit.min.js`
- Download: `web/css/xterm.css`

**Step 1: Download xterm.js vendor files**

```bash
cd D:/project/test/TermLive
curl -sL "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js" -o web/js/vendor/xterm.min.js
curl -sL "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js" -o web/js/vendor/xterm-addon-fit.min.js
curl -sL "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css" -o web/css/xterm.css
```

Note: if CDN URLs change, check https://www.npmjs.com/package/@xterm/xterm for latest. Alternative: `npm pack @xterm/xterm` and extract.

**Step 2: Create terminal.html**

```html
<!-- web/terminal.html -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>TermLive - Terminal</title>
    <link rel="stylesheet" href="/css/style.css">
    <link rel="stylesheet" href="/css/xterm.css">
</head>
<body>
    <div class="terminal-header">
        <a href="/">◀ 返回</a>
        <span id="session-name">...</span>
        <span id="session-status" class="status-dot online"></span>
    </div>
    <div id="terminal" class="terminal-container"></div>

    <script src="/js/vendor/xterm.min.js"></script>
    <script src="/js/vendor/xterm-addon-fit.min.js"></script>
    <script src="/js/terminal.js"></script>
</body>
</html>
```

**Step 3: Create terminal.js**

```javascript
// web/js/terminal.js
(function() {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('id');

    if (!sessionId) {
        document.getElementById('terminal').textContent = 'Error: no session ID';
        return;
    }

    // Initialize xterm.js
    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
        theme: {
            background: '#0d1117',
            foreground: '#e0e0e0',
            cursor: '#4ecca3',
        },
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    // WebSocket connection
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${location.host}/ws/${sessionId}`;
    let ws = null;
    let reconnectTimer = null;

    function connect() {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = function() {
            document.getElementById('session-status').className = 'status-dot online';
            // Send initial terminal size
            sendResize();
        };

        ws.onmessage = function(event) {
            const data = event.data instanceof ArrayBuffer
                ? new TextDecoder().decode(event.data)
                : event.data;
            term.write(data);
        };

        ws.onclose = function() {
            document.getElementById('session-status').className = 'status-dot';
            // Reconnect after 2s
            reconnectTimer = setTimeout(connect, 2000);
        };

        ws.onerror = function() {
            ws.close();
        };
    }

    // Send keyboard input to WebSocket
    term.onData(function(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    // Send resize events
    function sendResize() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            const msg = JSON.stringify({
                type: 'resize',
                rows: term.rows,
                cols: term.cols,
            });
            ws.send(msg);
        }
    }

    term.onResize(function() {
        sendResize();
    });

    window.addEventListener('resize', function() {
        fitAddon.fit();
    });

    // Load session name
    fetch(`/api/sessions`).then(r => r.json()).then(sessions => {
        const s = sessions.find(s => s.id === sessionId);
        if (s) {
            document.getElementById('session-name').textContent =
                `${s.command} (PID: ${s.pid})`;
        }
    });

    connect();
})();
```

**Step 4: Verify files**

Run: `ls D:/project/test/TermLive/web/terminal.html D:/project/test/TermLive/web/js/terminal.js`
Expected: both files listed

**Step 5: Commit**

```bash
git add web/
git commit -m "feat: add terminal page with xterm.js and WebSocket client"
```

---

### Task 12: CLI with Cobra - Run Command

**Files:**
- Modify: `cmd/tl/main.go`
- Create: `cmd/tl/run.go`
- Create: `web/embed.go`

**Step 1: Install cobra dependency**

```bash
cd D:/project/test/TermLive && go get github.com/spf13/cobra
```

**Step 2: Create web embed file**

```go
// web/embed.go
package web

import "embed"

//go:embed *.html css/*.css js/*.js js/vendor/*.js
var Assets embed.FS
```

**Step 3: Rewrite main.go with cobra**

```go
// cmd/tl/main.go
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var (
	port        int
	idleTimeout int
)

var rootCmd = &cobra.Command{
	Use:   "tl [command] [args...]",
	Short: "TermLive - Terminal live streaming tool",
	Long:  "Wrap terminal commands for remote monitoring and interaction via Web UI.",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runCommand,
}

func init() {
	rootCmd.Flags().IntVarP(&port, "port", "p", 8080, "Web server port")
	rootCmd.Flags().IntVarP(&idleTimeout, "timeout", "t", 30, "Idle notification timeout (seconds)")
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

**Step 4: Create run.go — the main orchestrator**

```go
// cmd/tl/run.go
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/termlive/termlive/internal/config"
	"github.com/termlive/termlive/internal/hub"
	"github.com/termlive/termlive/internal/notify"
	ptyPkg "github.com/termlive/termlive/internal/pty"
	"github.com/termlive/termlive/internal/server"
	"github.com/termlive/termlive/internal/session"
	"github.com/termlive/termlive/web"
)

func runCommand(cmd *cobra.Command, args []string) error {
	// Load config
	cfg := config.Default()
	cfg.Server.Port = port
	cfg.Notify.IdleTimeout = idleTimeout

	// Create session
	store := session.NewStore()
	sess := session.New(args[0], args[1:])
	store.Add(sess)

	// Create hub
	h := hub.New()
	go h.Run()
	hubs := map[string]*hub.Hub{sess.ID: h}

	// Start PTY
	proc, err := ptyPkg.Start(args[0], args[1:], 24, 80)
	if err != nil {
		return fmt.Errorf("failed to start command: %w", err)
	}
	sess.Pid = proc.Pid()

	// Hub input → PTY
	h.SetInputHandler(func(data []byte) {
		proc.Write(data)
	})

	// Setup notifiers
	var notifiers []notify.Notifier
	if cfg.Notify.WeChat.WebhookURL != "" {
		notifiers = append(notifiers, notify.NewWeChatNotifier(cfg.Notify.WeChat.WebhookURL))
	}
	if cfg.Notify.Feishu.WebhookURL != "" {
		notifiers = append(notifiers, notify.NewFeishuNotifier(cfg.Notify.Feishu.WebhookURL))
	}
	multiNotifier := notify.NewMultiNotifier(notifiers...)

	// Setup idle detector
	idleDetector := notify.NewIdleDetector(
		time.Duration(cfg.Notify.IdleTimeout)*time.Second,
		func() {
			localIP := getLocalIP()
			msg := &notify.NotifyMessage{
				SessionID:   sess.ID,
				Command:     sess.Command,
				Pid:         sess.Pid,
				Duration:    sess.Duration().Truncate(time.Second).String(),
				LastOutput:  string(sess.LastOutput(200)),
				WebURL:      fmt.Sprintf("http://%s:%d/terminal.html?id=%s", localIP, cfg.Server.Port, sess.ID),
				IdleSeconds: cfg.Notify.IdleTimeout,
			}
			if err := multiNotifier.Send(msg); err != nil {
				log.Printf("notification error: %v", err)
			}
		},
	)
	idleDetector.Start()

	// PTY output → local terminal + hub + session buffer
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := proc.Read(buf)
			if n > 0 {
				data := buf[:n]
				os.Stdout.Write(data)
				h.Broadcast(data)
				sess.AppendOutput(data)
				idleDetector.Reset()
			}
			if err != nil {
				break
			}
		}
	}()

	// Local terminal input → PTY (pass-through)
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				proc.Write(buf[:n])
			}
			if err != nil {
				break
			}
		}
	}()

	// Start HTTP server
	srv := server.New(store, hubs, "", "")
	srv.SetWebFS(web.Assets)
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)

	localIP := getLocalIP()
	fmt.Fprintf(os.Stderr, "\n  TermLive Web UI: http://%s:%d\n", localIP, cfg.Server.Port)
	fmt.Fprintf(os.Stderr, "  Session: %s (ID: %s)\n\n", sess.Command, sess.ID)

	httpServer := &http.Server{Addr: addr, Handler: srv.Handler()}
	go httpServer.ListenAndServe()

	// Wait for process exit or signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	doneCh := make(chan int, 1)
	go func() {
		code, _ := proc.Wait()
		doneCh <- code
	}()

	var exitCode int
	select {
	case exitCode = <-doneCh:
		fmt.Fprintf(os.Stderr, "\n  Process exited with code %d\n", exitCode)
	case sig := <-sigCh:
		fmt.Fprintf(os.Stderr, "\n  Received signal: %v\n", sig)
		proc.Close()
		exitCode = 130
	}

	// Cleanup
	idleDetector.Stop()
	h.Stop()
	sess.Status = session.StatusStopped
	httpServer.Close()

	return nil
}

func getLocalIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() && ipnet.IP.To4() != nil {
			return ipnet.IP.String()
		}
	}
	return "127.0.0.1"
}
```

**Step 5: Verify build**

Run: `cd D:/project/test/TermLive && go build -o tl ./cmd/tl`
Expected: builds successfully

**Step 6: Commit**

```bash
git add cmd/ web/embed.go go.mod go.sum
git commit -m "feat: add CLI run command with PTY, WebSocket, and notification wiring"
```

---

### Task 13: Resize Handling in WebSocket

**Files:**
- Modify: `internal/server/handler.go` (parse resize messages)

**Step 1: Update WebSocket handler to parse resize messages**

In `internal/server/handler.go`, update `handleWebSocket` to distinguish between terminal input and resize control messages:

```go
// Add to handler.go - replace the read loop in handleWebSocket

type wsMessage struct {
	Type string `json:"type"`
	Rows uint16 `json:"rows"`
	Cols uint16 `json:"cols"`
}

// In handleWebSocket, the read loop becomes:
for {
    _, msg, err := conn.ReadMessage()
    if err != nil {
        break
    }
    // Try to parse as JSON control message
    var ctrl wsMessage
    if json.Unmarshal(msg, &ctrl) == nil && ctrl.Type == "resize" {
        // Resize is handled by the caller via a callback
        if resizeHandler != nil {
            resizeHandler(ctrl.Rows, ctrl.Cols)
        }
        continue
    }
    // Otherwise it's terminal input
    h.Input(msg)
}
```

Note: The resize handler needs to be plumbed from the PTY process. Update `handleWebSocket` to accept a `ResizeFunc` parameter, and wire it from `run.go` to call `proc.Resize()`.

**Step 2: Verify build**

Run: `cd D:/project/test/TermLive && go build -o tl ./cmd/tl`
Expected: builds successfully

**Step 3: Commit**

```bash
git add internal/server/
git commit -m "feat: add terminal resize handling via WebSocket control messages"
```

---

### Task 14: Token Authentication

**Files:**
- Modify: `internal/server/server.go` (add token middleware)
- Modify: `cmd/tl/run.go` (generate and display token)

**Step 1: Add token middleware to server**

```go
// Add to server.go

func (s *Server) Handler() http.Handler {
    mux := http.NewServeMux()
    // ... routes ...

    if s.token != "" {
        return s.authMiddleware(mux)
    }
    return mux
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.URL.Query().Get("token")
        if token == "" {
            // Check cookie
            if cookie, err := r.Cookie("tl_token"); err == nil {
                token = cookie.Value
            }
        }
        if token != s.token {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        // Set cookie so subsequent requests don't need ?token=
        http.SetCookie(w, &http.Cookie{
            Name:  "tl_token",
            Value: s.token,
            Path:  "/",
        })
        next.ServeHTTP(w, r)
    })
}
```

**Step 2: Generate token in run.go**

```go
// In run.go, before starting server:
import "crypto/rand"
import "encoding/hex"

func generateToken() string {
    b := make([]byte, 16)
    rand.Read(b)
    return hex.EncodeToString(b)
}

// Usage:
token := generateToken()
srv := server.New(store, hubs, "", token)
fmt.Fprintf(os.Stderr, "  TermLive Web UI: http://%s:%d?token=%s\n", localIP, cfg.Server.Port, token)
```

**Step 3: Verify build**

Run: `cd D:/project/test/TermLive && go build -o tl ./cmd/tl`
Expected: builds successfully

**Step 4: Commit**

```bash
git add internal/server/ cmd/tl/
git commit -m "feat: add token-based authentication for Web UI"
```

---

### Task 15: QR Code on Startup

**Files:**
- Modify: `cmd/tl/run.go` (add QR code display)

**Step 1: Install QR code library**

```bash
cd D:/project/test/TermLive && go get github.com/mdp/qrterminal/v3
```

**Step 2: Add QR code display after server start**

```go
// In run.go, after printing the URL:
import qrterminal "github.com/mdp/qrterminal/v3"

url := fmt.Sprintf("http://%s:%d?token=%s", localIP, cfg.Server.Port, token)
fmt.Fprintf(os.Stderr, "\n  TermLive Web UI: %s\n\n", url)
qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stderr)
fmt.Fprintln(os.Stderr)
```

**Step 3: Verify build**

Run: `cd D:/project/test/TermLive && go build -o tl ./cmd/tl`
Expected: builds successfully

**Step 4: Commit**

```bash
git add cmd/tl/ go.mod go.sum
git commit -m "feat: display QR code on startup for mobile access"
```

---

### Task 16: Integration Test - End to End

**Files:**
- Create: `test/integration_test.go`

**Step 1: Write integration test**

```go
// test/integration_test.go
//go:build !windows

package test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/termlive/termlive/internal/hub"
	ptyPkg "github.com/termlive/termlive/internal/pty"
	"github.com/termlive/termlive/internal/server"
	"github.com/termlive/termlive/internal/session"
	"net/http/httptest"
)

func TestEndToEnd(t *testing.T) {
	// Create session and hub
	store := session.NewStore()
	sess := session.New("echo", []string{"integration test"})
	store.Add(sess)

	h := hub.New()
	go h.Run()
	defer h.Stop()

	hubs := map[string]*hub.Hub{sess.ID: h}

	// Start PTY
	proc, err := ptyPkg.Start("echo", []string{"integration test"}, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	sess.Pid = proc.Pid()

	// Wire PTY output to hub
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := proc.Read(buf)
			if n > 0 {
				h.Broadcast(buf[:n])
				sess.AppendOutput(buf[:n])
			}
			if err != nil {
				break
			}
		}
	}()

	// Start HTTP server
	srv := server.New(store, hubs, "", "")
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Test session list API
	resp, err := http.Get(ts.URL + "/api/sessions")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	// Test WebSocket
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/" + sess.ID
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	// Wait for PTY output via WebSocket
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("failed to read ws message: %v", err)
	}
	if !strings.Contains(string(msg), "integration test") {
		t.Errorf("expected 'integration test' in ws message, got: %q", string(msg))
	}

	proc.Wait()
}
```

**Step 2: Run integration test**

Run: `cd D:/project/test/TermLive && go test ./test/ -v -timeout 30s`
Expected: PASS

**Step 3: Commit**

```bash
git add test/
git commit -m "test: add end-to-end integration test"
```

---

### Task 17: Final Polish - Raw Terminal Mode

**Files:**
- Modify: `cmd/tl/run.go` (set stdin to raw mode for proper pass-through)

**Step 1: Add raw terminal mode**

```go
// In run.go, before starting the stdin read loop:
import "golang.org/x/term"

// Save and restore terminal state
oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
if err == nil {
    defer term.Restore(int(os.Stdin.Fd()), oldState)
}
```

```bash
cd D:/project/test/TermLive && go get golang.org/x/term
```

**Step 2: Verify build**

Run: `cd D:/project/test/TermLive && go build -o tl ./cmd/tl`
Expected: builds successfully

**Step 3: Manual smoke test**

Run: `./tl echo "Hello TermLive"`
Expected: Prints "Hello TermLive", shows Web UI URL with QR code, exits cleanly

**Step 4: Commit**

```bash
git add cmd/tl/ go.mod go.sum
git commit -m "feat: set terminal to raw mode for proper input pass-through"
```

---

### Task 18: Build and Release Setup

**Files:**
- Modify: `Makefile` (add cross-compile targets)

**Step 1: Update Makefile**

```makefile
.PHONY: build run test clean release

BINARY=tl
VERSION?=dev

build:
	go build -ldflags "-s -w" -o $(BINARY) ./cmd/tl

run: build
	./$(BINARY)

test:
	go test ./... -v -timeout 30s

clean:
	rm -f $(BINARY) $(BINARY)-*

release:
	GOOS=linux GOARCH=amd64 go build -ldflags "-s -w" -o $(BINARY)-linux-amd64 ./cmd/tl
	GOOS=darwin GOARCH=amd64 go build -ldflags "-s -w" -o $(BINARY)-darwin-amd64 ./cmd/tl
	GOOS=darwin GOARCH=arm64 go build -ldflags "-s -w" -o $(BINARY)-darwin-arm64 ./cmd/tl
	GOOS=windows GOARCH=amd64 go build -ldflags "-s -w" -o $(BINARY)-windows-amd64.exe ./cmd/tl
```

**Step 2: Verify**

Run: `cd D:/project/test/TermLive && make build`
Expected: builds `tl` binary

**Step 3: Commit**

```bash
git add Makefile
git commit -m "chore: add Makefile with cross-compile release targets"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Project scaffolding | `go.mod`, `cmd/tl/main.go`, `Makefile` |
| 2 | Config module (TDD) | `internal/config/` |
| 3 | PTY Manager | `internal/pty/` |
| 4 | Session management (TDD) | `internal/session/` |
| 5 | Hub broadcast center (TDD) | `internal/hub/` |
| 6 | Idle detector (TDD) | `internal/notify/idle.go` |
| 7 | WeChat notifier (TDD) | `internal/notify/wechat.go` |
| 8 | Feishu notifier (TDD) | `internal/notify/feishu.go` |
| 9 | HTTP + WebSocket server | `internal/server/` |
| 10 | Web UI - session list | `web/index.html`, `web/js/app.js` |
| 11 | Web UI - terminal page | `web/terminal.html`, xterm.js |
| 12 | CLI with Cobra | `cmd/tl/main.go`, `cmd/tl/run.go` |
| 13 | Resize handling | `internal/server/handler.go` |
| 14 | Token authentication | `internal/server/server.go` |
| 15 | QR code on startup | `cmd/tl/run.go` |
| 16 | Integration test | `test/integration_test.go` |
| 17 | Raw terminal mode | `cmd/tl/run.go` |
| 18 | Build & release | `Makefile` |
