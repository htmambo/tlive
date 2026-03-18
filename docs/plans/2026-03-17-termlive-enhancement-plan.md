# TermLive Enhancement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform TermLive from a terminal monitoring tool into a full AI coding tool remote control platform with bidirectional IM interaction, Claude Agent SDK integration, and Claude Code status line support.

**Architecture:** Hybrid Go Core (pure infrastructure: PTY, sessions, Web UI, HTTP API) + Node.js Bridge (intelligence layer: AI SDK, IM platforms, permission approval). Go Core compiled as `tlive-core` binary, Node.js Bridge distributed as npm package `termlive`. Communication via HTTP API + WebSocket.

**Tech Stack:** Go 1.24+ (Core), TypeScript + esbuild (Bridge), `@anthropic-ai/claude-agent-sdk`, `discord.js`, `node-telegram-bot-api`, `@larksuiteoapi/node-sdk`, `markdown-it`

**Spec:** `docs/plans/2026-03-17-termlive-enhancement-design.md`

---

## Phase P0: Go Core Refactor

**Goal:** Move Go code into `core/` subdirectory, remove all IM/notification modules, refactor WebSocket routing, add new API endpoints for Bridge integration.

### Task 1: Move Go Code to core/ Subdirectory

**Files:**
- Move: `go.mod` → `core/go.mod`
- Move: `go.sum` → `core/go.sum`
- Move: `cmd/` → `core/cmd/`
- Move: `internal/` → `core/internal/`
- Move: `web/` → `core/web/`
- Move: `Makefile` → `core/Makefile`

- [ ] **Step 1: Create core/ directory and move files**

```bash
mkdir -p core
mv go.mod go.sum cmd internal web Makefile core/
```

- [ ] **Step 2: Rename cmd/tlive/ to cmd/tlive-core/**

```bash
mv core/cmd/tlive core/cmd/tlive-core
```

- [ ] **Step 3: Update go.mod module path**

In `core/go.mod`, change:
```
module github.com/termlive/termlive
```
to:
```
module github.com/termlive/termlive/core
```

- [ ] **Step 4: Update all import paths**

Find ALL Go files with old import path and update:
```bash
cd core && grep -r '"github.com/termlive/termlive/internal/' --include='*.go' -l | xargs sed -i 's|github.com/termlive/termlive/internal/|github.com/termlive/termlive/core/internal/|g'
```

This covers all files including those not explicitly listed: `cmd/tlive-core/*.go`, `internal/daemon/*.go` (daemon.go, manager.go, lockfile.go, notification.go, all test files), `internal/server/*.go` (server.go, handler.go, wsclient.go, test files), `internal/generator/*.go`, `internal/notify/*.go`, etc.

- [ ] **Step 5: Update Makefile build target**

In `core/Makefile`, update binary name from `tlive` to `tlive-core` and update build paths.

- [ ] **Step 6: Verify build**

```bash
cd core && go build -o tlive-core ./cmd/tlive-core/
```
Expected: compiles successfully.

- [ ] **Step 7: Run tests**

```bash
cd core && go test ./... -v -timeout 30s
```
Expected: all existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add core/ && git rm -r cmd/ internal/ web/ go.mod go.sum Makefile && git commit -m "refactor: move Go code to core/ subdirectory"
```

**Note:** Do NOT use `git add -A` — the repo root contains `.termlive.toml` with real webhook secrets and `.claude/` directory that should not be committed.

---

### Task 2: Remove IM/Notification Modules

**Files:**
- Delete: `core/internal/notify/feishu.go`
- Delete: `core/internal/notify/wechat.go`
- Delete: `core/internal/notify/notifier.go`
- Delete: `core/internal/notify/classifier.go`
- Delete: `core/internal/notify/idle.go`
- Delete: `core/internal/notify/feishu_test.go`
- Delete: `core/internal/notify/classifier_test.go`
- Delete: `core/internal/notify/idle_test.go`
- Delete: `core/internal/notify/notifier_test.go`
- Keep: `core/internal/notify/ansi.go` (generic utility)
- Keep: `core/internal/notify/ansi_test.go`
- Delete: `core/cmd/tlive-core/notify.go`
- Delete: `core/cmd/tlive-core/init.go`
- Delete: `core/internal/generator/generator.go`
- Delete: `core/internal/generator/claude_code.go`
- Delete: `core/internal/generator/claude_code_test.go`
- Delete: `core/internal/generator/integration_test.go`
- Modify: `core/internal/daemon/daemon.go` — remove notification push, keep storage
- Modify: `core/internal/config/config.go` — remove `[notify]` section
- Modify: `core/cmd/tlive-core/daemon.go` — remove notifier setup
- Modify: `core/cmd/tlive-core/run.go` — remove notifier references
- Modify: `core/cmd/tlive-core/main.go` — remove notify/init command registration

- [ ] **Step 1: Delete IM notification files**

```bash
rm core/internal/notify/feishu.go \
   core/internal/notify/wechat.go \
   core/internal/notify/notifier.go \
   core/internal/notify/classifier.go \
   core/internal/notify/idle.go \
   core/internal/notify/feishu_test.go \
   core/internal/notify/classifier_test.go \
   core/internal/notify/idle_test.go \
   core/internal/notify/notifier_test.go
```

- [ ] **Step 2: Delete CLI notify and init commands**

```bash
rm core/cmd/tlive-core/notify.go \
   core/cmd/tlive-core/init.go
```

- [ ] **Step 3: Delete generator package**

```bash
rm -rf core/internal/generator
```

- [ ] **Step 4: Remove notify command and init command registration from main.go**

In `core/cmd/tlive-core/main.go`, remove `rootCmd.AddCommand(notifyCmd)` and `rootCmd.AddCommand(initCmd)` lines. Remove unused imports.

- [ ] **Step 5: Remove notifier setup from daemon.go CLI**

In `core/cmd/tlive-core/daemon.go`, remove code that creates Feishu/WeChat notifiers and calls `d.SetNotifiers(...)`. Remove the `notify` package import.

- [ ] **Step 6: Remove notifier references from run.go**

In `core/cmd/tlive-core/run.go`, remove idle detector setup, notifier creation, and all `notify` package imports.

- [ ] **Step 7: Simplify daemon/daemon.go — remove notification push endpoints**

In `core/internal/daemon/daemon.go`:
- Remove the `POST /api/notify` handler
- Remove the `GET /api/notifications` handler
- Remove `SetNotifiers()` method and notifier fields
- Remove `notify` package import
- Keep the `NotificationStore` reference (used for internal storage)

- [ ] **Step 7b: Simplify daemon/notification.go — storage only**

In `core/internal/daemon/notification.go`:
- Keep `NotificationType`, `Notification`, `NotificationStore`, `NewNotificationStore`, `Add`, `List` — these are pure storage
- Remove any push/forwarding logic if present
- Update `core/internal/daemon/notification_test.go` to remove tests for push behavior

**Note:** `internal/notify/wechat.go` has no corresponding test file — no test deletion needed for it.

- [ ] **Step 8: Remove notify config from config.go**

In `core/internal/config/config.go`, remove `NotifyConfig`, `NotifyOptions`, `PatternConfig`, `WeChatConfig`, `FeishuConfig` types and their references in `Config`. Keep only `DaemonConfig` and `ServerConfig`.

- [ ] **Step 9: Update config_test.go for removed fields**

Remove test cases that reference notify config fields.

- [ ] **Step 10: Verify build and tests**

```bash
cd core && go build -o tlive-core ./cmd/tlive-core/ && go test ./... -v -timeout 30s
```
Expected: compiles and all remaining tests pass.

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "refactor: remove IM notification modules from Go Core"
```

---

### Task 3: Refactor WebSocket Routing

**Files:**
- Modify: `core/internal/server/handler.go`
- Modify: `core/internal/server/server.go`
- Modify: `core/internal/server/wsclient.go` (review — may need changes if it references path patterns)
- Test: `core/internal/server/server_test.go`

Currently the WebSocket handler catches all `/ws/*` paths. Refactor to use explicit prefix matching.

- [ ] **Step 1: Write test for explicit WebSocket routing**

In `core/internal/server/server_test.go`, add tests:
- `/ws/session/<id>` → routes to terminal WebSocket handler
- `/ws/status` → routes to status WebSocket handler (will return 501 for now)
- `/ws/<random>` → returns 404

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && go test ./internal/server/ -run TestWebSocketRouting -v
```
Expected: FAIL

- [ ] **Step 3: Refactor handler.go for explicit routing**

In `core/internal/server/handler.go`, change the WebSocket handler from catching all `/ws/` to:
- `handleWebSocket` only handles paths matching `/ws/session/{id}`
- Add `handleStatusWebSocket` stub that returns 501 Not Implemented
- Parse session ID from path after `/ws/session/` prefix

- [ ] **Step 4: Update server.go routing**

In `core/internal/server/server.go`, register:
```go
mux.HandleFunc("/ws/session/", s.handleWebSocket)
mux.HandleFunc("/ws/status", s.handleStatusWebSocket)
```

- [ ] **Step 5: Run tests**

```bash
cd core && go test ./internal/server/ -v
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: explicit WebSocket routing with /ws/session/ and /ws/status prefixes"
```

---

### Task 4: Add Bridge Registration & Heartbeat API

**Files:**
- Create: `core/internal/daemon/bridge.go`
- Create: `core/internal/daemon/bridge_test.go`
- Modify: `core/internal/daemon/daemon.go`

- [ ] **Step 1: Write test for bridge registration**

Create `core/internal/daemon/bridge_test.go`:
- Test `POST /api/bridge/register` with `{version, coreMinVersion, channels}` → 200 OK
- Test `POST /api/bridge/heartbeat` → 200 OK
- Test `GET /api/bridge/status` → returns bridge info (connected: false initially, connected: true after register)
- Test heartbeat timeout (30s) marks bridge as disconnected

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd core && go test ./internal/daemon/ -run TestBridge -v
```
Expected: FAIL

- [ ] **Step 3: Implement bridge.go**

Create `core/internal/daemon/bridge.go`:
```go
package daemon

import (
    "sync"
    "time"
)

type BridgeInfo struct {
    Version        string   `json:"version"`
    CoreMinVersion string   `json:"coreMinVersion"`
    Channels       []string `json:"channels"`
    ConnectedAt    time.Time `json:"connected_at"`
    LastHeartbeat  time.Time `json:"last_heartbeat"`
    Connected      bool     `json:"connected"`
}

type BridgeManager struct {
    mu   sync.RWMutex
    info *BridgeInfo
}

func NewBridgeManager() *BridgeManager { ... }
func (bm *BridgeManager) Register(version, coreMinVersion string, channels []string) error { ... }
func (bm *BridgeManager) Heartbeat() { ... }
func (bm *BridgeManager) Status() BridgeInfo { ... }
func (bm *BridgeManager) IsConnected() bool { ... }  // checks last heartbeat < 30s ago
```

- [ ] **Step 4: Register API endpoints in daemon.go**

Add handlers:
- `POST /api/bridge/register` → calls `BridgeManager.Register()`
- `POST /api/bridge/heartbeat` → calls `BridgeManager.Heartbeat()`
- `GET /api/bridge/status` → returns `BridgeManager.Status()`

- [ ] **Step 5: Run tests**

```bash
cd core && go test ./internal/daemon/ -v
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add bridge registration and heartbeat API endpoints"
```

---

### Task 5: Add Stats API

**Files:**
- Create: `core/internal/daemon/stats.go`
- Create: `core/internal/daemon/stats_test.go`
- Modify: `core/internal/daemon/daemon.go`

- [ ] **Step 1: Write test for stats endpoints**

Create `core/internal/daemon/stats_test.go`:
- Test `POST /api/stats` with `{input_tokens, output_tokens, cost_usd}` → 200 OK
- Test `GET /api/stats` → returns accumulated stats
- Test multiple POST calls accumulate correctly

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && go test ./internal/daemon/ -run TestStats -v
```
Expected: FAIL

- [ ] **Step 3: Implement stats.go**

Create `core/internal/daemon/stats.go`:
```go
package daemon

import "sync"

type Stats struct {
    mu           sync.RWMutex
    InputTokens  int64   `json:"input_tokens"`
    OutputTokens int64   `json:"output_tokens"`
    CostUSD      float64 `json:"cost_usd"`
    RequestCount int64   `json:"request_count"`
}

func NewStats() *Stats { ... }
func (s *Stats) Add(input, output int64, cost float64) { ... }
func (s *Stats) Get() StatsResponse { ... }
```

- [ ] **Step 4: Register endpoints in daemon.go**

- `POST /api/stats` → parse JSON body, call `Stats.Add()`
- `GET /api/stats` → return `Stats.Get()`

- [ ] **Step 5: Run tests**

```bash
cd core && go test ./internal/daemon/ -v
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add stats API for Bridge token usage reporting"
```

---

### Task 6: Add Git Status API

**Files:**
- Create: `core/internal/daemon/git.go`
- Create: `core/internal/daemon/git_test.go`
- Modify: `core/internal/daemon/daemon.go`

- [ ] **Step 1: Write test for git status endpoint**

Create `core/internal/daemon/git_test.go`:
- Test `GET /api/git/status` returns `{branch, diff_count, clean}` JSON
- Test in a non-git directory returns `{error: "not a git repository"}`

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && go test ./internal/daemon/ -run TestGit -v
```
Expected: FAIL

- [ ] **Step 3: Implement git.go**

Create `core/internal/daemon/git.go`:
```go
package daemon

import (
    "os/exec"
    "strings"
)

type GitStatus struct {
    Branch    string `json:"branch"`
    DiffCount int    `json:"diff_count"`
    Clean     bool   `json:"clean"`
    Error     string `json:"error,omitempty"`
}

func GetGitStatus(workdir string) GitStatus {
    // exec "git rev-parse --abbrev-ref HEAD" for branch
    // exec "git diff --stat" and count lines for diff_count
    // exec "git status --porcelain" for clean check
}
```

- [ ] **Step 4: Register endpoint in daemon.go**

- `GET /api/git/status` → calls `GetGitStatus(workingDirectory)`

- [ ] **Step 5: Run tests**

```bash
cd core && go test ./internal/daemon/ -v
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add git status API endpoint"
```

---

### Task 7: Add Scoped Token API

**Files:**
- Create: `core/internal/daemon/tokens.go`
- Create: `core/internal/daemon/tokens_test.go`
- Modify: `core/internal/daemon/daemon.go`

- [ ] **Step 1: Write test for scoped token endpoints**

- Test `POST /api/tokens/scoped` with `{session_id}` → returns `{token, expires_at}`
- Test scoped token grants access to `GET /api/sessions` and `WS /ws/session/:id` for that session only
- Test scoped token expires after 1 hour
- Test scoped token cannot create/delete sessions

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && go test ./internal/daemon/ -run TestScopedToken -v
```
Expected: FAIL

- [ ] **Step 3: Implement tokens.go**

```go
package daemon

import (
    "crypto/rand"
    "encoding/hex"
    "sync"
    "time"
)

type ScopedToken struct {
    Token     string    `json:"token"`
    SessionID string    `json:"session_id"`
    ExpiresAt time.Time `json:"expires_at"`
    ReadOnly  bool      `json:"read_only"`
}

type TokenStore struct {
    mu     sync.RWMutex
    tokens map[string]*ScopedToken
}

func NewTokenStore() *TokenStore { ... }
func (ts *TokenStore) Create(sessionID string, ttl time.Duration) *ScopedToken { ... }
func (ts *TokenStore) Validate(token string) (*ScopedToken, bool) { ... }
func (ts *TokenStore) Cleanup() { ... }  // remove expired tokens
```

- [ ] **Step 4: Integrate scoped tokens into auth middleware**

In `core/internal/daemon/daemon.go`, update the auth middleware to check both:
1. Main `TL_TOKEN` → full access
2. Scoped token via `?stoken=` query param or `Authorization: Bearer` → limited access

- [ ] **Step 5: Register endpoint**

- `POST /api/tokens/scoped` → requires main token auth, returns scoped token

- [ ] **Step 6: Run tests**

```bash
cd core && go test ./internal/daemon/ -v
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: add scoped token API for secure IM web links"
```

---

### Task 8: Expand /api/status Response

**Files:**
- Modify: `core/internal/daemon/daemon.go`
- Test: `core/internal/daemon/daemon_test.go`

- [ ] **Step 1: Write test for expanded status response**

Test `GET /api/status` returns:
```json
{
  "status": "running",
  "uptime": 123,
  "port": 8080,
  "sessions": 2,
  "active_sessions": 2,
  "bridge": { "connected": true, "channels": ["telegram"] },
  "stats": { "input_tokens": 0, "output_tokens": 0, "cost_usd": 0 },
  "version": "1.0.0"
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && go test ./internal/daemon/ -run TestExpandedStatus -v
```

- [ ] **Step 3: Update StatusResponse struct and handler**

Add `ActiveSessions`, `Bridge`, `Stats`, `Version` fields to `StatusResponse`. Update the `/api/status` handler to include data from `BridgeManager` and `Stats`.

- [ ] **Step 4: Run all tests**

```bash
cd core && go test ./... -v -timeout 30s
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: expand /api/status with bridge, stats, and version info"
```

---

### Task 9: Implement /ws/status WebSocket

**Note:** Spec Section 6.2 references `/ws/statusline` but Section 2's API table says `/ws/status` to avoid catch-all conflict. We use `/ws/status`.

**Files:**
- Modify: `core/internal/server/handler.go`
- Create: `core/internal/server/status_ws.go`
- Test: `core/internal/server/server_test.go`

- [ ] **Step 1: Write test for status WebSocket**

Test that connecting to `/ws/status`:
- Receives initial status JSON on connect
- Receives updates when sessions are created/deleted
- Receives updates when bridge status changes

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && go test ./internal/server/ -run TestStatusWebSocket -v
```

- [ ] **Step 3: Implement status_ws.go**

Create `core/internal/server/status_ws.go`:
- `handleStatusWebSocket` upgrades to WebSocket
- Sends aggregated status JSON every 5 seconds (polling Go Core state)
- Sends immediate update on session/bridge state changes
- Status includes: `active_sessions`, `bridge_status`, `stats`, `git_status`

- [ ] **Step 4: Run tests**

```bash
cd core && go test ./internal/server/ -v
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add /ws/status WebSocket for real-time status updates"
```

---

### Task 10: Clean Up Config Files and Settings

**Files:**
- Modify: `.termlive.toml`
- Modify: `.claude/settings.local.json` (remove hooks config)

**Note:** `config.go` notify types were already removed in Task 2, Step 8. This task only handles non-Go config files.

- [ ] **Step 1: Simplify .termlive.toml**

Remove `[notify]` section entirely. Keep only:
```toml
[daemon]
port = 8080
token = "..."
auto_start = false
```

- [ ] **Step 2: Remove hooks from settings**

In `.claude/settings.local.json`, remove the hooks entries related to `tlive notify` (Notification and Stop event hooks). Keep any permission settings.

- [ ] **Step 3: Verify build still passes**

```bash
cd core && go test ./... -v -timeout 30s
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add .termlive.toml .claude/settings.local.json && git commit -m "chore: clean up config, remove notify settings and hooks"
```

---

## Phase P1: Bridge Skeleton

**Goal:** Set up the Node.js Bridge project with config loading, DI container, Go Core client, and process management scripts.

### Task 11: Initialize Bridge Node.js Project

**Files:**
- Create: `bridge/package.json`
- Create: `bridge/tsconfig.json`
- Create: `bridge/esbuild.config.js`
- Create: `bridge/.gitignore`

- [ ] **Step 1: Create bridge/ directory**

```bash
mkdir -p bridge/src
```

- [ ] **Step 2: Initialize package.json**

```bash
cd bridge && npm init -y
```

Then edit `bridge/package.json`:
```json
{
  "name": "termlive-bridge",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/main.mjs",
  "scripts": {
    "build": "node esbuild.config.js",
    "dev": "node esbuild.config.js --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 3: Install dev dependencies**

```bash
cd bridge && npm install -D typescript esbuild vitest @types/node
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: Create esbuild.config.js**

```js
import { build } from 'esbuild';
const isWatch = process.argv.includes('--watch');

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/main.mjs',
  external: ['@anthropic-ai/*', 'discord.js', '@larksuiteoapi/*'],
  sourcemap: true,
  ...(isWatch ? { watch: true } : {}),
});
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 7: Verify build works**

Create minimal `bridge/src/main.ts`:
```typescript
console.log('TermLive Bridge starting...');
```

```bash
cd bridge && npm run build
```
Expected: `dist/main.mjs` created.

- [ ] **Step 8: Commit**

```bash
git add bridge/ && git commit -m "feat: initialize Node.js Bridge project skeleton"
```

---

### Task 12: Config Loader

**Files:**
- Create: `bridge/src/config.ts`
- Create: `bridge/src/__tests__/config.test.ts`

- [ ] **Step 1: Write test for config loading**

Create `bridge/src/__tests__/config.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig, Config } from '../config.js';

describe('loadConfig', () => {
  it('loads from env vars', () => {
    process.env.TL_PORT = '9090';
    process.env.TL_TOKEN = 'test-token';
    const config = loadConfig();
    expect(config.port).toBe(9090);
    expect(config.token).toBe('test-token');
    delete process.env.TL_PORT;
    delete process.env.TL_TOKEN;
  });

  it('uses defaults', () => {
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.runtime).toBe('claude');
  });

  it('parses enabled channels', () => {
    process.env.TL_ENABLED_CHANNELS = 'telegram,discord';
    const config = loadConfig();
    expect(config.enabledChannels).toEqual(['telegram', 'discord']);
    delete process.env.TL_ENABLED_CHANNELS;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd bridge && npx vitest run src/__tests__/config.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement config.ts**

Create `bridge/src/config.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export interface Config {
  port: number;
  token: string;
  publicUrl: string;
  enabledChannels: string[];
  runtime: 'claude' | 'codex' | 'auto';
  defaultWorkdir: string;
  defaultModel: string;
  coreUrl: string;
  telegram: { botToken: string; chatId: string; allowedUsers: string[] };
  discord: { botToken: string; allowedUsers: string[]; allowedChannels: string[] };
  feishu: { appId: string; appSecret: string; allowedUsers: string[] };
}

export function loadConfig(): Config {
  // 1. Try loading ~/.termlive/config.env
  // 2. Override with process.env
  // 3. Apply defaults
}

function loadEnvFile(path: string): Record<string, string> {
  // Simple KEY=VALUE parser
}
```

- [ ] **Step 4: Run tests**

```bash
cd bridge && npx vitest run src/__tests__/config.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/config.ts bridge/src/__tests__/config.test.ts && git commit -m "feat: add Bridge config loader with env file and env var support"
```

---

### Task 13: DI Container (BridgeContext)

**Files:**
- Create: `bridge/src/context.ts`
- Create: `bridge/src/__tests__/context.test.ts`

- [ ] **Step 1: Write test for context**

```typescript
import { describe, it, expect } from 'vitest';
import { initBridgeContext, getBridgeContext } from '../context.js';

describe('BridgeContext', () => {
  it('stores and retrieves context', () => {
    const mockStore = {} as any;
    const mockLlm = {} as any;
    const mockPermissions = {} as any;
    const mockCore = {} as any;

    initBridgeContext({ store: mockStore, llm: mockLlm, permissions: mockPermissions, core: mockCore });
    const ctx = getBridgeContext();
    expect(ctx.store).toBe(mockStore);
    expect(ctx.core).toBe(mockCore);
  });

  it('throws if not initialized', () => {
    // Reset globalThis key
    expect(() => getBridgeContext()).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd bridge && npx vitest run src/__tests__/context.test.ts
```

- [ ] **Step 3: Implement context.ts**

```typescript
export interface BridgeContext {
  store: BridgeStore;
  llm: LLMProvider;
  permissions: PermissionGateway;
  core: CoreClient;
  lifecycle?: LifecycleHooks;
}

// Interfaces (stubs for now)
export interface BridgeStore { }
export interface LLMProvider { }
export interface PermissionGateway { }
export interface CoreClient { }
export interface LifecycleHooks {
  onBridgeStart?(): Promise<void>;
  onBridgeStop?(): Promise<void>;
}

const CONTEXT_KEY = '__termlive_bridge_context__';

export function initBridgeContext(ctx: BridgeContext): void {
  (globalThis as any)[CONTEXT_KEY] = ctx;
}

export function getBridgeContext(): BridgeContext {
  const ctx = (globalThis as any)[CONTEXT_KEY];
  if (!ctx) throw new Error('BridgeContext not initialized. Call initBridgeContext() first.');
  return ctx;
}
```

- [ ] **Step 4: Run tests**

```bash
cd bridge && npx vitest run src/__tests__/context.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/context.ts bridge/src/__tests__/context.test.ts && git commit -m "feat: add Bridge DI container (BridgeContext)"
```

---

### Task 14: Core Client

**Files:**
- Create: `bridge/src/core-client.ts`
- Create: `bridge/src/__tests__/core-client.test.ts`

- [ ] **Step 1: Write test for CoreClient**

Test HTTP methods against a mock server (use vitest + http.createServer):
- `connect()` → calls `POST /api/bridge/register`
- `heartbeat()` → calls `POST /api/bridge/heartbeat`
- `listSessions()` → calls `GET /api/sessions`
- `getStats()` → calls `GET /api/stats`
- `reportStats()` → calls `POST /api/stats`
- `getGitStatus()` → calls `GET /api/git/status`
- `createScopedToken()` → calls `POST /api/tokens/scoped`
- `isHealthy()` → returns false when Core is unreachable

- [ ] **Step 2: Run test to verify it fails**

```bash
cd bridge && npx vitest run src/__tests__/core-client.test.ts
```

- [ ] **Step 3: Implement core-client.ts**

Implement the `CoreClient` interface from the spec (Section 14):
- HTTP client using native `fetch()`
- WebSocket client for `/ws/status` subscription
- Auto-reconnect with exponential backoff (10s base, 5min max)
- `CoreUnavailableError` on connection failure
- Heartbeat interval (every 15s)

- [ ] **Step 4: Run tests**

```bash
cd bridge && npx vitest run src/__tests__/core-client.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/src/core-client.ts bridge/src/__tests__/core-client.test.ts && git commit -m "feat: add CoreClient for Bridge-to-Core HTTP/WS communication"
```

---

### Task 15: Logger

**Files:**
- Create: `bridge/src/logger.ts`
- Create: `bridge/src/__tests__/logger.test.ts`

- [ ] **Step 1: Write test for logger**

- Test log rotation (file exceeds 10MB → rotated)
- Test secret redaction (TL_TOKEN value replaced with `***`)
- Test log levels (info, warn, error, debug)

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement logger.ts**

```typescript
import { createWriteStream, statSync, renameSync } from 'node:fs';

export class Logger {
  private stream: NodeJS.WritableStream;
  private secrets: string[];

  constructor(logPath: string, secrets: string[]) { ... }
  info(msg: string, ...args: unknown[]): void { ... }
  warn(msg: string, ...args: unknown[]): void { ... }
  error(msg: string, ...args: unknown[]): void { ... }
  debug(msg: string, ...args: unknown[]): void { ... }
  private redact(text: string): string { ... }
  private rotate(): void { ... }
}
```

- [ ] **Step 4: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/logger.test.ts
git add bridge/src/logger.ts bridge/src/__tests__/logger.test.ts && git commit -m "feat: add Bridge logger with secret redaction and rotation"
```

---

### Task 16: Process Management Scripts

**Files:**
- Create: `scripts/daemon.sh`
- Create: `scripts/doctor.sh`

- [ ] **Step 1: Write daemon.sh**

```bash
#!/bin/bash
# Usage: daemon.sh start|stop|status|logs [N]
# Manages both Go Core (tlive-core) and Node.js Bridge

TERMLIVE_HOME="${HOME}/.termlive"
RUNTIME_DIR="${TERMLIVE_HOME}/runtime"
LOG_DIR="${TERMLIVE_HOME}/logs"
BIN_DIR="${TERMLIVE_HOME}/bin"

ensure_dirs() { mkdir -p "$RUNTIME_DIR" "$LOG_DIR" "$BIN_DIR"; }

start() {
  ensure_dirs
  # 1. Start Go Core
  "$BIN_DIR/tlive-core" daemon --port "${TL_PORT:-8080}" --token "${TL_TOKEN}" \
    > "$LOG_DIR/core.log" 2>&1 &
  echo $! > "$RUNTIME_DIR/core.pid"
  # Wait for health
  for i in $(seq 1 20); do
    curl -sf "http://localhost:${TL_PORT:-8080}/api/status" -H "Authorization: Bearer ${TL_TOKEN}" && break
    sleep 0.5
  done
  # 2. Start Node.js Bridge
  node "$(dirname "$0")/../bridge/dist/main.mjs" > "$LOG_DIR/bridge.log" 2>&1 &
  echo $! > "$RUNTIME_DIR/bridge.pid"
}

stop() {
  [ -f "$RUNTIME_DIR/bridge.pid" ] && kill "$(cat "$RUNTIME_DIR/bridge.pid")" 2>/dev/null && rm "$RUNTIME_DIR/bridge.pid"
  [ -f "$RUNTIME_DIR/core.pid" ] && kill "$(cat "$RUNTIME_DIR/core.pid")" 2>/dev/null && rm "$RUNTIME_DIR/core.pid"
}

status() { ... }
logs() { tail -n "${1:-50}" "$LOG_DIR/core.log" "$LOG_DIR/bridge.log"; }

case "$1" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) logs "$2" ;;
  *) echo "Usage: $0 {start|stop|status|logs [N]}" ;;
esac
```

- [ ] **Step 2: Write doctor.sh**

```bash
#!/bin/bash
# Health check diagnostics
echo "=== TermLive Doctor ==="
echo "Checking dependencies..."
command -v node >/dev/null && echo "  node: $(node -v)" || echo "  node: NOT FOUND"
command -v curl >/dev/null && echo "  curl: OK" || echo "  curl: NOT FOUND"
command -v jq >/dev/null && echo "  jq: OK" || echo "  jq: NOT FOUND (needed for statusline)"
echo ""
echo "Checking Go Core..."
[ -f "$HOME/.termlive/bin/tlive-core" ] && echo "  binary: OK" || echo "  binary: NOT FOUND"
echo ""
echo "Checking config..."
[ -f "$HOME/.termlive/config.env" ] && echo "  config.env: OK" || echo "  config.env: NOT FOUND"
echo ""
echo "Checking processes..."
# Check PIDs, check HTTP endpoints
```

- [ ] **Step 3: Make executable and commit**

```bash
chmod +x scripts/daemon.sh scripts/doctor.sh
git add scripts/ && git commit -m "feat: add process management and diagnostics scripts"
```

---

### Task 17: Bridge Main Entry Point

**Files:**
- Modify: `bridge/src/main.ts`

- [ ] **Step 1: Implement main.ts wiring**

```typescript
import { loadConfig } from './config.js';
import { initBridgeContext } from './context.js';
import { CoreClientImpl } from './core-client.js';
import { Logger } from './logger.js';

async function main() {
  const config = loadConfig();
  const logger = new Logger(
    `${process.env.HOME}/.termlive/logs/bridge.log`,
    [config.token, config.telegram.botToken, config.discord.botToken, config.feishu.appSecret].filter(Boolean)
  );

  logger.info('TermLive Bridge starting...');

  // Initialize Core Client
  const core = new CoreClientImpl(config.coreUrl, config.token);
  await core.connect();

  // Initialize context (LLM and permissions will be added in P2)
  initBridgeContext({
    store: {} as any,       // P1: stub
    llm: {} as any,         // P2: Claude SDK
    permissions: {} as any, // P4: Permission gateway
    core,
  });

  logger.info('Bridge connected to Core');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await core.disconnect();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await core.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
```

- [ ] **Step 2: Build and verify**

```bash
cd bridge && npm run build
```
Expected: `dist/main.mjs` created without errors.

- [ ] **Step 3: Commit**

```bash
git add bridge/src/main.ts && git commit -m "feat: Bridge main entry with config, core client, and graceful shutdown"
```

---

## Phase P2: Claude SDK Provider + Conversation Engine

**Goal:** Implement the AI provider that wraps Claude Agent SDK (with CLI fallback) and the conversation engine that processes messages.

### Task 18: LLM Provider Interface + SSE Utils

**Files:**
- Create: `bridge/src/providers/base.ts`
- Create: `bridge/src/providers/sse-utils.ts`
- Create: `bridge/src/__tests__/sse-utils.test.ts`

- [ ] **Step 1: Define LLM provider interface**

```typescript
// bridge/src/providers/base.ts
export interface StreamChatParams {
  prompt: string;
  workingDirectory: string;
  model?: string;
  sessionId?: string;
  permissionMode?: 'acceptEdits' | 'plan' | 'default';
  attachments?: FileAttachment[];
  abortSignal?: AbortSignal;
}

export interface FileAttachment {
  name: string;
  mimeType: string;
  base64Data: string;
}

export interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
}
```

- [ ] **Step 2: Write SSE utils with tests**

```typescript
// bridge/src/providers/sse-utils.ts
export function sseEvent(type: string, data: unknown): string {
  return `data: ${JSON.stringify({ type, data })}\n`;
}

export function parseSSE(line: string): { type: string; data: unknown } | null {
  if (!line.startsWith('data: ')) return null;
  return JSON.parse(line.slice(6));
}
```

- [ ] **Step 3: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/sse-utils.test.ts
git add bridge/src/providers/ bridge/src/__tests__/sse-utils.test.ts && git commit -m "feat: add LLM provider interface and SSE utilities"
```

---

### Task 19: Claude SDK Provider

**Files:**
- Create: `bridge/src/providers/claude-sdk.ts`
- Create: `bridge/src/providers/index.ts`
- Create: `bridge/src/__tests__/claude-sdk.test.ts`

- [ ] **Step 1: Write test for Claude SDK provider**

Test with mocked `@anthropic-ai/claude-agent-sdk` `query()` function:
- `streamChat()` returns a ReadableStream of SSE events
- `text` events are forwarded
- `tool_use` and `tool_result` events are forwarded
- `permission_request` events trigger `onPermissionRequest` callback
- `result` event includes token usage
- Fallback to CLI subprocess when SDK unavailable

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement claude-sdk.ts**

```typescript
import { sseEvent } from './sse-utils.js';

export class ClaudeSDKProvider implements LLMProvider {
  private pendingPermissions: PermissionGateway;

  constructor(pendingPermissions: PermissionGateway) {
    this.pendingPermissions = pendingPermissions;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      start: async (controller) => {
        try {
          // Try Agent SDK first
          await this.streamViaSDK(params, controller);
        } catch {
          // Fallback: spawn claude CLI subprocess
          await this.streamViaCLI(params, controller);
        }
        controller.close();
      }
    });
  }

  private async streamViaSDK(params, controller) {
    // Import @anthropic-ai/claude-agent-sdk dynamically
    // Call query() with canUseTool callback
    // Convert SDK events to SSE format
  }

  private async streamViaCLI(params, controller) {
    // Spawn: claude --output-format stream-json --permission-mode acceptEdits
    // Parse stdout line by line as SSE
    // Forward events to controller
  }
}
```

- [ ] **Step 4: Create providers/index.ts**

```typescript
export function resolveProvider(config: Config, permissions: PermissionGateway): LLMProvider {
  switch (config.runtime) {
    case 'claude': return new ClaudeSDKProvider(permissions);
    // Future: case 'codex': return new CodexProvider();
    default: return new ClaudeSDKProvider(permissions);
  }
}
```

- [ ] **Step 5: Run tests and commit**

```bash
cd bridge && npx vitest run
git add bridge/src/providers/ bridge/src/__tests__/claude-sdk.test.ts && git commit -m "feat: add Claude SDK provider with CLI fallback"
```

---

### Task 20: JSON File Store

**Files:**
- Create: `bridge/src/store/interface.ts`
- Create: `bridge/src/store/json-file.ts`
- Create: `bridge/src/__tests__/json-file-store.test.ts`

- [ ] **Step 1: Define store interface**

```typescript
// bridge/src/store/interface.ts
export interface BridgeStore {
  // Sessions
  getSession(id: string): Promise<SessionData | null>;
  saveSession(session: SessionData): Promise<void>;
  listSessions(): Promise<SessionData[]>;

  // Messages
  getMessages(sessionId: string): Promise<Message[]>;
  saveMessage(sessionId: string, message: Message): Promise<void>;

  // Bindings
  getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null>;
  saveBinding(binding: ChannelBinding): Promise<void>;
  deleteBinding(channelType: string, chatId: string): Promise<void>;

  // Dedup
  isDuplicate(messageId: string): Promise<boolean>;
  markProcessed(messageId: string): Promise<void>;

  // Locks
  acquireLock(key: string, ttl: number): Promise<boolean>;
  renewLock(key: string, ttl: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
}
```

- [ ] **Step 2: Write tests for JsonFileStore**

- [ ] **Step 3: Implement json-file.ts**

Atomic writes (write to `.tmp`, rename). In-memory cache. Per-session message files.

- [ ] **Step 4: Run tests and commit**

```bash
cd bridge && npx vitest run
git add bridge/src/store/ bridge/src/__tests__/json-file-store.test.ts && git commit -m "feat: add JSON file store with atomic writes and memory cache"
```

---

### Task 21: Conversation Engine

**Files:**
- Create: `bridge/src/engine/conversation.ts`
- Create: `bridge/src/engine/router.ts`
- Create: `bridge/src/__tests__/conversation.test.ts`

- [ ] **Step 1: Write test for conversation engine**

Test `processMessage()`:
- Acquires session lock
- Calls LLM provider with correct params
- Consumes SSE stream and accumulates response
- Saves user message and assistant response to store
- Releases lock on completion
- Forwards permission requests to broker

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement conversation.ts**

```typescript
export class ConversationEngine {
  async processMessage(params: {
    sessionId: string;
    text: string;
    attachments?: FileAttachment[];
    onTextDelta?: (delta: string) => void;
    onToolUse?: (tool: ToolUseEvent) => void;
    onPermissionRequest?: (req: PermissionRequestEvent) => Promise<void>;
    onResult?: (result: ResultEvent) => void;
  }): Promise<string> {
    const { store, llm } = getBridgeContext();
    // 1. Acquire session lock
    // 2. Save user message
    // 3. Stream LLM response
    // 4. Parse SSE events, call callbacks
    // 5. Save assistant response
    // 6. Release lock
    // 7. Return full response text
  }
}
```

- [ ] **Step 4: Implement router.ts**

```typescript
export class ChannelRouter {
  async resolve(channelType: string, chatId: string): Promise<ChannelBinding> {
    const { store } = getBridgeContext();
    let binding = await store.getBinding(channelType, chatId);
    if (!binding) {
      binding = await this.createBinding(channelType, chatId);
    }
    return binding;
  }
}
```

- [ ] **Step 5: Run tests and commit**

```bash
cd bridge && npx vitest run
git add bridge/src/engine/ bridge/src/__tests__/conversation.test.ts && git commit -m "feat: add conversation engine and channel router"
```

---

## Phase P3: IM Adapters

**Goal:** Implement Telegram, Discord, and Feishu channel adapters.

### Task 22: Base Channel Adapter

**Files:**
- Create: `bridge/src/channels/base.ts`
- Create: `bridge/src/channels/index.ts`
- Create: `bridge/src/channels/types.ts`

- [ ] **Step 1: Define adapter types and abstract base**

```typescript
// bridge/src/channels/types.ts
export type ChannelType = 'telegram' | 'discord' | 'feishu';

export interface InboundMessage {
  channelType: ChannelType;
  chatId: string;
  userId: string;
  text: string;
  attachments?: FileAttachment[];
  callbackData?: string;  // button click data
  messageId: string;
}

export interface OutboundMessage {
  chatId: string;
  text?: string;
  html?: string;
  buttons?: Button[];
  replyToMessageId?: string;
}

export interface SendResult {
  messageId: string;
  success: boolean;
}

export interface Button {
  label: string;
  callbackData: string;
  style?: 'primary' | 'danger' | 'default';
}

// bridge/src/channels/base.ts
export abstract class BaseChannelAdapter {
  abstract readonly channelType: ChannelType;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract send(message: OutboundMessage): Promise<SendResult>;
  abstract editMessage(chatId: string, messageId: string, message: OutboundMessage): Promise<void>;
  abstract validateConfig(): string | null;
  abstract isAuthorized(userId: string, chatId: string): boolean;
}

// Self-registration
const factories = new Map<ChannelType, () => BaseChannelAdapter>();
export function registerAdapterFactory(type: ChannelType, factory: () => BaseChannelAdapter) {
  factories.set(type, factory);
}
export function createAdapter(type: ChannelType): BaseChannelAdapter {
  const factory = factories.get(type);
  if (!factory) throw new Error(`Unknown channel type: ${type}`);
  return factory();
}
```

- [ ] **Step 2: Create index.ts (empty initially — add imports incrementally)**

```typescript
// bridge/src/channels/index.ts
// Self-registration imports — add each adapter import as it is created in Tasks 23-25
// import './telegram.js';   // Task 23
// import './discord.js';    // Task 24
// import './feishu.js';     // Task 25

export { createAdapter, type BaseChannelAdapter } from './base.js';
```

**Important:** Do NOT uncomment the adapter imports until the corresponding adapter file exists (Tasks 23-25). Each adapter task should uncomment its import line.

- [ ] **Step 3: Commit**

```bash
git add bridge/src/channels/ && git commit -m "feat: add base channel adapter with self-registration pattern"
```

---

### Task 23: Telegram Adapter

**Files:**
- Create: `bridge/src/channels/telegram.ts`
- Create: `bridge/src/__tests__/telegram.test.ts`

- [ ] **Step 1: Write test for Telegram adapter**

Mock `node-telegram-bot-api`. Test:
- `validateConfig()` → checks `TL_TG_BOT_TOKEN` exists
- `isAuthorized()` → checks user against `TL_TG_ALLOWED_USERS`
- `send()` → calls `sendMessage` with HTML parse mode
- `editMessage()` → calls `editMessageText`
- `consumeOne()` → returns inbound messages from polling
- Button callback handling

- [ ] **Step 2: Install dependency**

```bash
cd bridge && npm install node-telegram-bot-api && npm install -D @types/node-telegram-bot-api
```

- [ ] **Step 3: Implement telegram.ts**

```typescript
import TelegramBot from 'node-telegram-bot-api';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';

class TelegramAdapter extends BaseChannelAdapter {
  readonly channelType = 'telegram' as const;
  private bot: TelegramBot | null = null;
  private messageQueue: InboundMessage[] = [];
  private config: Config['telegram'];

  async start() { this.bot = new TelegramBot(this.config.botToken, { polling: true }); ... }
  async stop() { await this.bot?.stopPolling(); }
  async consumeOne() { return this.messageQueue.shift() ?? null; }
  async send(msg) { /* sendMessage with parse_mode: 'HTML', reply_markup for buttons */ }
  async editMessage(chatId, msgId, msg) { /* editMessageText */ }
  validateConfig() { return this.config.botToken ? null : 'TL_TG_BOT_TOKEN is required'; }
  isAuthorized(userId) { return this.config.allowedUsers.includes(userId); }
}

registerAdapterFactory('telegram', () => new TelegramAdapter());
```

- [ ] **Step 4: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/telegram.test.ts
git add bridge/src/channels/telegram.ts bridge/src/__tests__/telegram.test.ts && git commit -m "feat: add Telegram channel adapter"
```

---

### Task 24: Discord Adapter

**Files:**
- Create: `bridge/src/channels/discord.ts`
- Create: `bridge/src/__tests__/discord.test.ts`

- [ ] **Step 1: Install dependency**

```bash
cd bridge && npm install discord.js
```

- [ ] **Step 2: Write test and implement**

Same pattern as Telegram. Key differences:
- Uses `discord.js` `Client` with `GatewayIntentBits.MessageContent`
- Buttons via `ActionRowBuilder` + `ButtonBuilder`
- 2000 char message limit
- Edit-based streaming with 1500ms throttle

- [ ] **Step 3: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/discord.test.ts
git add bridge/src/channels/discord.ts bridge/src/__tests__/discord.test.ts && git commit -m "feat: add Discord channel adapter"
```

---

### Task 25: Feishu Adapter

**Files:**
- Create: `bridge/src/channels/feishu.ts`
- Create: `bridge/src/__tests__/feishu.test.ts`

- [ ] **Step 1: Install dependency**

```bash
cd bridge && npm install @larksuiteoapi/node-sdk
```

- [ ] **Step 2: Write test and implement**

Key features:
- WebSocket event subscription via `WSClient`
- CardKit v2 streaming cards (200ms throttle)
- Interactive card buttons for permissions
- Text fallback for permission commands
- 30000 char limit

- [ ] **Step 3: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/feishu.test.ts
git add bridge/src/channels/feishu.ts bridge/src/__tests__/feishu.test.ts && git commit -m "feat: add Feishu channel adapter with streaming cards"
```

---

## Phase P4: Permission System + Delivery Layer

**Goal:** Implement the permission gateway that blocks tool calls until IM user responds, and the reliable delivery layer for outbound messages.

### Task 26: Permission Gateway

**Files:**
- Create: `bridge/src/permissions/gateway.ts`
- Create: `bridge/src/__tests__/gateway.test.ts`

- [ ] **Step 1: Write test for permission gateway**

- `waitFor(toolUseId)` returns a Promise
- `resolve(toolUseId, 'allow')` resolves the Promise with `true`
- `resolve(toolUseId, 'deny')` resolves the Promise with `false`
- Timeout after 5 minutes auto-denies
- `denyAll()` denies all pending permissions

- [ ] **Step 2: Implement gateway.ts**

```typescript
export class PendingPermissions implements PermissionGateway {
  private pending = new Map<string, { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();

  waitFor(toolUseId: string, timeoutMs = 300_000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.resolve(toolUseId, false); }, timeoutMs);
      this.pending.set(toolUseId, { resolve, timer });
    });
  }

  resolve(toolUseId: string, allowed: boolean): boolean {
    const entry = this.pending.get(toolUseId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.resolve(allowed);
    this.pending.delete(toolUseId);
    return true;
  }

  denyAll(): void {
    for (const [id] of this.pending) { this.resolve(id, false); }
  }
}
```

- [ ] **Step 3: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/gateway.test.ts
git add bridge/src/permissions/ bridge/src/__tests__/gateway.test.ts && git commit -m "feat: add permission gateway with timeout and deny-all"
```

---

### Task 27: Permission Broker

**Files:**
- Create: `bridge/src/permissions/broker.ts`
- Create: `bridge/src/__tests__/broker.test.ts`

- [ ] **Step 1: Write test for broker**

- `forwardPermissionRequest()` formats and sends to all connected IM adapters
- Includes tool name, truncated input (300 chars), buttons, web link
- `handlePermissionCallback()` resolves the correct pending permission
- Callback data format: `perm:allow:<id>`, `perm:deny:<id>`, `perm:allow_session:<id>`

- [ ] **Step 2: Implement broker.ts**

- [ ] **Step 3: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/broker.test.ts
git add bridge/src/permissions/broker.ts bridge/src/__tests__/broker.test.ts && git commit -m "feat: add permission broker for IM approval cards"
```

---

### Task 28: Delivery Layer

**Files:**
- Create: `bridge/src/delivery/delivery.ts`
- Create: `bridge/src/delivery/rate-limiter.ts`
- Create: `bridge/src/__tests__/delivery.test.ts`
- Create: `bridge/src/__tests__/rate-limiter.test.ts`

- [ ] **Step 1: Write test for rate limiter**

- Token bucket: 20 msg/min per chat
- `tryConsume()` returns true when under limit
- Waits when limit reached

- [ ] **Step 2: Implement rate-limiter.ts**

- [ ] **Step 3: Write test for delivery layer**

- Chunking at platform-specific limits
- Retry 3 times with exponential backoff
- HTML parse fallback on error
- Dedup via store
- Inter-chunk delay (300ms)

- [ ] **Step 4: Implement delivery.ts**

- [ ] **Step 5: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/delivery.test.ts src/__tests__/rate-limiter.test.ts
git add bridge/src/delivery/ bridge/src/__tests__/delivery.test.ts bridge/src/__tests__/rate-limiter.test.ts && git commit -m "feat: add delivery layer with chunking, retry, rate limiting, and dedup"
```

---

### Task 29: Markdown IR Rendering

**Files:**
- Create: `bridge/src/markdown/ir.ts`
- Create: `bridge/src/markdown/telegram.ts`
- Create: `bridge/src/markdown/discord.ts`
- Create: `bridge/src/markdown/feishu.ts`
- Create: `bridge/src/__tests__/markdown.test.ts`

- [ ] **Step 1: Install dependency**

```bash
cd bridge && npm install markdown-it && npm install -D @types/markdown-it
```

- [ ] **Step 2: Write tests for markdown rendering**

- IR: parse markdown to intermediate representation
- Telegram: convert IR to HTML (`<b>`, `<i>`, `<code>`, `<pre>`)
- Discord: chunk at 2000 chars with code fence balancing
- Feishu: pass-through markdown for cards

- [ ] **Step 3: Implement all four files**

- [ ] **Step 4: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/markdown.test.ts
git add bridge/src/markdown/ bridge/src/__tests__/markdown.test.ts && git commit -m "feat: add Markdown IR rendering for Telegram, Discord, and Feishu"
```

---

### Task 30: Bridge Manager (Orchestrator)

**Files:**
- Create: `bridge/src/engine/bridge-manager.ts`
- Create: `bridge/src/__tests__/bridge-manager.test.ts`

- [ ] **Step 1: Write test for bridge manager**

- `start()` initializes enabled adapters and starts event loops
- Message routing: regular messages → conversation engine
- Callback routing: permission callbacks → broker
- Command routing: `/new`, `/status`, `/stop`, `/help` → handlers
- Session-level concurrency (different sessions run in parallel, same session serialized)

- [ ] **Step 2: Implement bridge-manager.ts**

```typescript
export class BridgeManager {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;

  async start() {
    const config = loadConfig();
    for (const channelType of config.enabledChannels) {
      const adapter = createAdapter(channelType);
      const err = adapter.validateConfig();
      if (err) { logger.warn(`Skipping ${channelType}: ${err}`); continue; }
      await adapter.start();
      this.adapters.set(channelType, adapter);
      this.runAdapterLoop(adapter);
    }
    this.running = true;
  }

  private async runAdapterLoop(adapter: BaseChannelAdapter) {
    while (this.running) {
      const msg = await adapter.consumeOne();
      if (!msg) { await sleep(100); continue; }
      if (!adapter.isAuthorized(msg.userId, msg.chatId)) continue;
      if (msg.callbackData) { await this.handleCallback(msg); continue; }
      if (msg.text.startsWith('/')) { await this.handleCommand(msg); continue; }
      await this.handleMessage(msg);
    }
  }

  async stop() { ... }
}
```

- [ ] **Step 3: Wire into main.ts**

Update `bridge/src/main.ts` to create and start `BridgeManager`.

- [ ] **Step 4: Run tests and commit**

```bash
cd bridge && npx vitest run
git add bridge/src/engine/bridge-manager.ts bridge/src/__tests__/bridge-manager.test.ts bridge/src/main.ts && git commit -m "feat: add Bridge Manager orchestrator with adapter routing"
```

---

## Phase P5: SKILL.md + Setup Wizard + npm Package

**Goal:** Create the Claude Code skill definition, interactive setup wizard, and npm package distribution.

### Task 31: SKILL.md

**Files:**
- Create: `skill/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

```yaml
---
name: termlive
description: >
  Terminal live monitoring + IM bridge for AI coding tools.
  Monitor sessions remotely, approve tool permissions from
  Telegram/Discord/Feishu, view real-time terminal output in browser.
argument-hint: "setup | start | stop | status | logs [N] | reconfigure | doctor | notify <msg>"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# TermLive Skill

## Command Routing
...
## Setup Wizard
...
## Start/Stop/Status
...
```

Include full fuzzy matching table (EN + CN), setup wizard flow, and all subcommand implementations per spec Section 3.

- [ ] **Step 2: Commit**

```bash
git add skill/ && git commit -m "feat: add Claude Code SKILL.md with setup wizard and subcommands"
```

---

### Task 32: postinstall.js (Go Binary Download)

**Files:**
- Create: `scripts/postinstall.js`

- [ ] **Step 1: Implement postinstall.js**

```javascript
#!/usr/bin/env node
// Downloads precompiled tlive-core binary for current platform
import { execSync } from 'node:child_process';
import { createWriteStream, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { get } from 'node:https';

const GITHUB_REPO = 'termlive/termlive';
const VERSION = 'latest';
const BIN_DIR = join(homedir(), '.termlive', 'bin');

const PLATFORM_MAP = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const ARCH_MAP = { x64: 'amd64', arm64: 'arm64' };

async function download() {
  const os = PLATFORM_MAP[platform()];
  const cpu = ARCH_MAP[arch()];
  const ext = os === 'windows' ? '.exe' : '';
  const url = `https://github.com/${GITHUB_REPO}/releases/${VERSION}/download/tlive-core-${os}-${cpu}${ext}`;

  mkdirSync(BIN_DIR, { recursive: true });
  const dest = join(BIN_DIR, `tlive-core${ext}`);
  // Download and save
  // chmod +x on unix
}

download().catch(console.error);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/postinstall.js && git commit -m "feat: add postinstall script for Go binary download"
```

---

### Task 33: Root package.json (npm Package)

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "termlive",
  "version": "0.1.0",
  "description": "Terminal live monitoring + IM bridge for AI coding tools",
  "type": "module",
  "bin": {
    "termlive": "./scripts/cli.js"
  },
  "scripts": {
    "postinstall": "node scripts/postinstall.js",
    "build": "cd bridge && npm run build",
    "test": "cd bridge && npm test"
  },
  "keywords": ["terminal", "monitoring", "claude-code", "telegram", "discord", "feishu"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/termlive/termlive"
  }
}
```

- [ ] **Step 2: Create scripts/cli.js entry point**

```javascript
#!/usr/bin/env node
import { execSync } from 'node:child_process';
const [,, command, ...args] = process.argv;
// Route: setup → wizard, start/stop/status/logs → daemon.sh
```

- [ ] **Step 3: Commit**

```bash
git add package.json scripts/cli.js && git commit -m "feat: add npm package configuration and CLI entry point"
```

---

### Task 34: Status Line Script

**Files:**
- Create: `scripts/statusline.sh`

- [ ] **Step 1: Write statusline.sh**

Per spec Section 6.1 — reads JSON from stdin, queries Go Core, outputs status line.

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x scripts/statusline.sh
git add scripts/statusline.sh && git commit -m "feat: add Claude Code status line script"
```

---

### Task 34b: Setup Wizard Fallback (Non-Claude-Code)

**Files:**
- Create: `bridge/src/setup-wizard.ts`
- Create: `bridge/src/__tests__/setup-wizard.test.ts`

Per spec Section 15: when `npx termlive setup` runs outside Claude Code, fall back to terminal prompts.

- [ ] **Step 1: Install inquirer**

```bash
cd bridge && npm install inquirer && npm install -D @types/inquirer
```

- [ ] **Step 2: Write test for environment detection and prompt fallback**

Test `isClaudeCodeEnvironment()` returns false when `CLAUDE_CODE` env var is absent. Test `askUser()` delegates to inquirer when outside Claude Code.

- [ ] **Step 3: Implement setup-wizard.ts**

```typescript
import inquirer from 'inquirer';

export function isClaudeCodeEnvironment(): boolean {
  return !!process.env.CLAUDE_CODE;
}

export async function askUser(question: string, choices?: string[]): Promise<string> {
  if (isClaudeCodeEnvironment()) {
    // Will be called via SKILL.md AskUserQuestion — not handled here
    throw new Error('Use AskUserQuestion tool in Claude Code context');
  }
  if (choices) {
    const { answer } = await inquirer.prompt([{ type: 'list', name: 'answer', message: question, choices }]);
    return answer;
  }
  const { answer } = await inquirer.prompt([{ type: 'input', name: 'answer', message: question }]);
  return answer;
}

export async function runSetupWizard(): Promise<void> {
  // 4-step wizard: choose platforms → collect credentials → general settings → write config
}
```

- [ ] **Step 4: Run tests and commit**

```bash
cd bridge && npx vitest run src/__tests__/setup-wizard.test.ts
git add bridge/src/setup-wizard.ts bridge/src/__tests__/setup-wizard.test.ts && git commit -m "feat: add setup wizard with terminal prompt fallback for non-Claude-Code environments"
```

---

### Task 34c: install.sh (Non-npm One-Click Install)

**Files:**
- Create: `scripts/install.sh`

- [ ] **Step 1: Write install.sh**

```bash
#!/bin/bash
# One-click installer for TermLive (without npm)
set -e

echo "=== TermLive Installer ==="
TERMLIVE_HOME="$HOME/.termlive"
mkdir -p "$TERMLIVE_HOME/bin"

# 1. Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in x86_64) ARCH="amd64" ;; aarch64|arm64) ARCH="arm64" ;; esac

# 2. Download Go Core binary
echo "Downloading tlive-core for ${OS}-${ARCH}..."
curl -fSL "https://github.com/termlive/termlive/releases/latest/download/tlive-core-${OS}-${ARCH}" \
  -o "$TERMLIVE_HOME/bin/tlive-core"
chmod +x "$TERMLIVE_HOME/bin/tlive-core"

# 3. Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required for the Bridge. Install from https://nodejs.org/"
  exit 1
fi

# 4. Install Bridge via npm
npm install -g termlive

echo "Done! Run 'npx termlive setup' to configure."
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x scripts/install.sh
git add scripts/install.sh && git commit -m "feat: add one-click install script for non-npm users"
```

---

## Phase P6: Web UI Status Bar

**Goal:** Add a real-time status bar to the TermLive Web dashboard.

### Task 35: Web UI Status Bar

**Files:**
- Modify: `core/web/index.html`
- Create: `core/web/js/statusbar.js`
- Modify: `core/web/css/style.css`

- [ ] **Step 1: Add status bar HTML to index.html**

At the bottom of `<body>` in `core/web/index.html`, add:
```html
<footer id="status-bar" class="status-bar">
  <div class="status-item" id="status-sessions">● 0 sessions</div>
  <div class="status-item" id="status-im">IM: --</div>
  <div class="status-item" id="status-tokens">0/0 tok</div>
  <div class="status-item" id="status-cost">$0.00</div>
  <div class="status-item" id="status-git">git: --</div>
  <div class="status-item" id="status-uptime">0s</div>
</footer>
<script src="/js/statusbar.js"></script>
```

- [ ] **Step 2: Add status bar CSS**

In `core/web/css/style.css`, add:
```css
.status-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 28px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
  z-index: 100;
}
.status-item { white-space: nowrap; }
```

- [ ] **Step 3: Implement statusbar.js**

```javascript
// Connect to /ws/status WebSocket
// Update DOM elements on each status message
const ws = new WebSocket(`ws://${location.host}/ws/status`);
ws.onmessage = (event) => {
  const status = JSON.parse(event.data);
  document.getElementById('status-sessions').textContent = `● ${status.active_sessions} sessions`;
  document.getElementById('status-im').textContent = formatIMStatus(status.bridge);
  document.getElementById('status-tokens').textContent = formatTokens(status.stats);
  document.getElementById('status-cost').textContent = `$${status.stats?.cost_usd?.toFixed(2) ?? '0.00'}`;
  document.getElementById('status-git').textContent = `git: ${status.git?.branch ?? '--'}`;
};
```

- [ ] **Step 4: Update embed.go if needed**

Verify `core/web/embed.go` glob pattern includes `js/statusbar.js`.

- [ ] **Step 5: Build and test**

```bash
cd core && go build -o tlive-core ./cmd/tlive-core/
```

- [ ] **Step 6: Commit**

```bash
git add core/web/ && git commit -m "feat: add real-time status bar to Web UI dashboard"
```

---

## Phase P7: Docker + Open Source Preparation

**Goal:** Create Docker deployment, documentation, and open-source readiness.

### Task 36: Go Core Dockerfile

**Files:**
- Create: `core/Dockerfile`

- [ ] **Step 1: Write multi-stage Dockerfile**

```dockerfile
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o tlive-core ./cmd/tlive-core/

FROM alpine:3.19
RUN apk add --no-cache git
COPY --from=builder /app/tlive-core /usr/local/bin/
EXPOSE 8080
ENTRYPOINT ["tlive-core", "daemon"]
```

- [ ] **Step 2: Commit**

```bash
git add core/Dockerfile && git commit -m "feat: add Go Core Dockerfile"
```

---

### Task 37: Bridge Dockerfile

**Files:**
- Create: `bridge/Dockerfile`

- [ ] **Step 1: Write Dockerfile**

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
CMD ["node", "dist/main.mjs"]
```

- [ ] **Step 2: Commit**

```bash
git add bridge/Dockerfile && git commit -m "feat: add Bridge Dockerfile"
```

---

### Task 38: docker-compose.yml

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Write docker-compose.yml per spec Section 16**

- [ ] **Step 2: Write .env.example**

```env
TL_TOKEN=your-token-here
TL_PORT=8080
TL_TG_BOT_TOKEN=
TL_DC_BOT_TOKEN=
TL_FS_APP_ID=
TL_FS_APP_SECRET=
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml .env.example && git commit -m "feat: add Docker Compose for one-click deployment"
```

---

### Task 39: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write CI workflow**

```yaml
name: CI
on: [push, pull_request]
jobs:
  go-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.24' }
      - run: cd core && go test ./... -v -timeout 60s

  bridge-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cd bridge && npm ci && npm test
```

- [ ] **Step 2: Write release workflow**

Cross-compile Go binary for linux-amd64, linux-arm64, darwin-amd64, darwin-arm64, windows-amd64. Upload as GitHub Release assets.

- [ ] **Step 3: Commit**

```bash
git add .github/ && git commit -m "ci: add GitHub Actions CI and release workflows"
```

---

### Task 40: LICENSE and Final Cleanup

**Files:**
- Create: `LICENSE` (MIT)
- Clean: Remove `tlive.exe` from repo root
- Clean: Remove old `.termlive.toml` from repo root (config now at `~/.termlive/config.env`)
- Verify: `.gitignore` covers `node_modules/`, `dist/`, `*.exe`, `.env`

- [ ] **Step 1: Add LICENSE**

- [ ] **Step 2: Clean up repo root**

```bash
rm -f tlive.exe
```

- [ ] **Step 3: Update .gitignore**

```
node_modules/
dist/
*.exe
.env
core/tlive-core
bridge/dist/
```

- [ ] **Step 4: Commit**

```bash
git add LICENSE .gitignore && git rm --cached tlive.exe 2>/dev/null; git commit -m "chore: add MIT license, clean up repo for open source"
```

---

## Task Dependency Graph

```
P0: Tasks 1-10 (sequential within phase)
     │
     ▼
P1: Tasks 11-17 (sequential)
     │
     ├──────────────────┐
     ▼                  ▼
P2: Tasks 18-21    P6: Tasks 35
     │
     ▼
P3: Tasks 22-25
     │
     ▼
P4: Tasks 26-30
     │
     ▼
P5: Tasks 31-34
     │
     ▼
P7: Tasks 36-40 (after all phases)
```

Note: P6 (Status Line Web UI) can run in parallel with P2-P5 since it only depends on P1 (Go Core APIs).
