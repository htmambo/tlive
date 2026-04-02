import { describe, it, expect } from 'vitest';
import { createNodeAgent, createUndiciAgent } from '../proxy.js';

describe('createNodeAgent (for grammy / node-fetch)', () => {
  it('returns undefined for empty string', () => {
    expect(createNodeAgent('')).toBeUndefined();
  });

  it('returns SocksProxyAgent for socks5:// URL', () => {
    const agent = createNodeAgent('socks5://127.0.0.1:1080');
    expect(agent).toBeDefined();
    expect(agent!.constructor.name).toBe('SocksProxyAgent');
  });

  it('returns SocksProxyAgent for socks4:// URL', () => {
    const agent = createNodeAgent('socks4://127.0.0.1:1080');
    expect(agent).toBeDefined();
    expect(agent!.constructor.name).toBe('SocksProxyAgent');
  });

  it('returns HttpsProxyAgent for http:// URL', () => {
    const agent = createNodeAgent('http://127.0.0.1:7890');
    expect(agent).toBeDefined();
    expect(agent!.constructor.name).toBe('HttpsProxyAgent');
  });

  it('returns HttpsProxyAgent for https:// URL', () => {
    const agent = createNodeAgent('https://127.0.0.1:7890');
    expect(agent).toBeDefined();
    expect(agent!.constructor.name).toBe('HttpsProxyAgent');
  });

  it('throws on unsupported protocol', () => {
    expect(() => createNodeAgent('ftp://foo')).toThrow();
  });
});

describe('createUndiciAgent (for discord.js)', () => {
  it('returns undefined for empty string', () => {
    expect(createUndiciAgent('')).toBeUndefined();
  });

  it('returns ProxyAgent for http:// URL', () => {
    const agent = createUndiciAgent('http://127.0.0.1:7890');
    expect(agent).toBeDefined();
  });

  it('returns ProxyAgent for https:// URL', () => {
    const agent = createUndiciAgent('https://127.0.0.1:7890');
    expect(agent).toBeDefined();
  });

  it('returns undefined and warns for socks:// URL', () => {
    const agent = createUndiciAgent('socks5://127.0.0.1:1080');
    expect(agent).toBeUndefined();
  });
});
