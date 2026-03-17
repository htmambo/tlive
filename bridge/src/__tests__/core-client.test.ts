import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { CoreClientImpl } from '../core-client.js';

let server: Server;
let port: number;
const TOKEN = 'test-token';

beforeAll(async () => {
  server = createServer((req, res) => {
    // Check auth
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://localhost`);

    if (req.method === 'POST' && url.pathname === '/api/bridge/register') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else if (req.method === 'POST' && url.pathname === '/api/bridge/heartbeat') {
      res.writeHead(200);
      res.end();
    } else if (req.method === 'GET' && url.pathname === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 'sess1', command: 'bash', status: 'running' }]));
    } else if (req.method === 'GET' && url.pathname === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 100, output_tokens: 50, cost_usd: 0.01 }));
    } else if (req.method === 'POST' && url.pathname === '/api/stats') {
      res.writeHead(200);
      res.end();
    } else if (req.method === 'GET' && url.pathname === '/api/git/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ branch: 'main', diff_count: 3, clean: false }));
    } else if (req.method === 'POST' && url.pathname === '/api/tokens/scoped') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: 'scoped-abc', session_id: 'sess1', expires_at: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>(resolve => {
    server.listen(0, () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});

afterAll(() => server.close());

describe('CoreClientImpl', () => {
  it('connects and registers', async () => {
    const client = new CoreClientImpl(`http://localhost:${port}`, TOKEN);
    await client.connect();
    expect(client.isHealthy()).toBe(true);
    await client.disconnect();
  });

  it('lists sessions', async () => {
    const client = new CoreClientImpl(`http://localhost:${port}`, TOKEN);
    await client.connect();
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess1');
    await client.disconnect();
  });

  it('gets stats', async () => {
    const client = new CoreClientImpl(`http://localhost:${port}`, TOKEN);
    await client.connect();
    const stats = await client.getStats();
    expect(stats.input_tokens).toBe(100);
    await client.disconnect();
  });

  it('reports stats', async () => {
    const client = new CoreClientImpl(`http://localhost:${port}`, TOKEN);
    await client.connect();
    await expect(client.reportStats({ input_tokens: 10, output_tokens: 5, cost_usd: 0.001 })).resolves.not.toThrow();
    await client.disconnect();
  });

  it('gets git status', async () => {
    const client = new CoreClientImpl(`http://localhost:${port}`, TOKEN);
    await client.connect();
    const git = await client.getGitStatus();
    expect(git.branch).toBe('main');
    await client.disconnect();
  });

  it('creates scoped token', async () => {
    const client = new CoreClientImpl(`http://localhost:${port}`, TOKEN);
    await client.connect();
    const token = await client.createScopedToken('sess1');
    expect(token).toBe('scoped-abc');
    await client.disconnect();
  });

  it('reports unhealthy when server unreachable', async () => {
    const client = new CoreClientImpl('http://localhost:1', TOKEN);
    try { await client.connect(); } catch {}
    expect(client.isHealthy()).toBe(false);
  });
});
