export interface BridgeStore {}
export interface LLMProvider {}
export interface PermissionGateway {}
export interface CoreClient {}

export interface LifecycleHooks {
  onBridgeStart?(): Promise<void>;
  onBridgeStop?(): Promise<void>;
}

export interface BridgeContext {
  store: BridgeStore;
  llm: LLMProvider;
  permissions: PermissionGateway;
  core: CoreClient;
  lifecycle?: LifecycleHooks;
}

const CONTEXT_KEY = '__termlive_bridge_context__';

export function initBridgeContext(ctx: BridgeContext): void {
  (globalThis as any)[CONTEXT_KEY] = ctx;
}

export function getBridgeContext(): BridgeContext {
  const ctx = (globalThis as any)[CONTEXT_KEY];
  if (!ctx) throw new Error('BridgeContext not initialized. Call initBridgeContext() first.');
  return ctx;
}
