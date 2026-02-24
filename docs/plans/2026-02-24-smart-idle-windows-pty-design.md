# Smart Idle Detection + Windows PTY Design

## Overview

Two improvements to TermLive:
1. Replace naive idle timeout with smart output-pattern-based detection to reduce false notifications
2. Replace Windows PTY stub with ConPTY implementation

## Problem: False Idle Notifications

Current `IdleDetector` triggers on "no PTY output for N seconds". This causes false positives when:
- AI tools call APIs and wait for responses (30-120s of silence)
- Long builds/installs with intermittent pauses
- Any background processing that doesn't produce output

The fundamental challenge: "AI thinking" and "waiting for user input" look identical at the PTY level — both produce zero output.

## Design: Smart Idle Detection

### Output Classifier

Analyze the last visible text from PTY output (after stripping ANSI escape codes) and classify the terminal state:

| Classification | Meaning | Timeout | Notification |
|---|---|---|---|
| `AwaitingInput` | Last output matches a prompt pattern | Short (30s) | High confidence: "终端等待输入" |
| `Processing` | Last output matches a processing pattern | None | Suppressed entirely |
| `Unknown` | No pattern match | Long (120s) | Low confidence: "终端已空闲，可能在处理中" |

### Pattern Library

Built-in patterns (user-configurable in `config.toml`):

**AwaitingInput patterns** — match against last line of visible text:
```
[Y/n], [y/N], (yes/no)
? .*$              (inquirer.js style)
> $                (command prompt)
$ $                (shell prompt)
password:, Password:
confirm, Continue?
Press any key, Press Enter
```

**Processing patterns** — match against last line:
```
[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]    (spinner characters)
Thinking, Loading, Processing
Compiling, Building, Installing, Downloading
...$                (trailing ellipsis)
```

### Architecture

```
PTY output → OutputClassifier → SmartIdleDetector → Notifier
                  │                      │
                  ├── stripANSI()        ├── AwaitingInput → short timer
                  ├── lastVisibleLine()  ├── Processing → cancel timers
                  └── matchPatterns()    └── Unknown → long timer
```

### SmartIdleDetector API

```go
type OutputClass int
const (
    ClassUnknown OutputClass = iota
    ClassAwaitingInput
    ClassProcessing
)

type SmartIdleDetector struct {
    shortTimeout time.Duration  // for AwaitingInput (default 30s)
    longTimeout  time.Duration  // for Unknown (default 120s)
    classifier   *OutputClassifier
    onIdle       func(confidence string)
    // ...
}

func (d *SmartIdleDetector) Feed(data []byte)  // Called on every PTY output
func (d *SmartIdleDetector) Start()
func (d *SmartIdleDetector) Stop()
```

`Feed()` replaces the old `Reset()` — it both resets timers AND classifies the output to determine which timeout to use.

### Notification Content

**High confidence** (AwaitingInput):
```
🔔 终端等待输入 (空闲 30s)
会话: claude | 最近输出: ? Do you want to proceed? [Y/n]
👉 http://...
```

**Low confidence** (Unknown):
```
ℹ️ 终端已空闲 2 分钟（可能仍在处理中）
会话: claude | 最近输出: Analyzing code...
👉 http://...
```

### Config

```toml
[notify]
short_timeout = 30    # seconds, for detected prompts
long_timeout = 120    # seconds, for unknown idle

[notify.patterns]
# Append to built-in patterns
awaiting_input = ['custom_prompt:']
processing = ['my_custom_spinner']
```

## Design: Windows PTY (ConPTY)

### Approach

Replace the Windows stub with a real implementation using `github.com/UserExistsError/conpty`, which wraps the Windows ConPTY API (available since Windows 10 1809).

### Implementation

```go
//go:build windows

package pty

type windowsProcess struct {
    cpty *conpty.ConPty
    pid  int
}

func Start(name string, args []string, rows, cols uint16) (Process, error) {
    cpty, err := conpty.Start(name, conpty.ConPtyDimensions(int(cols), int(rows)))
    // ...
}
```

The `Process` interface remains unchanged. The windowsProcess implements:
- `Read()` / `Write()` via ConPTY I/O pipes
- `Resize()` via `cpty.Resize()`
- `Wait()` waits for child process exit
- `Close()` cleans up ConPTY resources
- `Pid()` returns child process ID

### Requirements

- Windows 10 version 1809+ (October 2018 update)
- No CGo required (pure Go via Windows API calls)

## Files Changed

### Smart Idle Detection
- Modify: `internal/notify/idle.go` → rewrite as `SmartIdleDetector`
- Create: `internal/notify/classifier.go` → `OutputClassifier` with ANSI stripping + pattern matching
- Modify: `internal/notify/idle_test.go` → update tests
- Create: `internal/notify/classifier_test.go`
- Modify: `internal/config/config.go` → add pattern config fields
- Modify: `cmd/tlive/run.go` → use `Feed()` instead of `Reset()`
- Modify: `internal/notify/notifier.go` → add confidence field to `NotifyMessage`
- Modify: `internal/notify/wechat.go` / `feishu.go` → different message format by confidence

### Windows PTY
- Modify: `internal/pty/pty_windows.go` → real ConPTY implementation
- Create: `internal/pty/pty_windows_test.go`
