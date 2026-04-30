/**
 * CDKSession — the runtime implementation of the public `Session` interface.
 *
 * Multi-turn is achieved via the CLI's own session persistence (canonical
 * state lives in `~/.claude/projects/`):
 *   - First `send()` spawns the child with `--session-id <id>` to pre-assign
 *   - Subsequent `send()`s spawn with `--resume <id>` to continue the thread
 *
 * Each `send()` = one CLI invocation = one turn = one fresh child process.
 * Concurrent sessions are independent child processes; we do not share
 * process state in core.
 */

import { randomUUID } from 'node:crypto';
import type { spawn } from 'node:child_process';
import type { Session, SessionOptions } from './api.js';
import { spawnCli, type SpawnHandle } from './child.js';
import type { CDKEvent, SessionAbortedEvent } from './events.js';
import { buildSpawnArgs } from './spawn-args.js';

export interface CDKSessionDeps {
  binaryPath: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  /** Source of randomness for a fresh session id (overridable for tests). */
  newId?: () => string;
  /** Clock for synthesized session.aborted event (overridable for tests). */
  now?: () => number;
}

export class CDKSession implements Session {
  readonly id: string;

  private readonly opts: SessionOptions;
  private readonly deps: CDKSessionDeps;
  /** Once true, future spawns use --resume instead of --session-id. */
  private hasStarted: boolean;
  private aborted = false;
  private closed = false;
  private currentHandle: SpawnHandle | null = null;

  constructor(opts: SessionOptions, deps: CDKSessionDeps, hasStarted = false) {
    this.opts = opts;
    this.deps = deps;
    this.hasStarted = hasStarted;
    this.id = opts.resumeSessionId ?? opts.sessionId ?? (deps.newId ?? randomUUID)();
  }

  async *send(prompt: string): AsyncIterable<CDKEvent> {
    if (this.closed) throw new Error('Session is closed');
    if (this.aborted) throw new Error('Session is aborted');

    const args = buildSpawnArgs(
      // Pin sessionId on the options so buildSpawnArgs renders --session-id
      // on the first turn.
      { ...this.opts, sessionId: this.id, resumeSessionId: undefined },
      this.hasStarted ? { prompt, resumeSessionId: this.id } : { prompt },
    );

    const handle = spawnCli({
      binaryPath: this.deps.binaryPath,
      args,
      cwd: this.opts.cwd,
      ...(this.deps.env !== undefined ? { env: this.deps.env } : {}),
      ...(this.deps.spawnFn !== undefined ? { spawnFn: this.deps.spawnFn } : {}),
    });
    this.currentHandle = handle;

    let abortedDuringStream = false;
    let lastSessionId = this.id;
    let lastSeq = 0;
    let lastTurnId = '0';

    try {
      for await (const ev of handle.events) {
        lastSessionId = ev.sessionId;
        lastSeq = ev.seq;
        lastTurnId = ev.turnId;
        yield ev;
        if (this.aborted) {
          abortedDuringStream = true;
          break;
        }
        if (ev.type === 'session.done' || ev.type === 'session.error') break;
      }
    } finally {
      this.hasStarted = true;
      this.currentHandle = null;
      // If we broke early due to abort, ensure the child is dead.
      if (abortedDuringStream && !handle.child.killed) {
        handle.child.kill('SIGTERM');
      }
      try {
        await handle.exitCode;
      } catch {
        /* ignore */
      }
    }

    if (abortedDuringStream) {
      const ev: SessionAbortedEvent = {
        type: 'session.aborted',
        sessionId: lastSessionId,
        turnId: lastTurnId,
        seq: lastSeq + 1,
        ts: (this.deps.now ?? Date.now)(),
        reason: 'user',
      };
      yield ev;
    }
  }

  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    const handle = this.currentHandle;
    if (handle && !handle.child.killed) {
      handle.child.kill('SIGTERM');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.abort();
  }
}
