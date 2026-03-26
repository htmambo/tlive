import { describe, it, expect } from 'vitest';
import { formatPermissionCard } from '../formatting/permission.js';
import { formatNotification } from '../formatting/notification.js';

describe('formatPermissionCard', () => {
  const baseData = {
    toolName: 'Bash',
    toolInput: 'npm run build',
    permissionId: 'perm-123',
    expiresInMinutes: 5,
    terminalUrl: 'https://example.com/terminal',
  };

  it('telegram: returns HTML with structured sections', () => {
    const msg = formatPermissionCard(baseData, 'telegram');
    expect(msg.html).toContain('<b>Permission Required</b>');
    expect(msg.html).toContain('<b>Tool:</b> Bash');
    expect(msg.html).toContain('<pre>npm run build</pre>');
    expect(msg.html).toContain('Expires in 5 minutes');
    expect(msg.html).toContain('<a href="https://example.com/terminal">');
    expect(msg.buttons).toHaveLength(3);
    expect(msg.buttons![0].callbackData).toBe('perm:allow:perm-123');
    expect(msg.buttons![1].callbackData).toBe('perm:allow_session:perm-123');
    expect(msg.buttons![2].callbackData).toBe('perm:deny:perm-123');
  });

  it('discord: returns embed with amber color', () => {
    const msg = formatPermissionCard(baseData, 'discord');
    expect(msg.embed).toBeDefined();
    expect(msg.embed!.title).toContain('Permission Required');
    expect(msg.embed!.color).toBe(0xFFA500);
    expect(msg.embed!.description).toContain('npm run build');
    expect(msg.embed!.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Tool', value: 'Bash' }),
      ])
    );
    expect(msg.buttons).toHaveLength(3);
  });

  it('feishu: returns text with card built by caller', () => {
    const msg = formatPermissionCard(baseData, 'feishu');
    expect(msg.text).toContain('**Tool:** Bash');
    expect(msg.text).toContain('npm run build');
    expect(msg.feishuHeader).toEqual({ template: 'orange', title: expect.stringContaining('Permission Required') });
    expect(msg.buttons).toHaveLength(3);
  });

  it('truncates long tool input', () => {
    const longData = { ...baseData, toolInput: 'x'.repeat(500) };
    const msg = formatPermissionCard(longData, 'telegram');
    expect(msg.html!.length).toBeLessThan(800);
  });

  it('omits terminal link when url not provided', () => {
    const noUrl = { ...baseData, terminalUrl: undefined };
    const msg = formatPermissionCard(noUrl, 'telegram');
    expect(msg.html).not.toContain('<a href=');
  });
});

describe('formatNotification', () => {
  it('stop: telegram returns HTML with blockquote summary', () => {
    const msg = formatNotification(
      { type: 'stop', title: 'Task Complete', summary: 'Fixed the auth bug', terminalUrl: 'https://x.com/t' },
      'telegram'
    );
    expect(msg.html).toContain('<b>Task Complete</b>');
    expect(msg.html).toContain('<blockquote>');
    expect(msg.html).toContain('Fixed the auth bug');
    expect(msg.html).toContain('<a href="https://x.com/t">');
  });

  it('stop: discord returns green embed', () => {
    const msg = formatNotification(
      { type: 'stop', title: 'Task Complete', summary: 'Done' },
      'discord'
    );
    expect(msg.embed).toBeDefined();
    expect(msg.embed!.color).toBe(0x00CC66);
    expect(msg.embed!.title).toContain('Task Complete');
  });

  it('idle_prompt: discord returns blue embed', () => {
    const msg = formatNotification(
      { type: 'idle_prompt', title: 'Waiting for Input' },
      'discord'
    );
    expect(msg.embed!.color).toBe(0x3399FF);
  });

  it('feishu: returns card data with header', () => {
    const msg = formatNotification(
      { type: 'stop', title: 'Task Complete', summary: 'Done' },
      'feishu'
    );
    expect(msg.feishuHeader).toEqual({ template: 'green', title: expect.stringContaining('Task Complete') });
    expect(msg.text).toContain('Done');
  });

  it('truncates long summaries', () => {
    const msg = formatNotification(
      { type: 'stop', title: 'Done', summary: 'x'.repeat(4000) },
      'telegram'
    );
    expect(msg.html!.length).toBeLessThan(4000);
  });
});
