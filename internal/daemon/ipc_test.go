package daemon

import (
	"encoding/json"
	"testing"
)

func TestRPCRequestMarshal(t *testing.T) {
	params, _ := json.Marshal(RunParams{
		Cmd:  "bash",
		Args: []string{"-l"},
		Rows: 24,
		Cols: 80,
	})

	req := RPCRequest{
		Method: MethodRun,
		ID:     1,
		Params: params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal RPCRequest: %v", err)
	}

	var decoded RPCRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal RPCRequest: %v", err)
	}

	if decoded.Method != MethodRun {
		t.Errorf("method: got %q, want %q", decoded.Method, MethodRun)
	}
	if decoded.ID != 1 {
		t.Errorf("id: got %d, want 1", decoded.ID)
	}
}

func TestRPCResponseMarshal(t *testing.T) {
	result, _ := json.Marshal(RunResult{SessionID: "abc-123"})

	resp := RPCResponse{
		ID:     1,
		Result: result,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal RPCResponse: %v", err)
	}

	var decoded RPCResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal RPCResponse: %v", err)
	}

	if decoded.ID != 1 {
		t.Errorf("id: got %d, want 1", decoded.ID)
	}
	if decoded.Error != nil {
		t.Errorf("error: got %+v, want nil", decoded.Error)
	}

	var rr RunResult
	if err := json.Unmarshal(decoded.Result, &rr); err != nil {
		t.Fatalf("unmarshal RunResult: %v", err)
	}
	if rr.SessionID != "abc-123" {
		t.Errorf("session_id: got %q, want %q", rr.SessionID, "abc-123")
	}
}

func TestRPCResponseError(t *testing.T) {
	resp := RPCResponse{
		ID: 2,
		Error: &RPCError{
			Code:    -1,
			Message: "session not found",
		},
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal RPCResponse: %v", err)
	}

	var decoded RPCResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal RPCResponse: %v", err)
	}

	if decoded.Error == nil {
		t.Fatal("error: got nil, want non-nil")
	}
	if decoded.Error.Message != "session not found" {
		t.Errorf("error.message: got %q, want %q", decoded.Error.Message, "session not found")
	}
	if decoded.Error.Code != -1 {
		t.Errorf("error.code: got %d, want -1", decoded.Error.Code)
	}
}
