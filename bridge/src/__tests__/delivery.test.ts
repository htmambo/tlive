import { describe, it, expect, vi } from 'vitest';
import { DeliveryLayer } from '../delivery/delivery.js';
import type { BaseChannelAdapter } from '../channels/base.js';

function mockAdapter(): BaseChannelAdapter {
  return {
    channelType: 'telegram',
    send: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
    editMessage: vi.fn(), start: vi.fn(), stop: vi.fn(),
    consumeOne: vi.fn(), validateConfig: vi.fn(), isAuthorized: vi.fn(),
  } as any;
}

describe('DeliveryLayer', () => {
  it('delivers short message in one chunk', async () => {
    const adapter = mockAdapter();
    const layer = new DeliveryLayer();
    await layer.deliver(adapter, 'chat1', 'hello');
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it('chunks long message at platform limit', async () => {
    const adapter = mockAdapter();
    const layer = new DeliveryLayer();
    const longMsg = 'x'.repeat(5000); // Telegram limit is 4096
    await layer.deliver(adapter, 'chat1', longMsg, { platformLimit: 4096 });
    expect((adapter.send as any).mock.calls.length).toBeGreaterThan(1);
  });

  it('retries on failure', async () => {
    const adapter = mockAdapter();
    let callCount = 0;
    (adapter.send as any).mockImplementation(() => {
      callCount++;
      if (callCount < 3) throw new Error('server error');
      return { messageId: '1', success: true };
    });
    const layer = new DeliveryLayer();
    await layer.deliver(adapter, 'chat1', 'hello');
    expect(callCount).toBe(3);
  });

  it('gives up after max retries', async () => {
    const adapter = mockAdapter();
    (adapter.send as any).mockRejectedValue(new Error('fail'));
    const layer = new DeliveryLayer();
    await expect(layer.deliver(adapter, 'chat1', 'hello')).rejects.toThrow('fail');
  });
});
