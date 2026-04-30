/**
 * @claude-cdk/electron-host — Electron main-process glue. Registers `cdk:*`
 * handlers around @claude-cdk/core and pushes streaming events back to the
 * caller via `event.sender.send('cdk:event:<sessionId>', ev)`. Routing per
 * webContents falls out for free, so multi-window apps just work.
 *
 * Channels:
 *   cdk:detect           → invoke
 *   cdk:startSession     → invoke (opts) → sessionId
 *   cdk:resumeSession    → invoke (id, opts?) → sessionId
 *   cdk:send             → invoke (sessionId, prompt) → void
 *   cdk:abort            → invoke (sessionId) → void
 *   cdk:close            → invoke (sessionId) → void
 *   cdk:listSessions     → invoke → SessionMeta[]
 *   cdk:event:<id>       → webContents.send (per-session event stream)
 *
 * All event payloads are JSON-safe by design (see DESIGN.md §Event Taxonomy).
 * No closures cross the IPC boundary — that's the whole reason permission
 * responses (Phase 4) were resolved as preapproval-only.
 */

import {
  CDKHost as CoreCDKHost,
  type CDKHostOptions,
  type Session,
  type SessionOptions,
} from '@claude-cdk/core';

export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

export interface IpcMainInvokeEventLike {
  sender: WebContentsLike;
}

export type IpcInvokeListener = (
  event: IpcMainInvokeEventLike,
  ...args: unknown[]
) => unknown | Promise<unknown>;

export interface IpcMainLike {
  handle(channel: string, listener: IpcInvokeListener): void;
  removeHandler?(channel: string): void;
}

const CHANNELS = [
  'cdk:detect',
  'cdk:startSession',
  'cdk:resumeSession',
  'cdk:send',
  'cdk:abort',
  'cdk:close',
  'cdk:listSessions',
] as const;

export class CDKHost extends CoreCDKHost {
  private readonly sessions = new Map<string, Session>();
  private boundIpc: IpcMainLike | null = null;

  constructor(opts?: CDKHostOptions) {
    super(opts);
  }

  override bindIpc(ipcMain: IpcMainLike): void {
    this.boundIpc = ipcMain;

    ipcMain.handle('cdk:detect', () => this.detect());

    ipcMain.handle('cdk:startSession', async (_event, opts) => {
      const session = await this.startSession(opts as SessionOptions);
      this.sessions.set(session.id, session);
      return session.id;
    });

    ipcMain.handle('cdk:resumeSession', async (_event, id, opts) => {
      const session = await this.resumeSession(
        id as string,
        opts as Partial<SessionOptions> | undefined,
      );
      this.sessions.set(session.id, session);
      return session.id;
    });

    ipcMain.handle('cdk:send', async (event, sessionId, prompt) => {
      const session = this.sessions.get(sessionId as string);
      if (!session) {
        throw new Error(`cdk:send: session ${String(sessionId)} not found`);
      }
      const channel = `cdk:event:${sessionId as string}`;
      for await (const ev of session.send(prompt as string)) {
        event.sender.send(channel, ev);
      }
    });

    ipcMain.handle('cdk:abort', async (_event, sessionId) => {
      const session = this.sessions.get(sessionId as string);
      if (session) await session.abort();
    });

    ipcMain.handle('cdk:close', async (_event, sessionId) => {
      const session = this.sessions.get(sessionId as string);
      if (session) {
        await session.close();
        this.sessions.delete(sessionId as string);
      }
    });

    ipcMain.handle('cdk:listSessions', () => this.listSessions());
  }

  /**
   * Tear down all `cdk:*` handlers. Useful for tests and for hot-reload of
   * the Electron main process. Safe to call when not bound.
   */
  unbindIpc(): void {
    if (!this.boundIpc?.removeHandler) {
      this.boundIpc = null;
      return;
    }
    for (const ch of CHANNELS) this.boundIpc.removeHandler(ch);
    this.boundIpc = null;
  }
}

export type {
  CDKEvent,
  DetectResult,
  McpServerConfig,
  Session,
  SessionMeta,
  SessionOptions,
  CDKHostOptions,
} from '@claude-cdk/core';
