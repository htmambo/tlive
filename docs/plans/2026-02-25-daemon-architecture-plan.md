# TermLive Daemon Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert TermLive from a single-invocation CLI wrapper to a daemon with persistent sessions, supporting `tlive daemon`, `tlive run`, `tlive attach`, `tlive shell`, and `tlive init` commands.

**Architecture:** A background daemon process owns all PTY sessions and an HTTP server. CLI commands communicate with the daemon via JSON-RPC over Unix socket (Linux/macOS) or Named Pipe (Windows). The `tlive attach` command bridges local terminal I/O to a daemon session. Existing functionality (Web UI, notifications, idle detection) moves into the daemon.

**Tech Stack:** Go 1.24, creack/pty (Unix), conpty (Windows), gorilla/websocket, cobra CLI, golang.org/x/term

**Design doc:** `docs/plans/2026-02-25-daemon-architecture-design.md`

---

## Phase 1: Refactor — Extract SessionManager

**Goal:** Extract PTY/session/hub lifecycle management from `run.go` into `internal/daemon/manager.go` without changing any external behavior. After this phase, `tlive <cmd>` works exactly as before but uses the new SessionManager internally.

### Task 1: Create SessionManager and ManagedSession types

**Files:**
- Create: `internal/daemon/manager.go`
- Test: `internal/daemon/manager_test.go`

**Step 1: Write the failing test**

```go
// internal/daemon/manager_test.go
package daemon

import (
	"os"
	"runtime"
	"testing"
	"time"
)

func TestCreateAndStopSession(t *testing.T) {
	mgr := NewSessionManager()

	// Use a simple command that exits quickly
	cmd := "echo"
	args := []string{"hello"}
	if runtime.GOOS == "windows" {
		cmd = "cmd.exe"
		args = []string{"/C", "echo hello"}
	}

	cfg := SessionConfig{
		Rows: 24,
		Cols: 80,
	}

	ms, err := mgr.CreateSession(cmd, args, cfg)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	if ms.Session.ID == "" {
		t.Fatal("expected non-empty session ID")
	}
	if ms.Session.Status != "running" {
		t.Fatalf("expected status running, got %s", ms.Session.Status)
	}
	if ms.Proc == nil {
		t.Fatal("expected non-nil Process")
	}
	if ms.Hub == nil {
		t.Fatal("expected non-nil Hub")
	}

	// Verify it appears in list
	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}

	// Verify we can get it by ID
	got, ok := mgr.GetSession(ms.Session.ID)
	if !ok {
		t.Fatal("GetSession returned false")
	}
	if got.Session.ID != ms.Session.ID {
		t.Fatal("GetSession returned wrong session")
	}

	// Wait for the echo command to finish
	time.Sleep(2 * time.Second)

	// Stop should not error even if process already exited
	err = mgr.StopSession(ms.Session.ID)
	if err != nil {
		t.Fatalf("StopSession failed: %v", err)
	}

	if ms.Session.Status != "stopped" {
		t.Fatalf("expected status stopped, got %s", ms.Session.Status)
	}
}

func TestStopNonexistentSession(t *testing.T) {
	mgr := NewSessionManager()
	err := mgr.StopSession("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent session")
	}
}

func TestSessionOutput(t *testing.T) {
	mgr := NewSessionManager()

	cmd := "echo"
	args := []string{"hello world"}
	if runtime.GOOS == "windows" {
		cmd = "cmd.exe"
		args = []string{"/C", "echo hello world"}
	}

	cfg := SessionConfig{
		Rows: 24,
		Cols: 80,
	}

	ms, err := mgr.CreateSession(cmd, args, cfg)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	defer mgr.StopSession(ms.Session.ID)

	// Wait for output to be captured
	time.Sleep(2 * time.Second)

	output := string(ms.Session.LastOutput(200))
	if len(output) == 0 {
		t.Fatal("expected some output from echo command")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./internal/daemon/ -v -run TestCreate`
Expected: FAIL — package does not exist

**Step 3: Write minimal implementation**

```go
// internal/daemon/manager.go
package daemon

import (
	"fmt"
	"sync"

	"github.com/termlive/termlive/internal/hub"
	"github.com/termlive/termlive/internal/pty"
	"github.com/termlive/termlive/internal/session"
)

// SessionConfig holds parameters for creating a new session.
type SessionConfig struct {
	Rows uint16
	Cols uint16
}

// ManagedSession bundles a session with its PTY, hub, and output goroutine.
type ManagedSession struct {
	Session *session.Session
	Hub     *hub.Hub
	Proc    pty.Process
	done    chan int // receives exit code when process exits
}

// ExitCode blocks until the process exits and returns the exit code.
func (ms *ManagedSession) ExitCode() int {
	return <-ms.done
}

// SessionManager creates, tracks, and stops managed sessions.
type SessionManager struct {
	store    *session.Store
	sessions map[string]*ManagedSession
	mu       sync.Mutex
}

// NewSessionManager creates a new SessionManager.
func NewSessionManager() *SessionManager {
	return &SessionManager{
		store:    session.NewStore(),
		sessions: make(map[string]*ManagedSession),
	}
}

// Store returns the underlying session store (for server API).
func (m *SessionManager) Store() *session.Store {
	return m.store
}

// CreateSession starts a command in a new PTY and returns a ManagedSession.
func (m *SessionManager) CreateSession(cmd string, args []string, cfg SessionConfig) (*ManagedSession, error) {
	// Create session metadata
	sess := session.New(cmd, args)

	// Create broadcast hub
	h := hub.New()
	go h.Run()

	// Start PTY
	proc, err := pty.Start(cmd, args, cfg.Rows, cfg.Cols)
	if err != nil {
		h.Stop()
		return nil, fmt.Errorf("failed to start command: %w", err)
	}
	sess.Pid = proc.Pid()

	// Hub input -> PTY
	h.SetInputHandler(func(data []byte) {
		proc.Write(data)
	})

	ms := &ManagedSession{
		Session: sess,
		Hub:     h,
		Proc:    proc,
		done:    make(chan int, 1),
	}

	// PTY output -> hub + session buffer
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := proc.Read(buf)
			if n > 0 {
				data := buf[:n]
				h.Broadcast(data)
				sess.AppendOutput(data)
			}
			if err != nil {
				break
			}
		}
	}()

	// Wait for process exit in background
	go func() {
		code, _ := proc.Wait()
		ms.done <- code
	}()

	// Register
	m.mu.Lock()
	m.sessions[sess.ID] = ms
	m.store.Add(sess)
	m.mu.Unlock()

	return ms, nil
}

// GetSession returns a managed session by ID.
func (m *SessionManager) GetSession(id string) (*ManagedSession, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ms, ok := m.sessions[id]
	return ms, ok
}

// ListSessions returns all sessions.
func (m *SessionManager) ListSessions() []*session.Session {
	return m.store.List()
}

// Hubs returns a map of session ID -> hub (for server compatibility).
func (m *SessionManager) Hubs() map[string]*hub.Hub {
	m.mu.Lock()
	defer m.mu.Unlock()
	hubs := make(map[string]*hub.Hub, len(m.sessions))
	for id, ms := range m.sessions {
		hubs[id] = ms.Hub
	}
	return hubs
}

// StopSession closes the PTY and stops the hub for a session.
func (m *SessionManager) StopSession(id string) error {
	m.mu.Lock()
	ms, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %s not found", id)
	}
	delete(m.sessions, id)
	m.mu.Unlock()

	ms.Proc.Close()
	ms.Hub.Stop()
	ms.Session.Status = session.StatusStopped
	return nil
}
```

**Step 4: Run tests to verify they pass**

Run: `go test ./internal/daemon/ -v -timeout 30s`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add internal/daemon/manager.go internal/daemon/manager_test.go
git commit -m "feat: add SessionManager for daemon session lifecycle"
```

---

### Task 2: Integrate SessionManager into run.go

**Files:**
- Modify: `cmd/tlive/run.go`

**Step 1: Rewrite runCommand to use SessionManager**

Replace the body of `runCommand` to delegate session creation to SessionManager while keeping local terminal I/O, idle detection, and HTTP server in `run.go`. The key change: PTY/session/hub creation moves to `mgr.CreateSession()`.

```go
// cmd/tlive/run.go — full replacement
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
	"github.com/termlive/termlive/internal/daemon"
	"github.com/termlive/termlive/internal/notify"
	"github.com/termlive/termlive/internal/server"
	"github.com/termlive/termlive/web"

	qrterminal "github.com/mdp/qrterminal/v3"
	"golang.org/x/term"
)

func runCommand(cmd *cobra.Command, args []string) error {
	// Load config
	cfg := config.Default()
	cfg.Server.Port = port
	cfg.Notify.ShortTimeout = shortTimeout
	cfg.Notify.LongTimeout = longTimeout

	// Detect terminal size
	rows, cols := uint16(24), uint16(80)
	if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
		cols, rows = uint16(w), uint16(h)
	}

	// Create session via SessionManager
	mgr := daemon.NewSessionManager()
	ms, err := mgr.CreateSession(args[0], args[1:], daemon.SessionConfig{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		return err
	}
	defer mgr.StopSession(ms.Session.ID)

	// Master shutdown context
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Setup notifiers
	var notifiers []notify.Notifier
	if cfg.Notify.WeChat.WebhookURL != "" {
		notifiers = append(notifiers, notify.NewWeChatNotifier(cfg.Notify.WeChat.WebhookURL))
	}
	if cfg.Notify.Feishu.WebhookURL != "" {
		notifiers = append(notifiers, notify.NewFeishuNotifier(cfg.Notify.Feishu.WebhookURL))
	}
	multiNotifier := notify.NewMultiNotifier(notifiers...)

	// Setup smart idle detector
	localIP := publicIP
	if localIP == "" {
		localIP = getLocalIP()
	}
	idleDetector := notify.NewSmartIdleDetector(
		time.Duration(cfg.Notify.ShortTimeout)*time.Second,
		time.Duration(cfg.Notify.LongTimeout)*time.Second,
		cfg.Notify.Patterns.AwaitingInput,
		cfg.Notify.Patterns.Processing,
		func(confidence string) {
			msg := &notify.NotifyMessage{
				SessionID:   ms.Session.ID,
				Command:     ms.Session.Command,
				Pid:         ms.Session.Pid,
				Duration:    ms.Session.Duration().Truncate(time.Second).String(),
				LastOutput:  string(ms.Session.LastOutput(200)),
				WebURL:      fmt.Sprintf("http://%s:%d/terminal.html?id=%s", localIP, cfg.Server.Port, ms.Session.ID),
				IdleSeconds: cfg.Notify.ShortTimeout,
				Confidence:  confidence,
			}
			if confidence == "low" {
				msg.IdleSeconds = cfg.Notify.LongTimeout
			}
			if err := multiNotifier.Send(msg); err != nil {
				log.Printf("notification error: %v", err)
			}
		},
	)
	idleDetector.Start()

	// Subscribe to session output for local terminal + idle detection
	ms.Hub.Register(&localOutputClient{
		writer:       os.Stdout,
		idleDetector: idleDetector,
	})

	// Set terminal to raw mode
	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	rawMode := err == nil

	// Local stdin -> PTY (exits when ctx cancelled)
	go func() {
		buf := make([]byte, 1024)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				ms.Proc.Write(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()

	// Start HTTP server
	token := generateToken()
	hubs := mgr.Hubs()
	srv := server.New(mgr.Store(), hubs, token)
	srv.SetResizeFunc(ms.Session.ID, func(rows, cols uint16) {
		ms.Proc.Resize(rows, cols)
	})
	srv.SetWebFS(web.Assets)
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)

	url := fmt.Sprintf("http://%s:%d?token=%s", localIP, cfg.Server.Port, token)
	localURL := fmt.Sprintf("http://localhost:%d?token=%s", cfg.Server.Port, token)
	fmt.Fprintf(os.Stderr, "\n  TermLive Web UI:\n")
	fmt.Fprintf(os.Stderr, "    Local:   %s\n", localURL)
	fmt.Fprintf(os.Stderr, "    Network: %s\n", url)
	fmt.Fprintf(os.Stderr, "  Session: %s (ID: %s)\n\n", ms.Session.Command, ms.Session.ID)
	qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stderr)
	fmt.Fprintln(os.Stderr)

	httpServer := &http.Server{Addr: addr, Handler: srv.Handler()}
	go httpServer.ListenAndServe()

	// Wait for process exit or signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	doneCh := make(chan int, 1)
	go func() {
		doneCh <- ms.ExitCode()
	}()

	var exitCode int
	select {
	case exitCode = <-doneCh:
		fmt.Fprintf(os.Stderr, "\n  Process exited with code %d\n", exitCode)
	case sig := <-sigCh:
		fmt.Fprintf(os.Stderr, "\n  Received signal: %v\n", sig)
		exitCode = 130
	}

	// Cleanup
	cancel()
	if rawMode {
		term.Restore(int(os.Stdin.Fd()), oldState)
	}
	idleDetector.Stop()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer shutdownCancel()
	httpServer.Shutdown(shutdownCtx)

	return nil
}

// localOutputClient implements hub.Client to write PTY output to local terminal
// and feed the idle detector.
type localOutputClient struct {
	writer       *os.File
	idleDetector *notify.SmartIdleDetector
}

func (c *localOutputClient) Send(data []byte) error {
	c.writer.Write(data)
	if c.idleDetector != nil {
		c.idleDetector.Feed(data)
	}
	return nil
}

func getLocalIP() string {
	conn, err := net.DialTimeout("udp4", "8.8.8.8:53", 1*time.Second)
	if err == nil {
		defer conn.Close()
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && addr.IP.To4() != nil && !addr.IP.IsLoopback() {
			return addr.IP.String()
		}
	}

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

func generateToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
```

**Step 2: Run build to verify compilation**

Run: `go build ./cmd/tlive`
Expected: SUCCESS

**Step 3: Run all existing tests**

Run: `go test ./... -v -timeout 60s`
Expected: ALL PASS (no behavior change)

**Step 4: Commit**

```bash
git add cmd/tlive/run.go
git commit -m "refactor: use SessionManager in run.go"
```

---

## Phase 2: Daemon + IPC

**Goal:** Add `tlive daemon start/stop` commands and JSON-RPC IPC, so `tlive run` can communicate with a background daemon.

### Task 3: Create IPC protocol types

**Files:**
- Create: `internal/daemon/ipc.go`
- Test: `internal/daemon/ipc_test.go`

**Step 1: Write the failing test**

```go
// internal/daemon/ipc_test.go
package daemon

import (
	"encoding/json"
	"testing"
)

func TestRPCRequestMarshal(t *testing.T) {
	req := &RPCRequest{
		Method: "run",
		ID:     1,
		Params: json.RawMessage(`{"cmd":"echo","args":["hello"]}`),
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	var decoded RPCRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Method != "run" {
		t.Fatalf("expected method run, got %s", decoded.Method)
	}
	if decoded.ID != 1 {
		t.Fatalf("expected id 1, got %d", decoded.ID)
	}
}

func TestRPCResponseMarshal(t *testing.T) {
	resp := &RPCResponse{
		ID:     1,
		Result: json.RawMessage(`{"session_id":"abc123"}`),
	}
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}

	var decoded RPCResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ID != 1 {
		t.Fatalf("expected id 1, got %d", decoded.ID)
	}
	if decoded.Error != nil {
		t.Fatalf("expected no error, got %v", decoded.Error)
	}
}

func TestRPCResponseError(t *testing.T) {
	rpcErr := &RPCError{Code: -1, Message: "not found"}
	resp := &RPCResponse{
		ID:    2,
		Error: rpcErr,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}

	var decoded RPCResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Error == nil {
		t.Fatal("expected error in response")
	}
	if decoded.Error.Message != "not found" {
		t.Fatalf("expected 'not found', got %s", decoded.Error.Message)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./internal/daemon/ -v -run TestRPC`
Expected: FAIL — types not defined

**Step 3: Write implementation**

```go
// internal/daemon/ipc.go
package daemon

import (
	"encoding/json"
)

// RPCRequest is a JSON-RPC request from CLI to daemon.
type RPCRequest struct {
	Method string          `json:"method"`
	ID     int             `json:"id"`
	Params json.RawMessage `json:"params,omitempty"`
}

// RPCResponse is a JSON-RPC response from daemon to CLI.
type RPCResponse struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

// RPCError represents an error in a JSON-RPC response.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// RPC method names
const (
	MethodRun     = "run"
	MethodAttach  = "attach"
	MethodList    = "list"
	MethodStop    = "stop"
	MethodResize  = "resize"
)

// RunParams is the params for the "run" RPC method.
type RunParams struct {
	Cmd  string   `json:"cmd"`
	Args []string `json:"args"`
	Rows uint16   `json:"rows"`
	Cols uint16   `json:"cols"`
}

// RunResult is the result for the "run" RPC method.
type RunResult struct {
	SessionID string `json:"session_id"`
}

// AttachParams is the params for the "attach" RPC method.
type AttachParams struct {
	SessionID string `json:"session_id"`
}

// ListResult is the result for the "list" RPC method.
type ListResult struct {
	Sessions []SessionInfo `json:"sessions"`
}

// SessionInfo is a summary of a session for RPC responses.
type SessionInfo struct {
	ID         string `json:"id"`
	Command    string `json:"command"`
	Pid        int    `json:"pid"`
	Status     string `json:"status"`
	Duration   string `json:"duration"`
	LastOutput string `json:"last_output"`
}

// StopParams is the params for the "stop" RPC method.
type StopParams struct {
	SessionID string `json:"session_id"`
}

// ResizeParams is the params for the "resize" RPC method.
type ResizeParams struct {
	SessionID string `json:"session_id"`
	Rows      uint16 `json:"rows"`
	Cols      uint16 `json:"cols"`
}
```

**Step 4: Run tests**

Run: `go test ./internal/daemon/ -v -run TestRPC`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/daemon/ipc.go internal/daemon/ipc_test.go
git commit -m "feat: add JSON-RPC protocol types for daemon IPC"
```

---

### Task 4: Create Daemon struct with IPC listener

**Files:**
- Create: `internal/daemon/daemon.go`
- Create: `internal/daemon/socket.go` (cross-platform socket/pipe helpers)
- Test: `internal/daemon/daemon_test.go`

**Step 1: Write the failing test**

```go
// internal/daemon/daemon_test.go
package daemon

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestDaemonStartStop(t *testing.T) {
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "test.sock")
	if runtime.GOOS == "windows" {
		socketPath = `\\.\pipe\termlive-test-` + filepath.Base(dir)
	}

	d := NewDaemon(DaemonConfig{
		SocketPath: socketPath,
		Port:       0, // random port
	})

	errCh := make(chan error, 1)
	go func() {
		errCh <- d.Run()
	}()

	// Wait for daemon to start
	time.Sleep(500 * time.Millisecond)

	// Verify we can connect
	conn, err := dialSocket(socketPath)
	if err != nil {
		t.Fatalf("failed to connect to daemon: %v", err)
	}
	conn.Close()

	// Stop daemon
	d.Stop()

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("daemon Run returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon did not stop within timeout")
	}
}

func TestDaemonRPCList(t *testing.T) {
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "test.sock")
	if runtime.GOOS == "windows" {
		socketPath = `\\.\pipe\termlive-test-list-` + filepath.Base(dir)
	}

	d := NewDaemon(DaemonConfig{
		SocketPath: socketPath,
		Port:       0,
	})

	go d.Run()
	defer d.Stop()
	time.Sleep(500 * time.Millisecond)

	// Send list RPC
	conn, err := dialSocket(socketPath)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	req := &RPCRequest{Method: MethodList, ID: 1}
	encoder := json.NewEncoder(conn)
	decoder := json.NewDecoder(conn)

	if err := encoder.Encode(req); err != nil {
		t.Fatalf("failed to send request: %v", err)
	}

	var resp RPCResponse
	if err := decoder.Decode(&resp); err != nil {
		t.Fatalf("failed to read response: %v", err)
	}

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
	if resp.ID != 1 {
		t.Fatalf("expected id 1, got %d", resp.ID)
	}

	var result ListResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}
	if len(result.Sessions) != 0 {
		t.Fatalf("expected 0 sessions, got %d", len(result.Sessions))
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./internal/daemon/ -v -run TestDaemon`
Expected: FAIL — NewDaemon not defined

**Step 3: Write socket helpers**

```go
// internal/daemon/socket.go
package daemon

import (
	"net"
	"runtime"
)

func listenSocket(path string) (net.Listener, error) {
	if runtime.GOOS == "windows" {
		return listenPipe(path)
	}
	return net.Listen("unix", path)
}

func dialSocket(path string) (net.Conn, error) {
	if runtime.GOOS == "windows" {
		return dialPipe(path)
	}
	return net.Dial("unix", path)
}
```

```go
// internal/daemon/socket_windows.go
//go:build windows

package daemon

import (
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

func listenPipe(path string) (net.Listener, error) {
	cfg := &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;CO)", // Creator Owner only
	}
	return winio.ListenPipe(path, cfg)
}

func dialPipe(path string) (net.Conn, error) {
	return winio.DialPipe(path, (*time.Duration)(nil))
}
```

```go
// internal/daemon/socket_unix.go
//go:build !windows

package daemon

import (
	"net"
	"os"
)

func listenPipe(path string) (net.Listener, error) {
	os.Remove(path) // Clean up stale socket
	return net.Listen("unix", path)
}

func dialPipe(path string) (net.Conn, error) {
	return net.Dial("unix", path)
}
```

**Step 4: Write daemon implementation**

```go
// internal/daemon/daemon.go
package daemon

import (
	"encoding/json"
	"log"
	"net"
	"sync"
	"time"
)

// DaemonConfig holds daemon startup configuration.
type DaemonConfig struct {
	SocketPath string
	Port       int
}

// Daemon is the background process that manages sessions and IPC.
type Daemon struct {
	cfg      DaemonConfig
	mgr      *SessionManager
	listener net.Listener
	stop     chan struct{}
	wg       sync.WaitGroup
}

// NewDaemon creates a new daemon instance.
func NewDaemon(cfg DaemonConfig) *Daemon {
	return &Daemon{
		cfg:  cfg,
		mgr:  NewSessionManager(),
		stop: make(chan struct{}),
	}
}

// Manager returns the underlying SessionManager.
func (d *Daemon) Manager() *SessionManager {
	return d.mgr
}

// Run starts the daemon IPC listener. Blocks until Stop is called.
func (d *Daemon) Run() error {
	var err error
	d.listener, err = listenSocket(d.cfg.SocketPath)
	if err != nil {
		return err
	}

	// Accept connections until stopped
	go func() {
		<-d.stop
		d.listener.Close()
	}()

	for {
		conn, err := d.listener.Accept()
		if err != nil {
			select {
			case <-d.stop:
				d.wg.Wait()
				return nil
			default:
				log.Printf("accept error: %v", err)
				continue
			}
		}
		d.wg.Add(1)
		go func() {
			defer d.wg.Done()
			d.handleConn(conn)
		}()
	}
}

// Stop signals the daemon to shut down.
func (d *Daemon) Stop() {
	close(d.stop)
	if d.listener != nil {
		d.listener.Close()
	}
}

func (d *Daemon) handleConn(conn net.Conn) {
	defer conn.Close()
	decoder := json.NewDecoder(conn)
	encoder := json.NewEncoder(conn)

	for {
		var req RPCRequest
		if err := decoder.Decode(&req); err != nil {
			return // connection closed or malformed
		}

		resp := d.handleRPC(&req)
		if err := encoder.Encode(resp); err != nil {
			return
		}
	}
}

func (d *Daemon) handleRPC(req *RPCRequest) *RPCResponse {
	switch req.Method {
	case MethodList:
		return d.handleList(req)
	case MethodRun:
		return d.handleRun(req)
	case MethodStop:
		return d.handleStop(req)
	case MethodResize:
		return d.handleResize(req)
	default:
		return &RPCResponse{
			ID:    req.ID,
			Error: &RPCError{Code: -1, Message: "unknown method: " + req.Method},
		}
	}
}

func (d *Daemon) handleList(req *RPCRequest) *RPCResponse {
	sessions := d.mgr.ListSessions()
	infos := make([]SessionInfo, len(sessions))
	for i, s := range sessions {
		infos[i] = SessionInfo{
			ID:         s.ID,
			Command:    s.Command,
			Pid:        s.Pid,
			Status:     string(s.Status),
			Duration:   s.Duration().Truncate(time.Second).String(),
			LastOutput: string(s.LastOutput(200)),
		}
	}
	result, _ := json.Marshal(ListResult{Sessions: infos})
	return &RPCResponse{ID: req.ID, Result: result}
}

func (d *Daemon) handleRun(req *RPCRequest) *RPCResponse {
	var params RunParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return &RPCResponse{ID: req.ID, Error: &RPCError{Code: -1, Message: err.Error()}}
	}
	if params.Rows == 0 {
		params.Rows = 24
	}
	if params.Cols == 0 {
		params.Cols = 80
	}

	ms, err := d.mgr.CreateSession(params.Cmd, params.Args, SessionConfig{
		Rows: params.Rows,
		Cols: params.Cols,
	})
	if err != nil {
		return &RPCResponse{ID: req.ID, Error: &RPCError{Code: -1, Message: err.Error()}}
	}

	result, _ := json.Marshal(RunResult{SessionID: ms.Session.ID})
	return &RPCResponse{ID: req.ID, Result: result}
}

func (d *Daemon) handleStop(req *RPCRequest) *RPCResponse {
	var params StopParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return &RPCResponse{ID: req.ID, Error: &RPCError{Code: -1, Message: err.Error()}}
	}

	if err := d.mgr.StopSession(params.SessionID); err != nil {
		return &RPCResponse{ID: req.ID, Error: &RPCError{Code: -1, Message: err.Error()}}
	}

	result, _ := json.Marshal(map[string]bool{"ok": true})
	return &RPCResponse{ID: req.ID, Result: result}
}

func (d *Daemon) handleResize(req *RPCRequest) *RPCResponse {
	var params ResizeParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return &RPCResponse{ID: req.ID, Error: &RPCError{Code: -1, Message: err.Error()}}
	}

	ms, ok := d.mgr.GetSession(params.SessionID)
	if !ok {
		return &RPCResponse{ID: req.ID, Error: &RPCError{Code: -1, Message: "session not found"}}
	}
	ms.Proc.Resize(params.Rows, params.Cols)

	result, _ := json.Marshal(map[string]bool{"ok": true})
	return &RPCResponse{ID: req.ID, Result: result}
}
```

**Step 5: Add go-winio dependency (Windows named pipes)**

Run: `go get github.com/Microsoft/go-winio`

**Step 6: Run tests**

Run: `go test ./internal/daemon/ -v -timeout 30s`
Expected: PASS

**Step 7: Commit**

```bash
git add internal/daemon/
git commit -m "feat: add Daemon with IPC listener and RPC handlers"
```

---

### Task 5: Add CLI commands for daemon start/stop/list

**Files:**
- Create: `cmd/tlive/daemon_cmd.go`
- Modify: `cmd/tlive/main.go`

**Step 1: Create daemon CLI commands**

```go
// cmd/tlive/daemon_cmd.go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/termlive/termlive/internal/config"
	"github.com/termlive/termlive/internal/daemon"
)

func defaultSocketPath() string {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".termlive")
	os.MkdirAll(dir, 0700)
	if runtime.GOOS == "windows" {
		return `\\.\pipe\termlive`
	}
	return filepath.Join(dir, "daemon.sock")
}

func defaultPidPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".termlive", "daemon.pid")
}

var daemonCmd = &cobra.Command{
	Use:   "daemon",
	Short: "Manage the TermLive background daemon",
}

var daemonStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the TermLive daemon",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg := config.Default()
		cfg.Server.Port = port

		socketPath := defaultSocketPath()
		pidPath := defaultPidPath()

		// Check if already running
		if pidData, err := os.ReadFile(pidPath); err == nil {
			pid, _ := strconv.Atoi(string(pidData))
			if pid > 0 {
				if proc, err := os.FindProcess(pid); err == nil {
					// On Unix, FindProcess always succeeds. Try signal 0 to check.
					if runtime.GOOS != "windows" {
						if proc.Signal(nil) == nil {
							// Verify socket is responsive
							conn, err := daemon.DialSocket(socketPath)
							if err == nil {
								conn.Close()
								return fmt.Errorf("daemon already running (pid %d)", pid)
							}
						}
					} else {
						conn, err := daemon.DialSocket(socketPath)
						if err == nil {
							conn.Close()
							return fmt.Errorf("daemon already running (pid %d)", pid)
						}
					}
				}
			}
		}

		d := daemon.NewDaemon(daemon.DaemonConfig{
			SocketPath: socketPath,
			Port:       cfg.Server.Port,
		})

		// Write PID file
		os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0600)
		defer os.Remove(pidPath)

		fmt.Fprintf(os.Stderr, "  TermLive daemon started (pid %d)\n", os.Getpid())
		fmt.Fprintf(os.Stderr, "  Socket: %s\n", socketPath)
		fmt.Fprintf(os.Stderr, "  Port: %d\n\n", cfg.Server.Port)

		return d.Run()
	},
}

var daemonStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the TermLive daemon",
	RunE: func(cmd *cobra.Command, args []string) error {
		pidPath := defaultPidPath()
		pidData, err := os.ReadFile(pidPath)
		if err != nil {
			return fmt.Errorf("daemon not running (no pid file)")
		}
		pid, err := strconv.Atoi(string(pidData))
		if err != nil {
			return fmt.Errorf("invalid pid file")
		}

		proc, err := os.FindProcess(pid)
		if err != nil {
			return fmt.Errorf("daemon process not found: %w", err)
		}

		if err := proc.Signal(os.Interrupt); err != nil {
			return fmt.Errorf("failed to stop daemon: %w", err)
		}

		// Wait briefly for cleanup
		time.Sleep(500 * time.Millisecond)
		os.Remove(pidPath)
		fmt.Fprintf(os.Stderr, "  Daemon stopped (pid %d)\n", pid)
		return nil
	},
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List active sessions",
	Aliases: []string{"ls"},
	RunE: func(cmd *cobra.Command, args []string) error {
		socketPath := defaultSocketPath()
		conn, err := daemon.DialSocket(socketPath)
		if err != nil {
			return fmt.Errorf("cannot connect to daemon — is it running? (tlive daemon start)")
		}
		defer conn.Close()

		req := &daemon.RPCRequest{Method: daemon.MethodList, ID: 1}
		encoder := json.NewEncoder(conn)
		decoder := json.NewDecoder(conn)

		if err := encoder.Encode(req); err != nil {
			return fmt.Errorf("failed to send request: %w", err)
		}

		var resp daemon.RPCResponse
		if err := decoder.Decode(&resp); err != nil {
			return fmt.Errorf("failed to read response: %w", err)
		}
		if resp.Error != nil {
			return fmt.Errorf("daemon error: %s", resp.Error.Message)
		}

		var result daemon.ListResult
		if err := json.Unmarshal(resp.Result, &result); err != nil {
			return fmt.Errorf("failed to parse response: %w", err)
		}

		if len(result.Sessions) == 0 {
			fmt.Fprintln(os.Stderr, "  No active sessions")
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tCOMMAND\tPID\tSTATUS\tDURATION")
		for _, s := range result.Sessions {
			fmt.Fprintf(w, "%s\t%s\t%d\t%s\t%s\n", s.ID, s.Command, s.Pid, s.Status, s.Duration)
		}
		w.Flush()
		return nil
	},
}

func init() {
	daemonCmd.AddCommand(daemonStartCmd)
	daemonCmd.AddCommand(daemonStopCmd)
}
```

**Step 2: Update main.go to register new commands**

```go
// cmd/tlive/main.go — add daemon and list subcommands
// In init(), add:
//   rootCmd.AddCommand(daemonCmd)
//   rootCmd.AddCommand(listCmd)
```

Modify `cmd/tlive/main.go` init():
```go
func init() {
	rootCmd.Flags().IntVarP(&port, "port", "p", 8080, "Web server port")
	rootCmd.Flags().IntVarP(&shortTimeout, "short-timeout", "s", 30, "Short idle timeout for detected prompts (seconds)")
	rootCmd.Flags().IntVarP(&longTimeout, "long-timeout", "l", 120, "Long idle timeout for unknown idle (seconds)")
	rootCmd.Flags().StringVar(&publicIP, "ip", "", "Override auto-detected LAN IP address")

	rootCmd.AddCommand(daemonCmd)
	rootCmd.AddCommand(listCmd)
}
```

**Step 3: Export DialSocket from daemon package**

Add to `internal/daemon/socket.go`:
```go
// DialSocket connects to the daemon socket (exported for CLI use).
func DialSocket(path string) (net.Conn, error) {
	return dialSocket(path)
}
```

**Step 4: Build and verify**

Run: `go build ./cmd/tlive`
Expected: SUCCESS

Run: `./tlive daemon --help`
Expected: Shows "start" and "stop" subcommands

Run: `./tlive list --help`
Expected: Shows list command help

**Step 5: Commit**

```bash
git add cmd/tlive/daemon_cmd.go cmd/tlive/main.go internal/daemon/socket.go
git commit -m "feat: add daemon start/stop and list CLI commands"
```

---

### Task 6: Add HTTP server to daemon

**Files:**
- Modify: `internal/daemon/daemon.go`

**Step 1: Add HTTP server startup to daemon Run()**

The daemon needs to serve the Web UI and WebSocket connections, same as `run.go` does now but long-lived. Add HTTP server creation and startup to the Daemon, using the SessionManager's Store and Hubs.

Key changes to `daemon.go`:
- Import `net/http` and `github.com/termlive/termlive/internal/server` and `github.com/termlive/termlive/web`
- Add `token` field to Daemon
- In `Run()`, start HTTP server before IPC listener
- In `Stop()`, shutdown HTTP server gracefully
- Add `Token()` method for CLI to display URLs

```go
// Add to DaemonConfig:
type DaemonConfig struct {
	SocketPath string
	Port       int
	Token      string // If empty, auto-generated
}

// Add to Daemon struct:
type Daemon struct {
	// ... existing fields ...
	httpServer *http.Server
	token      string
}

// In NewDaemon, generate token if not provided
// In Run(), before IPC listener:
//   srv := server.New(d.mgr.Store(), d.mgr.Hubs(), d.token)
//   srv.SetWebFS(web.Assets)
//   d.httpServer = &http.Server{Addr: fmt.Sprintf(":%d", d.cfg.Port), Handler: srv.Handler()}
//   go d.httpServer.ListenAndServe()
// In Stop():
//   ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
//   defer cancel()
//   d.httpServer.Shutdown(ctx)
```

**Step 2: Build and verify**

Run: `go build ./cmd/tlive`
Expected: SUCCESS

**Step 3: Run all tests**

Run: `go test ./... -v -timeout 60s`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add internal/daemon/daemon.go
git commit -m "feat: add HTTP server to daemon for Web UI"
```

---

## Phase 3: Attach

**Goal:** Add `tlive attach` command that connects a local terminal to a daemon session with full read/write I/O.

### Task 7: Add attach streaming to daemon IPC

**Files:**
- Modify: `internal/daemon/daemon.go`

The attach RPC is special — after the initial handshake, the connection becomes a bidirectional byte stream (not JSON-RPC). The daemon registers the connection as a hub client and forwards PTY output. Input from the connection is written to the PTY.

**Step 1: Add attach handler to daemon**

```go
// In daemon.go handleRPC, add case MethodAttach — but attach is special:
// After sending the initial RPCResponse, switch the conn to raw stream mode.
// The conn becomes a hub.Client that receives broadcast data, and reads from
// conn are forwarded to the PTY.

func (d *Daemon) handleAttach(conn net.Conn, req *RPCRequest) {
	var params AttachParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		resp := &RPCResponse{ID: req.ID, Error: &RPCError{Code: -1, Message: err.Error()}}
		json.NewEncoder(conn).Encode(resp)
		return
	}

	sessionID := params.SessionID
	if sessionID == "" {
		// Default to most recent session
		sessions := d.mgr.ListSessions()
		if len(sessions) == 0 {
			resp := &RPCResponse{ID: req.ID, Error: &RPCError{Code: -1, Message: "no active sessions"}}
			json.NewEncoder(conn).Encode(resp)
			return
		}
		sessionID = sessions[len(sessions)-1].ID
	}

	ms, ok := d.mgr.GetSession(sessionID)
	if !ok {
		resp := &RPCResponse{ID: req.ID, Error: &RPCError{Code: -1, Message: "session not found"}}
		json.NewEncoder(conn).Encode(resp)
		return
	}

	// Send success response with session info
	result, _ := json.Marshal(RunResult{SessionID: sessionID})
	json.NewEncoder(conn).Encode(&RPCResponse{ID: req.ID, Result: result})

	// Replay recent output
	if recent := ms.Session.LastOutput(4096); len(recent) > 0 {
		conn.Write(recent)
	}

	// Register as hub client
	client := &connClient{conn: conn}
	ms.Hub.Register(client)
	defer ms.Hub.Unregister(client)

	// Forward input from conn to PTY
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			ms.Proc.Write(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// connClient implements hub.Client for a net.Conn
type connClient struct {
	conn net.Conn
	mu   sync.Mutex
}

func (c *connClient) Send(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.conn.Write(data)
	return err
}
```

Modify `handleConn` to detect attach method and switch to streaming:
```go
func (d *Daemon) handleConn(conn net.Conn) {
	defer conn.Close()
	decoder := json.NewDecoder(conn)

	var req RPCRequest
	if err := decoder.Decode(&req); err != nil {
		return
	}

	if req.Method == MethodAttach {
		d.handleAttach(conn, &req)
		return
	}

	// Normal RPC: encode response and continue reading
	encoder := json.NewEncoder(conn)
	resp := d.handleRPC(&req)
	if err := encoder.Encode(resp); err != nil {
		return
	}

	// Continue handling more requests on same connection
	for {
		if err := decoder.Decode(&req); err != nil {
			return
		}
		resp := d.handleRPC(&req)
		if err := encoder.Encode(resp); err != nil {
			return
		}
	}
}
```

**Step 2: Commit**

```bash
git add internal/daemon/daemon.go
git commit -m "feat: add attach streaming handler to daemon"
```

---

### Task 8: Create tlive attach CLI command

**Files:**
- Create: `cmd/tlive/attach_cmd.go`
- Modify: `cmd/tlive/main.go`

**Step 1: Implement attach command**

```go
// cmd/tlive/attach_cmd.go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"
	"github.com/termlive/termlive/internal/daemon"
	"golang.org/x/term"
)

var attachCmd = &cobra.Command{
	Use:   "attach [session-id]",
	Short: "Attach to a daemon session",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		socketPath := defaultSocketPath()
		conn, err := daemon.DialSocket(socketPath)
		if err != nil {
			return fmt.Errorf("cannot connect to daemon — is it running? (tlive daemon start)")
		}
		defer conn.Close()

		// Build attach request
		sessionID := ""
		if len(args) > 0 {
			sessionID = args[0]
		}

		params, _ := json.Marshal(daemon.AttachParams{SessionID: sessionID})
		req := &daemon.RPCRequest{Method: daemon.MethodAttach, ID: 1, Params: params}

		encoder := json.NewEncoder(conn)
		if err := encoder.Encode(req); err != nil {
			return fmt.Errorf("failed to send attach request: %w", err)
		}

		// Read initial response
		decoder := json.NewDecoder(conn)
		var resp daemon.RPCResponse
		if err := decoder.Decode(&resp); err != nil {
			return fmt.Errorf("failed to read response: %w", err)
		}
		if resp.Error != nil {
			return fmt.Errorf("attach failed: %s", resp.Error.Message)
		}

		var result daemon.RunResult
		json.Unmarshal(resp.Result, &result)
		fmt.Fprintf(os.Stderr, "  Attached to session %s\n", result.SessionID)
		fmt.Fprintf(os.Stderr, "  (Press Ctrl+\\ to detach)\n\n")

		// Set terminal to raw mode
		oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
		if err != nil {
			return fmt.Errorf("failed to set raw mode: %w", err)
		}
		defer term.Restore(int(os.Stdin.Fd()), oldState)

		// Also restore on signal
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			<-sigCh
			term.Restore(int(os.Stdin.Fd()), oldState)
			os.Exit(0)
		}()

		// conn is now a raw byte stream after the JSON handshake.
		// However, the decoder may have buffered data. Read from decoder's Buffered() first.

		// PTY output from daemon -> local stdout
		go func() {
			// First drain any buffered data from the JSON decoder
			if decoder.Buffered().Len() > 0 {
				buf := make([]byte, decoder.Buffered().Len())
				n, _ := decoder.Buffered().Read(buf)
				if n > 0 {
					os.Stdout.Write(buf[:n])
				}
			}
			// Then read directly from conn
			buf := make([]byte, 4096)
			for {
				n, err := conn.Read(buf)
				if n > 0 {
					os.Stdout.Write(buf[:n])
				}
				if err != nil {
					return
				}
			}
		}()

		// Local stdin -> daemon -> PTY
		buf := make([]byte, 1024)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				// Check for detach key (Ctrl+\, byte 0x1c)
				for i := 0; i < n; i++ {
					if buf[i] == 0x1c {
						fmt.Fprintf(os.Stderr, "\n  Detached from session %s\n", result.SessionID)
						return nil
					}
				}
				conn.Write(buf[:n])
			}
			if err != nil {
				return nil
			}
		}
	},
}
```

**Step 2: Register in main.go**

Add to `init()`: `rootCmd.AddCommand(attachCmd)`

**Step 3: Build and verify**

Run: `go build ./cmd/tlive`
Expected: SUCCESS

Run: `./tlive attach --help`
Expected: Shows attach command help

**Step 4: Commit**

```bash
git add cmd/tlive/attach_cmd.go cmd/tlive/main.go
git commit -m "feat: add tlive attach command for session connection"
```

---

## Phase 4: Shell + Init

### Task 9: Add tlive shell command

**Files:**
- Create: `cmd/tlive/shell_cmd.go`
- Modify: `cmd/tlive/main.go`

**Step 1: Implement shell command**

```go
// cmd/tlive/shell_cmd.go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"

	"github.com/spf13/cobra"
	"github.com/termlive/termlive/internal/daemon"
	"golang.org/x/term"
)

var shellCmd = &cobra.Command{
	Use:   "shell",
	Short: "Start a monitored shell in the daemon",
	RunE: func(cmd *cobra.Command, args []string) error {
		// Prevent recursive wrapping
		if os.Getenv("TERMLIVE_ACTIVE") == "1" {
			return fmt.Errorf("already inside a TermLive session (TERMLIVE_ACTIVE=1)")
		}

		socketPath := defaultSocketPath()
		conn, err := daemon.DialSocket(socketPath)
		if err != nil {
			return fmt.Errorf("cannot connect to daemon — is it running? (tlive daemon start)")
		}
		defer conn.Close()

		// Detect shell
		shell := os.Getenv("SHELL")
		if shell == "" {
			if runtime.GOOS == "windows" {
				shell = "cmd.exe"
			} else {
				shell = "/bin/sh"
			}
		}

		// Detect terminal size
		rows, cols := uint16(24), uint16(80)
		if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
			cols, rows = uint16(w), uint16(h)
		}

		// Request daemon to start shell
		params, _ := json.Marshal(daemon.RunParams{
			Cmd:  shell,
			Rows: rows,
			Cols: cols,
		})
		req := &daemon.RPCRequest{Method: daemon.MethodRun, ID: 1, Params: params}
		encoder := json.NewEncoder(conn)
		decoder := json.NewDecoder(conn)

		if err := encoder.Encode(req); err != nil {
			return err
		}

		var resp daemon.RPCResponse
		if err := decoder.Decode(&resp); err != nil {
			return err
		}
		if resp.Error != nil {
			return fmt.Errorf("failed to start shell: %s", resp.Error.Message)
		}

		var result daemon.RunResult
		json.Unmarshal(resp.Result, &result)
		conn.Close()

		fmt.Fprintf(os.Stderr, "  Shell session created: %s\n", result.SessionID)
		fmt.Fprintf(os.Stderr, "  Attaching...\n\n")

		// Now attach to the shell session (reuse attach logic)
		return runAttach(result.SessionID)
	},
}

// runAttach connects to a daemon session (extracted from attachCmd for reuse).
func runAttach(sessionID string) error {
	// This duplicates attach logic — in production, extract to shared function.
	// For now, call the attach command's RunE directly.
	return attachCmd.RunE(attachCmd, []string{sessionID})
}
```

**Step 2: Register in main.go**

Add to `init()`: `rootCmd.AddCommand(shellCmd)`

**Step 3: Add TERMLIVE_ACTIVE env var to daemon session creation**

In `internal/daemon/manager.go` CreateSession, the PTY process should inherit the environment. For `tlive shell`, the daemon should set `TERMLIVE_ACTIVE=1` in the child process environment. This requires passing environment variables through SessionConfig:

```go
// Add to SessionConfig:
type SessionConfig struct {
	Rows uint16
	Cols uint16
	Env  []string // Additional environment variables
}
```

In `pty.Start()` on both platforms, the child process already inherits `os.Environ()`. We need to propagate extra env vars. This may require modifying the pty.Start signature or setting env vars on the daemon process before starting the PTY. The simplest approach: set `TERMLIVE_ACTIVE=1` on the daemon process itself, so all child processes inherit it.

In `daemon.go` Run(), add:
```go
os.Setenv("TERMLIVE_ACTIVE", "1")
```

**Step 4: Build and verify**

Run: `go build ./cmd/tlive`
Expected: SUCCESS

**Step 5: Commit**

```bash
git add cmd/tlive/shell_cmd.go cmd/tlive/main.go internal/daemon/manager.go internal/daemon/daemon.go
git commit -m "feat: add tlive shell command for monitored shell sessions"
```

---

### Task 10: Add tlive init command

**Files:**
- Create: `cmd/tlive/init_cmd.go`
- Modify: `cmd/tlive/main.go`

**Step 1: Implement init command**

```go
// cmd/tlive/init_cmd.go
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

var initCommands []string

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Configure shell aliases for auto-wrapping commands",
	Long:  "Generates shell configuration that auto-wraps specified commands with TermLive.",
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(initCommands) == 0 {
			initCommands = []string{"claude", "aider"}
		}

		shell := detectShell()

		switch shell {
		case "bash", "zsh":
			return generatePosixConfig(initCommands, shell)
		case "powershell":
			return generatePowershellConfig(initCommands)
		default:
			return fmt.Errorf("unsupported shell: %s", shell)
		}
	},
}

func detectShell() string {
	if runtime.GOOS == "windows" {
		return "powershell"
	}
	sh := os.Getenv("SHELL")
	if strings.Contains(sh, "zsh") {
		return "zsh"
	}
	return "bash"
}

func generatePosixConfig(commands []string, shell string) error {
	var rcFile string
	home, _ := os.UserHomeDir()
	if shell == "zsh" {
		rcFile = filepath.Join(home, ".zshrc")
	} else {
		rcFile = filepath.Join(home, ".bashrc")
	}

	var sb strings.Builder
	sb.WriteString("\n# TermLive auto-wrap configuration\n")
	for _, cmd := range commands {
		sb.WriteString(fmt.Sprintf(`%s() {
    if [ -n "$TERMLIVE_ACTIVE" ]; then
        command %s "$@"
    else
        tlive run %s "$@"
    fi
}
`, cmd, cmd, cmd))
	}

	fmt.Fprintf(os.Stderr, "  Add the following to %s:\n\n", rcFile)
	fmt.Println(sb.String())
	fmt.Fprintf(os.Stderr, "  Or run: echo '%s' >> %s\n", strings.TrimSpace(sb.String()), rcFile)
	return nil
}

func generatePowershellConfig(commands []string) error {
	var sb strings.Builder
	sb.WriteString("\n# TermLive auto-wrap configuration\n")
	for _, cmd := range commands {
		sb.WriteString(fmt.Sprintf(`function %s {
    if ($env:TERMLIVE_ACTIVE -eq "1") {
        & (Get-Command -CommandType Application %s) @args
    } else {
        tlive run %s @args
    }
}
`, cmd, cmd, cmd))
	}

	profile := "$PROFILE"
	fmt.Fprintf(os.Stderr, "  Add the following to your PowerShell profile (%s):\n\n", profile)
	fmt.Println(sb.String())
	return nil
}

func init() {
	initCmd.Flags().StringSliceVar(&initCommands, "commands", nil, "Commands to auto-wrap (default: claude,aider)")
}
```

**Step 2: Register in main.go**

Add to `init()`: `rootCmd.AddCommand(initCmd)`

**Step 3: Build and verify**

Run: `go build ./cmd/tlive`
Expected: SUCCESS

Run: `./tlive init --help`
Expected: Shows init command help with --commands flag

Run: `./tlive init --commands claude,aider`
Expected: Prints shell configuration to stdout

**Step 4: Commit**

```bash
git add cmd/tlive/init_cmd.go cmd/tlive/main.go
git commit -m "feat: add tlive init command for shell alias generation"
```

---

## Phase 5: Integration & Polish

### Task 11: Update run command to use daemon when available

**Files:**
- Modify: `cmd/tlive/run.go`

Currently `tlive <cmd>` runs standalone. It should also work as `tlive run <cmd>` which creates a session in the daemon and attaches. The old standalone mode becomes a fallback.

**Step 1: Add `run` subcommand that delegates to daemon**

Create a new `runDaemonCmd` that:
1. Connects to daemon socket
2. Sends "run" RPC
3. Attaches to the created session

Keep the existing `rootCmd.RunE = runCommand` as the standalone fallback.

```go
// cmd/tlive/run_cmd.go
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/termlive/termlive/internal/daemon"
	"golang.org/x/term"
)

var runDaemonCmd = &cobra.Command{
	Use:   "run [command] [args...]",
	Short: "Run a command in a daemon session",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		socketPath := defaultSocketPath()
		conn, err := daemon.DialSocket(socketPath)
		if err != nil {
			return fmt.Errorf("cannot connect to daemon — is it running? (tlive daemon start)")
		}
		defer conn.Close()

		rows, cols := uint16(24), uint16(80)
		if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
			cols, rows = uint16(w), uint16(h)
		}

		params, _ := json.Marshal(daemon.RunParams{
			Cmd:  args[0],
			Args: args[1:],
			Rows: rows,
			Cols: cols,
		})
		req := &daemon.RPCRequest{Method: daemon.MethodRun, ID: 1, Params: params}

		encoder := json.NewEncoder(conn)
		decoder := json.NewDecoder(conn)

		if err := encoder.Encode(req); err != nil {
			return err
		}

		var resp daemon.RPCResponse
		if err := decoder.Decode(&resp); err != nil {
			return err
		}
		if resp.Error != nil {
			return fmt.Errorf("failed to start: %s", resp.Error.Message)
		}

		var result daemon.RunResult
		json.Unmarshal(resp.Result, &result)
		conn.Close()

		fmt.Fprintf(os.Stderr, "  Session created: %s\n", result.SessionID)

		return attachCmd.RunE(attachCmd, []string{result.SessionID})
	},
}
```

Register: `rootCmd.AddCommand(runDaemonCmd)`

**Step 2: Build and verify**

Run: `go build ./cmd/tlive`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add cmd/tlive/run_cmd.go cmd/tlive/main.go
git commit -m "feat: add tlive run command for daemon-managed sessions"
```

---

### Task 12: Final integration test and cleanup

**Step 1: Run all tests**

Run: `go test ./... -v -timeout 60s`
Expected: ALL PASS

**Step 2: Build final binary**

Run: `go build -o tlive.exe ./cmd/tlive`
Expected: SUCCESS

**Step 3: Verify command help**

Run: `./tlive --help`
Expected: Shows all commands: daemon, run, attach, list, shell, init, plus the original positional arg mode

**Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: final integration cleanup for daemon architecture"
```

---

## Summary of New Files

| File | Purpose |
|------|---------|
| `internal/daemon/manager.go` | SessionManager — creates/tracks/stops sessions |
| `internal/daemon/manager_test.go` | Tests for SessionManager |
| `internal/daemon/ipc.go` | JSON-RPC types and method constants |
| `internal/daemon/ipc_test.go` | Tests for RPC types |
| `internal/daemon/daemon.go` | Daemon — IPC listener + RPC handlers + HTTP server |
| `internal/daemon/daemon_test.go` | Tests for Daemon start/stop/RPC |
| `internal/daemon/socket.go` | Cross-platform socket helpers |
| `internal/daemon/socket_windows.go` | Windows Named Pipe implementation |
| `internal/daemon/socket_unix.go` | Unix socket implementation |
| `cmd/tlive/daemon_cmd.go` | `tlive daemon start/stop` + `tlive list` |
| `cmd/tlive/attach_cmd.go` | `tlive attach` command |
| `cmd/tlive/shell_cmd.go` | `tlive shell` command |
| `cmd/tlive/init_cmd.go` | `tlive init` command |
| `cmd/tlive/run_cmd.go` | `tlive run` command (daemon mode) |

## Modified Files

| File | Change |
|------|--------|
| `cmd/tlive/main.go` | Register new subcommands |
| `cmd/tlive/run.go` | Use SessionManager, add localOutputClient |
