# TermLive

[中文文档](README_CN.md)

AI coding tool remote control platform — monitor terminal sessions, approve tool permissions, and interact with Claude Code from your phone via Telegram, Discord, or Feishu.

## What is TermLive?

TermLive bridges your AI coding sessions to instant messaging platforms. Run Claude Code on your server, get real-time streaming responses on your phone, approve tool permissions with one tap, and view live terminal output in the browser.

**Without TermLive:** You stare at a terminal waiting for Claude Code to finish.

**With TermLive:** You walk away. Your phone buzzes when Claude needs approval or finishes work.

## Features

- **Bidirectional IM** — chat with Claude Code from Telegram, Discord, or Feishu
- **Tool Permission Approval** — approve/deny file edits, command execution from IM buttons
- **Web Terminal** — real-time terminal access from any browser, including mobile
- **Multi-session Dashboard** — manage multiple terminal sessions in one view
- **Streaming Responses** — see Claude's output as it types, not after it finishes
- **Status Line** — Claude Code bottom bar showing sessions, costs, and IM status
- **Two-component Architecture** — Go Core (infrastructure) + Node.js Bridge (AI + IM), independently deployable
- **Cross-platform** — Linux, macOS, Windows
- **Docker Ready** — `docker compose up` for one-click deployment

## Prerequisites

- **Node.js >= 22**
- **Go 1.24+** (for building Go Core from source, or download prebuilt binary)
- **Claude Code** (recommended) or Codex CLI

## Installation

### npx skills (recommended)

```bash
npx skills add termlive/termlive
```

### Git clone

```bash
git clone https://github.com/termlive/termlive.git ~/.claude/skills/termlive
```

Clones the repo directly into your personal skills directory. Claude Code discovers it automatically.

### Symlink (for development)

```bash
git clone https://github.com/termlive/termlive.git ~/code/termlive
mkdir -p ~/.claude/skills
ln -s ~/code/termlive ~/.claude/skills/termlive
```

### Verify installation

Start a new Claude Code session and type `/` — you should see `termlive` in the skill list.

## Quick Start

### 1. Setup

```
/termlive setup
```

The wizard handles everything:
1. **Build Go Core** — compiles `tlive-core` binary (or downloads prebuilt)
2. **Build Bridge** — `npm install && npm run build`
3. **Choose IM platforms** — Telegram, Discord, Feishu
4. **Enter credentials** — guided, one field at a time
5. **Write config** — `~/.termlive/config.env`

### 2. Start

```
/termlive start
```

Starts both components in order:
1. Go Core starts → listens on `:8080` → serves Web UI + API
2. Bridge starts → connects to Core → connects to IM platforms

### 3. Chat

Open your IM app and send a message to your bot. Claude Code will respond. When Claude needs to use a tool, you'll see permission buttons right in the chat.

### Core Only (no IM)

If you only want terminal monitoring + Web UI without IM integration:

```bash
~/.termlive/bin/tlive-core daemon --port 8080 --token <your-token>
```

### Docker

```bash
git clone https://github.com/termlive/termlive.git && cd termlive
cp .env.example .env    # Fill in your tokens
docker compose up -d
```

## How It Works

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
│              Node.js Bridge (IM + AI)                    │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Claude SDK  │  │  Telegram    │  │  Permission    │ │
│  │ Provider    │  │  Discord     │  │  Gateway       │ │
│  │             │  │  Feishu      │  │                │ │
│  └─────────────┘  └──────────────┘  └────────────────┘ │
│  ┌─────────────────────────────────────────────────┐    │
│  │           Core Client (HTTP/WebSocket)           │    │
│  └──────────────────────┬──────────────────────────┘    │
└─────────────────────────┼───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              Go Core (tlive-core)                         │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────┐ │
│  │ PTY Mgr  │  │ Session   │  │ Web UI   │  │ Stats │ │
│  │          │  │ Manager   │  │ Dashboard│  │       │ │
│  └──────────┘  └───────────┘  └──────────┘  └───────┘ │
│  ┌──────────────────────────────────────────────────┐   │
│  │              HTTP API + WebSocket                 │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
        │                               │
        ▼                               ▼
   Terminal PTY                    Browser (xterm.js)
```

**Two components:**

| Component | Role | Can run standalone? |
|-----------|------|---------------------|
| **Go Core** (`tlive-core`) | PTY, Web UI, HTTP API, WebSocket | Yes — terminal monitoring without IM |
| **Node.js Bridge** | Claude SDK, IM adapters, permissions | No — needs Core running |

## IM Interaction

```
You (Telegram):  "Fix the login bug in auth.ts"
                         │
Claude Code:     Analyzes code, finds the issue...
                         │
TermLive (TG):   🔧 Claude is editing src/auth.ts
                 Streaming: "I found the issue..."
                         │
TermLive (TG):   🔒 Permission Required
                 Tool: Edit | File: src/auth.ts
                 [Allow] [Allow Session] [Deny]
                 🖥 View Terminal ↗
                         │
You:             Tap [Allow]
                         │
TermLive (TG):   ✅ Task Complete
                 Fixed auth.ts, all tests pass
                 📊 12.3k/8.1k tok | $0.08 | 2m 34s
```

### Platform Support

| Feature | Telegram | Discord | Feishu |
|---------|----------|---------|--------|
| Streaming | Edit-based, 700ms | Edit-based, 1500ms | CardKit v2, 200ms |
| Permission buttons | Inline keyboard | Button components | Interactive card |
| Image support | Yes | Yes | Yes |
| Character limit | 4096/chunk | 2000/chunk | 30000/chunk |

## Commands

| Command | Description |
|---------|-------------|
| `/termlive setup` | Interactive configuration wizard |
| `/termlive start` | Start Go Core + Bridge |
| `/termlive stop` | Stop all services (Bridge first, then Core) |
| `/termlive status` | Show service status, connections, sessions |
| `/termlive logs [N]` | View last N log lines (both Core and Bridge) |
| `/termlive doctor` | Run diagnostic checks |
| `/termlive reconfigure` | Change IM platform settings |

Supports English and Chinese: `启动`, `停止`, `状态`, `诊断` all work.

## Status Line

Claude Code bottom bar:
```
TL: 2sess | bridge:on | 12.3k/8.1k tok | $0.08
```

Web UI dashboard footer:
```
● 3 sessions │ TG ● DC ● FS ● │ 12.3k/8.1k tok │ $0.08 │ 2m 34s
```

## Configuration

All settings in `~/.termlive/config.env` (created by `/termlive setup`):

```env
TL_PORT=8080
TL_TOKEN=auto-generated
TL_PUBLIC_URL=https://termlive.example.com
TL_ENABLED_CHANNELS=telegram,discord,feishu

TL_TG_BOT_TOKEN=your-bot-token
TL_TG_ALLOWED_USERS=123456789

TL_DC_BOT_TOKEN=your-bot-token
TL_DC_ALLOWED_CHANNELS=channel-id

TL_FS_APP_ID=your-app-id
TL_FS_APP_SECRET=your-app-secret
```

See `config.env.example` for the full list.

## Development

```bash
# Build Go Core
cd core && go build -o tlive-core ./cmd/tlive-core/

# Build Bridge
cd bridge && npm install && npm run build

# Test Go (all packages)
cd core && go test ./... -v -timeout 30s

# Test Bridge (122 tests)
cd bridge && npm test
```

### Project Structure

```
termlive/
├── SKILL.md                 # Claude Code skill definition
├── config.env.example       # Config template
├── core/                    # Go Core → tlive-core binary
│   ├── cmd/tlive-core/
│   ├── internal/
│   │   ├── daemon/          # HTTP API, session mgr, bridge, stats, tokens
│   │   ├── server/          # WebSocket handlers, status stream
│   │   ├── session/         # Session state and output buffer
│   │   ├── hub/             # Broadcast hub
│   │   ├── pty/             # PTY (Unix + Windows ConPTY)
│   │   └── config/          # TOML configuration
│   └── web/                 # Embedded Web UI
├── bridge/                  # Node.js Bridge
│   └── src/
│       ├── providers/       # Claude Agent SDK + CLI fallback
│       ├── channels/        # Telegram, Discord, Feishu adapters
│       ├── engine/          # Conversation engine, bridge manager
│       ├── permissions/     # Permission gateway + broker
│       ├── delivery/        # Chunking, retry, rate limiting
│       ├── markdown/        # IR → per-platform rendering
│       └── store/           # JSON file persistence
├── scripts/                 # daemon.sh, doctor.sh, statusline.sh
├── docker-compose.yml
└── .github/workflows/       # CI + Release
```

## Security

- **Bearer token auth** for all API endpoints (auto-generated during setup)
- **Scoped tokens** for IM web links (1-hour TTL, read-only, session-specific)
- **IM user whitelist** per platform
- **Secret redaction** in all log output
- **Config permissions** `chmod 600` on `config.env`

## License

MIT
