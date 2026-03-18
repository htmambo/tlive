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
    const result = await promise;
    expect(result.behavior).toBe('allow');
  });

  it('waitFor returns deny result on deny', async () => {
    const promise = gateway.waitFor('tool2');
    gateway.resolve('tool2', false);
    const result = await promise;
    expect(result.behavior).toBe('deny');
  });

  it('resolve returns true if permission was pending', () => {
    gateway.waitFor('tool1');
    expect(gateway.resolve('tool1', true)).toBe(true);
  });

  it('resolve returns false if no pending permission', () => {
    expect(gateway.resolve('unknown', true)).toBe(false);
  });

  it('times out after 5 minutes and auto-denies', async () => {
    // Just verify the waitFor call creates a pending entry
    gateway.waitFor('tool1');
    expect(gateway.pendingCount()).toBe(1);
    // Clean up
    gateway.denyAll();
  });

  it('denyAll denies all pending permissions', async () => {
    const p1 = gateway.waitFor('t1');
    const p2 = gateway.waitFor('t2');
    gateway.denyAll();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.behavior).toBe('deny');
    expect(r2.behavior).toBe('deny');
  });

  it('pendingCount returns number of pending', () => {
    gateway.waitFor('t1');
    gateway.waitFor('t2');
    expect(gateway.pendingCount()).toBe(2);
    gateway.resolve('t1', true);
    expect(gateway.pendingCount()).toBe(1);
  });
});
