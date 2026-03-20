import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @larksuiteoapi/node-sdk before importing the adapter
const mockMessageCreate = vi.fn();
const mockMessagePatch = vi.fn().mockResolvedValue({});
const mockEventHandler = vi.fn();
const mockCardHandler = vi.fn();

vi.mock('@larksuiteoapi/node-sdk', () => {
  const MockClient = vi.fn(function (this: any) {
    this.im = {
      message: {
        create: mockMessageCreate,
        patch: mockMessagePatch,
      },
      v1: { messageResource: { get: vi.fn().mockResolvedValue({ data: null }) } },
    };
  });

  const MockEventDispatcher = vi.fn(function (this: any) {
    this.register = vi.fn((handlers: Record<string, Function>) => {
      for (const [key, fn] of Object.entries(handlers)) {
        mockEventHandler.mockImplementation(fn);
      }
    });
    this.invoke = vi.fn(async (body: string) => {
      const parsed = JSON.parse(body);
      if (parsed.type === 'url_verification') {
        return { challenge: parsed.challenge };
      }
      if (parsed.event) {
        await mockEventHandler(parsed.event);
      }
      return {};
    });
  });

  const MockCardActionHandler = vi.fn(function (this: any, _cfg: any, handler: Function) {
    mockCardHandler.mockImplementation(handler);
    this.invoke = vi.fn(async (body: string) => {
      const parsed = JSON.parse(body);
      return mockCardHandler(parsed) ?? {};
    });
  });

  return {
    Client: MockClient,
    EventDispatcher: MockEventDispatcher,
    CardActionHandler: MockCardActionHandler,
  };
});

import { FeishuAdapter } from '../channels/feishu.js';

async function getPort(adapter: FeishuAdapter): Promise<number> {
  const server = (adapter as any).server;
  return server?.address()?.port ?? 0;
}

async function postToEndpoint(port: number, path: string, body: object): Promise<any> {
  const resp = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg-feishu-1' } });
    mockMessagePatch.mockResolvedValue({});
    adapter = new FeishuAdapter({
      appId: 'cli_test123',
      appSecret: 'secret_abc',
      verificationToken: 'verify_token',
      encryptKey: '',
      webhookPort: 0,
      allowedUsers: ['user1', 'user2'],
    });
  });

  it('has correct channelType', () => {
    expect(adapter.channelType).toBe('feishu');
  });

  describe('validateConfig()', () => {
    it('returns error when appId is missing', () => {
      const bad = new FeishuAdapter({ appId: '', appSecret: 'sec', verificationToken: '', encryptKey: '', webhookPort: 0, allowedUsers: [] });
      expect(bad.validateConfig()).toContain('TL_FS_APP_ID');
    });

    it('returns error when appSecret is missing', () => {
      const bad = new FeishuAdapter({ appId: 'id', appSecret: '', verificationToken: '', encryptKey: '', webhookPort: 0, allowedUsers: [] });
      expect(bad.validateConfig()).toContain('TL_FS_APP_SECRET');
    });

    it('returns null when config is valid', () => {
      expect(adapter.validateConfig()).toBeNull();
    });
  });

  describe('isAuthorized()', () => {
    it('allows users in allowedUsers list', () => {
      expect(adapter.isAuthorized('user1', 'chat1')).toBe(true);
    });

    it('denies users not in allowedUsers list', () => {
      expect(adapter.isAuthorized('unknown', 'chat1')).toBe(false);
    });

    it('allows all users when allowedUsers is empty', () => {
      const open = new FeishuAdapter({ appId: 'id', appSecret: 'sec', verificationToken: '', encryptKey: '', webhookPort: 0, allowedUsers: [] });
      expect(open.isAuthorized('anyone', 'anychat')).toBe(true);
    });
  });

  describe('send()', () => {
    it('sends interactive card when buttons are present', async () => {
      await adapter.start();
      const result = await adapter.send({
        chatId: 'oc_chat123',
        text: 'Do you want to allow access?',
        buttons: [
          { label: 'Allow', callbackData: 'perm:allow:123', style: 'primary' },
          { label: 'Deny', callbackData: 'perm:deny:123', style: 'danger' },
        ],
      });

      expect(mockMessageCreate).toHaveBeenCalledOnce();
      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.data.msg_type).toBe('interactive');

      const card = JSON.parse(call.data.content);
      expect(card.config.wide_screen_mode).toBe(true);
      expect(card.elements[0].tag).toBe('markdown');
      expect(card.elements[0].content).toBe('Do you want to allow access?');
      expect(card.elements[1].tag).toBe('action');
      expect(card.elements[1].actions).toHaveLength(2);
      expect(card.elements[1].actions[0].text.content).toBe('Allow');
      expect(card.elements[1].actions[0].value.action).toBe('perm:allow:123');
      expect(card.elements[1].actions[1].type).toBe('danger');

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-feishu-1');
      await adapter.stop();
    });

    it('sends post message for plain text (no buttons)', async () => {
      await adapter.start();
      const result = await adapter.send({
        chatId: 'oc_chat123',
        text: 'Hello from TermLive',
      });

      expect(mockMessageCreate).toHaveBeenCalledOnce();
      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.data.msg_type).toBe('post');

      const post = JSON.parse(call.data.content);
      expect(post.zh_cn.content[0][0].tag).toBe('md');
      expect(post.zh_cn.content[0][0].text).toBe('Hello from TermLive');

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-feishu-1');
      await adapter.stop();
    });

    it('uses html content as text when text is not provided', async () => {
      await adapter.start();
      await adapter.send({ chatId: 'oc_chat123', html: '**bold**' });

      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.data.msg_type).toBe('post');
      const post = JSON.parse(call.data.content);
      expect(post.zh_cn.content[0][0].text).toBe('**bold**');
      await adapter.stop();
    });

    it('sends message content using markdown tag', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'oc_chat123',
        text: '**Permission Request**\nUser wants access',
        buttons: [{ label: 'OK', callbackData: 'ok:1' }],
      });

      const call = mockMessageCreate.mock.calls[0][0];
      const card = JSON.parse(call.data.content);
      // markdown element carries the text
      expect(card.elements[0].tag).toBe('markdown');
      await adapter.stop();
    });

    it('sets receive_id and receive_id_type correctly', async () => {
      await adapter.start();
      await adapter.send({ chatId: 'oc_specific_chat', text: 'hi' });

      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.params.receive_id_type).toBe('chat_id');
      expect(call.data.receive_id).toBe('oc_specific_chat');
      await adapter.stop();
    });

    it('passes root_id when replyToMessageId is set', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'oc_chat123',
        text: 'Reply text',
        replyToMessageId: 'msg-parent-1',
      });

      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.data.root_id).toBe('msg-parent-1');
      await adapter.stop();
    });

    it('throws when client is not started', async () => {
      await expect(adapter.send({ chatId: 'oc_chat123', text: 'hi' })).rejects.toThrow(
        'Feishu client not started',
      );
    });
  });

  describe('start() / stop()', () => {
    it('initializes client on start', async () => {
      await adapter.start();
      // After start, send should not throw "not started"
      await expect(
        adapter.send({ chatId: 'oc_chat', text: 'test' }),
      ).resolves.toBeDefined();
      await adapter.stop();
    });

    it('clears client on stop so subsequent sends fail', async () => {
      await adapter.start();
      await adapter.stop();
      await expect(adapter.send({ chatId: 'oc_chat', text: 'test' })).rejects.toThrow(
        'Feishu client not started',
      );
    });
  });

  describe('consumeOne()', () => {
    it('returns null when queue is empty', async () => {
      const msg = await adapter.consumeOne();
      expect(msg).toBeNull();
    });
  });

  describe('editMessage()', () => {
    it('patches message with interactive card', async () => {
      await adapter.start();
      await adapter.editMessage('oc_chat123', 'msg-feishu-1', {
        chatId: 'oc_chat123',
        text: 'Updated content',
      });
      expect(mockMessagePatch).toHaveBeenCalledOnce();
      const call = mockMessagePatch.mock.calls[0][0];
      expect(call.path.message_id).toBe('msg-feishu-1');
      const card = JSON.parse(call.data.content);
      expect(card.elements[0].tag).toBe('markdown');
      expect(card.elements[0].content).toBe('Updated content');
      await adapter.stop();
    });

    it('does nothing when client is not started', async () => {
      await adapter.editMessage('oc_chat', 'msg-1', { chatId: 'oc_chat', text: 'hi' });
      expect(mockMessagePatch).not.toHaveBeenCalled();
    });
  });

  describe('sendTyping()', () => {
    it('is a no-op that resolves without error', async () => {
      await adapter.start();
      await expect(adapter.sendTyping('oc_chat123')).resolves.toBeUndefined();
      await adapter.stop();
    });
  });

  describe('webhook event handling', () => {
    it('processes text messages via webhook', async () => {
      await adapter.start();
      const port = await getPort(adapter);

      await postToEndpoint(port, '/event', {
        event: {
          message: {
            message_id: 'msg_1', chat_id: 'chat_1',
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello' }),
          },
          sender: { sender_id: { user_id: 'user_1' } },
        },
      });

      const msg = await adapter.consumeOne();
      expect(msg).not.toBeNull();
      expect(msg!.text).toBe('Hello');
      expect(msg!.chatId).toBe('chat_1');

      await adapter.stop();
    });

    it('handles URL verification challenge', async () => {
      await adapter.start();
      const port = await getPort(adapter);

      const resp = await postToEndpoint(port, '/event', {
        type: 'url_verification',
        challenge: 'test_challenge',
      });
      expect(resp.challenge).toBe('test_challenge');

      await adapter.stop();
    });
  });

  describe('card action callbacks', () => {
    it('processes button clicks as callbackData', async () => {
      await adapter.start();
      const port = await getPort(adapter);

      await postToEndpoint(port, '/card', {
        action: { value: { action: 'perm:allow:123:s1' } },
        open_chat_id: 'chat_1',
        open_id: 'user_1',
        open_message_id: 'msg_1',
      });

      const msg = await adapter.consumeOne();
      expect(msg).not.toBeNull();
      expect(msg!.callbackData).toBe('perm:allow:123:s1');

      await adapter.stop();
    });
  });
});
