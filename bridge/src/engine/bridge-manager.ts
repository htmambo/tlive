import { BaseChannelAdapter, createAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { ConversationEngine } from './conversation.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { DeliveryLayer } from '../delivery/delivery.js';
import { getBridgeContext } from '../context.js';
import { loadConfig } from '../config.js';

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

    // Regular message → conversation engine
    const binding = await this.router.resolve(msg.channelType, msg.chatId);

    const result = await this.engine.processMessage({
      sessionId: binding.sessionId,
      text: msg.text,
      onTextDelta: (delta) => {
        // TODO: streaming preview via adapter.editMessage
      },
      onPermissionRequest: async (req) => {
        await this.broker.forwardPermissionRequest(req, msg.chatId, [adapter]);
      },
    });

    // Deliver response (skip if empty)
    const responseText = result.text.trim();
    if (responseText) {
      const platformLimits: Record<string, number> = { telegram: 4096, discord: 2000, feishu: 30000 };
      await this.delivery.deliver(adapter, msg.chatId, responseText, {
        platformLimit: platformLimits[adapter.channelType] ?? 4096,
      });
    } else {
      await adapter.send({ chatId: msg.chatId, text: '(no response)' });
    }

    return true;
  }

  private async handleCommand(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const cmd = msg.text.split(' ')[0].toLowerCase();

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
        await this.router.resolve(msg.channelType, msg.chatId);
        await adapter.send({ chatId: msg.chatId, text: 'New session created.' });
        return true;
      }
      case '/help': {
        await adapter.send({
          chatId: msg.chatId,
          text: 'Commands:\n/status - Show status\n/new - New session\n/help - Show help',
        });
        return true;
      }
      default:
        return false;
    }
  }
}
