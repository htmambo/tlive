import { chunkMarkdown } from '../delivery/delivery.js';

export function markdownToDiscordChunks(text: string, limit = 2000): string[] {
  return chunkMarkdown(text, limit);
}
