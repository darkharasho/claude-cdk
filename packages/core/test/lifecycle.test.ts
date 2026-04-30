import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetLifecycleForTests,
  killChildTree,
  liveChildCount,
  trackChild,
} from '../src/lifecycle.js';

vi.mock('tree-kill', () => ({
  default: vi.fn((pid: number, signal: string, cb: (err?: Error) => void) => {
    // Simulate async tree-kill that always succeeds.
    setImmediate(() => cb());
    void pid;
    void signal;
  }),
}));

afterEach(() => {
  _resetLifecycleForTests();
});

function makeFakeChild(pid = 12345) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    killed: boolean;
    kill: (signal?: string) => boolean;
  };
  child.pid = pid;
  child.killed = false;
  child.kill = (signal?: string) => {
    child.killed = true;
    void signal;
    return true;
  };
  return child;
}

describe('trackChild', () => {
  it('adds the child to the live set and removes it on close', () => {
    const child = makeFakeChild();
    trackChild(child as never);
    expect(liveChildCount()).toBe(1);
    child.emit('close');
    expect(liveChildCount()).toBe(0);
  });

  it('is idempotent — tracking the same child twice has no effect', () => {
    const child = makeFakeChild();
    trackChild(child as never);
    trackChild(child as never);
    expect(liveChildCount()).toBe(1);
    child.emit('close');
    expect(liveChildCount()).toBe(0);
  });

  it('handles many concurrent children independently', () => {
    const children = Array.from({ length: 5 }, (_, i) => makeFakeChild(1000 + i));
    for (const c of children) trackChild(c as never);
    expect(liveChildCount()).toBe(5);
    children[0]!.emit('close');
    children[2]!.emit('close');
    expect(liveChildCount()).toBe(3);
  });
});

describe('killChildTree', () => {
  it('resolves immediately when the child has no pid', async () => {
    const child = makeFakeChild();
    child.pid = undefined;
    await expect(killChildTree(child as never)).resolves.toBeUndefined();
  });

  it('resolves immediately when the child is already killed', async () => {
    const child = makeFakeChild();
    child.killed = true;
    await expect(killChildTree(child as never)).resolves.toBeUndefined();
  });

  it('invokes tree-kill with the configured signal and resolves on callback', async () => {
    const child = makeFakeChild(7777);
    const treeKill = (await import('tree-kill')).default as unknown as ReturnType<typeof vi.fn>;
    await killChildTree(child as never, 'SIGINT');
    expect(treeKill).toHaveBeenCalled();
    const call = treeKill.mock.calls.find((c: unknown[]) => c[0] === 7777);
    expect(call?.[1]).toBe('SIGINT');
  });
});
