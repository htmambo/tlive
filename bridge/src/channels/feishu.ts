import { createServer, type Server } from 'node:http';
import { Client, EventDispatcher, CardActionHandler } from '@larksuiteoapi/node-sdk';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult, FileAttachment } from './types.js';
import { loadConfig } from '../config.js';
import { classifyError } from './errors.js';
import { markdownToFeishu } from '../markdown/feishu.js';

/** Feishu interactive card element (markdown block, action block, etc.) */
interface FeishuCardElement {
  tag: string;
  content?: string;
  actions?: Array<{
    tag: string;
    text: { tag: string; content: string };
    type: string;
    value: Record<string, string>;
  }>;
}

/** Shape of the Feishu message.create API response */
interface FeishuCreateMessageResult {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}

/** Shape of the Feishu card action callback data */
interface FeishuCardActionData {
  action?: { value?: { action?: string } };
  open_chat_id?: string;
  open_id?: string;
  open_message_id?: string;
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  webhookPort: number;
  allowedUsers: string[];
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu' as const;
  private client: Client | null = null;
  private server: Server | null = null;
  private config: FeishuConfig;
  private messageQueue: InboundMessage[] = [];

  constructor(config: FeishuConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    this.client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const eventDispatcher = new EventDispatcher({
      verificationToken: this.config.verificationToken,
      encryptKey: this.config.encryptKey,
    });

    eventDispatcher.register({
      'im.message.receive_v1': async (event: { sender?: { sender_id?: { user_id?: string } }; message?: { message_type?: string; content: string; chat_id: string; message_id: string } }) => {
        const msg = event?.message;
        if (!msg) return;

        const userId = event?.sender?.sender_id?.user_id ?? '';
        const attachments: FileAttachment[] = [];

        if (msg.message_type === 'text') {
          let text = '';
          try {
            const content = JSON.parse(msg.content);
            text = content.text ?? '';
          } catch {
            return;
          }

          this.messageQueue.push({
            channelType: 'feishu',
            chatId: msg.chat_id,
            userId,
            text,
            messageId: msg.message_id,
          });
        } else if (msg.message_type === 'image') {
          try {
            const imageKey = JSON.parse(msg.content).image_key;
            const resp = await this.client!.im.v1.messageResource.get({
              path: { message_id: msg.message_id, file_key: imageKey },
              params: { type: 'image' },
            });
            if (resp?.data) {
              const chunks: Buffer[] = [];
              for await (const chunk of resp.data as AsyncIterable<Buffer>) {
                chunks.push(chunk);
              }
              const buf = Buffer.concat(chunks);
              if (buf.length <= 10_000_000) {
                attachments.push({
                  type: 'image', name: 'image.png',
                  mimeType: 'image/png', base64Data: buf.toString('base64'),
                });
              }
            }
          } catch { /* skip undownloadable images */ }

          if (attachments.length > 0) {
            this.messageQueue.push({
              channelType: 'feishu',
              chatId: msg.chat_id,
              userId,
              text: '',
              messageId: msg.message_id,
              attachments,
            });
          }
        } else if (msg.message_type === 'file') {
          try {
            const fileKey = JSON.parse(msg.content).file_key;
            const resp = await this.client!.im.v1.messageResource.get({
              path: { message_id: msg.message_id, file_key: fileKey },
              params: { type: 'file' },
            });
            if (resp?.data) {
              const chunks: Buffer[] = [];
              for await (const chunk of resp.data as AsyncIterable<Buffer>) {
                chunks.push(chunk);
              }
              const buf = Buffer.concat(chunks);
              if (buf.length <= 10_000_000) {
                attachments.push({
                  type: 'file', name: 'file',
                  mimeType: 'application/octet-stream', base64Data: buf.toString('base64'),
                });
              }
            }
          } catch { /* skip undownloadable files */ }

          if (attachments.length > 0) {
            this.messageQueue.push({
              channelType: 'feishu',
              chatId: msg.chat_id,
              userId,
              text: '',
              messageId: msg.message_id,
              attachments,
            });
          }
        }
      },
    });

    const cardHandler = new CardActionHandler({}, (data: unknown) => {
      const cardData = data as FeishuCardActionData;
      const callbackData = cardData?.action?.value?.action;
      if (!callbackData) return {};

      this.messageQueue.push({
        channelType: 'feishu',
        chatId: cardData.open_chat_id ?? '',
        userId: cardData.open_id ?? '',
        text: '',
        callbackData,
        messageId: cardData.open_message_id ?? '',
      });

      return {};
    });

    this.server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString('utf-8');

      let result: unknown;
      try {
        if (req.url === '/event') {
          result = await eventDispatcher.invoke(body);
        } else if (req.url === '/card') {
          result = await cardHandler.invoke(body);
        } else {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
      } catch (err) {
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result ?? {}));
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.webhookPort, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => (err ? reject(err) : resolve()));
      });
      this.server = null;
    }
    this.client = null;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  private buildCard(text: string, buttons?: OutboundMessage['buttons']): string {
    const elements: FeishuCardElement[] = [
      { tag: 'markdown', content: text },
    ];

    if (buttons?.length) {
      elements.push({
        tag: 'action',
        actions: buttons.map(btn => ({
          tag: 'button',
          text: { tag: 'plain_text', content: btn.label },
          type: btn.style === 'danger' ? 'danger' : 'primary',
          value: { action: btn.callbackData },
        })),
      });
    }

    return JSON.stringify({
      config: { wide_screen_mode: true },
      elements,
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.client) throw new Error('Feishu client not started');

    const raw = message.text ?? message.html ?? '';

    try {
      if (message.buttons?.length) {
        const result = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: message.chatId,
            msg_type: 'interactive',
            content: this.buildCard(raw, message.buttons),
            ...(message.replyToMessageId ? { root_id: message.replyToMessageId } : {}),
          },
        });

        const messageId = (result as FeishuCreateMessageResult)?.data?.message_id ?? '';
        return { messageId: String(messageId), success: true };
      } else {
        const text = markdownToFeishu(raw);
        const post = {
          zh_cn: {
            content: [[{ tag: 'md', text }]],
          },
        };

        const result = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: message.chatId,
            msg_type: 'post',
            content: JSON.stringify(post),
            ...(message.replyToMessageId ? { root_id: message.replyToMessageId } : {}),
          },
        });

        const messageId = (result as FeishuCreateMessageResult)?.data?.message_id ?? '';
        return { messageId: String(messageId), success: true };
      }
    } catch (err) {
      throw classifyError('feishu', err);
    }
  }

  async editMessage(_chatId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const text = message.text ?? message.html ?? '';

    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: this.buildCard(text, message.buttons),
        },
      });
    } catch (err) {
      throw classifyError('feishu', err);
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu has no native typing API; streaming card updates serve this purpose
  }

  validateConfig(): string | null {
    if (!this.config.appId) return 'TL_FS_APP_ID is required for Feishu';
    if (!this.config.appSecret) return 'TL_FS_APP_SECRET is required for Feishu';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    if (this.config.allowedUsers.length === 0) return true;
    return this.config.allowedUsers.includes(userId);
  }
}

// Self-register
registerAdapterFactory('feishu', () => new FeishuAdapter(loadConfig().feishu));
