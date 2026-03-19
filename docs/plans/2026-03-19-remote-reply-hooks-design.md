# Remote Reply & Extended Hooks Design

**Date:** 2026-03-19
**Scope:** Go Core + Hook scripts + Node.js Bridge + Channel Adapters

## Overview

Enable users to reply to Claude Code prompts from IM (phone), and extend hook support to include task completion notifications. Two new capabilities:

1. **Remote reply** — when Claude Code asks a question (idle_prompt), user can quote-reply in IM to send text to PTY stdin
2. **Task complete notification** — Stop hook fires when Claude finishes, notification sent to IM

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Hook scope (v1) | `Notification (idle_prompt)` + `Stop` | Core use cases: reply to questions + task done notification |
| PTY input API | `POST /api/sessions/:id/input` | Precise routing when multiple sessions exist |
| Session ID propagation | `TLIVE_SESSION_ID` env var injected by Go Core | Each PTY process gets unique ID, Claude Code inherits it, hooks carry it |
| IM reply routing | Quote-reply (`replyToMessageId`) | Natural UX, no commands needed, all three platforms support it |
| Source labels | `[Local]` / `[Bridge]` prefix | Simple, consistent across platforms |

## Go Core Changes

### 1. PTY Environment Variable Injection

`core/internal/daemon/manager.go` — `CreateSession()`:

```go
// After creating session, before starting PTY:
cmd.Env = append(os.Environ(), "TLIVE_SESSION_ID="+sess.ID)
```

Claude Code inherits `TLIVE_SESSION_ID`, hook scripts read it via `$TLIVE_SESSION_ID`.

### 2. New API: `POST /api/sessions/:id/input`

`core/internal/daemon/daemon.go` — new handler:

**Routing note:** The existing `mux.HandleFunc("/api/sessions/", d.handleDeleteSession)` catches all `/api/sessions/*` requests and rejects non-DELETE methods. The new `/input` sub-path must be registered **before** the catch-all, or `handleDeleteSession` must be refactored to dispatch by method and sub-path. Recommended approach: register `/api/sessions/` handler that dispatches by method and path suffix:

```go
mux.HandleFunc("/api/sessions/", func(w http.ResponseWriter, r *http.Request) {
    path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
    if strings.HasSuffix(path, "/input") && r.Method == http.MethodPost {
        d.handleSessionInput(w, r)  // new handler
        return
    }
    if r.Method == http.MethodDelete {
        d.handleDeleteSession(w, r)
        return
    }
    http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
})
```

New `handleSessionInput`:

```
POST /api/sessions/:id/input
Authorization: Bearer <token>
Content-Type: application/json
Body: {"text": "A\n"}

→ Extract session ID from path (strip "/input" suffix)
→ Find session by ID → 404 if not found
→ Hub.Input([]byte(text))  // same mechanism as WebSocket input
→ 200 OK
```

### 3. Hook Notify API Extension

Existing `POST /api/hooks/notify` already accepts arbitrary JSON. Hook scripts now include `tlive_session_id` in the forwarded JSON. Go Core stores and returns it via `/api/hooks/pending` (for Bridge polling) and notification store.

The notification JSON now contains:

```json
{
  "session_id": "claude-code-uuid",
  "hook_event_name": "Notification",
  "notification_type": "idle_prompt",
  "message": "Claude is waiting for input...",
  "tlive_session_id": "89c9c3b7",
  "tlive_hook_type": "notification"
}
```

## Hook Script Changes

### hook-handler.sh (PreToolUse) — modify

Add `TLIVE_SESSION_ID` injection:

```bash
HOOK_JSON=$(cat)
[ -f "$HOME/.tlive/hooks-paused" ] && exit 0

# Inject TLIVE_SESSION_ID
if command -v jq &>/dev/null && [ -n "$TLIVE_SESSION_ID" ]; then
  HOOK_JSON=$(echo "$HOOK_JSON" | jq --arg sid "$TLIVE_SESSION_ID" '. + {tlive_session_id: $sid}')
fi

# ... rest unchanged (check Go Core, long-poll)
```

### notify-handler.sh (Notification) — modify

Add session ID injection, `tlive_hook_type`, and Go Core liveness check (matching `hook-handler.sh` guard pattern):

```bash
HOOK_JSON=$(cat)
[ -f "$HOME/.tlive/hooks-paused" ] && exit 0

[ -f "$HOME/.tlive/config.env" ] && source "$HOME/.tlive/config.env" 2>/dev/null
TL_PORT="${TL_PORT:-8080}"
TL_TOKEN="${TL_TOKEN:-}"

if command -v jq &>/dev/null && [ -n "$TLIVE_SESSION_ID" ]; then
  HOOK_JSON=$(echo "$HOOK_JSON" | jq --arg sid "$TLIVE_SESSION_ID" '. + {tlive_session_id: $sid, tlive_hook_type: "notification"}')
fi

# Check Go Core liveness before posting
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

### stop-handler.sh (Stop) — new

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

### Settings.json Hook Configuration

`tlive install skills` writes:

```json
{
  "hooks": {
    "PreToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "~/.tlive/bin/hook-handler.sh",
        "timeout": 300000
      }]
    }],
    "Notification": [{
      "matcher": "idle_prompt|permission_prompt",
      "hooks": [{
        "type": "command",
        "command": "~/.tlive/bin/notify-handler.sh",
        "timeout": 5000
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "~/.tlive/bin/stop-handler.sh",
        "async": true
      }]
    }]
  }
}
```

## Bridge Changes

### InboundMessage Extension

`bridge/src/channels/types.ts`:

```typescript
export interface InboundMessage {
  // ... existing fields
  replyToMessageId?: string;  // NEW: message being quoted/replied to
}
```

### Channel Adapter Changes

Each adapter extracts `replyToMessageId` from platform-specific reply data:

**Telegram:** `msg.reply_to_message?.message_id` — always present on reply messages
**Discord:** `msg.reference?.messageId` — can be null for non-reply messages or thread-start references, must null-check
**Feishu:** **v1 descoped** — Feishu adapter has no inbound messaging (`consumeOne()` returns null). Hook notifications are forwarded to Feishu (outbound works), but remote reply is not supported until Feishu inbound messaging is implemented.

### BridgeManager Changes

`bridge/src/engine/bridge-manager.ts`:

```typescript
// Track hook messages for reply routing (evict entries older than 24h to prevent unbounded growth)
private hookMessages = new Map<string, { sessionId: string; timestamp: number }>();

// In handleInboundMessage, before existing logic:
// Check if this is a quote-reply to a hook message
if (msg.replyToMessageId && this.hookMessages.has(msg.replyToMessageId)) {
  const entry = this.hookMessages.get(msg.replyToMessageId)!;
  const sessionId = entry.sessionId;
  await fetch(`${this.coreUrl}/api/sessions/${sessionId}/input`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: msg.text + '\n' }),
  });
  await adapter.send({ chatId: msg.chatId, text: '✓ Sent to local session' });
  return true;
}
```

### Hook Notification Forwarding

When Bridge polls `/api/hooks/pending` or receives notifications, format with source label:

```typescript
// Format hook messages with [Local] prefix
function formatHookNotification(hook: any): string {
  const type = hook.tlive_hook_type || hook.hook_event_name;

  if (type === 'stop' || hook.hook_event_name === 'Stop') {
    return `[Local] ✅ Task complete`;
  }

  if (hook.notification_type === 'idle_prompt') {
    return `[Local] ${hook.message || 'Claude is waiting for input...'}`;
  }

  // PreToolUse permission (existing format, add label)
  return `[Local] 🔒 Permission Required\nTool: ${hook.tool_name}\n...`;
}

// When sending hook message to IM, store mapping:
const result = await adapter.send({ chatId, text });
this.hookMessages.set(result.messageId, { sessionId: hook.tlive_session_id, timestamp: Date.now() });
// Prune entries older than 24h
for (const [id, entry] of this.hookMessages) {
  if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) this.hookMessages.delete(id);
}
```

### Bridge Messages Source Label

Streaming responses from Bridge conversations get `[Bridge]` prefix:

```typescript
// In StreamController compose(), prepend label:
// Only when Bridge is the source (not hook forwarding)
```

Actually, `[Bridge]` prefix is only needed when hooks are also active. Simpler approach: **only add `[Local]` to hook messages, Bridge messages stay as-is.** Users can tell by the format — hook messages have `[Local]`, everything else is from Bridge.

## Message Flow Summary

```
Scenario 1: Hook permission approval (existing + label)
    Claude Code → PreToolUse hook → Go Core → Bridge polls
    → IM: "[Local] 🔒 Permission Required..." [Allow] [Deny]
    ← User taps button → resolve via existing flow

Scenario 2: Remote reply to question (NEW)
    Claude Code idle → Notification hook (idle_prompt)
    → notify-handler.sh → Go Core /api/hooks/notify
    → Bridge polls → IM: "[Local] Claude is waiting for input..."
    ← User quote-replies "选 A"
    → Bridge detects replyToMessageId matches hook message
    → POST /api/sessions/89c9c3b7/input {"text": "选 A\n"}
    → Go Core writes to PTY stdin
    → Claude Code receives "选 A", continues

Scenario 3: Task complete notification (NEW)
    Claude Code finishes → Stop hook (async)
    → stop-handler.sh → Go Core /api/hooks/notify
    → Bridge polls → IM: "[Local] ✅ Task complete"
    (informational only, no reply needed)

Scenario 4: Bridge conversation (existing + unchanged)
    IM: user sends "Fix the login bug"
    → Bridge → Agent SDK → Claude response
    → IM: "🔍 Grep → ✏️ Edit..." (no prefix, format is distinct)
```

## Modified Files

| File | Action | Change |
|------|--------|--------|
| `core/internal/daemon/manager.go` | Modify | Inject `TLIVE_SESSION_ID` env var |
| `core/internal/daemon/daemon.go` | Modify | Add `POST /api/sessions/:id/input` handler |
| `scripts/hook-handler.sh` | Modify | Inject `tlive_session_id` via jq |
| `scripts/notify-handler.sh` | Modify | Inject `tlive_session_id` via jq |
| `scripts/stop-handler.sh` | Create | New Stop hook handler |
| `scripts/cli.js` | Modify | `install skills` writes Stop hook config |
| `bridge/src/channels/types.ts` | Modify | Add `replyToMessageId` to `InboundMessage` |
| `bridge/src/channels/telegram.ts` | Modify | Extract `reply_to_message.message_id` |
| `bridge/src/channels/discord.ts` | Modify | Extract `reference.messageId` |
| `bridge/src/channels/feishu.ts` | — | v1 descoped: no inbound messaging, cannot extract reply |
| `bridge/src/engine/bridge-manager.ts` | Modify | Hook message tracking, reply routing, `[Local]` prefix |

## Testing Strategy

| Feature | Test |
|---------|------|
| PTY env var injection | Go test: verify `TLIVE_SESSION_ID` in process env |
| `/api/sessions/:id/input` | Go test: POST text, verify PTY receives it |
| `stop-handler.sh` | Manual: run `tlive claude`, finish task, check IM notification |
| Reply routing | Bridge unit test: mock replyToMessageId matching hook message |
| Source labels | Bridge unit test: verify `[Local]` prefix on hook messages |
| `replyToMessageId` extraction | Per-adapter unit test |
