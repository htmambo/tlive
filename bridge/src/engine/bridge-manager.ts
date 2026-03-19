import { BaseChannelAdapter, createAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { ConversationEngine } from './conversation.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { DeliveryLayer } from '../delivery/delivery.js';
import { getBridgeContext } from '../context.js';
import { loadConfig } from '../config.js';
import { StreamController, type VerboseLevel } from './stream-controller.js';
import { CostTracker } from './cost-tracker.js';

export class BridgeManager {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;
  private engine = new ConversationEngine();
  private router = new ChannelRouter();
  private delivery = new DeliveryLayer();
  private gateway = new PendingPermissions();
  private broker: PermissionBroker;
  private coreUrl: string;
  private token: string;
  private coreAvailable = false;
  private verboseLevels = new Map<string, VerboseLevel>();
  private lastActive = new Map<string, number>();

  constructor() {
    const config = loadConfig();
    this.broker = new PermissionBroker(this.gateway, config.publicUrl);
    this.coreUrl = config.coreUrl;
    this.token = config.token;
  }

  /** Expose coreAvailable flag for main.ts polling loop */
  setCoreAvailable(available: boolean): void {
    this.coreAvailable = available;
  }

  /** Returns all active adapters */
  getAdapters(): BaseChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  registerAdapter(adapter: BaseChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
  }

  async start(): Promise<void> {
    this.running = true;
    for (const [type, adapter] of this.adapters) {
      const err = adapter.validateConfig();
      if (err) { console.warn(`Skipping ${type}: ${err}`); this.adapters.delete(type); continue; }
      await adapter.start();
      this.runAdapterLoop(adapter);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.gateway.denyAll();
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  private stateKey(channelType: string, chatId: string): string {
    return `${channelType}:${chatId}`;
  }

  private getVerboseLevel(channelType: string, chatId: string): VerboseLevel {
    return this.verboseLevels.get(this.stateKey(channelType, chatId)) ?? 1;
  }

  private setVerboseLevel(channelType: string, chatId: string, level: VerboseLevel): void {
    this.verboseLevels.set(this.stateKey(channelType, chatId), level);
  }

  private checkAndUpdateLastActive(channelType: string, chatId: string): boolean {
    const key = this.stateKey(channelType, chatId);
    const last = this.lastActive.get(key);
    const now = Date.now();
    this.lastActive.set(key, now);
    if (last && (now - last) > 30 * 60 * 1000) return true;
    return false;
  }

  private clearLastActive(channelType: string, chatId: string): void {
    this.lastActive.delete(this.stateKey(channelType, chatId));
  }

  private async runAdapterLoop(adapter: BaseChannelAdapter): Promise<void> {
    while (this.running) {
      const msg = await adapter.consumeOne();
      if (!msg) { await new Promise(r => setTimeout(r, 100)); continue; }
      console.log(`[${adapter.channelType}] Message from ${msg.userId}: ${msg.text || '(callback)'}`);
      try {
        await this.handleInboundMessage(adapter, msg);
      } catch (err) {
        console.error(`[${adapter.channelType}] Error handling message:`, err);
      }
    }
  }

  async handleInboundMessage(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    // Auth check
    if (!adapter.isAuthorized(msg.userId, msg.chatId)) return false;

    // Callback data
    if (msg.callbackData) {
      // Hook permission callbacks (hook:allow:ID or hook:deny:ID)
      if (msg.callbackData.startsWith('hook:')) {
        const parts = msg.callbackData.split(':');
        const decision = parts[1]; // allow or deny
        const hookId = parts[2];

        if (this.coreAvailable) {
          try {
            await fetch(`${this.coreUrl}/api/hooks/permission/${hookId}/resolve`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ decision }),
              signal: AbortSignal.timeout(5000),
            });
            await adapter.send({
              chatId: msg.chatId,
              text: decision === 'allow' ? '✅ Allowed' : '❌ Denied',
            });
          } catch (err) {
            await adapter.send({ chatId: msg.chatId, text: `❌ Failed to resolve: ${err}` });
          }
        } else {
          await adapter.send({ chatId: msg.chatId, text: '❌ Go Core not available' });
        }
        return true;
      }

      // Regular permission broker callbacks
      this.broker.handlePermissionCallback(msg.callbackData);
      return true;
    }

    // Commands
    if (msg.text.startsWith('/')) {
      return this.handleCommand(adapter, msg);
    }

    // Session resume: check timeout before resolving
    const expired = this.checkAndUpdateLastActive(msg.channelType, msg.chatId);
    if (expired) {
      const newId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.router.rebind(msg.channelType, msg.chatId, newId);
    }

    const binding = await this.router.resolve(msg.channelType, msg.chatId);

    // Start typing heartbeat
    const typingInterval = setInterval(() => {
      adapter.sendTyping(msg.chatId);
    }, 4000);
    adapter.sendTyping(msg.chatId);

    const verboseLevel = this.getVerboseLevel(msg.channelType, msg.chatId);
    const costTracker = new CostTracker();
    costTracker.start();

    const platformLimits: Record<string, number> = { telegram: 4096, discord: 2000, feishu: 30000 };
    const stream = new StreamController({
      verboseLevel,
      platformLimit: platformLimits[adapter.channelType] ?? 4096,
      flushCallback: async (content, isEdit) => {
        if (!isEdit) {
          const result = await adapter.send({ chatId: msg.chatId, text: content });
          clearInterval(typingInterval);
          return result.messageId;
        } else {
          await adapter.editMessage(msg.chatId, stream.messageId!, { chatId: msg.chatId, text: content });
        }
      },
    });

    try {
      const result = await this.engine.processMessage({
        sessionId: binding.sessionId,
        text: msg.text,
        onTextDelta: (delta) => stream.onTextDelta(delta),
        onToolUse: (event) => stream.onToolStart(event.name, event.input),
        onResult: (event) => {
          if (verboseLevel > 0) {
            const usage = event.usage ?? { input_tokens: 0, output_tokens: 0 };
            const stats = costTracker.finish(usage);
            stream.onComplete(stats);
          }
        },
        onError: (err) => stream.onError(err),
        onPermissionRequest: async (req) => {
          await this.broker.forwardPermissionRequest(req, msg.chatId, [adapter]);
        },
      });

      // Level 0: deliver final response via delivery layer (stream didn't flush text)
      if (verboseLevel === 0) {
        const responseText = result.text.trim();
        const usage = result.usage ?? { input_tokens: 0, output_tokens: 0 };
        const stats = costTracker.finish(usage);
        const costLine = CostTracker.format(stats);
        const fullText = responseText ? `${responseText}\n${costLine}` : costLine;
        await this.delivery.deliver(adapter, msg.chatId, fullText, {
          platformLimit: platformLimits[adapter.channelType] ?? 4096,
        });
      }
    } finally {
      clearInterval(typingInterval);
      stream.dispose();
    }

    return true;
  }

  private async handleCommand(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const parts = msg.text.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/status': {
        const ctx = getBridgeContext();
        const healthy = (ctx.core as any).isHealthy?.() ?? false;
        await adapter.send({
          chatId: msg.chatId,
          text: `TermLive Status\nCore: ${healthy ? '● connected' : '○ disconnected'}\nAdapters: ${this.adapters.size} active`,
        });
        return true;
      }
      case '/new': {
        const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
        this.clearLastActive(msg.channelType, msg.chatId);
        await adapter.send({ chatId: msg.chatId, text: '🆕 New session started.' });
        return true;
      }
      case '/verbose': {
        const level = parseInt(parts[1]) as VerboseLevel;
        if ([0, 1, 2].includes(level)) {
          this.setVerboseLevel(msg.channelType, msg.chatId, level);
          const labels = ['quiet', 'normal', 'detailed'];
          await adapter.send({ chatId: msg.chatId, text: `Verbose level: ${level} (${labels[level]})` });
        } else {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /verbose 0|1|2\n0=quiet, 1=normal, 2=detailed' });
        }
        return true;
      }
      case '/help': {
        await adapter.send({
          chatId: msg.chatId,
          text: 'Commands:\n/status - Show status\n/new - New session\n/verbose 0|1|2 - Set detail level\n/help - Show help',
        });
        return true;
      }
      default:
        return false;
    }
  }
}
