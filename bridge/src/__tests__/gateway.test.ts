import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PendingPermissions } from '../permissions/gateway.js';

describe('PendingPermissions', () => {
  let gateway: PendingPermissions;

  beforeEach(() => {
    gateway = new PendingPermissions();
  });

  it('waitFor returns a promise that resolves on allow', async () => {
    const promise = gateway.waitFor('tool1');
    gateway.resolve('tool1', true);
    expect(await promise).toBe(true);
  });

  it('waitFor returns false on deny', async () => {
    const promise = gateway.waitFor('tool2');
    gateway.resolve('tool2', false);
    expect(await promise).toBe(false);
  });

  it('resolve returns true if permission was pending', () => {
    gateway.waitFor('tool1');
    expect(gateway.resolve('tool1', true)).toBe(true);
  });

  it('resolve returns false if no pending permission', () => {
    expect(gateway.resolve('unknown', true)).toBe(false);
  });

  it('times out after specified duration and auto-denies', async () => {
    const promise = gateway.waitFor('tool1', 50); // 50ms timeout
    const result = await promise;
    expect(result).toBe(false);
  });

  it('denyAll denies all pending permissions', async () => {
    const p1 = gateway.waitFor('t1');
    const p2 = gateway.waitFor('t2');
    gateway.denyAll();
    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
  });

  it('pendingCount returns number of pending', () => {
    gateway.waitFor('t1');
    gateway.waitFor('t2');
    expect(gateway.pendingCount()).toBe(2);
    gateway.resolve('t1', true);
    expect(gateway.pendingCount()).toBe(1);
  });
});
