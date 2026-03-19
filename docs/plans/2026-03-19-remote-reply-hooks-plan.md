# Remote Reply & Extended Hooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to reply to Claude Code prompts from IM and receive task completion notifications.

**Architecture:** Env var `TLIVE_SESSION_ID` propagated from Go Core PTY → Claude Code → hook scripts → Go Core API → Bridge → IM. Reply flow reverses: IM quote-reply → Bridge → Go Core `/api/sessions/:id/input` → PTY stdin.

**Tech Stack:** Go (Core), Bash (hook scripts), TypeScript/Vitest (Bridge)

**Spec:** `docs/plans/2026-03-19-remote-reply-hooks-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `core/internal/pty/pty_unix.go` | Modify | Accept extra env vars in `Start()` |
| `core/internal/pty/pty_windows.go` | Modify | Windows: use `os.Setenv` before `conpty.Start` (no cmd.Env available) |
| `core/internal/daemon/manager.go` | Modify | Pass `TLIVE_SESSION_ID` to PTY |
| `core/internal/daemon/daemon.go` | Modify | Add `/api/sessions/:id/input` route + handler |
| `bridge/src/main.ts` | Modify | Add notification polling, wire `sendHookNotification`, `[Local]` prefix on permissions |
| `scripts/hook-handler.sh` | Modify | Inject `tlive_session_id` via jq |
| `scripts/notify-handler.sh` | Modify | Rewrite: add session ID, liveness check |
| `scripts/stop-handler.sh` | Create | Stop hook handler |
| `scripts/cli.js` | Modify | Install stop-handler.sh + Stop hook config |
| `bridge/src/channels/types.ts` | Modify | Add `replyToMessageId` to InboundMessage |
| `bridge/src/channels/telegram.ts` | Modify | Extract reply_to_message |
| `bridge/src/channels/discord.ts` | Modify | Extract reference.messageId |
| `bridge/src/engine/bridge-manager.ts` | Modify | Hook message tracking, reply routing, [Local] prefix |
| `bridge/src/__tests__/bridge-manager.test.ts` | Modify | Tests for reply routing + hook formatting |

---

### Task 1: Go Core — PTY env var injection + session input API

**Files:**
- Modify: `core/internal/pty/pty_unix.go`
- Modify: `core/internal/pty/pty_windows.go`
- Modify: `core/internal/daemon/manager.go`
- Modify: `core/internal/daemon/daemon.go`

- [ ] **Step 1: Add `extraEnv` parameter to `pty.Start`**

In `core/internal/pty/pty_unix.go`, change `Start` signature:

```go
func Start(name string, args []string, rows, cols uint16, extraEnv ...string) (Process, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), extraEnv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		cmd = exec.Command(name, args...)
		cmd.Env = append(os.Environ(), extraEnv...)
		ptmx, err = pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
		if err != nil {
			return nil, err
		}
		return &unixProcess{ptmx: ptmx, cmd: cmd, hasPgid: false}, nil
	}
	return &unixProcess{ptmx: ptmx, cmd: cmd, hasPgid: true}, nil
}
```

For `core/internal/pty/pty_windows.go`, `conpty` does not use `exec.Cmd`, so env vars must be set on the process before `conpty.Start`:

```go
func Start(name string, args []string, rows, cols uint16, extraEnv ...string) (Process, error) {
	// conpty doesn't support per-process env, set on parent process
	for _, env := range extraEnv {
		parts := strings.SplitN(env, "=", 2)
		if len(parts) == 2 {
			os.Setenv(parts[0], parts[1])
		}
	}

	cmdLine := name
	if len(args) > 0 {
		cmdLine = name + " " + strings.Join(args, " ")
	}
	// ... rest unchanged
```

Note: `os.Setenv` affects the entire process. For single-session usage this is fine. Multi-session on Windows would need a different approach (not a v1 concern).

- [ ] **Step 2: Pass `TLIVE_SESSION_ID` in manager.go**

In `core/internal/daemon/manager.go`, change line 73:

```go
// Before:
proc, err := pty.Start(cmd, args, cfg.Rows, cfg.Cols)

// After:
proc, err := pty.Start(cmd, args, cfg.Rows, cfg.Cols, "TLIVE_SESSION_ID="+sess.ID)
```

- [ ] **Step 3: Refactor session route dispatcher in daemon.go**

Replace line 122:

```go
// Before:
mux.HandleFunc("/api/sessions/", d.handleDeleteSession)

// After:
mux.HandleFunc("/api/sessions/", func(w http.ResponseWriter, r *http.Request) {
    path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
    if strings.HasSuffix(path, "/input") && r.Method == http.MethodPost {
        d.handleSessionInput(w, r)
        return
    }
    if r.Method == http.MethodDelete {
        d.handleDeleteSession(w, r)
        return
    }
    http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
})
```

- [ ] **Step 4: Add `handleSessionInput` handler in daemon.go**

Add after `handleDeleteSession`:

```go
// handleSessionInput handles POST /api/sessions/:id/input — writes text to PTY stdin.
func (d *Daemon) handleSessionInput(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	id := strings.TrimSuffix(path, "/input")
	if id == "" {
		http.Error(w, "session ID required", http.StatusBadRequest)
		return
	}

	ms, ok := d.mgr.GetSession(id)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	ms.Hub.Input([]byte(body.Text))
	w.WriteHeader(http.StatusOK)
}
```

- [ ] **Step 5: Build and test Go Core**

Run: `cd core && go build ./... && go test ./... -v -timeout 30s`
Expected: Build succeeds, tests pass

- [ ] **Step 6: Rebuild local binary and verify**

```bash
cd core && go build -o ~/.tlive/bin/tlive-core ./cmd/tlive/
```

- [ ] **Step 7: Commit**

```bash
git add core/internal/pty/pty_unix.go core/internal/pty/pty_windows.go core/internal/daemon/manager.go core/internal/daemon/daemon.go
git commit -m "feat(core): add TLIVE_SESSION_ID env injection + POST /api/sessions/:id/input"
```

---

### Task 2: Hook scripts — session ID injection + stop handler

**Files:**
- Modify: `scripts/hook-handler.sh`
- Modify: `scripts/notify-handler.sh`
- Create: `scripts/stop-handler.sh`

- [ ] **Step 1: Add session ID injection to hook-handler.sh**

After line 9 (`[ -f "$HOME/.tlive/hooks-paused" ] && exit 0`), before the config sourcing, add:

```bash
# Inject TLIVE_SESSION_ID into hook JSON
if command -v jq &>/dev/null && [ -n "$TLIVE_SESSION_ID" ]; then
  HOOK_JSON=$(echo "$HOOK_JSON" | jq --arg sid "$TLIVE_SESSION_ID" '. + {tlive_session_id: $sid}')
fi
```

- [ ] **Step 2: Rewrite notify-handler.sh**

Replace entire contents:

```bash
#!/bin/bash
# TLive Notification Hook — forwards notifications to Go Core
HOOK_JSON=$(cat)

# Check if hooks are paused
[ -f "$HOME/.tlive/hooks-paused" ] && exit 0

[ -f "$HOME/.tlive/config.env" ] && source "$HOME/.tlive/config.env" 2>/dev/null
TL_PORT="${TL_PORT:-8080}"
TL_TOKEN="${TL_TOKEN:-}"

# Inject TLIVE_SESSION_ID + hook type
if command -v jq &>/dev/null && [ -n "$TLIVE_SESSION_ID" ]; then
  HOOK_JSON=$(echo "$HOOK_JSON" | jq --arg sid "$TLIVE_SESSION_ID" '. + {tlive_session_id: $sid, tlive_hook_type: "notification"}')
fi

# Check if Go Core is running
if ! curl -sf "http://localhost:${TL_PORT}/api/status" \
     -H "Authorization: Bearer ${TL_TOKEN}" >/dev/null 2>&1; then
  exit 0
fi

curl -sf -X POST "http://localhost:${TL_PORT}/api/hooks/notify" \
  -H "Authorization: Bearer ${TL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$HOOK_JSON" \
  --max-time 5 >/dev/null 2>&1

exit 0
```

- [ ] **Step 3: Create stop-handler.sh**

```bash
#!/bin/bash
# TLive Stop Hook — notify task completion via Go Core
HOOK_JSON=$(cat)

[ -f "$HOME/.tlive/hooks-paused" ] && exit 0

[ -f "$HOME/.tlive/config.env" ] && source "$HOME/.tlive/config.env" 2>/dev/null
TL_PORT="${TL_PORT:-8080}"
TL_TOKEN="${TL_TOKEN:-}"

if command -v jq &>/dev/null && [ -n "$TLIVE_SESSION_ID" ]; then
  HOOK_JSON=$(echo "$HOOK_JSON" | jq --arg sid "$TLIVE_SESSION_ID" '. + {tlive_session_id: $sid, tlive_hook_type: "stop"}')
fi

if ! curl -sf "http://localhost:${TL_PORT}/api/status" \
     -H "Authorization: Bearer ${TL_TOKEN}" >/dev/null 2>&1; then
  exit 0
fi

curl -sf -X POST "http://localhost:${TL_PORT}/api/hooks/notify" \
  -H "Authorization: Bearer ${TL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$HOOK_JSON" \
  --max-time 5 >/dev/null 2>&1

exit 0
```

Make executable: `chmod +x scripts/stop-handler.sh`

- [ ] **Step 4: Commit**

```bash
git add scripts/hook-handler.sh scripts/notify-handler.sh scripts/stop-handler.sh
git commit -m "feat: add session ID to hook scripts, create stop-handler.sh"
```

---

### Task 3: CLI — install stop-handler.sh + Stop hook config

**Files:**
- Modify: `scripts/cli.js`

- [ ] **Step 1: Add stop-handler.sh to copy list**

At line 139, add:

```javascript
const stopSrc = join(__dirname, 'stop-handler.sh');
```

At line 162, change the copy loop:

```javascript
// Before:
for (const src of [hookSrc, notifySrc]) {

// After:
for (const src of [hookSrc, notifySrc, stopSrc]) {
```

- [ ] **Step 2: Add Stop hook config to settings.json writer**

After the Notification block (line 218), add:

```javascript
        const stopHandlerCmd = join(binDir, 'stop-handler.sh');

        // Check if Stop hook already configured
        const hasStopHook = (settings.hooks.Stop || []).some(e => {
          if (e.hooks) return e.hooks.some(h => h.command?.includes('stop-handler.sh'));
          return e.command?.includes('stop-handler.sh');
        });

        if (!hasStopHook) {
          if (!settings.hooks.Stop) settings.hooks.Stop = [];
          settings.hooks.Stop.push({
            hooks: [{
              type: 'command',
              command: stopHandlerCmd,
              async: true,
            }],
          });
          hooksAdded = true;
        }
```

Also update the Notification hook to include `matcher`:

```javascript
        if (!hasHook('Notification', notifyHandlerCmd)) {
          if (!settings.hooks.Notification) settings.hooks.Notification = [];
          settings.hooks.Notification.push({
            matcher: 'idle_prompt|permission_prompt',  // ← add matcher
            hooks: [{
              type: 'command',
              command: notifyHandlerCmd,
              timeout: 5000,
            }],
          });
          hooksAdded = true;
        }
```

- [ ] **Step 3: Add stop-handler.sh to package.json files**

In root `package.json`, add to `files` array:

```json
"scripts/stop-handler.sh",
```

- [ ] **Step 4: Test**

```bash
node scripts/cli.js install skills
```

Expected: shows `Skill installed`, `Hook scripts installed`, `Hooks configured` (including Stop).

- [ ] **Step 5: Commit**

```bash
git add scripts/cli.js package.json
git commit -m "feat: install stop-handler.sh and Stop hook config in tlive install skills"
```

---

### Task 4: Bridge — reply routing + [Local] label + hook forwarding

**Files:**
- Modify: `bridge/src/channels/types.ts`
- Modify: `bridge/src/channels/telegram.ts`
- Modify: `bridge/src/channels/discord.ts`
- Modify: `bridge/src/engine/bridge-manager.ts`
- Modify: `bridge/src/__tests__/bridge-manager.test.ts`

- [ ] **Step 1: Add `replyToMessageId` to InboundMessage**

In `bridge/src/channels/types.ts`, add after `messageId: string;` (line 10):

```typescript
  replyToMessageId?: string;
```

- [ ] **Step 2: Extract replyToMessageId in Telegram adapter**

In `bridge/src/channels/telegram.ts`, in the `this.bot.on('message', ...)` handler (line 26-35), add `replyToMessageId`:

```typescript
this.bot.on('message', (msg) => {
  if (!msg.text) return;
  this.messageQueue.push({
    channelType: 'telegram',
    chatId: String(msg.chat.id),
    userId: String(msg.from?.id ?? ''),
    text: msg.text,
    messageId: String(msg.message_id),
    replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
  });
});
```

- [ ] **Step 3: Extract replyToMessageId in Discord adapter**

In `bridge/src/channels/discord.ts`, in the `this.client.on('messageCreate', ...)` handler (line 40-49), add `replyToMessageId`:

```typescript
this.client.on('messageCreate', (msg) => {
  if (msg.author.bot) return;
  this.messageQueue.push({
    channelType: 'discord',
    chatId: msg.channelId,
    userId: msg.author.id,
    text: msg.content,
    messageId: msg.id,
    replyToMessageId: msg.reference?.messageId ?? undefined,
  });
});
```

- [ ] **Step 4: Add hookMessages map + reply routing to BridgeManager**

In `bridge/src/engine/bridge-manager.ts`, add private field after `lastActive` map:

```typescript
  private hookMessages = new Map<string, { sessionId: string; timestamp: number }>();
```

In `handleInboundMessage`, after the auth check (line 109) and before the callback data check (line 112), add:

```typescript
    // Reply routing: quote-reply to a hook message → send to PTY stdin
    if (msg.text && msg.replyToMessageId && this.hookMessages.has(msg.replyToMessageId)) {
      const entry = this.hookMessages.get(msg.replyToMessageId)!;
      try {
        await fetch(`${this.coreUrl}/api/sessions/${entry.sessionId}/input`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: msg.text + '\n' }),
          signal: AbortSignal.timeout(5000),
        });
        await adapter.send({ chatId: msg.chatId, text: '✓ Sent to local session' });
      } catch (err) {
        await adapter.send({ chatId: msg.chatId, text: `❌ Failed to send: ${err}` });
      }
      return true;
    }
```

- [ ] **Step 5: Add [Local] prefix to hook permission messages**

In the existing hook permission forwarding code in `handleInboundMessage` (the section that handles hook polling results), add `[Local]` prefix when sending hook messages to IM. Find where `broker.forwardPermissionRequest` sends messages and add the prefix.

Also add a helper method for sending hook notifications:

```typescript
  async sendHookNotification(adapter: BaseChannelAdapter, chatId: string, hook: any): Promise<void> {
    const hookType = hook.tlive_hook_type || '';
    let text: string;

    if (hookType === 'stop') {
      text = '[Local] ✅ Task complete';
    } else if (hook.notification_type === 'idle_prompt') {
      text = `[Local] ${hook.message || 'Claude is waiting for input...'}`;
    } else {
      text = `[Local] ${hook.message || 'Notification'}`;
    }

    const result = await adapter.send({ chatId, text });

    // Track for reply routing (with 24h eviction)
    if (hook.tlive_session_id) {
      this.hookMessages.set(result.messageId, {
        sessionId: hook.tlive_session_id,
        timestamp: Date.now(),
      });
      // Prune old entries
      for (const [id, entry] of this.hookMessages) {
        if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) {
          this.hookMessages.delete(id);
        }
      }
    }
  }
```

- [ ] **Step 6: Write tests**

Add to `bridge/src/__tests__/bridge-manager.test.ts`:

```typescript
  describe('hook reply routing', () => {
    it('routes quote-reply to hook message via /api/sessions/:id/input', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      // Simulate storing a hook message
      (manager as any).hookMessages.set('hook-msg-1', {
        sessionId: 'session-abc',
        timestamp: Date.now(),
      });

      // Mock fetch for session input
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({ ok: true });

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1',
        text: 'A', messageId: 'm1', replyToMessageId: 'hook-msg-1',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/sessions/session-abc/input'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: '✓ Sent to local session' })
      );

      global.fetch = originalFetch;
    });

    it('ignores quote-reply to non-hook message', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      const handled = await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1',
        text: 'hello', messageId: 'm1', replyToMessageId: 'unknown-msg',
      });

      // Should fall through to normal message handling, not reply routing
      expect(adapter.send).toHaveBeenCalled();  // normal response
    });
  });

  describe('hook notification formatting', () => {
    it('sendHookNotification formats stop notification', async () => {
      const adapter = mockAdapter();
      await (manager as any).sendHookNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        tlive_session_id: 'sess-1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: '[Local] ✅ Task complete' })
      );
    });

    it('sendHookNotification formats idle_prompt notification', async () => {
      const adapter = mockAdapter();
      await (manager as any).sendHookNotification(adapter, 'c1', {
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
        tlive_session_id: 'sess-1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: '[Local] Claude is waiting for your input' })
      );
    });

    it('sendHookNotification stores hook message for reply routing', async () => {
      const adapter = mockAdapter();
      await (manager as any).sendHookNotification(adapter, 'c1', {
        tlive_hook_type: 'notification',
        tlive_session_id: 'sess-1',
        message: 'test',
      });

      expect((manager as any).hookMessages.has('1')).toBe(true);  // messageId from mock
    });
  });
```

- [ ] **Step 7: Run tests**

Run: `cd bridge && npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Type check + build**

Run: `cd bridge && npx tsc --noEmit && npm run build`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add bridge/src/channels/types.ts bridge/src/channels/telegram.ts bridge/src/channels/discord.ts bridge/src/engine/bridge-manager.ts bridge/src/__tests__/bridge-manager.test.ts
git commit -m "feat(bridge): add hook reply routing, [Local] prefix, replyToMessageId extraction"
```

---

### Task 5: Wire notification polling + [Local] prefix in main.ts

**Files:**
- Modify: `bridge/src/main.ts`

- [ ] **Step 1: Add [Local] prefix to existing permission messages**

In `bridge/src/main.ts`, at line 149, add `[Local] ` prefix to the permission text:

```typescript
// Before:
const text = `🔒 Permission Required (Local Claude Code)\n\n...`;

// After:
const text = `[Local] 🔒 Permission Required\n\nTool: \`${perm.tool_name}\`\n\`\`\`\n${truncatedInput}\n\`\`\`\n\n⏱ Expires in 5 minutes`;
```

Also store the hook message for reply routing — after `adapter.send()` at line 164, add:

```typescript
const sendResult = await adapter.send({ chatId, text, buttons: [...] });
// Store for reply routing
manager.trackHookMessage(sendResult.messageId, perm.tlive_session_id || '');
```

This requires exposing `trackHookMessage` on BridgeManager (add a public method that calls `this.hookMessages.set(...)`).

- [ ] **Step 2: Add notification polling (for idle_prompt + stop)**

After the existing hook permission polling block (line 173), add a notification polling interval:

```typescript
// Poll Go Core for hook notifications (idle_prompt, stop)
const notifyPollInterval = setInterval(async () => {
  if (!coreAvailable) return;
  try {
    const resp = await fetch(`${config.coreUrl}/api/hooks/notifications`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return;
    const notifications = await resp.json() as Array<any>;

    for (const notif of notifications) {
      if (sentPermissionIds.has(notif.id)) continue;
      sentPermissionIds.add(notif.id);

      for (const adapter of manager.getAdapters()) {
        const chatId = config.telegram.chatId;
        if (!chatId) continue;
        try {
          await manager.sendHookNotification(adapter, chatId, notif);
        } catch (err) {
          logger.warn(`Failed to send notification to ${adapter.channelType}: ${err}`);
        }
      }
    }
  } catch {
    // Non-fatal
  }
}, 2000);
```

Add `clearInterval(notifyPollInterval)` to the shutdown function.

- [ ] **Step 3: Expose `trackHookMessage` on BridgeManager**

In `bridge/src/engine/bridge-manager.ts`, add a public method:

```typescript
  trackHookMessage(messageId: string, sessionId: string): void {
    if (!sessionId) return;
    this.hookMessages.set(messageId, { sessionId, timestamp: Date.now() });
    for (const [id, entry] of this.hookMessages) {
      if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) this.hookMessages.delete(id);
    }
  }
```

- [ ] **Step 4: Run tests + build**

Run: `cd bridge && npx vitest run && npx tsc --noEmit && npm run build`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add bridge/src/main.ts bridge/src/engine/bridge-manager.ts
git commit -m "feat(bridge): wire notification polling, [Local] prefix, trackHookMessage"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full Bridge test suite**

Run: `cd bridge && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run Go tests**

Run: `cd core && go test ./... -v -timeout 30s`
Expected: All tests pass

- [ ] **Step 3: Build Go Core**

Run: `cd core && go build -o ~/.tlive/bin/tlive-core ./cmd/tlive/`

- [ ] **Step 4: Build Bridge**

Run: `cd bridge && npm run build`

- [ ] **Step 5: Test install skills**

Run: `node scripts/cli.js install skills`
Expected: Installs SKILL.md + 3 hook scripts + configures PreToolUse + Notification + Stop hooks

- [ ] **Step 6: Push**

```bash
git push origin main
```
