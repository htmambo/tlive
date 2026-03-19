# Hook Pause/Resume Design

**Date:** 2026-03-19
**Scope:** Shell scripts + Bridge + CLI (no Go Core changes)

## Problem

Hooks cannot be disabled without stopping Go Core. When the user is at their computer, hook notifications are unnecessary noise.

## Solution

File-based toggle: `~/.tlive/hooks-paused` existence controls hook behavior.

### Script behavior

```
hook-handler.sh / notify-handler.sh:
  ~/.tlive/hooks-paused exists? → exit 0 (auto-allow, no notification)
  otherwise → normal flow
```

### Control interfaces

| Interface | Pause | Resume | Status |
|-----------|-------|--------|--------|
| CLI | `tlive hooks pause` | `tlive hooks resume` | `tlive hooks status` |
| IM | `/hooks pause` | `/hooks resume` | `/hooks` |

### Modified files

- `scripts/hook-handler.sh` — add file check before Go Core check
- `scripts/notify-handler.sh` — same
- `scripts/cli.js` — add `hooks` subcommand
- `bridge/src/engine/bridge-manager.ts` — add `/hooks` command handler
- `bridge/src/__tests__/bridge-manager.test.ts` — add tests
