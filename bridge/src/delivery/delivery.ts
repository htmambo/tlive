import type { BaseChannelAdapter } from '../channels/base.js';
import type { OutboundMessage } from '../channels/types.js';
import { ChatRateLimiter } from './rate-limiter.js';

interface DeliveryOptions {
  platformLimit?: number;
  maxRetries?: number;
  interChunkDelayMs?: number;
}

export class DeliveryLayer {
  private rateLimiter = new ChatRateLimiter(20, 60_000);

  async deliver(
    adapter: BaseChannelAdapter,
    chatId: string,
    text: string,
    options: DeliveryOptions = {}
  ): Promise<void> {
    const { platformLimit = 4096, maxRetries = 3, interChunkDelayMs = 300 } = options;
    const chunks = this.chunk(text, platformLimit);

    for (let i = 0; i < chunks.length; i++) {
      // Rate limit
      while (!this.rateLimiter.tryConsume(chatId)) {
        await new Promise(r => setTimeout(r, 1000));
      }

      await this.sendWithRetry(adapter, { chatId, text: chunks[i] }, maxRetries);

      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, interChunkDelayMs));
      }
    }
  }

  private async sendWithRetry(
    adapter: BaseChannelAdapter,
    message: OutboundMessage,
    maxRetries: number
  ): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await adapter.send(message);
        return;
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  private chunk(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    // Split at line boundaries when possible
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', limit);
      if (splitAt <= 0) splitAt = limit;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
      if (remaining.startsWith('\n')) remaining = remaining.slice(1);
    }
    return chunks;
  }
}
