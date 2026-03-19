#!/bin/bash
# TLive Notification Hook — forwards notifications to Go Core
HOOK_JSON=$(cat)

# Check if hooks are paused
[ -f "$HOME/.tlive/hooks-paused" ] && exit 0

[ -f "$HOME/.tlive/config.env" ] && source "$HOME/.tlive/config.env" 2>/dev/null
TL_PORT="${TL_PORT:-8080}"
TL_TOKEN="${TL_TOKEN:-}"

# Check if Go Core is running, forward if so
curl -sf -X POST "http://localhost:${TL_PORT}/api/hooks/notify" \
  -H "Authorization: Bearer ${TL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$HOOK_JSON" \
  --max-time 5 >/dev/null 2>&1

exit 0
