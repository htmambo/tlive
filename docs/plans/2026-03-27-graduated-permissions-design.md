# Graduated Permissions + Dynamic Whitelist + Message Delay Design

## Overview

Three tightly coupled improvements to the permission UX, all building on the extracted `PermissionCoordinator`:

1. **Graduated permission buttons** — tool-specific approval options instead of uniform Yes/No
2. **Dynamic session whitelist** — approved tools auto-allowed for the rest of the session
3. **Conditional tool delay** — 250ms buffer on tool_start events to prevent flicker

## 1. Graduated Permission Buttons

### Current
All tools get the same two buttons: `[✅ Yes] [❌ No]`

### New
Buttons vary by tool type:

| Tool Category | Detection | Buttons |
|--------------|-----------|---------|
| Edit tools | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `[✅ Yes] [✅ Allow all edits] [❌ No]` |
| Bash commands | `Bash` | `[✅ Yes] [✅ Allow Bash({prefix}*)] [❌ No]` |
| Other tools | everything else | `[✅ Yes] [✅ Allow {toolName}] [❌ No]` |

The middle button's callback data encodes the whitelist action:
- `perm:allow_edits:{permId}` — sets acceptEdits mode via SDK
- `perm:allow_tool:{permId}:{toolName}` — adds tool to session whitelist
- `perm:allow_bash:{permId}:{prefix}` — adds Bash prefix to session whitelist

### Bash Prefix Extraction

Extract the first "word" of the command as the prefix:
```
"npm test" → "npm"
"git push origin main" → "git"
"cd /tmp && ls" → "cd"  (conservative — only first word)
```

The button shows: `Allow Bash(npm *)` — user sees exactly what pattern they're approving.

### Implementation

In `bridge-manager.ts`'s `sdkPermissionHandler`, replace the static two-button array with dynamic generation:

```typescript
function makePermissionButtons(permId: string, toolName: string, toolInput: Record<string, unknown>): Button[] {
  const buttons: Button[] = [
    { label: '✅ Yes', callbackData: `perm:allow:${permId}`, style: 'primary' },
  ];

  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  if (EDIT_TOOLS.has(toolName)) {
    buttons.push({ label: '✅ Allow all edits', callbackData: `perm:allow_edits:${permId}`, style: 'default' });
  } else if (toolName === 'Bash') {
    const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
    const prefix = cmd.split(/\s/)[0];
    if (prefix) {
      buttons.push({ label: `✅ Allow Bash(${prefix} *)`, callbackData: `perm:allow_bash:${permId}:${prefix}`, style: 'default' });
    }
  } else {
    buttons.push({ label: `✅ Allow ${toolName}`, callbackData: `perm:allow_tool:${permId}:${toolName}`, style: 'default' });
  }

  buttons.push({ label: '❌ No', callbackData: `perm:deny:${permId}`, style: 'danger' });
  return buttons;
}
```

## 2. Dynamic Session Whitelist

### State (in PermissionCoordinator)

```typescript
private allowedTools = new Set<string>();
private allowedBashPrefixes = new Set<string>();
```

### Check (before prompting)

In `sdkPermissionHandler`, before showing the permission card:

```typescript
if (this.permissions.isToolAllowed(toolName, toolInput)) {
  return 'allow';
}
```

`isToolAllowed` logic:
```typescript
isToolAllowed(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (this.allowedTools.has(toolName)) return true;
  if (toolName === 'Bash') {
    const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
    const firstWord = cmd.split(/\s/)[0];
    if (firstWord && this.allowedBashPrefixes.has(firstWord)) return true;
  }
  return false;
}
```

### Add to whitelist (on button click)

When the user clicks the middle button, `PermissionCoordinator.handleCallback` parses the action:
- `perm:allow_edits:{permId}` → resolve allow + (no whitelist change — SDK handles `acceptEdits` mode)
- `perm:allow_tool:{permId}:{toolName}` → resolve allow + `allowedTools.add(toolName)`
- `perm:allow_bash:{permId}:{prefix}` → resolve allow + `allowedBashPrefixes.add(prefix)`

### Clear on session reset

When `/new` is called or session expires (30-min timeout), clear the whitelist:
```typescript
permissions.clearSessionWhitelist();
```

## 3. Conditional Tool Delay (250ms)

### Problem
Currently, `onToolStart` immediately adds to `toolEntries` and triggers a flush. Fast tool calls (Read, Grep) flash in the terminal card then immediately get replaced by the next tool — visual noise.

### Solution
Buffer tool_start events for 250ms before displaying:

```typescript
// In TerminalCardRenderer
private pendingTool?: { entry: ToolEntry; timer: ReturnType<typeof setTimeout> };

onToolStart(name: string, input: Record<string, unknown>): string {
  // Flush any previous pending tool immediately
  this.flushPendingTool();

  const id = `tool-${++this.toolIdCounter}`;
  const entry = { id, name, title: getToolTitle(name, input), running: true, denied: false };

  // Buffer for 250ms
  this.pendingTool = {
    entry,
    timer: setTimeout(() => {
      this.commitTool(entry);
      this.pendingTool = undefined;
    }, 250),
  };

  return id;
}

onToolComplete(toolUseId: string, result?: string, isError?: boolean): void {
  // If the completing tool is still pending, flush it immediately with its result
  if (this.pendingTool?.entry.id === toolUseId) {
    clearTimeout(this.pendingTool.timer);
    const entry = this.pendingTool.entry;
    entry.running = false;
    if (result) entry.resultPreview = getToolResultPreview(entry.name, result, isError);
    this.commitTool(entry);
    this.pendingTool = undefined;
    return;
  }
  // Normal path for already-displayed tools
  // ... existing logic
}

onPermissionNeeded(...): void {
  // Flush pending tool immediately — user needs context
  this.flushPendingTool();
  // ... existing logic
}

private flushPendingTool(): void {
  if (!this.pendingTool) return;
  clearTimeout(this.pendingTool.timer);
  this.commitTool(this.pendingTool.entry);
  this.pendingTool = undefined;
}

private commitTool(entry: ToolEntry): void {
  this.toolEntries.push(entry);
  this.enforceWindow();
  if (this.verboseLevel > 0) this.scheduleFlush();
}
```

### Release triggers
- **Timer expires (250ms)** — tool is still running, display it
- **tool_result arrives** — tool finished fast, display entry + result together (no flash)
- **Permission request** — user needs to see the tool context before deciding
- **Another tool_start** — flush previous pending, start new buffer
- **dispose()** — flush any pending tool

## File Changes

| Action | File | Change |
|--------|------|--------|
| Modify | `engine/permission-coordinator.ts` | Add `allowedTools`, `allowedBashPrefixes`, `isToolAllowed()`, `addAllowedTool()`, `addAllowedBashPrefix()`, `clearSessionWhitelist()`, update callback handling |
| Modify | `engine/bridge-manager.ts` | `sdkPermissionHandler`: check whitelist before prompting, generate graduated buttons, handle new callback types, clear whitelist on session reset |
| Modify | `engine/terminal-card-renderer.ts` | Add `pendingTool` buffer, modify `onToolStart`/`onToolComplete`/`onPermissionNeeded`/`dispose` |
| Modify | `engine/session-state.ts` | Add hook for session reset notification (so permissions can clear whitelist) |
| Modify | `formatting/permission.ts` | Update `makeButtons` to accept tool info and generate graduated buttons (for hook permissions too) |

## Out of Scope

- `acceptEdits` mode via SDK `setPermissionMode()` — the button resolves as `allow` for now; true mode switching is sub-project 2c
- Persisting whitelist across bridge restarts — session-scoped only
- Per-user whitelists (all users in a chat share the same whitelist)
