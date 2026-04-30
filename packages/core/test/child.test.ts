import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CDKEvent } from '../src/index.js';
import { spawnCli } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

/**
 * A fake `child_process.spawn` that emits the contents of an NDJSON fixture
 * over stdout (in arbitrary chunks to exercise the buffer-splitting logic),
 * then exits with the given code.
 */
function fakeSpawnFromFixture(fixture: string, opts: { exitCode?: number; chunkSize?: number } = {}) {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: NodeJS.WritableStream | null;
    };
    const chunkSize = opts.chunkSize ?? 64;
    const buf = Buffer.from(loadFixture(fixture));
    const chunks: Buffer[] = [];
    for (let i = 0; i < buf.length; i += chunkSize) {
      chunks.push(buf.subarray(i, Math.min(i + chunkSize, buf.length)));
    }
    child.stdout = Readable.from(chunks);
    child.stderr = Readable.from([]);
    child.stdin = null;
    let pending = 2;
    const onEnd = () => {
      if (--pending === 0) child.emit('close', opts.exitCode ?? 0);
    };
    child.stdout.once('end', onEnd);
    child.stderr.once('end', onEnd);
    return child;
  }) as never;
}

async function collectAll(events: AsyncIterable<CDKEvent>): Promise<CDKEvent[]> {
  const out: CDKEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('spawnCli', () => {
  it('replays fixture 01 through the parser, end-to-end', async () => {
    const handle = spawnCli({
      binaryPath: '/fake/claude',
      args: ['-p'],
      spawnFn: fakeSpawnFromFixture('01-simple-text.ndjson'),
    });
    const events = await collectAll(handle.events);
    expect(events.length).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'session.init')).toBeDefined();
    expect(events.find((e) => e.type === 'session.done')).toBeDefined();
    await expect(handle.exitCode).resolves.toBe(0);
    await expect(handle.stderr).resolves.toBe('');
  });

  it('handles fixture chunked at a small size (tests buffer splitting)', async () => {
    const handle = spawnCli({
      binaryPath: '/fake/claude',
      args: ['-p'],
      spawnFn: fakeSpawnFromFixture('02-single-tool-use.ndjson', { chunkSize: 17 }),
    });
    const events = await collectAll(handle.events);
    expect(events.find((e) => e.type === 'tool.use_start')).toBeDefined();
    expect(events.find((e) => e.type === 'tool.result')).toBeDefined();
    expect(events.find((e) => e.type === 'session.done')).toBeDefined();
  });

  it('handles fixture chunked one byte at a time', async () => {
    const handle = spawnCli({
      binaryPath: '/fake/claude',
      args: ['-p'],
      spawnFn: fakeSpawnFromFixture('01-simple-text.ndjson', { chunkSize: 1 }),
    });
    const events = await collectAll(handle.events);
    expect(events.find((e) => e.type === 'session.done')).toBeDefined();
  });

  it('captures stderr and surfaces non-zero exit codes', async () => {
    const fakeWithStderr = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
      };
      child.stdout = Readable.from([]);
      child.stderr = Readable.from([Buffer.from('something failed\n')]);
      let pending = 2;
      const onEnd = () => {
        if (--pending === 0) child.emit('close', 2);
      };
      child.stdout.once('end', onEnd);
      child.stderr.once('end', onEnd);
      return child;
    }) as never;

    const handle = spawnCli({
      binaryPath: '/fake/claude',
      args: ['-p'],
      spawnFn: fakeWithStderr,
    });
    const events = await collectAll(handle.events);
    expect(events).toEqual([]);
    await expect(handle.exitCode).resolves.toBe(2);
    await expect(handle.stderr).resolves.toBe('something failed\n');
  });
});
