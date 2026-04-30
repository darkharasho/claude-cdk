/**
 * CDKHost — the top-level entry point. Stub for Phase 0; logic lands in later
 * phases. The `bindIpc` method is intentionally typed loosely here so core has
 * no Electron dependency; @claude-cdk/electron-host re-exports a tightened version.
 */

import type {
  CDKHostOptions,
  DetectResult,
  Session,
  SessionMeta,
  SessionOptions,
} from './api.js';
import { detectClaude } from './detect.js';
import type { CDKEvent } from './events.js';

export class CDKHost {
  private readonly opts: CDKHostOptions;

  constructor(opts: CDKHostOptions = {}) {
    this.opts = opts;
  }

  detect(): Promise<DetectResult> {
    return detectClaude({
      ...(this.opts.binaryPath !== undefined ? { binaryPath: this.opts.binaryPath } : {}),
      ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  startSession(_opts: SessionOptions): Promise<Session> {
    return Promise.reject(new Error('CDKHost.startSession not yet implemented (Phase 3)'));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  resumeSession(_sessionId: string): Promise<Session> {
    return Promise.reject(new Error('CDKHost.resumeSession not yet implemented (Phase 3)'));
  }

  listSessions(): Promise<SessionMeta[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  bindIpc(_ipcMain: unknown): void {
    throw new Error(
      'CDKHost.bindIpc is provided by @claude-cdk/electron-host. Import CDKHost from there in the main process.',
    );
  }
}

// Re-export convenience aliases used by callers.
export type { CDKEvent };
