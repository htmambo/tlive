export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
}

export interface WaitForOptions {
  onTimeout?: (toolUseId: string) => void;
  timeoutMs?: number;
}

export class PendingPermissions {
  private pending = new Map<string, {
    resolve: (r: PermissionResult) => void;
    timer: NodeJS.Timeout;
  }>();
  private timeoutMs = 5 * 60 * 1000; // 5 minutes

  waitFor(toolUseId: string, options?: WaitForOptions): Promise<PermissionResult> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseId);
        options?.onTimeout?.(toolUseId);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, timeoutMs);
      this.pending.set(toolUseId, { resolve, timer });
    });
  }

  resolve(permissionRequestId: string, allowed: boolean, message?: string): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    if (allowed) {
      entry.resolve({ behavior: 'allow' });
    } else {
      entry.resolve({ behavior: 'deny', message: message || 'Denied by user' });
    }
    this.pending.delete(permissionRequestId);
    return true;
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ behavior: 'deny', message: 'Bridge shutting down' });
    }
    this.pending.clear();
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
