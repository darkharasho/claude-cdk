/**
 * End-to-end IPC roundtrip test. Connects @claude-cdk/electron-host and
 * @claude-cdk/electron-client through an in-memory bridge that imitates
 * Electron's ipcMain/ipcRenderer pair, then drives a fixture replay through
 * the full stack. This is the closest we get to a real Electron test
 * without launching one.
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CDKHost, type IpcInvokeListener, type IpcMainLike } from '../src/index.js';
import { CDKClient, type IpcBridge } from '@claude-cdk/electron-client';
import type { CDKEvent } from '@claude-cdk/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

/**
 * Build an in-memory IPC pair: an `ipcMain`-like that the host binds to,
 * and an `IpcBridge` that the client wraps. The bridge invokes call the
 * host's registered handlers directly. webContents.send pushes to the
 * bridge's listeners.
 */
function makeIpcPair() {
  const handlers = new Map<string, IpcInvokeListener>();
  const channelEmitter = new EventEmitter();

  const fakeWebContents = {
    send(channel: string, ...args: unknown[]) {
      channelEmitter.emit(channel, ...args);
    },
  };

  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };

  const bridge: IpcBridge = {
    async invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return await handler({ sender: fakeWebContents }, ...args);
    },
    on(channel, listener) {
      channelEmitter.on(channel, listener);
      return () => channelEmitter.removeListener(channel, listener);
    },
  };

  return { ipcMain, bridge };
}

/** Fake spawn that emits a fixture, like packages/core/test/session.test.ts. */
function fixtureSpawn(fixture: string) {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: NodeJS.WritableStream | null;
      kill: () => boolean;
      killed: boolean;
    };
    child.stdout = Readable.from([Buffer.from(loadFixture(fixture))]);
    child.stderr = Readable.from([]);
    child.stdin = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    let pending = 2;
    const fire = () => {
      if (--pending === 0) child.emit('close', 0);
    };
    const onFinished = (s: Readable) => {
      let fired = false;
      const f = () => {
        if (!fired) {
          fired = true;
          fire();
        }
      };
      s.once('end', f);
      s.once('close', f);
    };
    onFinished(child.stdout);
    onFinished(child.stderr);
    return child;
  }) as never;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('IPC roundtrip — host ↔ client', () => {
  it('client.detect() round-trips the host detect result', async () => {
    const { ipcMain, bridge } = makeIpcPair();
    const host = new CDKHost({
      binaryPath: '/fake/claude',
      // The host's CDKHostOptions allows a spawnFn pass-through; we don't
      // exercise it for detect since binaryPath is supplied.
    });
    host.bindIpc(ipcMain);
    const client = new CDKClient(bridge);
    const result = await client.detect();
    // detect with a binaryPath that doesn't actually exist on disk returns
    // found:false but with the path recorded.
    expect(result).toMatchObject({ authMode: 'unknown' });
  });

  it('client.startSession + send replays fixture events through IPC', async () => {
    const { ipcMain, bridge } = makeIpcPair();
    const host = new CDKHost({
      binaryPath: '/fake/claude',
      // @ts-expect-error spawnFn is on the internal options shape
      spawnFn: fixtureSpawn('01-simple-text.ndjson'),
    });
    host.bindIpc(ipcMain);
    const client = new CDKClient(bridge);

    const session = await client.startSession({ cwd: '/work' });
    expect(session.id).toBeTruthy();

    const events = await collect(session.send('hi'));
    expect(events.length).toBeGreaterThan(0);
    const types = events.map((e: CDKEvent) => e.type);
    expect(types).toContain('session.init');
    expect(types).toContain('assistant.text_delta');
    expect(types).toContain('session.done');
  });

  it('multi-turn: second send uses --resume on the host side', async () => {
    const { ipcMain, bridge } = makeIpcPair();
    const calls: string[][] = [];
    const recordingSpawn = (() => {
      const fn = ((...args: unknown[]) => {
        const argv = args[1] as readonly string[];
        calls.push([...argv]);
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          stdin: NodeJS.WritableStream | null;
          kill: () => boolean;
          killed: boolean;
        };
        child.stdout = Readable.from([Buffer.from(loadFixture('01-simple-text.ndjson'))]);
        child.stderr = Readable.from([]);
        child.stdin = null;
        child.killed = false;
        child.kill = () => {
          child.killed = true;
          return true;
        };
        let pending = 2;
        const fire = () => {
          if (--pending === 0) child.emit('close', 0);
        };
        const onFinished = (s: Readable) => {
          let fired = false;
          const f = () => {
            if (!fired) {
              fired = true;
              fire();
            }
          };
          s.once('end', f);
          s.once('close', f);
        };
        onFinished(child.stdout);
        onFinished(child.stderr);
        return child;
      }) as never;
      return fn;
    })();

    const host = new CDKHost({
      binaryPath: '/fake/claude',
      // @ts-expect-error internal opt
      spawnFn: recordingSpawn,
    });
    host.bindIpc(ipcMain);
    const client = new CDKClient(bridge);

    const session = await client.startSession({ cwd: '/work' });
    await collect(session.send('first'));
    await collect(session.send('second'));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.join(' ')).toMatch(/--session-id\s+\S+/);
    expect(calls[1]?.join(' ')).toMatch(/--resume\s+\S+/);
  });

  it('per-session event channel namespacing prevents cross-talk', async () => {
    const { ipcMain, bridge } = makeIpcPair();
    const host = new CDKHost({
      binaryPath: '/fake/claude',
      // @ts-expect-error internal opt
      spawnFn: fixtureSpawn('01-simple-text.ndjson'),
    });
    host.bindIpc(ipcMain);
    const client = new CDKClient(bridge);

    const a = await client.startSession({ cwd: '/work' });
    const b = await client.startSession({ cwd: '/work' });
    expect(a.id).not.toBe(b.id);

    // Subscribe a tap on B's channel and run A; B's listener must never fire.
    let bGotEvent = false;
    const unsub = bridge.on(`cdk:event:${b.id}`, () => {
      bGotEvent = true;
    });
    await collect(a.send('hi'));
    unsub();
    expect(bGotEvent).toBe(false);
  });

  it('client.close() removes the session on the host', async () => {
    const { ipcMain, bridge } = makeIpcPair();
    const host = new CDKHost({
      binaryPath: '/fake/claude',
      // @ts-expect-error internal opt
      spawnFn: fixtureSpawn('01-simple-text.ndjson'),
    });
    host.bindIpc(ipcMain);
    const client = new CDKClient(bridge);

    const session = await client.startSession({ cwd: '/work' });
    await session.close();

    // After close, host should have removed the session — sending to the same
    // id should fail with "not found".
    await expect(bridge.invoke('cdk:send', session.id, 'late')).rejects.toThrow(/not found/);
  });

  it('unbindIpc removes all handlers', async () => {
    const { ipcMain, bridge } = makeIpcPair();
    const host = new CDKHost({ binaryPath: '/fake/claude' });
    host.bindIpc(ipcMain);
    host.unbindIpc();
    await expect(bridge.invoke('cdk:detect')).rejects.toThrow(/no handler/);
  });
});
