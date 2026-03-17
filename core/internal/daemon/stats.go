package daemon

import "sync"

// Stats accumulates token usage and cost data reported by the Node.js Bridge.
type Stats struct {
	mu           sync.RWMutex
	InputTokens  int64   `json:"input_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	CostUSD      float64 `json:"cost_usd"`
	RequestCount int64   `json:"request_count"`
}

// StatsResponse is a snapshot of accumulated stats, safe to send as JSON.
type StatsResponse struct {
	InputTokens  int64   `json:"input_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	CostUSD      float64 `json:"cost_usd"`
	RequestCount int64   `json:"request_count"`
}

// NewStats creates a new Stats accumulator with zeroed counters.
func NewStats() *Stats {
	return &Stats{}
}

// Add accumulates token usage and cost in a thread-safe manner.
// Each call increments RequestCount by 1.
func (s *Stats) Add(input, output int64, cost float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InputTokens += input
	s.OutputTokens += output
	s.CostUSD += cost
	s.RequestCount++
}

// Get returns a snapshot of the current accumulated stats.
func (s *Stats) Get() StatsResponse {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return StatsResponse{
		InputTokens:  s.InputTokens,
		OutputTokens: s.OutputTokens,
		CostUSD:      s.CostUSD,
		RequestCount: s.RequestCount,
	}
}
