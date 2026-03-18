export class PendingPermissions {
  private pending = new Map<string, { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();

  waitFor(toolUseId: string, timeoutMs = 300_000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.resolve(toolUseId, false);
      }, timeoutMs);
      this.pending.set(toolUseId, { resolve, timer });
    });
  }

  resolve(toolUseId: string, allowed: boolean): boolean {
    const entry = this.pending.get(toolUseId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.resolve(allowed);
    this.pending.delete(toolUseId);
    return true;
  }

  denyAll(): void {
    for (const [id] of this.pending) {
      this.resolve(id, false);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
