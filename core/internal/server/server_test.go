package server

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/termlive/termlive/core/internal/daemon"
)

func testCommand() (string, []string) {
	if runtime.GOOS == "windows" {
		return "cmd.exe", []string{"/C", "echo hello"}
	}
	return "echo", []string{"hello"}
}

func TestWebSocketConnection(t *testing.T) {
	mgr := daemon.NewSessionManager()
	cmd, args := testCommand()
	ms, err := mgr.CreateSession(cmd, args, daemon.SessionConfig{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.StopSession(ms.Session.ID)

	srv := New(mgr)
	server := httptest.NewServer(srv.Handler())
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/session/" + ms.Session.ID
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	ms.Hub.Broadcast([]byte("hello from pty"))
	// Drain messages until we find the expected one; the session may replay
	// buffered PTY output (e.g. "hello\r\n") before our broadcast arrives.
	deadline := time.Now().Add(2 * time.Second)
	for {
		ws.SetReadDeadline(deadline)
		_, msg, err := ws.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if string(msg) == "hello from pty" {
			return
		}
	}
}

func TestWebSocketRouting_Session(t *testing.T) {
	mgr := daemon.NewSessionManager()
	cmd, args := testCommand()
	ms, err := mgr.CreateSession(cmd, args, daemon.SessionConfig{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.StopSession(ms.Session.ID)

	srv := New(mgr)
	server := httptest.NewServer(srv.Handler())
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/session/" + ms.Session.ID
	ws, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("expected successful WebSocket upgrade for /ws/session/<id>, got error: %v (resp: %v)", err, resp)
	}
	defer ws.Close()

	// Verify we get output — broadcast something and read it back.
	// Drain any replayed PTY output before checking for our broadcast.
	ms.Hub.Broadcast([]byte("routing test"))
	deadline := time.Now().Add(2 * time.Second)
	for {
		ws.SetReadDeadline(deadline)
		_, msg, err := ws.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if string(msg) == "routing test" {
			return
		}
	}
}

func TestWebSocketRouting_Status(t *testing.T) {
	mgr := daemon.NewSessionManager()
	srv := New(mgr)
	server := httptest.NewServer(srv.Handler())
	defer server.Close()

	// /ws/status should return 501 Not Implemented (stub), not upgrade to WebSocket.
	resp, err := http.Get(strings.Replace(server.URL, "http", "http", 1) + "/ws/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotImplemented {
		t.Errorf("expected 501 Not Implemented for /ws/status, got %d", resp.StatusCode)
	}
}

func TestWebSocketRouting_Unknown(t *testing.T) {
	mgr := daemon.NewSessionManager()
	srv := New(mgr)
	server := httptest.NewServer(srv.Handler())
	defer server.Close()

	// /ws/random should return 404 — no handler registered for it.
	resp, err := http.Get(server.URL + "/ws/random")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 Not Found for /ws/random, got %d", resp.StatusCode)
	}
}
