package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- Stats unit tests ---

func TestStats_Add(t *testing.T) {
	s := NewStats()
	s.Add(100, 50, 0.01)

	got := s.Get()
	if got.InputTokens != 100 {
		t.Errorf("expected InputTokens=100, got %d", got.InputTokens)
	}
	if got.OutputTokens != 50 {
		t.Errorf("expected OutputTokens=50, got %d", got.OutputTokens)
	}
	if got.CostUSD != 0.01 {
		t.Errorf("expected CostUSD=0.01, got %f", got.CostUSD)
	}
	if got.RequestCount != 1 {
		t.Errorf("expected RequestCount=1, got %d", got.RequestCount)
	}
}

func TestStats_Get(t *testing.T) {
	s := NewStats()

	// Initially zero
	got := s.Get()
	if got.InputTokens != 0 {
		t.Errorf("expected InputTokens=0 initially, got %d", got.InputTokens)
	}
	if got.OutputTokens != 0 {
		t.Errorf("expected OutputTokens=0 initially, got %d", got.OutputTokens)
	}
	if got.CostUSD != 0.0 {
		t.Errorf("expected CostUSD=0.0 initially, got %f", got.CostUSD)
	}
	if got.RequestCount != 0 {
		t.Errorf("expected RequestCount=0 initially, got %d", got.RequestCount)
	}

	// After adding, Get returns updated values
	s.Add(200, 100, 0.02)
	got = s.Get()
	if got.InputTokens != 200 {
		t.Errorf("expected InputTokens=200 after Add, got %d", got.InputTokens)
	}
}

func TestStats_MultipleAdds(t *testing.T) {
	s := NewStats()

	s.Add(100, 50, 0.01)
	s.Add(200, 100, 0.02)
	s.Add(300, 150, 0.03)

	got := s.Get()
	if got.InputTokens != 600 {
		t.Errorf("expected InputTokens=600, got %d", got.InputTokens)
	}
	if got.OutputTokens != 300 {
		t.Errorf("expected OutputTokens=300, got %d", got.OutputTokens)
	}
	// Use approximate comparison for floating point
	if got.CostUSD < 0.059 || got.CostUSD > 0.061 {
		t.Errorf("expected CostUSD≈0.06, got %f", got.CostUSD)
	}
	if got.RequestCount != 3 {
		t.Errorf("expected RequestCount=3, got %d", got.RequestCount)
	}
}

// --- HTTP endpoint tests ---

func TestStatsAPI_Post(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "test-token"})
	handler := d.Handler()

	body := `{"input_tokens":100,"output_tokens":50,"cost_usd":0.01}`
	req := httptest.NewRequest("POST", "/api/stats", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify stats were accumulated
	got := d.stats.Get()
	if got.InputTokens != 100 {
		t.Errorf("expected InputTokens=100, got %d", got.InputTokens)
	}
	if got.OutputTokens != 50 {
		t.Errorf("expected OutputTokens=50, got %d", got.OutputTokens)
	}
	if got.RequestCount != 1 {
		t.Errorf("expected RequestCount=1, got %d", got.RequestCount)
	}
}

func TestStatsAPI_Get(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "test-token"})
	handler := d.Handler()

	// Add some stats first via POST
	postBody := `{"input_tokens":100,"output_tokens":50,"cost_usd":0.01}`
	postReq := httptest.NewRequest("POST", "/api/stats", strings.NewReader(postBody))
	postReq.Header.Set("Authorization", "Bearer test-token")
	postReq.Header.Set("Content-Type", "application/json")
	postW := httptest.NewRecorder()
	handler.ServeHTTP(postW, postReq)
	if postW.Code != http.StatusOK {
		t.Fatalf("POST /api/stats returned %d: %s", postW.Code, postW.Body.String())
	}

	// GET /api/stats and verify accumulated JSON
	req := httptest.NewRequest("GET", "/api/stats", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp StatsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.InputTokens != 100 {
		t.Errorf("expected InputTokens=100, got %d", resp.InputTokens)
	}
	if resp.OutputTokens != 50 {
		t.Errorf("expected OutputTokens=50, got %d", resp.OutputTokens)
	}
	if resp.CostUSD != 0.01 {
		t.Errorf("expected CostUSD=0.01, got %f", resp.CostUSD)
	}
	if resp.RequestCount != 1 {
		t.Errorf("expected RequestCount=1, got %d", resp.RequestCount)
	}
}
