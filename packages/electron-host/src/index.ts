/**
 * @claude-cdk/electron-host — Electron main-process glue. Stub for Phase 0; the real
 * IPC handler wiring lands in Phase 5.
 *
 * IPC channel namespace:
 *   cdk:detect, cdk:startSession, cdk:send, cdk:respond, cdk:abort, cdk:listSessions
 * Per-session event channel:
 *   cdk:event:<sessionId>
 */

import { CDKHost as CoreCDKHost, type CDKHostOptions } from '@claude-cdk/core';

// Minimal structural type for ipcMain so we don't take a hard dependency on
// `electron` at build time. Consumers pass the real `ipcMain`.
export interface IpcMainLike {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
  on(channel: string, listener: (...args: unknown[]) => void): void;
}

export class CDKHost extends CoreCDKHost {
  constructor(opts?: CDKHostOptions) {
    super(opts);
  }

  override bindIpc(ipcMain: IpcMainLike): void {
    // Phase 5: register cdk:* handlers here.
    void ipcMain;
  }
}

export type {
  CDKEvent,
  DetectResult,
  McpServerConfig,
  PermissionDecision,
  Session,
  SessionMeta,
  SessionOptions,
  CDKHostOptions,
} from '@claude-cdk/core';
