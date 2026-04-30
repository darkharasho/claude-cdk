/**
 * CDKHost — top-level entry point for spawning sessions and detecting the
 * installed CLI. The Electron-host package extends this class to add
 * `bindIpc()` without taking a hard dependency on `electron`.
 */

import type { spawn } from 'node:child_process';
import type { CDKHostOptions, DetectResult, Session, SessionMeta, SessionOptions } from './api.js';
import { detectClaude } from './detect.js';
import type { CDKEvent } from './events.js';
import { CDKSession } from './session.js';

/**
 * Internal-only CDKHost extensions used by tests to inject `spawn`. Public
 * consumers stay on `CDKHostOptions`.
 */
export interface CDKHostInternalOptions extends CDKHostOptions {
  spawnFn?: typeof spawn;
}

export class CDKHost {
  private readonly opts: CDKHostInternalOptions;
  private resolvedBinaryPath: string | undefined;

  constructor(opts: CDKHostInternalOptions = {}) {
    this.opts = opts;
    this.resolvedBinaryPath = opts.binaryPath;
  }

  detect(): Promise<DetectResult> {
    return detectClaude({
      ...(this.opts.binaryPath !== undefined ? { binaryPath: this.opts.binaryPath } : {}),
      ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
      ...(this.opts.spawnFn !== undefined ? { spawnFn: this.opts.spawnFn } : {}),
    });
  }

  async startSession(opts: SessionOptions): Promise<Session> {
    const binaryPath = await this.resolveBinaryPath();
    return new CDKSession(opts, {
      binaryPath,
      ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
      ...(this.opts.spawnFn !== undefined ? { spawnFn: this.opts.spawnFn } : {}),
    });
  }

  async resumeSession(sessionId: string, opts?: Partial<SessionOptions>): Promise<Session> {
    const binaryPath = await this.resolveBinaryPath();
    const sessionOpts: SessionOptions = {
      cwd: opts?.cwd ?? process.cwd(),
      ...opts,
      resumeSessionId: sessionId,
    };
    return new CDKSession(
      sessionOpts,
      {
        binaryPath,
        ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
        ...(this.opts.spawnFn !== undefined ? { spawnFn: this.opts.spawnFn } : {}),
      },
      /* hasStarted */ true,
    );
  }

  /**
   * Returns sessions known to this CDKHost instance. Canonical session state
   * lives on disk in `~/.claude/projects/` and must be reached via the CLI's
   * own resume mechanism — we do not duplicate that store.
   */
  listSessions(): Promise<SessionMeta[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  bindIpc(_ipcMain: unknown): void {
    throw new Error(
      'CDKHost.bindIpc is provided by @claude-cdk/electron-host. Import CDKHost from there in the main process.',
    );
  }

  private async resolveBinaryPath(): Promise<string> {
    if (this.resolvedBinaryPath) return this.resolvedBinaryPath;
    const result = await this.detect();
    if (!result.found || !result.binaryPath) {
      throw new Error(
        `claude CLI not found: ${result.reason ?? 'unknown reason'}. ` +
          `Pass CDKHostOptions.binaryPath to override.`,
      );
    }
    this.resolvedBinaryPath = result.binaryPath;
    return result.binaryPath;
  }
}

// Re-export convenience aliases used by callers.
export type { CDKEvent };
