import { describe, it, expect, vi } from 'vitest';
import { ClaudeSDKProvider } from '../providers/claude-sdk.js';

describe('ClaudeSDKProvider', () => {
  it('creates a StreamChatResult with stream from streamChat', () => {
    const provider = new ClaudeSDKProvider({ resolvePendingPermission: () => true } as any);
    const result = provider.streamChat({
      prompt: 'test',
      workingDirectory: '/tmp',
    });
    expect(result).toHaveProperty('stream');
    expect(result.stream).toBeInstanceOf(ReadableStream);
  });

  it('resolveProvider returns ClaudeSDKProvider for claude runtime', async () => {
    const { resolveProvider } = await import('../providers/index.js');
    const provider = resolveProvider('claude', {} as any);
    expect(provider).toBeInstanceOf(ClaudeSDKProvider);
  });
});
