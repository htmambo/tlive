# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Terminal-style card display with rolling tool window, tree connectors, and inline permissions
- Zod-validated canonical event system replacing SSE string pipeline
- Multi-provider support: Codex (OpenAI) via `/runtime codex` command
- Graduated permission buttons: "Allow all edits", "Allow Bash(prefix *)", "Allow {tool}"
- Dynamic session whitelist — approved tools auto-allowed for the session
- 250ms conditional tool delay buffer — prevents fast tool call flicker
- Sensitive content redaction — API keys, tokens, passwords, private keys auto-redacted in IM
- AskUserQuestion support with inline option buttons
- `/runtime`, `/effort`, `/stop` IM commands
- `thinking_delta` event kind — Claude's thinking hidden from IM by default
- Hidden internal tools filtered from display (ToolSearch, TaskCreate, etc.)
- `parentToolUseId` for subagent nesting tracking
- `SessionMode` and `ProviderBackend` types for future multi-provider architecture

### Changed
- `StreamController` replaced by `TerminalCardRenderer` with rolling window
- `sseEvent()`/`parseSSE()` replaced by Zod `CanonicalEvent` typed stream
- `BridgeManager` refactored: extracted `SessionStateManager`, `PermissionCoordinator`, `CommandRouter`
- Permission buttons: Yes/No only → graduated tool-specific options
- Verbose levels: 0/1/2 → 0/1 (quiet / terminal card)

### Removed
- `StreamController` class
- `sse-utils.ts` (SSE string serialization)
- Verbose level 2 (detailed)
- "Always" permission button (use `/perm off` instead)

## [0.2.3] - 2026-03-25

### Changed
- Renamed GitHub repository from `TermLive` to `tlive` for consistency with npm package name

### Fixed
- Detect and replace empty tlive-core from failed downloads
- Use package.json version for Go Core download URL

## [0.2.1] - 2026-03-22

### Fixed
- Fail npm install when tlive-core download fails

### Changed
- Set npm publish access to public
- Use npm trusted publishing with provenance

## [0.2.0] - 2026-03-20

### Added
- **Feishu support** — WebSocket long connection, CardKit v2 interactive cards
- File upload support — images (vision) and text files from Telegram + Discord
- Permission timeout IM notification
- Consistent source labels for hook permissions and notifications
- DeliveryLayer with typed errors for smart retry decisions

### Fixed
- Prevent ambiguous permission resolution in multi-session mode
- Show URL, IP and QR code in client mode
- Skip stale notifications after Bridge restart
- Hooks only activate for tlive-managed sessions
- Prevent reply-to-hook from misrouting to Bridge LLM
- Filter WebSocket control messages in client mode
- Auto-rebind session after 30-minute inactivity
- Windows cross-compile (extract SIGWINCH handler to platform files)

### Changed
- Render Telegram messages as HTML with proper formatting
- Replace `any` types with proper interfaces
- Increase hook notification summary limit from 300 to 3000 chars

## [0.1.0] - 2026-03-15

### Added
- **Web Terminal** — wrap any command with `tlive <cmd>`, multi-session dashboard
- **IM Bridge** — chat with Claude Code from Telegram and Discord
- **Hook Approval** — approve Claude Code permissions from your phone
- Go Core with PTY management, WebSocket, HTTP API
- Node.js Bridge with Agent SDK, streaming responses, cost tracking
- QR code display for mobile access
- Token-based authentication
- Smart idle detection with output classification
- Windows ConPTY support
- Docker Compose support
