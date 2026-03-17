const BRIDGE_VERSION = '0.1.0';
const HEARTBEAT_INTERVAL_MS = 15_000;

export class CoreClientImpl {
  private baseUrl: string;
  private token: string;
  private healthy = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async connect(): Promise<void> {
    await this.request('POST', '/api/bridge/register', {
      version: BRIDGE_VERSION,
      core_min_version: '0.1.0',
      channels: [],
    });
    this.healthy = true;
    this.heartbeatInterval = setInterval(() => {
      this.heartbeat().catch(() => {
        this.healthy = false;
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.healthy = false;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async listSessions(): Promise<any[]> {
    return this.request('GET', '/api/sessions');
  }

  async getStats(): Promise<any> {
    return this.request('GET', '/api/stats');
  }

  async reportStats(stats: { input_tokens: number; output_tokens: number; cost_usd: number }): Promise<void> {
    await this.request('POST', '/api/stats', stats);
  }

  async getGitStatus(): Promise<any> {
    return this.request('GET', '/api/git/status');
  }

  async createScopedToken(sessionId: string): Promise<string> {
    const result = await this.request('POST', '/api/tokens/scoped', { session_id: sessionId });
    return result.token;
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`Core API error: ${res.status} ${res.statusText}`);
    if (res.headers.get('content-type')?.includes('application/json')) {
      return res.json();
    }
  }

  private async heartbeat(): Promise<void> {
    await this.request('POST', '/api/bridge/heartbeat');
  }
}
