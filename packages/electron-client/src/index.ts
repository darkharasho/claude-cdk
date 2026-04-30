/**
 * @claude-cdk/electron-client — renderer-process client. Speaks to
 * @claude-cdk/electron-host over IPC via a contextBridge-exposed
 * `IpcBridge` (so it works under contextIsolation: true and sandbox: true).
 *
 * The renderer exposes a thin shim in preload.js, e.g.:
 *
 *   contextBridge.exposeInMainWorld('cdk', {
 *     invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
 *     on: (channel, listener) => {
 *       const handler = (_event, ...args) => listener(...args);
 *       ipcRenderer.on(channel, handler);
 *       return () => ipcRenderer.removeListener(channel, handler);
 *     },
 *   });
 *
 * Then in the renderer:
 *
 *   const client = new CDKClient(window.cdk);
 *   const session = await client.startSession({ cwd: '/work' });
 *   for await (const ev of session.send('hi')) console.log(ev.type);
 */

import type {
  CDKEvent,
  DetectResult,
  Session,
  SessionMeta,
  SessionOptions,
} from '@claude-cdk/core';

export interface IpcBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** Subscribe to channel pushes. Returns an unsubscribe function. */
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
}

export class CDKClient {
  constructor(private readonly bridge: IpcBridge) {}

  async detect(): Promise<DetectResult> {
    return (await this.bridge.invoke('cdk:detect')) as DetectResult;
  }

  async startSession(opts: SessionOptions): Promise<Session> {
    const id = (await this.bridge.invoke('cdk:startSession', opts)) as string;
    return new ClientSession(id, this.bridge);
  }

  async resumeSession(id: string, opts?: Partial<SessionOptions>): Promise<Session> {
    const sessionId = (await this.bridge.invoke('cdk:resumeSession', id, opts)) as string;
    return new ClientSession(sessionId, this.bridge);
  }

  async listSessions(): Promise<SessionMeta[]> {
    return (await this.bridge.invoke('cdk:listSessions')) as SessionMeta[];
  }
}

/**
 * Renderer-side Session. send() subscribes to the per-session event channel,
 * invokes cdk:send, and yields events until the host's iteration on the
 * other side completes (the invoke promise resolves).
 *
 * Per-session channel namespace (`cdk:event:<id>`) prevents cross-talk
 * between concurrent sessions.
 */
class ClientSession implements Session {
  constructor(
    public readonly id: string,
    private readonly bridge: IpcBridge,
  ) {}

  async *send(prompt: string): AsyncIterable<CDKEvent> {
    const channel = `cdk:event:${this.id}`;
    const queue: CDKEvent[] = [];
    let waiter: ((r: IteratorResult<CDKEvent>) => void) | null = null;
    let done = false;
    let invokeError: Error | null = null;

    const unsubscribe = this.bridge.on(channel, (...args) => {
      const ev = args[0] as CDKEvent;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: ev, done: false });
      } else {
        queue.push(ev);
      }
    });

    const invokePromise = this.bridge
      .invoke('cdk:send', this.id, prompt)
      .catch((err) => {
        invokeError = err instanceof Error ? err : new Error(String(err));
      })
      .finally(() => {
        done = true;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: undefined as never, done: true });
        }
      });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as CDKEvent;
          continue;
        }
        if (done) break;
        const result = await new Promise<IteratorResult<CDKEvent>>((resolve) => {
          waiter = resolve;
        });
        if (result.done) break;
        yield result.value;
      }
      // Surface any invoke-side error after we've yielded all queued events.
      await invokePromise;
      if (invokeError) throw invokeError;
    } finally {
      unsubscribe();
    }
  }

  async abort(): Promise<void> {
    await this.bridge.invoke('cdk:abort', this.id);
  }

  async close(): Promise<void> {
    await this.bridge.invoke('cdk:close', this.id);
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
