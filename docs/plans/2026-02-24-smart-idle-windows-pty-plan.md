# Smart Idle Detection + Windows PTY Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace naive idle timeout with output-pattern-based classification to reduce false notifications, and add real Windows PTY support via ConPTY.

**Architecture:** New `OutputClassifier` strips ANSI codes and matches terminal output against configurable prompt/processing patterns. `SmartIdleDetector` replaces `IdleDetector`, using classification results to pick short (30s) or long (120s) timeouts. Windows PTY uses `conpty` library wrapping the ConPTY API.

**Tech Stack:** Go regexp, `github.com/UserExistsError/conpty` (Windows PTY)

**Design doc:** `docs/plans/2026-02-24-smart-idle-windows-pty-design.md`

---

### Task 1: ANSI Stripping Utility (TDD)

**Files:**
- Create: `internal/notify/ansi.go`
- Create: `internal/notify/ansi_test.go`

**Step 1: Write the failing test**

```go
// internal/notify/ansi_test.go
package notify

import "testing"

func TestStripANSI(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"plain text", "hello world", "hello world"},
		{"color code", "\x1b[32mgreen\x1b[0m", "green"},
		{"cursor move", "\x1b[2J\x1b[H", ""},
		{"bold text", "\x1b[1mbold\x1b[0m text", "bold text"},
		{"256 color", "\x1b[38;5;196mred\x1b[0m", "red"},
		{"rgb color", "\x1b[38;2;255;0;0mred\x1b[0m", "red"},
		{"mixed", "\x1b[1;32m? \x1b[0mDo you want? \x1b[36m[Y/n]\x1b[0m", "? Do you want? [Y/n]"},
		{"OSC title", "\x1b]0;window title\x07rest", "rest"},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := StripANSI(tt.input)
			if got != tt.want {
				t.Errorf("StripANSI(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestLastVisibleLine(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"single line", "hello", "hello"},
		{"multi line", "line1\nline2\nline3", "line3"},
		{"trailing newline", "line1\nline2\n", "line2"},
		{"with ansi", "line1\n\x1b[32m? prompt\x1b[0m", "? prompt"},
		{"empty", "", ""},
		{"only newlines", "\n\n\n", ""},
		{"carriage return", "overwritten\rprompt> ", "prompt> "},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := LastVisibleLine(tt.input)
			if got != tt.want {
				t.Errorf("LastVisibleLine(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -run "TestStripANSI|TestLastVisibleLine" -v`
Expected: FAIL with "undefined: StripANSI"

**Step 3: Write implementation**

```go
// internal/notify/ansi.go
package notify

import (
	"regexp"
	"strings"
)

// ansiPattern matches ANSI escape sequences:
// - CSI sequences: \x1b[ ... (letter)
// - OSC sequences: \x1b] ... (\x07 or \x1b\\)
// - Other escapes: \x1b (single char)
var ansiPattern = regexp.MustCompile(`\x1b(?:\[[0-9;]*[a-zA-Z]|\][^\x07]*\x07|\[[0-9;]*m|.)`)

// StripANSI removes all ANSI escape sequences from a string.
func StripANSI(s string) string {
	return ansiPattern.ReplaceAllString(s, "")
}

// LastVisibleLine returns the last non-empty line of text after stripping
// ANSI codes and handling carriage returns.
func LastVisibleLine(s string) string {
	clean := StripANSI(s)

	// Handle carriage returns: keep only text after last \r on each line
	lines := strings.Split(clean, "\n")
	for i, line := range lines {
		if idx := strings.LastIndex(line, "\r"); idx >= 0 {
			lines[i] = line[idx+1:]
		}
	}

	// Find last non-empty line
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed != "" {
			return lines[i]
		}
	}
	return ""
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -run "TestStripANSI|TestLastVisibleLine" -v`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/notify/ansi.go internal/notify/ansi_test.go
git commit -m "feat: add ANSI stripping and last visible line extraction"
```

---

### Task 2: Output Classifier (TDD)

**Files:**
- Create: `internal/notify/classifier.go`
- Create: `internal/notify/classifier_test.go`

**Step 1: Write the failing test**

```go
// internal/notify/classifier_test.go
package notify

import "testing"

func TestClassifyAwaitingInput(t *testing.T) {
	c := NewOutputClassifier(nil, nil)
	tests := []struct {
		name string
		line string
	}{
		{"Y/n prompt", "Do you want to proceed? [Y/n]"},
		{"y/N prompt", "Continue? [y/N]"},
		{"yes/no prompt", "Are you sure? (yes/no)"},
		{"inquirer style", "? Select a framework"},
		{"shell prompt", "user@host:~$ "},
		{"password", "Password: "},
		{"press enter", "Press Enter to continue"},
		{"confirm", "Please confirm"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := c.Classify(tt.line)
			if got != ClassAwaitingInput {
				t.Errorf("Classify(%q) = %v, want ClassAwaitingInput", tt.line, got)
			}
		})
	}
}

func TestClassifyProcessing(t *testing.T) {
	c := NewOutputClassifier(nil, nil)
	tests := []struct {
		name string
		line string
	}{
		{"spinner", "⠙ Processing..."},
		{"thinking", "Thinking"},
		{"loading", "Loading modules..."},
		{"compiling", "Compiling src/main.go"},
		{"building", "Building project..."},
		{"installing", "Installing dependencies..."},
		{"downloading", "Downloading packages"},
		{"ellipsis", "Analyzing code..."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := c.Classify(tt.line)
			if got != ClassProcessing {
				t.Errorf("Classify(%q) = %v, want ClassProcessing", tt.line, got)
			}
		})
	}
}

func TestClassifyUnknown(t *testing.T) {
	c := NewOutputClassifier(nil, nil)
	tests := []struct {
		name string
		line string
	}{
		{"regular output", "src/main.go:15: syntax error"},
		{"empty", ""},
		{"random text", "The quick brown fox"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := c.Classify(tt.line)
			if got != ClassUnknown {
				t.Errorf("Classify(%q) = %v, want ClassUnknown", tt.line, got)
			}
		})
	}
}

func TestClassifyCustomPatterns(t *testing.T) {
	extraInput := []string{`my_custom_prompt>`}
	extraProcessing := []string{`CRUNCHING`}
	c := NewOutputClassifier(extraInput, extraProcessing)

	if c.Classify("my_custom_prompt>") != ClassAwaitingInput {
		t.Error("expected custom input pattern to match")
	}
	if c.Classify("CRUNCHING data") != ClassProcessing {
		t.Error("expected custom processing pattern to match")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -run TestClassify -v`
Expected: FAIL

**Step 3: Write implementation**

```go
// internal/notify/classifier.go
package notify

import (
	"regexp"
	"strings"
)

type OutputClass int

const (
	ClassUnknown        OutputClass = iota
	ClassAwaitingInput
	ClassProcessing
)

func (c OutputClass) String() string {
	switch c {
	case ClassAwaitingInput:
		return "AwaitingInput"
	case ClassProcessing:
		return "Processing"
	default:
		return "Unknown"
	}
}

// Default built-in patterns
var defaultAwaitingInputPatterns = []string{
	`\[Y/n\]`,
	`\[y/N\]`,
	`\(yes/no\)`,
	`\?\s+\S`,
	`>\s*$`,
	`\$\s*$`,
	`[Pp]assword\s*:`,
	`[Cc]onfirm`,
	`Press\s+(any key|Enter|enter)`,
	`Continue\?`,
	`\(y\)`,
}

var defaultProcessingPatterns = []string{
	`[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]`,
	`(?i)^thinking`,
	`(?i)^loading`,
	`(?i)^processing`,
	`(?i)^compiling`,
	`(?i)^building`,
	`(?i)^installing`,
	`(?i)^downloading`,
	`\.\.\.\s*$`,
}

// OutputClassifier categorizes terminal output lines.
type OutputClassifier struct {
	awaitingInput []*regexp.Regexp
	processing    []*regexp.Regexp
}

// NewOutputClassifier creates a classifier with built-in patterns
// plus any extra patterns provided. Extra patterns are regex strings.
func NewOutputClassifier(extraInput, extraProcessing []string) *OutputClassifier {
	c := &OutputClassifier{}

	all := append(defaultAwaitingInputPatterns, extraInput...)
	for _, p := range all {
		if re, err := regexp.Compile(p); err == nil {
			c.awaitingInput = append(c.awaitingInput, re)
		}
	}

	allProc := append(defaultProcessingPatterns, extraProcessing...)
	for _, p := range allProc {
		if re, err := regexp.Compile(p); err == nil {
			c.processing = append(c.processing, re)
		}
	}

	return c
}

// Classify returns the classification for a visible terminal line.
func (c *OutputClassifier) Classify(line string) OutputClass {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return ClassUnknown
	}

	// Check awaiting input first (higher priority)
	for _, re := range c.awaitingInput {
		if re.MatchString(trimmed) {
			return ClassAwaitingInput
		}
	}

	// Check processing patterns
	for _, re := range c.processing {
		if re.MatchString(trimmed) {
			return ClassProcessing
		}
	}

	return ClassUnknown
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -run TestClassify -v`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/notify/classifier.go internal/notify/classifier_test.go
git commit -m "feat: add output classifier with built-in prompt/processing patterns"
```

---

### Task 3: SmartIdleDetector (TDD)

**Files:**
- Modify: `internal/notify/idle.go` → rewrite as `SmartIdleDetector`
- Modify: `internal/notify/idle_test.go` → new tests

**Step 1: Write the failing test**

Replace the entire content of `internal/notify/idle_test.go`:

```go
// internal/notify/idle_test.go
package notify

import (
	"sync"
	"testing"
	"time"
)

func TestSmartIdleAwaitingInputNotifies(t *testing.T) {
	var mu sync.Mutex
	var lastConfidence string
	notifyCount := 0

	d := NewSmartIdleDetector(100*time.Millisecond, 500*time.Millisecond, nil, nil,
		func(confidence string) {
			mu.Lock()
			notifyCount++
			lastConfidence = confidence
			mu.Unlock()
		},
	)
	d.Start()
	defer d.Stop()

	// Feed output that looks like a prompt
	d.Feed([]byte("? Do you want to proceed? [Y/n]"))

	// Wait for short timeout to fire
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	if notifyCount != 1 {
		t.Errorf("expected 1 notification, got %d", notifyCount)
	}
	if lastConfidence != "high" {
		t.Errorf("expected high confidence, got %s", lastConfidence)
	}
	mu.Unlock()
}

func TestSmartIdleProcessingSuppresses(t *testing.T) {
	notifyCount := 0
	d := NewSmartIdleDetector(50*time.Millisecond, 200*time.Millisecond, nil, nil,
		func(confidence string) { notifyCount++ },
	)
	d.Start()
	defer d.Stop()

	// Feed output that looks like processing
	d.Feed([]byte("⠙ Thinking..."))

	// Wait past short timeout
	time.Sleep(100 * time.Millisecond)

	if notifyCount != 0 {
		t.Errorf("expected 0 notifications for processing output, got %d", notifyCount)
	}
}

func TestSmartIdleUnknownUsesLongTimeout(t *testing.T) {
	var mu sync.Mutex
	var lastConfidence string
	notifyCount := 0

	d := NewSmartIdleDetector(50*time.Millisecond, 200*time.Millisecond, nil, nil,
		func(confidence string) {
			mu.Lock()
			notifyCount++
			lastConfidence = confidence
			mu.Unlock()
		},
	)
	d.Start()
	defer d.Stop()

	// Feed output that doesn't match any pattern
	d.Feed([]byte("some random output"))

	// Should NOT notify at short timeout
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if notifyCount != 0 {
		t.Errorf("expected 0 notifications at short timeout, got %d", notifyCount)
	}
	mu.Unlock()

	// SHOULD notify at long timeout
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	if notifyCount != 1 {
		t.Errorf("expected 1 notification at long timeout, got %d", notifyCount)
	}
	if lastConfidence != "low" {
		t.Errorf("expected low confidence, got %s", lastConfidence)
	}
	mu.Unlock()
}

func TestSmartIdleFeedResetsTimers(t *testing.T) {
	notifyCount := 0
	d := NewSmartIdleDetector(100*time.Millisecond, 500*time.Millisecond, nil, nil,
		func(confidence string) { notifyCount++ },
	)
	d.Start()
	defer d.Stop()

	d.Feed([]byte("? prompt [Y/n]"))

	// Feed new output before timeout
	time.Sleep(50 * time.Millisecond)
	d.Feed([]byte("some new output"))
	time.Sleep(50 * time.Millisecond)
	d.Feed([]byte("more output"))
	time.Sleep(50 * time.Millisecond)

	if notifyCount != 0 {
		t.Errorf("expected 0 notifications when feed keeps resetting, got %d", notifyCount)
	}
}

func TestSmartIdleNotifiesOnceUntilNewOutput(t *testing.T) {
	var mu sync.Mutex
	notifyCount := 0

	d := NewSmartIdleDetector(50*time.Millisecond, 500*time.Millisecond, nil, nil,
		func(confidence string) {
			mu.Lock()
			notifyCount++
			mu.Unlock()
		},
	)
	d.Start()
	defer d.Stop()

	d.Feed([]byte("? prompt [Y/n]"))
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	if notifyCount != 1 {
		t.Errorf("expected 1 notification, got %d", notifyCount)
	}
	mu.Unlock()

	// Wait more — should NOT notify again
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if notifyCount != 1 {
		t.Errorf("expected still 1 notification, got %d", notifyCount)
	}
	mu.Unlock()

	// Feed new output, then wait — should notify again
	d.Feed([]byte("? another prompt [Y/n]"))
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if notifyCount != 2 {
		t.Errorf("expected 2 notifications after new output, got %d", notifyCount)
	}
	mu.Unlock()
}
```

**Step 2: Run test to verify it fails**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -run TestSmartIdle -v`
Expected: FAIL with "undefined: NewSmartIdleDetector"

**Step 3: Replace idle.go with SmartIdleDetector**

Replace the entire content of `internal/notify/idle.go`:

```go
// internal/notify/idle.go
package notify

import (
	"sync"
	"time"
)

// SmartIdleDetector uses output classification to pick appropriate timeouts.
// AwaitingInput output → short timeout → high-confidence notification
// Processing output → no timer (suppressed)
// Unknown output → long timeout → low-confidence notification
type SmartIdleDetector struct {
	shortTimeout time.Duration
	longTimeout  time.Duration
	classifier   *OutputClassifier
	onIdle       func(confidence string)

	mu       sync.Mutex
	timer    *time.Timer
	notified bool
	stopped  bool
	lastClass OutputClass
}

// NewSmartIdleDetector creates a smart idle detector.
// extraInput/extraProcessing are additional regex patterns appended to built-ins.
func NewSmartIdleDetector(
	shortTimeout, longTimeout time.Duration,
	extraInput, extraProcessing []string,
	onIdle func(confidence string),
) *SmartIdleDetector {
	return &SmartIdleDetector{
		shortTimeout: shortTimeout,
		longTimeout:  longTimeout,
		classifier:   NewOutputClassifier(extraInput, extraProcessing),
		onIdle:       onIdle,
	}
}

func (d *SmartIdleDetector) Start() {
	d.mu.Lock()
	defer d.mu.Unlock()
	// Start with long timeout (unknown state)
	d.timer = time.AfterFunc(d.longTimeout, func() { d.fire("low") })
}

// Feed is called on every PTY output. It classifies the output
// and resets the appropriate timer.
func (d *SmartIdleDetector) Feed(data []byte) {
	line := LastVisibleLine(string(data))
	class := d.classifier.Classify(line)

	d.mu.Lock()
	defer d.mu.Unlock()

	if d.stopped {
		return
	}

	d.notified = false
	d.lastClass = class

	if d.timer != nil {
		d.timer.Stop()
	}

	switch class {
	case ClassAwaitingInput:
		d.timer = time.AfterFunc(d.shortTimeout, func() { d.fire("high") })
	case ClassProcessing:
		// No timer — suppress notifications while processing
		d.timer = nil
	default: // ClassUnknown
		d.timer = time.AfterFunc(d.longTimeout, func() { d.fire("low") })
	}
}

func (d *SmartIdleDetector) fire(confidence string) {
	d.mu.Lock()
	if d.stopped || d.notified {
		d.mu.Unlock()
		return
	}
	d.notified = true
	d.mu.Unlock()

	d.onIdle(confidence)
}

func (d *SmartIdleDetector) Stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stopped = true
	if d.timer != nil {
		d.timer.Stop()
	}
}
```

**Step 4: Run test to verify it passes**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -run TestSmartIdle -v`
Expected: PASS (5 tests)

**Step 5: Run ALL notify tests to make sure nothing else broke**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -v`
Expected: All tests pass (classifier + ansi + smart idle + wechat + feishu)

**Step 6: Commit**

```bash
git add internal/notify/idle.go internal/notify/idle_test.go
git commit -m "feat: replace IdleDetector with SmartIdleDetector using output classification"
```

---

### Task 4: Add Confidence to NotifyMessage and Notifiers

**Files:**
- Modify: `internal/notify/notifier.go` — add `Confidence` field
- Modify: `internal/notify/wechat.go` — format message by confidence
- Modify: `internal/notify/feishu.go` — format message by confidence
- Modify: `internal/notify/notifier_test.go` — update tests

**Step 1: Update NotifyMessage**

In `internal/notify/notifier.go`, add `Confidence` field:

```go
type NotifyMessage struct {
	SessionID   string
	Command     string
	Pid         int
	Duration    string
	LastOutput  string
	WebURL      string
	IdleSeconds int
	Confidence  string // "high" or "low"
}
```

**Step 2: Update WeChat notifier**

In `internal/notify/wechat.go`, change `Send` to vary message by confidence:

```go
func (w *WeChatNotifier) Send(msg *NotifyMessage) error {
	if w.webhookURL == "" {
		return nil
	}

	var title string
	if msg.Confidence == "high" {
		title = fmt.Sprintf("**TermLive: 终端等待输入 (空闲 %ds)**", msg.IdleSeconds)
	} else {
		title = fmt.Sprintf("**TermLive: 终端已空闲 %ds（可能仍在处理中）**", msg.IdleSeconds)
	}

	content := fmt.Sprintf(
		"%s\n\n> 会话: %s (PID: %d)\n> 运行时长: %s\n\n"+
			"最近输出:\n```\n%s\n```\n\n[打开 Web 终端](%s)",
		title, msg.Command, msg.Pid, msg.Duration, msg.LastOutput, msg.WebURL,
	)
	payload := map[string]interface{}{
		"msgtype":  "markdown",
		"markdown": map[string]string{"content": content},
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

**Step 3: Update Feishu notifier**

In `internal/notify/feishu.go`, change the header title and template color by confidence:

```go
func (f *FeishuNotifier) Send(msg *NotifyMessage) error {
	if f.webhookURL == "" {
		return nil
	}

	var headerContent, headerTemplate string
	if msg.Confidence == "high" {
		headerContent = fmt.Sprintf("TermLive: 终端等待输入 (空闲 %ds)", msg.IdleSeconds)
		headerTemplate = "red"
	} else {
		headerContent = fmt.Sprintf("TermLive: 终端已空闲 %ds（可能仍在处理中）", msg.IdleSeconds)
		headerTemplate = "orange"
	}

	card := map[string]interface{}{
		"msg_type": "interactive",
		"card": map[string]interface{}{
			"header": map[string]interface{}{
				"title":    map[string]string{"tag": "plain_text", "content": headerContent},
				"template": headerTemplate,
			},
			"elements": []interface{}{
				map[string]interface{}{
					"tag":  "div",
					"text": map[string]string{"tag": "lark_md", "content": fmt.Sprintf("**会话:** %s (PID: %d)\n**运行时长:** %s", msg.Command, msg.Pid, msg.Duration)},
				},
				map[string]interface{}{
					"tag":  "div",
					"text": map[string]string{"tag": "lark_md", "content": fmt.Sprintf("**最近输出:**\n```\n%s\n```", msg.LastOutput)},
				},
				map[string]interface{}{
					"tag": "action",
					"actions": []interface{}{
						map[string]interface{}{
							"tag":  "button",
							"text": map[string]string{"tag": "plain_text", "content": "打开 Web 终端"},
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

**Step 4: Update tests**

In `internal/notify/notifier_test.go`, update `TestWeChatNotify` to set `Confidence: "high"` on the message. In `internal/notify/feishu_test.go`, same.

**Step 5: Run all notify tests**

Run: `cd D:/project/test/TermLive && go test ./internal/notify/ -v`
Expected: PASS

**Step 6: Commit**

```bash
git add internal/notify/notifier.go internal/notify/wechat.go internal/notify/feishu.go internal/notify/notifier_test.go internal/notify/feishu_test.go
git commit -m "feat: add confidence-based notification messages (high/low)"
```

---

### Task 5: Config Changes for Dual Timeout + Patterns

**Files:**
- Modify: `internal/config/config.go` — add fields
- Modify: `internal/config/config_test.go` — update tests

**Step 1: Update config structs**

In `internal/config/config.go`, update `NotifyConfig`:

```go
type NotifyConfig struct {
	IdleTimeout  int            `toml:"idle_timeout"`   // kept for backward compat, maps to ShortTimeout
	ShortTimeout int            `toml:"short_timeout"`  // seconds, for awaiting-input (default 30)
	LongTimeout  int            `toml:"long_timeout"`   // seconds, for unknown idle (default 120)
	Patterns     PatternConfig  `toml:"patterns"`
	WeChat       WeChatConfig   `toml:"wechat"`
	Feishu       FeishuConfig   `toml:"feishu"`
}

type PatternConfig struct {
	AwaitingInput []string `toml:"awaiting_input"`
	Processing    []string `toml:"processing"`
}
```

Update `Default()`:

```go
func Default() *Config {
	return &Config{
		Server: ServerConfig{Port: 8080, Host: "0.0.0.0"},
		Notify: NotifyConfig{
			ShortTimeout: 30,
			LongTimeout:  120,
		},
	}
}
```

**Step 2: Update test**

Add to `internal/config/config_test.go`:

```go
func TestLoadDefaultsV2(t *testing.T) {
	cfg := Default()
	if cfg.Notify.ShortTimeout != 30 {
		t.Errorf("expected short timeout 30, got %d", cfg.Notify.ShortTimeout)
	}
	if cfg.Notify.LongTimeout != 120 {
		t.Errorf("expected long timeout 120, got %d", cfg.Notify.LongTimeout)
	}
}

func TestLoadPatternsFromFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	content := []byte(`
[notify]
short_timeout = 15
long_timeout = 300

[notify.patterns]
awaiting_input = ["my_prompt>"]
processing = ["CRUNCHING"]
`)
	if err := os.WriteFile(cfgPath, content, 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFromFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Notify.ShortTimeout != 15 {
		t.Errorf("expected short timeout 15, got %d", cfg.Notify.ShortTimeout)
	}
	if cfg.Notify.LongTimeout != 300 {
		t.Errorf("expected long timeout 300, got %d", cfg.Notify.LongTimeout)
	}
	if len(cfg.Notify.Patterns.AwaitingInput) != 1 || cfg.Notify.Patterns.AwaitingInput[0] != "my_prompt>" {
		t.Errorf("unexpected awaiting_input patterns: %v", cfg.Notify.Patterns.AwaitingInput)
	}
	if len(cfg.Notify.Patterns.Processing) != 1 || cfg.Notify.Patterns.Processing[0] != "CRUNCHING" {
		t.Errorf("unexpected processing patterns: %v", cfg.Notify.Patterns.Processing)
	}
}
```

**Step 3: Fix existing test**

The existing `TestLoadDefaults` checks `cfg.Notify.IdleTimeout != 30`. Since we're deprecating `IdleTimeout` in favor of `ShortTimeout`, either keep both or update the test. Simplest: keep `IdleTimeout` in struct but unused; the old test still passes since `Default()` no longer sets it (it's 0). Update the old test to remove the `IdleTimeout` check, or just keep it and set it in `Default()` for backward compat.

**Recommendation:** Remove `IdleTimeout` field entirely and update `TestLoadDefaults` to check `ShortTimeout` instead. Update `TestLoadFromFile` if it references `idle_timeout`.

**Step 4: Run all config tests**

Run: `cd D:/project/test/TermLive && go test ./internal/config/ -v`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/config/config.go internal/config/config_test.go
git commit -m "feat: add dual timeout config and custom pattern support"
```

---

### Task 6: Wire SmartIdleDetector into run.go

**Files:**
- Modify: `cmd/tlive/run.go` — replace `IdleDetector` with `SmartIdleDetector`
- Modify: `cmd/tlive/main.go` — update CLI flags

**Step 1: Update main.go CLI flags**

Replace the single `--timeout` flag with `--short-timeout` and `--long-timeout`:

```go
var (
	port         int
	shortTimeout int
	longTimeout  int
)

func init() {
	rootCmd.Flags().IntVarP(&port, "port", "p", 8080, "Web server port")
	rootCmd.Flags().IntVarP(&shortTimeout, "short-timeout", "s", 30, "Short idle timeout for detected prompts (seconds)")
	rootCmd.Flags().IntVarP(&longTimeout, "long-timeout", "l", 120, "Long idle timeout for unknown idle (seconds)")
}
```

**Step 2: Update run.go**

Replace the `IdleDetector` section with `SmartIdleDetector`:

```go
// Setup smart idle detector
localIP := getLocalIP()
idleDetector := notify.NewSmartIdleDetector(
    time.Duration(cfg.Notify.ShortTimeout)*time.Second,
    time.Duration(cfg.Notify.LongTimeout)*time.Second,
    cfg.Notify.Patterns.AwaitingInput,
    cfg.Notify.Patterns.Processing,
    func(confidence string) {
        msg := &notify.NotifyMessage{
            SessionID:   sess.ID,
            Command:     sess.Command,
            Pid:         sess.Pid,
            Duration:    sess.Duration().Truncate(time.Second).String(),
            LastOutput:  string(sess.LastOutput(200)),
            WebURL:      fmt.Sprintf("http://%s:%d/terminal.html?id=%s", localIP, cfg.Server.Port, sess.ID),
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
```

In the PTY output loop, replace `idleDetector.Reset()` with `idleDetector.Feed(data)`:

```go
go func() {
    buf := make([]byte, 4096)
    for {
        n, err := proc.Read(buf)
        if n > 0 {
            data := buf[:n]
            os.Stdout.Write(data)
            h.Broadcast(data)
            sess.AppendOutput(data)
            idleDetector.Feed(data)  // was: idleDetector.Reset()
        }
        if err != nil {
            break
        }
    }
}()
```

Also update the config loading to use `ShortTimeout`/`LongTimeout`:

```go
cfg := config.Default()
cfg.Server.Port = port
cfg.Notify.ShortTimeout = shortTimeout
cfg.Notify.LongTimeout = longTimeout
```

**Step 3: Verify build**

Run: `cd D:/project/test/TermLive && go build -o tlive.exe ./cmd/tlive`
Expected: builds successfully

**Step 4: Run all tests**

Run: `cd D:/project/test/TermLive && go test ./... -v`
Expected: PASS

**Step 5: Commit**

```bash
git add cmd/tlive/main.go cmd/tlive/run.go
git commit -m "feat: wire SmartIdleDetector into CLI with dual timeout flags"
```

---

### Task 7: Windows PTY via ConPTY

**Files:**
- Modify: `internal/pty/pty_windows.go` — real implementation
- Create: `internal/pty/pty_windows_test.go`

**Step 1: Install conpty dependency**

```bash
cd D:/project/test/TermLive && go get github.com/UserExistsError/conpty
```

**Step 2: Replace pty_windows.go stub**

Replace the entire content of `internal/pty/pty_windows.go`:

```go
//go:build windows

package pty

import (
	"fmt"
	"io"
	"strings"
	"unsafe"

	"github.com/UserExistsError/conpty"
	"golang.org/x/sys/windows"
)

type windowsProcess struct {
	cpty   *conpty.ConPty
	pid    int
	exited bool
}

func Start(name string, args []string, rows, cols uint16) (Process, error) {
	cmdLine := name
	if len(args) > 0 {
		cmdLine = name + " " + strings.Join(args, " ")
	}

	cpty, err := conpty.Start(cmdLine, conpty.ConPtyDimensions(int(cols), int(rows)))
	if err != nil {
		return nil, fmt.Errorf("conpty start: %w", err)
	}

	pid := cpty.Pid()

	return &windowsProcess{
		cpty: cpty,
		pid:  pid,
	}, nil
}

func (p *windowsProcess) Read(b []byte) (int, error) {
	return p.cpty.Read(b)
}

func (p *windowsProcess) Write(b []byte) (int, error) {
	return p.cpty.Write(b)
}

func (p *windowsProcess) Resize(rows, cols uint16) error {
	return p.cpty.Resize(int(cols), int(rows))
}

func (p *windowsProcess) Wait() (int, error) {
	exitCode, err := p.cpty.Wait(windows.INFINITE)
	p.exited = true
	if err != nil {
		return -1, err
	}
	return int(exitCode), nil
}

func (p *windowsProcess) Close() error {
	return p.cpty.Close()
}

func (p *windowsProcess) Pid() int {
	return p.pid
}
```

**Note:** The `conpty` library API may differ from what's written above. The implementer MUST read the actual `conpty` package docs/source to get the correct method names. Key things to verify:
- `conpty.Start()` — what args does it take? Does it accept `ConPtyDimensions`?
- `cpty.Pid()` — does this method exist?
- `cpty.Read()` / `cpty.Write()` — do these exist or does it use `io.Reader`/`io.Writer`?
- `cpty.Wait()` — what's the signature?
- `cpty.Resize()` — width,height or height,width?

The implementer should run `go doc github.com/UserExistsError/conpty` after installing and adjust accordingly.

**Step 3: Write Windows test**

```go
// internal/pty/pty_windows_test.go
//go:build windows

package pty

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestWindowsStartAndRead(t *testing.T) {
	proc, err := Start("cmd.exe", []string{"/C", "echo", "hello"}, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer proc.Close()

	var buf bytes.Buffer
	tmp := make([]byte, 4096)

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
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}

	if !strings.Contains(buf.String(), "hello") {
		t.Errorf("expected output to contain 'hello', got: %q", buf.String())
	}
}

func TestWindowsPid(t *testing.T) {
	proc, err := Start("cmd.exe", []string{"/C", "timeout", "/t", "2"}, 24, 80)
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

**Step 4: Run tests (Windows only)**

Run: `cd D:/project/test/TermLive && go test ./internal/pty/ -v -timeout 30s`
Expected: PASS on Windows (the tests have `//go:build windows` tag)

**Step 5: Verify full build**

Run: `cd D:/project/test/TermLive && go build -o tlive.exe ./cmd/tlive`
Expected: builds successfully

**Step 6: Commit**

```bash
git add internal/pty/pty_windows.go internal/pty/pty_windows_test.go go.mod go.sum
git commit -m "feat: add Windows ConPTY implementation replacing stub"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | ANSI stripping utility | `internal/notify/ansi.go` |
| 2 | Output classifier with pattern matching | `internal/notify/classifier.go` |
| 3 | SmartIdleDetector with dual timeouts | `internal/notify/idle.go` (rewrite) |
| 4 | Confidence-based notification messages | `notifier.go`, `wechat.go`, `feishu.go` |
| 5 | Config for dual timeout + custom patterns | `internal/config/config.go` |
| 6 | Wire into CLI run.go | `cmd/tlive/run.go`, `cmd/tlive/main.go` |
| 7 | Windows ConPTY implementation | `internal/pty/pty_windows.go` |
