# TermLive Enhancement Design — AI Bridge + IM Interaction + Status Line

**Date:** 2026-03-17
**Status:** Approved

## Overview

Enhance TermLive from a terminal monitoring tool into a full AI coding tool remote control platform. Referencing [Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill) architecture patterns.

### Key Decisions

| Dimension | Decision |
|-----------|----------|
| Positioning | AI coding tool remote monitoring platform (Claude Code first, extensible to Cursor/Codex) |
| Target Users | Developers + general users (simple install + advanced config) |
| Architecture | Hybrid — Go Core (infrastructure) + Node.js Bridge (AI + IM) |
| IM Platforms | Telegram + Discord + Feishu (bidirectional) |
| Status Line | Claude Code status line script + Web UI status bar |
| Distribution | npm package (`termlive`), installed as Claude Code skill |
| Core Features | Bidirectional IM, Agent SDK integration, tool permission approval, streaming responses |

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code CLI                       │
│  ┌──────────┐  ┌──────────────┐                         │
│  │ SKILL.md │  │ Status Line  │                         │
│  │ /termlive│  │ statusline.sh│                         │
│  └────┬─────┘  └──────┬───────┘                         │
└───────┼───────────────┼─────────────────────────────────┘
        │               │
        ▼               ▼
┌─────────────────────────────────────────────────────────┐
│              Node.js Bridge (main process)               │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ AI Provider │  │ IM Channels  │  │ Permission     │ │
│  │ Claude SDK  │  │ Telegram     │  │ Gateway        │ │
│  │ (Codex..)   │  │ Discord      │  │ (tool approve) │ │
│  └─────────────┘  │ Feishu       │  └────────────────┘ │
│                    └──────────────┘                      │
│  ┌─────────────────────────────────────────────────┐    │
│  │           Core Client (HTTP/WebSocket)           │    │
│  └──────────────────────┬──────────────────────────┘    │
└─────────────────────────┼───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              Go Core (tlive-core binary)                  │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────┐ │
│  │ PTY Mgr  │  │ Session   │  │ Web UI   │  │ Stats │ │
│  │ (unix/   │  │ Manager   │  │ Dashboard│  │ Store │ │
│  │  win)    │  │ + Hub     │  │ Terminal │  │       │ │
│  └──────────┘  └───────────┘  └──────────┘  └───────┘ │
│  ┌──────────────────────────────────────────────────┐   │
│  │              HTTP API + WebSocket                 │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
        │                               │
        ▼                               ▼
   Terminal PTY                    Browser (xterm.js)
```

### Design Principles

- **Go Core is pure infrastructure** — PTY, sessions, Web UI, HTTP API. No AI or IM logic.
- **Node.js Bridge is the intelligence layer** — AI SDK, IM platforms, permission approval.
- **Communication** — Node.js calls Go Core's HTTP API + WebSocket. Go Core is unaware of Node.js.
- **Optional deployment** — Go Core alone = terminal monitoring. Add Bridge = AI + IM features.
- **No hooks** — Agent SDK event-driven replaces all hook-based notification. Hooks and Go-side IM notification modules are removed.

---

## 2. Responsibility Split

### Go Core (tlive-core)

| Responsibility | Status |
|---------------|--------|
| PTY management (unix/windows) | Existing, keep |
| Session management + Hub | Existing, keep |
| Web UI (dashboard + terminal) | Existing, keep + status bar |
| HTTP API + WebSocket | Existing, expand |
| Token authentication | Existing, keep |
| Git status query | New |
| Stats data storage | New |
| Bridge connection management | New |

### Go Core — Code to Remove

| File | Action |
|------|--------|
| `internal/notify/feishu.go` | Delete |
| `internal/notify/wechat.go` | Delete |
| `internal/notify/notifier.go` | Delete |
| `internal/notify/classifier.go` | Delete |
| `internal/notify/idle.go` | Delete |
| `internal/notify/ansi.go` | Keep (generic terminal utility) |
| `internal/daemon/notification.go` | Simplify — storage only, remove push |
| `cmd/tlive/notify.go` | Delete |
| `cmd/tlive/init.go` | Delete (skill install handled by npm) |
| `internal/generator/` | Delete |
| `.claude/settings.local.json` | Remove hooks config |
| `.termlive.toml` | Remove `[notify]` section |

### Go Core — New API Endpoints

```
Existing (keep):
GET    /api/status              # Daemon status
GET    /api/sessions            # Session list
POST   /api/sessions            # Create session
DELETE /api/sessions/:id        # Delete session
WS     /ws/session/:id          # Terminal WebSocket (refactor: explicit /ws/session/ prefix)

Existing (remove):
POST   /api/notify              # Delete — Bridge handles all notifications
GET    /api/notifications       # Delete — replaced by Bridge-side delivery

New:
GET    /api/stats               # Token usage, cost (Bridge writes, Core stores)
POST   /api/stats               # Bridge reports stats
GET    /api/bridge/status       # Bridge connection status
POST   /api/bridge/register     # Bridge registers on startup (with version field)
POST   /api/bridge/heartbeat    # Bridge heartbeat
WS     /ws/status               # Real-time status push (note: /ws/status not /ws/statusline to avoid catch-all conflict)
GET    /api/git/status          # Git repo status (branch, diff count)
```

**WebSocket routing fix:** Current handler catches all `/ws/*` paths. Refactor to use explicit prefix matching: `/ws/session/:id` for terminal streams, `/ws/status` for status line. Bridge registration includes a `version` field for compatibility checking.

### Node.js Bridge

| Responsibility |
|---------------|
| Claude Agent SDK integration |
| IM platforms (Telegram, Discord, Feishu) |
| Permission gateway (tool approval) |
| Conversation engine |
| Message delivery (chunking, retry, rate limit, dedup) |
| Markdown rendering (IR → per-platform) |
| Session binding (chat_id ↔ session) |
| Status line data aggregation |
| Notification push (all channels) |

---

## 3. npm Distribution & Installation

### Package: `termlive` (npm)

**Installation:**
```bash
npx termlive setup
```

**Steps:**
1. Detect platform (linux/darwin/windows) + architecture (x64/arm64)
2. Download precompiled `tlive-core` from GitHub Releases → `~/.termlive/bin/tlive-core`
3. Interactive setup wizard (via Claude Code's AskUserQuestion):
   - Choose IM platforms (Telegram/Discord/Feishu)
   - Collect bot tokens/credentials per platform
   - Configure public URL (domain), daemon port, auth token
   - Write `~/.termlive/config.env` (chmod 600)
4. Install Claude Code skill → `~/.claude/skills/termlive/SKILL.md`
5. Configure Status Line → `~/.termlive/bin/statusline.sh`
6. Verify installation — health check + test notification

### SKILL.md Subcommands

| Command | Function |
|---------|----------|
| `/termlive setup` | Configuration wizard |
| `/termlive start` | Start Go Core + Node.js Bridge |
| `/termlive stop` | Stop all services |
| `/termlive status` | Service status, connected IMs, active sessions |
| `/termlive logs [N]` | View last N log lines |
| `/termlive reconfigure` | Reconfigure IM platforms |
| `/termlive doctor` | Diagnostic checks |
| `/termlive notify <msg>` | Send manual notification |

**Fuzzy command matching (EN + CN):**

| Input | Maps to |
|-------|---------|
| `setup` / `configure` / `配置` / `帮我连接 Telegram` | setup |
| `start` / `启动` / `启动服务` | start |
| `stop` / `停止` / `关闭` | stop |
| `status` / `状态` | status |
| `logs` / `日志` / `logs 50` | logs |
| `doctor` / `diagnose` / `诊断` / `挂了` | doctor |

### Runtime Directory

```
~/.termlive/
├── bin/
│   ├── tlive-core          # Go precompiled binary
│   └── statusline.sh       # Status line script
├── config.env              # Credentials (chmod 600)
├── data/
│   ├── sessions/           # Session persistence
│   └── permissions/        # Permission records
├── logs/
│   ├── core.log            # Go Core log
│   └── bridge.log          # Node.js Bridge log
└── runtime/
    ├── core.pid
    ├── bridge.pid
    └── status.json
```

---

## 4. IM Bidirectional Interaction

### Interaction Flow

```
User Phone IM                  TermLive Bridge                Claude Code
    │                              │                              │
    │  "Fix the login bug"         │                              │
    ├─────────────────────────────▶│                              │
    │                              │  query() via Agent SDK       │
    │                              ├─────────────────────────────▶│
    │                              │                              │
    │                              │  stream: text_delta...       │
    │                              │◀─────────────────────────────┤
    │  Streaming response          │                              │
    │◀─────────────────────────────┤                              │
    │                              │                              │
    │                              │  permission_request:         │
    │                              │  "Edit src/auth.ts"          │
    │                              │◀─────────────────────────────┤
    │  [Allow] [Allow All] [Deny]  │                              │
    │◀─────────────────────────────┤                              │
    │                              │                              │
    │  Tap [Allow]                 │                              │
    ├─────────────────────────────▶│                              │
    │                              │  approve tool                │
    │                              ├─────────────────────────────▶│
    │                              │                              │
    │  "Fixed auth.ts, tests pass" │                              │
    │◀─────────────────────────────┤                              │
```

### Platform Implementation

| Feature | Telegram | Discord | Feishu |
|---------|----------|---------|--------|
| Message receiving | Bot API polling/webhook | Gateway (discord.js) | WebSocket SDK |
| Streaming response | Edit message, 700ms throttle | Edit message, 1500ms throttle | CardKit v2 streaming, 200ms |
| Permission approval | Inline Keyboard buttons | Button components | Card buttons + text `/perm` |
| Image support | Send screenshots/diff | Send screenshots/diff | Send screenshots/diff |
| Multi-user isolation | chat_id binding | channel_id binding | user_id binding |
| Character limit | 4096 per chunk | 2000 per chunk | 30000 per chunk |

### Domain Configuration & Web Links

```env
# ~/.termlive/config.env
TL_PUBLIC_URL=https://termlive.example.com
```

Every IM message includes clickable Web monitoring links:

**Permission card:**
```
┌─────────────────────────────────┐
│ 🔒 Permission Required          │
│                                  │
│ Tool: `Edit`                     │
│ ┌──────────────────────────┐    │
│ │ src/auth.ts              │    │
│ │ lines 42-58              │    │
│ └──────────────────────────┘    │
│                                  │
│ ⏱ Expires in 5 minutes          │
│                                  │
│ [Allow] [Allow All] [Deny]      │
│                                  │
│ 🖥 View Terminal ↗               │
│ https://termlive.example.com/    │
│   terminal/sess-abc?token=xxx    │
└─────────────────────────────────┘
```

**Task completion:**
```
┌─────────────────────────────────┐
│ ✅ Task Complete                 │
│                                  │
│ Fixed login page auth bug        │
│ Modified 3 files, all tests pass │
│                                  │
│ 📊 Token: 12.3k in / 8.1k out  │
│ 💰 Cost: $0.08                  │
│ ⏱ Duration: 2m 34s             │
│                                  │
│ 📋 Dashboard ↗  🖥 Terminal ↗   │
└─────────────────────────────────┘
```

Links include auth token parameter — click to open, no re-login needed.

---

## 5. Borrowing from Claude-to-IM-skill

### Bridge Module Patterns

| Pattern | Source | TermLive Adaptation |
|---------|--------|-------------------|
| DI container `BridgeContext` | claude-to-im | Add `CoreClient` interface for Go Core communication |
| Adapter self-registration | claude-to-im | Identical — `registerAdapterFactory()` + import |
| SSE internal protocol | claude-to-im | Identical — LLM → Engine event stream |
| Session-level concurrency lock | claude-to-im | Identical — 600s TTL + 60s renewal |
| Permission blocking gateway | claude-to-im | Identical — 5min timeout Promise |
| Markdown IR rendering | claude-to-im | Identical — IR → per-platform renderer |
| Delivery layer (retry/rate-limit/dedup) | claude-to-im | Identical |
| JsonFileStore | Claude-to-IM-skill | Identical — atomic write + memory cache |

### Skill Module Patterns

| Pattern | Source | TermLive Adaptation |
|---------|--------|-------------------|
| SKILL.md subcommand routing | Claude-to-IM-skill | Identical fuzzy matching + CN/EN |
| 4-step setup wizard | Claude-to-IM-skill | Identical + domain config |
| daemon.sh process management | Claude-to-IM-skill | Adapted for dual process (Go + Node) |
| Config check gate | Claude-to-IM-skill | Identical — all commands (except setup) require config |
| Doctor diagnostics | Claude-to-IM-skill | Adapted for dual process health check |

### TermLive-Unique Enhancements

| Module | Claude-to-IM | TermLive Enhancement |
|--------|-------------|---------------------|
| `CoreClient` | N/A | HTTP/WS communication with Go Core |
| Web monitoring links | N/A | Every IM message includes clickable terminal URL |
| Terminal snapshot | N/A | Permission cards can include terminal screenshot |
| Multi-PTY sessions | N/A | Sync Go Core's session list |
| Web UI status bar | N/A | Real-time dashboard status bar |

---

## 6. Status Line

### 6.1 Claude Code Status Line Script

`~/.termlive/bin/statusline.sh` — reads JSON session data from stdin, queries Go Core, outputs status.

```bash
#!/bin/bash
read -r SESSION_JSON

CORE_STATUS=$(curl -s "http://localhost:${TL_PORT:-8080}/api/status" \
  -H "Authorization: Bearer ${TL_TOKEN}" 2>/dev/null)

TOKENS_IN=$(echo "$SESSION_JSON" | jq -r '.token_usage.input // 0')
TOKENS_OUT=$(echo "$SESSION_JSON" | jq -r '.token_usage.output // 0')
COST=$(echo "$SESSION_JSON" | jq -r '.cost_usd // "0.00"')
SESSIONS=$(echo "$CORE_STATUS" | jq -r '.active_sessions // 0')
IM_CONNECTED=$(echo "$CORE_STATUS" | jq -r '.im_channels // 0')

echo "TL: ${SESSIONS}sess | ${IM_CONNECTED}ch | ${TOKENS_IN}/${TOKENS_OUT}tok | \$${COST}"
```

**Display:** `TL: 2sess | 3ch | 12.3k/8.1k tok | $0.08`

### 6.2 Web UI Status Bar

Bottom bar on TermLive Web Dashboard:

```
├──────────────────────────────────────────────────────┤
│ ● 3 sessions │ TG ● DC ● FS ● │ 12.3k/8.1k tok │  │
│ ↑ 2 notifs   │ git: main +3   │ $0.08 │ 2m 34s │  │
└──────────────────────────────────────────────────────┘
```

Data sources: Go Core API (sessions, git), Bridge API (IM status, tokens), frontend timer (duration). Updated via `/ws/statusline` WebSocket.

---

## 7. Project Structure

```
termlive/
├── core/                           # Go Core → tlive-core binary
│   ├── cmd/tlive-core/
│   │   └── main.go
│   ├── internal/
│   │   ├── daemon/                 # HTTP server + new endpoints
│   │   ├── session/                # Session management
│   │   ├── pty/                    # Cross-platform PTY
│   │   ├── hub/                    # Broadcast hub
│   │   ├── server/                 # Web + statusline WS
│   │   └── config/                 # TOML config
│   ├── web/                        # Embedded Web UI + status bar
│   ├── go.mod
│   └── Makefile
│
├── bridge/                         # Node.js Bridge
│   ├── src/
│   │   ├── main.ts                 # Daemon entry
│   │   ├── config.ts               # Config loader
│   │   ├── context.ts              # DI container
│   │   ├── core-client.ts          # Go Core HTTP/WS client
│   │   ├── providers/              # AI providers (claude-sdk)
│   │   ├── channels/               # IM adapters (telegram, discord, feishu)
│   │   ├── engine/                 # Conversation engine + bridge manager
│   │   ├── permissions/            # Permission gateway + broker
│   │   ├── delivery/               # Delivery layer
│   │   ├── markdown/               # IR → per-platform rendering
│   │   ├── store/                  # JSON file persistence
│   │   └── logger.ts               # Secret-redacted logging
│   ├── package.json
│   ├── tsconfig.json
│   └── esbuild.config.js
│
├── skill/
│   └── SKILL.md                    # Claude Code skill definition
│
├── scripts/
│   ├── daemon.sh                   # Process management
│   ├── statusline.sh               # Claude Code status line
│   ├── postinstall.js              # Download Go binary
│   ├── doctor.sh                   # Diagnostics
│   └── install.sh                  # Non-npm one-click install
│
├── package.json                    # npm: termlive
├── Dockerfile
├── docker-compose.yml
├── LICENSE
└── README.md
```

## 8. Tech Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Go Core | Go 1.24+, Cobra, gorilla/websocket, xterm.js | Existing, keep |
| Node.js Bridge | TypeScript, esbuild | Claude Agent SDK ecosystem |
| Claude SDK | `@anthropic-ai/claude-agent-sdk` | Official SDK, permission callbacks. Fallback: wrap `claude` CLI subprocess with `--output-format stream-json`, parse SSE stdout. See Section 10. |
| Telegram | `node-telegram-bot-api` or Bot API | Lightweight |
| Discord | `discord.js` | Official, Button component support |
| Feishu | `@larksuiteoapi/node-sdk` | Official SDK, WebSocket + cards |
| Markdown | `markdown-it` → IR → per-platform | Proven by Claude-to-IM |
| Bundling | esbuild → `dist/main.mjs` | Fast, single file |
| Go binary distribution | GitHub Releases + postinstall.js | Like esbuild/turbo pattern |
| Containerization | Docker multi-stage | One-click for general users |

## 9. Implementation Phases

| Phase | Content | Depends On |
|-------|---------|------------|
| P0 | Go Core refactor (cmd/tlive → core/cmd/tlive-core), remove IM modules, add new APIs | None |
| P1 | Bridge skeleton — config, context, core-client, daemon.sh | P0 |
| P2 | Claude SDK Provider + Conversation Engine | P1 |
| P3 | IM adapters — Telegram → Discord → Feishu | P2 |
| P4 | Permission system + Delivery layer | P3 |
| P5 | SKILL.md + Setup wizard + npm package | P4 |
| P6 | Status Line (Claude Code + Web UI) | P1 |
| P7 | Docker + docs + open source preparation | All |

---

## 10. Claude Agent SDK & Fallback Strategy

The `@anthropic-ai/claude-agent-sdk` package provides the `query()` function to spawn Claude Code sessions with event-driven streaming and `canUseTool` permission callbacks.

**If the SDK is unavailable or its API changes**, the fallback approach is:

1. Spawn `claude` CLI as subprocess with `--output-format stream-json --permission-mode acceptEdits`
2. Parse stdout SSE events: `text_delta`, `tool_use`, `tool_result`, `result`, `error`
3. For permission handling: use `--permission-mode` flags or parse permission prompts from the stream

**SSE event types consumed by Bridge:**

| Event | Data | Purpose |
|-------|------|---------|
| `text` | delta string | Streaming text chunk |
| `tool_use` | `{id, name, input}` | Tool call started |
| `tool_result` | `{tool_use_id, content, is_error}` | Tool call completed |
| `permission_request` | `{permissionRequestId, toolName, toolInput}` | Claude needs approval |
| `result` | `{session_id, is_error, usage}` | Final result with token usage |
| `error` | error string | Fatal error |

---

## 11. Security Model

### Bridge-to-Core Authentication

- Bridge uses the same bearer token from `config.env` (`TL_TOKEN`) to authenticate with Go Core
- Token is auto-generated during setup (32-char hex)
- All API calls require `Authorization: Bearer <TL_TOKEN>` header

### IM User Authorization

- **Whitelist model**: each platform has an allowed-users list in `config.env`
  ```env
  TL_TG_ALLOWED_USERS=123456789,987654321
  TL_DC_ALLOWED_USERS=user1_id,user2_id
  TL_DC_ALLOWED_CHANNELS=channel_id
  TL_FS_ALLOWED_USERS=feishu_user_id
  ```
- Setup wizard collects these during configuration
- Unauthorized messages are silently ignored (no error response to prevent user enumeration)
- Initial binding: first authorized message from a chat creates the chat → session binding

### Web URL Token Security

- IM messages include Web monitoring links with `?token=xxx`
- **Use short-lived scoped tokens** instead of the main auth token:
  - Go Core provides `POST /api/tokens/scoped` → returns a token valid for 1 hour, read-only, scoped to specific session
  - Format: `https://termlive.example.com/terminal/sess-abc?stoken=<scoped_token>`
  - Scoped tokens cannot create/delete sessions or access other sessions
- Main `TL_TOKEN` is never exposed in IM messages

### Bridge Version Compatibility

- `POST /api/bridge/register` includes `{ version: "1.0.0", coreMinVersion: "1.0.0" }`
- Go Core checks compatibility and returns error if Bridge version is too old/new
- Prevents silent failures from version skew

---

## 12. Error Handling & Recovery

### Go Core Crash While Bridge Running

- Bridge's `CoreClient` detects connection failure (HTTP timeout / WebSocket close)
- Bridge enters **degraded mode**: IM messages get "Core unavailable, please check server" response
- Bridge retries Core connection every 10s with exponential backoff (max 5min)
- When Core comes back, Bridge re-registers via `POST /api/bridge/register`

### Bridge Crash While Core Running

- Core detects Bridge heartbeat timeout (no heartbeat for 30s)
- Core marks Bridge status as disconnected in `/api/bridge/status`
- Web UI status bar shows "Bridge offline"
- Core continues serving terminal sessions normally (degraded = no IM)
- When Bridge restarts, it re-registers and resumes

### Claude SDK Errors

- **Rate limit (429)**: exponential backoff with `retry_after`, notify user via IM "Rate limited, retrying in Xs"
- **Context overflow**: truncate conversation, start new session, notify user
- **API auth error**: detect via regex, send user-friendly message, suggest re-running setup
- **Network error**: retry 3 times, then notify user of failure

### IM Platform Unreachable

- Per-adapter error tracking: if 5 consecutive failures, mark adapter as unhealthy
- Other adapters continue functioning (multi-channel resilience)
- Unhealthy adapter retries connection every 60s
- `doctor` command shows per-adapter health status

### Permission Request Timeout

- 5-minute timeout → auto-deny the tool call
- Claude Code receives denial → may ask user again or proceed differently
- IM user gets "Permission request expired" message

---

## 13. Go Module Migration Plan (P0)

### Current Structure → New Structure

```
# Current (single module at repo root)
termlive/
├── go.mod              # module github.com/user/termlive
├── cmd/tlive/
└── internal/

# New (Go module moved to core/ subdirectory)
termlive/
├── core/
│   ├── go.mod          # module github.com/user/termlive/core
│   ├── cmd/tlive-core/
│   └── internal/
├── bridge/
└── package.json
```

### Migration Steps

1. Create `core/` directory
2. Move `go.mod`, `go.sum`, `cmd/`, `internal/`, `web/`, `Makefile` into `core/`
3. Update `go.mod` module path to `github.com/user/termlive/core`
4. Update all import paths (`internal/` → same, relative paths unchanged within `core/`)
5. Rename binary: `cmd/tlive/` → `cmd/tlive-core/`, output binary `tlive-core`
6. The existing `tlive` name is NOT preserved — npm package provides the `termlive` command, Go binary is internal as `tlive-core`
7. Update Makefile build target

### Non-npm Standalone Usage

For users who want Go Core only (no AI/IM), provide:
```bash
go install github.com/user/termlive/core/cmd/tlive-core@latest
```

---

## 14. CoreClient Interface

```typescript
interface CoreClient {
  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isHealthy(): boolean;

  // Sessions
  listSessions(): Promise<Session[]>;
  createSession(cmd: string, opts?: SessionOpts): Promise<Session>;
  deleteSession(id: string): Promise<void>;

  // Terminal I/O (WebSocket)
  attachSession(id: string): WebSocket;

  // Stats
  reportStats(stats: StatsPayload): Promise<void>;
  getStats(): Promise<StatsResponse>;

  // Bridge registration
  register(info: BridgeInfo): Promise<RegisterResponse>;
  heartbeat(): Promise<void>;

  // Git
  getGitStatus(): Promise<GitStatus>;

  // Scoped tokens for IM links
  createScopedToken(sessionId: string): Promise<string>;

  // Status stream (WebSocket)
  subscribeStatus(cb: (status: AggregatedStatus) => void): () => void;
}

interface BridgeInfo {
  version: string;
  coreMinVersion: string;
  channels: string[];  // e.g. ['telegram', 'discord', 'feishu']
}

interface AggregatedStatus {
  activeSessions: number;
  imChannels: { type: string; healthy: boolean }[];
  tokenUsage: { input: number; output: number };
  costUsd: number;
  gitBranch: string;
  gitDiffCount: number;
}
```

Error handling: all methods throw `CoreUnavailableError` when Core is down. `CoreClient` internally manages reconnection with exponential backoff. Consumers check `isHealthy()` before operations or catch the error for degraded mode.

---

## 15. Setup Wizard Fallback (Non-Claude-Code)

The setup wizard uses `AskUserQuestion` when running inside Claude Code. When run from a regular terminal (`npx termlive setup`), it detects the absence of Claude Code and falls back to interactive terminal prompts using `inquirer` or `readline`.

```typescript
async function askUser(question: string, choices?: string[]): Promise<string> {
  if (isClaudeCodeEnvironment()) {
    // Use AskUserQuestion tool
    return await askUserQuestion(question, choices);
  } else {
    // Fallback to terminal prompts
    return await inquirerPrompt(question, choices);
  }
}
```

Detection: check for `CLAUDE_CODE` environment variable or presence of Claude Code IPC socket.

---

## 16. Docker Deployment

### docker-compose.yml

```yaml
version: '3.8'
services:
  core:
    build:
      context: ./core
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    volumes:
      - termlive-data:/data
    environment:
      - TL_TOKEN=${TL_TOKEN}
      - TL_PORT=8080

  bridge:
    build:
      context: ./bridge
      dockerfile: Dockerfile
    depends_on:
      - core
    environment:
      - TL_TOKEN=${TL_TOKEN}
      - TL_CORE_URL=http://core:8080
      - TL_TG_BOT_TOKEN=${TL_TG_BOT_TOKEN}
      - TL_DC_BOT_TOKEN=${TL_DC_BOT_TOKEN}
      - TL_FS_APP_ID=${TL_FS_APP_ID}
      - TL_FS_APP_SECRET=${TL_FS_APP_SECRET}
    volumes:
      - termlive-data:/data

volumes:
  termlive-data:
```

### Dockerfiles

**Go Core**: multi-stage — `golang:1.24-alpine` build → `alpine:3.19` runtime
**Bridge**: `node:22-alpine`, copy `dist/main.mjs` + `node_modules`

Users run:
```bash
cp .env.example .env  # fill in tokens
docker compose up -d
```

---

## 17. Environment Variables Reference

All variables use `TL_` prefix:

| Variable | Required | Description |
|----------|----------|-------------|
| `TL_PORT` | No (default: 8080) | Go Core HTTP port |
| `TL_TOKEN` | Yes (auto-generated) | Authentication token |
| `TL_PUBLIC_URL` | No | Public URL for Web links in IM messages |
| `TL_ENABLED_CHANNELS` | No | Comma-separated: `telegram,discord,feishu` |
| `TL_TG_BOT_TOKEN` | If Telegram | Telegram Bot API token |
| `TL_TG_CHAT_ID` | If Telegram | Default chat ID |
| `TL_TG_ALLOWED_USERS` | If Telegram | Comma-separated user IDs |
| `TL_DC_BOT_TOKEN` | If Discord | Discord bot token |
| `TL_DC_ALLOWED_USERS` | If Discord | Comma-separated user IDs |
| `TL_DC_ALLOWED_CHANNELS` | If Discord | Comma-separated channel IDs |
| `TL_FS_APP_ID` | If Feishu | Feishu App ID |
| `TL_FS_APP_SECRET` | If Feishu | Feishu App Secret |
| `TL_FS_ALLOWED_USERS` | If Feishu | Comma-separated user IDs |
| `TL_RUNTIME` | No (default: claude) | `claude` / `codex` / `auto` |
| `TL_DEFAULT_WORKDIR` | No | Default working directory for sessions |
| `TL_DEFAULT_MODEL` | No | Model override |
