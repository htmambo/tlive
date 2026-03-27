import { CostTracker, type UsageStats } from './cost-tracker.js';

export type VerboseLevel = 0 | 1 | 2;

const TOOL_EMOJI: Record<string, string> = {
  Read: '📖', Edit: '✏️', Write: '📝',
  Bash: '🖥️', Grep: '🔍', Glob: '📂',
  Agent: '🤖', WebSearch: '🌐', WebFetch: '🌐',
};

function getToolEmoji(name: string): string {
  return TOOL_EMOJI[name] ?? '🔧';
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return '';
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read': return str(input.file_path).split('/').pop() ?? '';
    case 'Edit': case 'Write': return str(input.file_path).split('/').pop() ?? '';
    case 'Grep': return `"${str(input.pattern)}" in ${str(input.path) || '.'}`;
    case 'Glob': return str(input.pattern);
    case 'Bash': return str(input.command).slice(0, 80);
    default: return '';
  }
}

/** Build compact tool summary with global counts: "📖 Read ×45 · 🖥️ Bash ×12 · 🔍 Grep ×8 (128 total)" */
function compactToolSummary(tools: string[]): string {
  if (tools.length === 0) return '';
  // Global count per tool name
  const counts = new Map<string, number>();
  for (const header of tools) {
    const match = header.match(/^.+?\s(\w+)/);
    const name = match?.[1] ?? 'unknown';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // Sort by count descending
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const parts = sorted.map(([name, count]) =>
    `${getToolEmoji(name)} ${name}${count > 1 ? ` ×${count}` : ''}`
  );
  return parts.join(' · ') + (tools.length > 5 ? ` (${tools.length} total)` : '');
}

interface StreamControllerOptions {
  verboseLevel: VerboseLevel;
  platformLimit: number;
  throttleMs?: number;
  minInitialChars?: number;
  flushCallback: (content: string, isEdit: boolean) => Promise<string | void>;
}

export class StreamController {
  private buffer = '';
  private toolHeaders: string[] = [];
  private _messageId?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private verboseLevel: VerboseLevel;
  private platformLimit: number;
  private throttleMs: number;
  private flushCallback: (content: string, isEdit: boolean) => Promise<string | void>;
  private flushing = false;
  private pendingFlush = false;
  private lastCostLine?: string;
  private minInitialChars: number;
  private agentStatus?: string;

  get messageId(): string | undefined {
    return this._messageId;
  }

  constructor(options: StreamControllerOptions) {
    this.verboseLevel = options.verboseLevel;
    this.platformLimit = options.platformLimit;
    this.throttleMs = options.throttleMs ?? 300;
    this.minInitialChars = options.minInitialChars ?? 50;
    this.flushCallback = options.flushCallback;
  }

  onTextDelta(text: string): void {
    this.buffer += text;
    if (this.verboseLevel === 0) return;
    this.scheduleFlush();
  }

  onToolStart(name: string, input?: Record<string, unknown>): void {
    if (this.verboseLevel === 0) return;

    let header = `${getToolEmoji(name)} ${name}`;
    if (this.verboseLevel === 2 && input) {
      const summary = summarizeToolInput(name, input);
      if (summary) header += ` ${summary}`;
    }
    this.toolHeaders.push(header);
    this.scheduleFlush();
  }

  onAgentProgress(description: string, lastTool?: string, usage?: { tool_uses: number; duration_ms: number }): void {
    if (this.verboseLevel === 0) return;
    let status = `🤖 ${description}`;
    if (lastTool) status += ` → ${getToolEmoji(lastTool)} ${lastTool}`;
    if (usage) status += ` (${usage.tool_uses} tools, ${Math.round(usage.duration_ms / 1000)}s)`;
    this.agentStatus = status;
    this.scheduleFlush();
  }

  onAgentComplete(summary: string, status: 'completed' | 'failed' | 'stopped'): void {
    if (this.verboseLevel === 0) return;
    const icon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏹';
    this.agentStatus = `${icon} ${summary.slice(0, 100)}`;
    this.scheduleFlush();
  }

  onComplete(stats: UsageStats): void {
    const costLine = CostTracker.format(stats);
    this.lastCostLine = costLine;
    const content = this.compose(costLine);
    this.cancelTimer();
    this.doFlush(content);
  }

  onError(error: string): void {
    this.cancelTimer();
    const content = `❌ Error: ${error}`;
    this.doFlush(content);
  }

  dispose(): void {
    this.cancelTimer();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Debounce initial send: wait for enough content before creating the first message.
      // But always flush if we have tool headers or agent progress — so users see progress
      // during long tool-use loops even before any text is generated.
      const hasProgress = this.toolHeaders.length > 0 || !!this.agentStatus;
      if (!this._messageId && this.buffer.length < this.minInitialChars && !hasProgress && this.verboseLevel > 0) {
        this.scheduleFlush(); // reschedule
        return;
      }
      const content = this.compose();
      this.doFlush(content);
    }, this.throttleMs);
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private compose(costLine?: string): string {
    const parts: string[] = [];

    if (this.toolHeaders.length > 0 && this.verboseLevel > 0) {
      parts.push(compactToolSummary(this.toolHeaders));
      parts.push('━━━━━━━━━━━━━━━━━━');
    }

    if (this.agentStatus && this.verboseLevel > 0) {
      parts.push(this.agentStatus);
    }

    if (this.buffer && this.verboseLevel > 0) {
      parts.push(this.buffer);
    }

    if (costLine) {
      parts.push(costLine);
    }

    let content = parts.join('\n');

    if (content.length > this.platformLimit) {
      const tail = content.slice(-(this.platformLimit - 100));
      content = '...\n' + tail;
    }

    return content;
  }

  private async doFlush(content: string): Promise<void> {
    if (!content) return;
    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }
    this.flushing = true;
    try {
      const isEdit = !!this._messageId;
      const result = await this.flushCallback(content, isEdit);
      if (!isEdit && typeof result === 'string') {
        this._messageId = result;
      }
    } finally {
      this.flushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        const retryContent = this.compose(this.lastCostLine);
        if (retryContent) await this.doFlush(retryContent);
      }
    }
  }
}
