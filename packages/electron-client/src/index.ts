/**
 * @claude-cdk/electron-client — renderer-process client. Stub for Phase 0; the real
 * IPC bridge lands in Phase 5.
 *
 * Designed to work under contextIsolation: true and sandbox: true. Callers
 * expose `ipcRenderer.invoke` + `ipcRenderer.on` via contextBridge and pass
 * that bridge in here.
 */

import type {
  CDKEvent,
  CDKHostOptions,
  DetectResult,
  Session,
  SessionMeta,
  SessionOptions,
} from '@claude-cdk/core';

// Minimal structural type for the contextBridge-exposed ipcRenderer.
export interface IpcBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
}

export class CDKClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_bridge: IpcBridge, _opts?: CDKHostOptions) {
    // Phase 5: store bridge for invoke/on calls.
  }

  detect(): Promise<DetectResult> {
    return Promise.resolve({
      found: false,
      authMode: 'unknown',
      reason: 'CDKClient.detect not yet implemented (Phase 5)',
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  startSession(_opts: SessionOptions): Promise<Session> {
    return Promise.reject(new Error('CDKClient.startSession not yet implemented (Phase 5)'));
  }

  listSessions(): Promise<SessionMeta[]> {
    return Promise.resolve([]);
  }
}

export type {
  CDKEvent,
  CDKHostOptions,
  DetectResult,
  McpServerConfig,
  Session,
  SessionMeta,
  SessionOptions,
} from '@claude-cdk/core';
