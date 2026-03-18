import { describe, it, expect } from 'vitest';
import { markdownToTelegram, markdownToDiscordChunks, markdownToFeishu } from '../markdown/index.js';

describe('Telegram rendering', () => {
  it('converts bold', () => {
    expect(markdownToTelegram('**hello**')).toContain('<b>hello</b>');
  });

  it('converts inline code', () => {
    expect(markdownToTelegram('`code`')).toContain('<code>code</code>');
  });

  it('converts code blocks', () => {
    const result = markdownToTelegram('```js\nconsole.log()\n```');
    expect(result).toContain('<pre>');
    expect(result).toContain('console.log()');
  });

  it('strips unsupported HTML tags', () => {
    const result = markdownToTelegram('# Heading\nparagraph');
    // Telegram doesn't support <h1>, should be plain text or bold
    expect(result).not.toContain('<h1>');
  });
});

describe('Discord chunking', () => {
  it('returns single chunk for short text', () => {
    const chunks = markdownToDiscordChunks('hello world');
    expect(chunks).toHaveLength(1);
  });

  it('chunks at 2000 chars', () => {
    const long = 'x'.repeat(3000);
    const chunks = markdownToDiscordChunks(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('balances code fences across chunks', () => {
    const md = '```\n' + 'x'.repeat(2500) + '\n```';
    const chunks = markdownToDiscordChunks(md);
    // Each chunk with a code block should be properly fenced
    for (const chunk of chunks) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0); // even number = balanced
    }
  });
});

describe('Feishu rendering', () => {
  it('passes through markdown unchanged', () => {
    const md = '**bold** and `code`';
    expect(markdownToFeishu(md)).toBe(md);
  });
});
