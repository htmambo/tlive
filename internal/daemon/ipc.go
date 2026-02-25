package daemon

import "encoding/json"

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

// Method constants
const (
	MethodRun    = "run"
	MethodAttach = "attach"
	MethodList   = "list"
	MethodStop   = "stop"
	MethodResize = "resize"
)

// Param/Result types for each method

// RunParams contains parameters for the "run" method.
type RunParams struct {
	Cmd  string   `json:"cmd"`
	Args []string `json:"args"`
	Rows uint16   `json:"rows"`
	Cols uint16   `json:"cols"`
}

// RunResult contains the result for the "run" method.
type RunResult struct {
	SessionID string `json:"session_id"`
}

// AttachParams contains parameters for the "attach" method.
type AttachParams struct {
	SessionID string `json:"session_id"`
}

// ListResult contains the result for the "list" method.
type ListResult struct {
	Sessions []SessionInfo `json:"sessions"`
}

// SessionInfo describes a single session in a list result.
type SessionInfo struct {
	ID         string `json:"id"`
	Command    string `json:"command"`
	Pid        int    `json:"pid"`
	Status     string `json:"status"`
	Duration   string `json:"duration"`
	LastOutput string `json:"last_output"`
}

// StopParams contains parameters for the "stop" method.
type StopParams struct {
	SessionID string `json:"session_id"`
}

// ResizeParams contains parameters for the "resize" method.
type ResizeParams struct {
	SessionID string `json:"session_id"`
	Rows      uint16 `json:"rows"`
	Cols      uint16 `json:"cols"`
}
