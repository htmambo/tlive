import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock discord.js before importing the adapter
const mockSend = vi.fn().mockResolvedValue({ id: 'msg-99' });
const mockEdit = vi.fn().mockResolvedValue({});
const mockSendTyping = vi.fn().mockResolvedValue(undefined);
const mockFetchMessage = vi.fn().mockResolvedValue({
  id: 'msg-99',
  edit: mockEdit,
});
const mockFetchChannel = vi.fn().mockResolvedValue({
  send: mockSend,
  messages: { fetch: mockFetchMessage },
  isTextBased: () => true,
  sendTyping: mockSendTyping,
});
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();

vi.mock('discord.js', () => {
  const MockClient = vi.fn(function (this: any) {
    this.on = mockOn;
    this.login = mockLogin;
    this.destroy = mockDestroy;
    this.channels = { fetch: mockFetchChannel };
  });

  class MockButtonBuilder {
    private data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(label: string) { this.data.label = label; return this; }
    setStyle(style: unknown) { this.data.style = style; return this; }
  }

  class MockActionRowBuilder {
    private components: unknown[] = [];
    addComponents(...items: unknown[]) { this.components.push(...items); return this; }
  }

  const ButtonStyle = { Primary: 1, Danger: 4 };
  const GatewayIntentBits = { Guilds: 1, GuildMessages: 2, MessageContent: 4 };

  return {
    Client: MockClient,
    ButtonBuilder: MockButtonBuilder,
    ActionRowBuilder: MockActionRowBuilder,
    ButtonStyle,
    GatewayIntentBits,
  };
});

import { DiscordAdapter } from '../channels/discord.js';

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter({
      botToken: 'test-bot-token',
      allowedUsers: ['user1', 'user2'],
      allowedChannels: ['channel1'],
    });
  });

  it('has correct channelType', () => {
    expect(adapter.channelType).toBe('discord');
  });

  describe('validateConfig()', () => {
    it('returns error when botToken is missing', () => {
      const bad = new DiscordAdapter({ botToken: '', allowedUsers: [], allowedChannels: [] });
      expect(bad.validateConfig()).toContain('TL_DC_BOT_TOKEN');
    });

    it('returns null when config is valid', () => {
      expect(adapter.validateConfig()).toBeNull();
    });
  });

  describe('isAuthorized()', () => {
    it('allows users in allowedUsers list', () => {
      expect(adapter.isAuthorized('user1', 'channel1')).toBe(true);
    });

    it('denies users not in allowedUsers list', () => {
      expect(adapter.isAuthorized('unknown', 'channel1')).toBe(false);
    });

    it('denies channels not in allowedChannels list', () => {
      expect(adapter.isAuthorized('user1', 'other-channel')).toBe(false);
    });

    it('allows all users when allowedUsers is empty', () => {
      const open = new DiscordAdapter({ botToken: 'tok', allowedUsers: [], allowedChannels: [] });
      expect(open.isAuthorized('anyone', 'anychannel')).toBe(true);
    });

    it('allows all channels when allowedChannels is empty', () => {
      const open = new DiscordAdapter({ botToken: 'tok', allowedUsers: ['u1'], allowedChannels: [] });
      expect(open.isAuthorized('u1', 'any-channel')).toBe(true);
    });

    it('denies if user passes but channel fails', () => {
      const a = new DiscordAdapter({ botToken: 'tok', allowedUsers: ['u1'], allowedChannels: ['c1'] });
      expect(a.isAuthorized('u1', 'c2')).toBe(false);
    });
  });

  describe('send()', () => {
    it('calls channel.send with message content', async () => {
      await adapter.start();
      const result = await adapter.send({ chatId: 'channel1', text: 'Hello Discord!' });
      expect(mockFetchChannel).toHaveBeenCalledWith('channel1');
      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ content: 'Hello Discord!' }));
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-99');
    });

    it('calls channel.send with button components', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'channel1',
        text: 'Choose:',
        buttons: [
          { label: 'Allow', callbackData: 'perm:allow:123', style: 'primary' },
          { label: 'Deny', callbackData: 'perm:deny:123', style: 'danger' },
        ],
      });
      const call = mockSend.mock.calls[0][0];
      expect(call.components).toHaveLength(1);
    });

    it('chunks content exceeding 2000 chars into multiple messages', async () => {
      await adapter.start();
      const longText = 'a'.repeat(2500);
      await adapter.send({ chatId: 'channel1', text: longText });
      expect(mockSend.mock.calls.length).toBeGreaterThan(1);
      // All chunks combined should equal original content
      const allContent = mockSend.mock.calls.map((c: any) => c[0].content).join('');
      expect(allContent).toBe(longText);
    });

    it('sends multiple messages for long content with newlines', async () => {
      await adapter.start();
      const longText = 'x\n'.repeat(1500);
      await adapter.send({ chatId: 'channel1', text: longText });
      const channel = await (adapter as any).client.channels.fetch('channel1');
      expect(channel.send.mock.calls.length).toBeGreaterThan(1);
    });

    it('attaches buttons only to last chunk', async () => {
      await adapter.start();
      const longText = 'a'.repeat(2500);
      await adapter.send({
        chatId: 'channel1',
        text: longText,
        buttons: [{ label: 'OK', callbackData: 'ok', style: 'primary' as const }],
      });
      const calls = mockSend.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      // Only the last call should have components
      for (let i = 0; i < calls.length - 1; i++) {
        expect(calls[i][0].components).toBeUndefined();
      }
      expect(calls[calls.length - 1][0].components).toHaveLength(1);
    });

    it('uses html content when text is not provided', async () => {
      await adapter.start();
      await adapter.send({ chatId: 'channel1', html: '<b>bold</b>' });
      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ content: '<b>bold</b>' }));
    });
  });

  describe('reply support', () => {
    it('includes reply reference when replyToMessageId set', async () => {
      await adapter.start();
      await adapter.send({ chatId: 'channel1', text: 'response', replyToMessageId: 'msg-123' });
      const channel = await (adapter as any).client.channels.fetch('channel1');
      const payload = channel.send.mock.calls[0][0];
      expect(payload.reply?.messageReference).toBe('msg-123');
    });

    it('reply reference only on first chunk', async () => {
      await adapter.start();
      const longText = 'a'.repeat(2500);
      await adapter.send({ chatId: 'channel1', text: longText, replyToMessageId: 'msg-456' });
      const calls = mockSend.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      expect(calls[0][0].reply?.messageReference).toBe('msg-456');
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i][0].reply).toBeUndefined();
      }
    });
  });

  describe('error wrapping', () => {
    it('wraps send errors as BridgeError', async () => {
      await adapter.start();
      mockSend.mockRejectedValueOnce(new Error('Discord API failed'));
      try {
        await adapter.send({ chatId: 'channel1', text: 'fail' });
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.name).toBeDefined();
        expect(err.retryable).toBeDefined();
      }
    });
  });

  describe('editMessage()', () => {
    it('fetches then edits the message', async () => {
      await adapter.start();
      await adapter.editMessage('channel1', 'msg-99', { chatId: 'channel1', text: 'Updated!' });
      expect(mockFetchChannel).toHaveBeenCalledWith('channel1');
      expect(mockFetchMessage).toHaveBeenCalledWith('msg-99');
      expect(mockEdit).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated!' }));
    });
  });

  describe('start() / stop()', () => {
    it('calls client.login on start', async () => {
      await adapter.start();
      expect(mockLogin).toHaveBeenCalledWith('test-bot-token');
    });

    it('calls client.destroy on stop', async () => {
      await adapter.start();
      await adapter.stop();
      expect(mockDestroy).toHaveBeenCalled();
    });
  });

  describe('consumeOne()', () => {
    it('returns null when queue is empty', async () => {
      const msg = await adapter.consumeOne();
      expect(msg).toBeNull();
    });
  });

  describe('sendTyping()', () => {
    it('calls channel.sendTyping', async () => {
      await adapter.start();
      await adapter.sendTyping('channel1');
      expect(mockFetchChannel).toHaveBeenCalledWith('channel1');
      expect(mockSendTyping).toHaveBeenCalled();
    });

    it('swallows errors', async () => {
      await adapter.start();
      mockFetchChannel.mockRejectedValueOnce(new Error('network'));
      await expect(adapter.sendTyping('channel1')).resolves.toBeUndefined();
    });
  });
});
