/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 * Based on Claude-to-IM-skill's implementation.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { sseEvent } from './sse-utils.js';
import type { LLMProvider, StreamChatParams } from './base.js';
import type { PendingPermissions } from '../permissions/gateway.js';

export class ClaudeSDKProvider implements LLMProvider {
  private pendingPerms: PendingPermissions;

  constructor(pendingPerms: PendingPermissions) {
    this.pendingPerms = pendingPerms;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;

    return new ReadableStream({
      start(controller) {
        (async () => {
          let hasReceivedResult = false;

          try {
            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model: params.model || undefined,
              resume: params.sessionId || undefined,
              permissionMode: params.permissionMode || undefined,
              abortController: params.abortSignal
                ? Object.assign(new AbortController(), { signal: params.abortSignal })
                : undefined,
              canUseTool: async (
                toolName: string,
                input: Record<string, unknown>,
                opts: { toolUseID: string; suggestions?: string[] },
              ): Promise<PermissionResult> => {
                controller.enqueue(
                  sseEvent('permission_request', {
                    permissionRequestId: opts.toolUseID,
                    toolName,
                    toolInput: input,
                  }),
                );

                const result = await pendingPerms.waitFor(opts.toolUseID);

                if (result.behavior === 'allow') {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                return {
                  behavior: 'deny' as const,
                  message: result.message || 'Denied by user',
                };
              },
            };

            const q = query({
              prompt: params.prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            let hasStreamedText = false;

            for await (const msg of q) {
              const streamed = handleMessage(msg, controller, (v) => { hasReceivedResult = v; }, hasStreamedText);
              if (streamed) hasStreamedText = true;
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[claude-sdk] query error:', message);

            // If result was already received, this is just transport teardown noise
            if (hasReceivedResult && message.includes('process exited with code')) {
              controller.close();
              return;
            }

            controller.enqueue(sseEvent('error', message));
            controller.close();
          }
        })();
      },
    });
  }
}

/** Returns true if text was streamed in this message. */
function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  setHasReceivedResult: (v: boolean) => void,
  hasStreamedText: boolean,
): boolean {
  let didStreamText = false;

  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        controller.enqueue(sseEvent('text', event.delta.text));
        didStreamText = true;
      }
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        controller.enqueue(sseEvent('tool_use', {
          id: event.content_block.id,
          name: event.content_block.name,
          input: {},
        }));
      }
      break;
    }

    case 'assistant': {
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            controller.enqueue(sseEvent('tool_use', {
              id: block.id,
              name: block.name,
              input: block.input,
            }));
          } else if (block.type === 'text' && block.text && !hasStreamedText) {
            // Fallback: if no stream_event text_delta was received,
            // emit the full text from the assistant message
            controller.enqueue(sseEvent('text', block.text));
            didStreamText = true;
          }
        }
      }
      break;
    }

    case 'user': {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            controller.enqueue(sseEvent('tool_result', {
              tool_use_id: rb.tool_use_id,
              content: typeof rb.content === 'string' ? rb.content : JSON.stringify(rb.content ?? ''),
              is_error: rb.is_error || false,
            }));
          }
        }
      }
      break;
    }

    case 'result': {
      setHasReceivedResult(true);
      if (msg.subtype === 'success') {
        controller.enqueue(sseEvent('result', {
          session_id: msg.session_id,
          is_error: msg.is_error,
          usage: {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            cost_usd: msg.total_cost_usd,
          },
        }));
      } else {
        const errors = 'errors' in msg && Array.isArray(msg.errors)
          ? msg.errors.join('; ')
          : 'Unknown error';
        controller.enqueue(sseEvent('error', errors));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(sseEvent('status', {
          session_id: msg.session_id,
          model: msg.model,
        }));
      }
      break;
    }
  }

  return didStreamText;
}
