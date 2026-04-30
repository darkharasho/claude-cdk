/**
 * Process lifecycle management for CDK-spawned children.
 *
 * Two responsibilities:
 *   1. Track every CLI child we spawn so the parent can clean them up on
 *      exit. Without this, killing the host Node process leaves child
 *      `claude` processes (and the MCP servers they spawn) as orphans.
 *   2. Provide async `killChildTree()` for explicit aborts that cleanly
 *      reaches grandchildren too.
 *
 * Cleanup on parent `'exit'` is best-effort and synchronous (Node's `exit`
 * event only allows sync work). For SIGINT/SIGTERM we leave default Node
 * behavior in place and rely on POSIX process-group propagation plus the
 * `exit` handler firing during shutdown. This keeps us from interfering
 * with consumer signal handlers (e.g. Vite's, Vitest's, the user's own).
 */

import type { ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';

const liveChildren = new Set<ChildProcess>();
let exitHandlerInstalled = false;

/**
 * Register a child for cleanup on parent exit. Idempotent — safe to call
 * multiple times for the same child. Auto-removes the child when it
 * `close`s normally.
 */
export function trackChild(child: ChildProcess): void {
  if (liveChildren.has(child)) return;
  liveChildren.add(child);
  child.once('close', () => {
    liveChildren.delete(child);
  });
  ensureExitHandler();
}

/**
 * Kill the child and its entire process tree.
 *
 * Strategy: signal the immediate child synchronously (so the parent's
 * stdio closes promptly), then `tree-kill` any descendants asynchronously
 * to catch grandchildren the CLI itself may have spawned (MCP servers,
 * etc.). Resolves once the descendant kill has been signaled.
 */
export function killChildTree(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<void> {
  if (child.killed) return Promise.resolve();
  // Synchronous immediate-child kill. Closes stdio promptly so any
  // pending stream readers can wind down.
  try {
    child.kill(signal);
  } catch {
    /* best effort */
  }
  if (!child.pid) return Promise.resolve();
  return new Promise((resolve) => {
    treeKill(child.pid as number, signal, () => resolve());
  });
}

/** Returns the current number of live tracked children (test helper). */
export function liveChildCount(): number {
  return liveChildren.size;
}

/**
 * Test-only helper to forget all tracked children. Does not kill them.
 * Used by the test suite to keep state isolated across cases.
 */
export function _resetLifecycleForTests(): void {
  liveChildren.clear();
}

function ensureExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => {
    for (const child of liveChildren) {
      if (child.pid && !child.killed) {
        try {
          // Synchronous best-effort kill; tree-kill is async and won't run
          // here. Children that survive will still receive process-group
          // SIGHUP/SIGTERM from the OS shortly after.
          child.kill('SIGTERM');
        } catch {
          /* best effort */
        }
      }
    }
  });
}
