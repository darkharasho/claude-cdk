import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CDKHost, CDKSession, type CDKEvent } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  cwd: string | undefined;
}

/**
 * Build a fake spawn that records every invocation and replays fixtures from
 * a list (one per call). Each call gets the next fixture in the sequence.
 */
function recordingFakeSpawn(fixtures: string[]) {
  const calls: SpawnCall[] = [];
  let i = 0;
  const fn = ((cmd: string, args: readonly string[], opts: { cwd?: string }) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const fixture = fixtures[i++] ?? fixtures[fixtures.length - 1]!;
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: NodeJS.WritableStream | null;
      kill: (signal?: string) => boolean;
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
    onStreamFinished(child.stdout, fire);
    onStreamFinished(child.stderr, fire);
    return child;
  }) as never;
  return { fn, calls };
}

/** A stream is "finished" when 'end' OR 'close' fires (whichever first). */
function onStreamFinished(s: Readable, cb: () => void) {
  let fired = false;
  const fire = () => {
    if (!fired) {
      fired = true;
      cb();
    }
  };
  s.once('end', fire);
  s.once('close', fire);
}

/**
 * Fake spawn that emits stdout slowly and never completes until kill() is
 * called — useful for testing abort.
 */
function neverEndingFakeSpawn() {
  let killSignaled = false;
  const fn = (() => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (signal?: string) => boolean;
      killed: boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;

    let pending = 2;
    const fire = () => {
      if (--pending === 0) child.emit('close', 0);
    };
    onStreamFinished(stdout, fire);
    onStreamFinished(stderr, fire);

    // Push one initial event so the iterator's first .next() resolves.
    setImmediate(() => {
      stdout.push(
        '{"type":"system","subtype":"init","session_id":"abc","cwd":"/x","tools":[],"mcp_servers":[],"model":"m","permissionMode":"default","slash_commands":[],"apiKeySource":"none","claude_code_version":"x","output_style":"d","agents":[],"skills":[],"plugins":[],"analytics_disabled":false,"uuid":"u","memory_paths":{},"fast_mode_state":"off"}\n',
      );
    });

    child.kill = () => {
      child.killed = true;
      killSignaled = true;
      stdout.push(null);
      stderr.push(null);
      return true;
    };
    return child;
  }) as never;
  return { fn, get killSignaled() { return killSignaled; } };
}

async function collect(events: AsyncIterable<CDKEvent>): Promise<CDKEvent[]> {
  const out: CDKEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('CDKHost.startSession', () => {
  it('first send uses --session-id <id>; second send uses --resume <id>', async () => {
    const { fn, calls } = recordingFakeSpawn([
      '01-simple-text.ndjson',
      '01-simple-text.ndjson',
    ]);
    const host = new CDKHost({ binaryPath: '/fake/claude', spawnFn: fn });
    const session = await host.startSession({ cwd: '/work', model: 'haiku' });
    await collect(session.send('first'));
    await collect(session.send('second'));

    const firstArgs = calls[0]?.args.join(' ') ?? '';
    const secondArgs = calls[1]?.args.join(' ') ?? '';
    expect(firstArgs).toMatch(/--session-id\s+\S+/);
    expect(firstArgs).not.toMatch(/--resume/);
    expect(secondArgs).toMatch(/--resume\s+\S+/);
    expect(secondArgs).not.toMatch(/--session-id/);

    // Both calls reference the same session id
    const firstId = /--session-id\s+(\S+)/.exec(firstArgs)?.[1];
    const secondId = /--resume\s+(\S+)/.exec(secondArgs)?.[1];
    expect(firstId).toBe(secondId);
    expect(firstId).toBe(session.id);
  });

  it('passes the prompt as trailing argv and sets cwd on spawn', async () => {
    const { fn, calls } = recordingFakeSpawn(['01-simple-text.ndjson']);
    const host = new CDKHost({ binaryPath: '/fake/claude', spawnFn: fn });
    const session = await host.startSession({ cwd: '/some/where' });
    await collect(session.send('hello world'));
    expect(calls[0]?.cwd).toBe('/some/where');
    expect(calls[0]?.args[calls[0].args.length - 1]).toBe('hello world');
  });

  it('yields events from the parser end-to-end', async () => {
    const { fn } = recordingFakeSpawn(['01-simple-text.ndjson']);
    const host = new CDKHost({ binaryPath: '/fake/claude', spawnFn: fn });
    const session = await host.startSession({ cwd: '/work' });
    const events = await collect(session.send('hi'));
    expect(events.find((e) => e.type === 'session.init')).toBeDefined();
    expect(events.find((e) => e.type === 'session.done')).toBeDefined();
  });

  it('honors caller-supplied sessionId for the first turn', async () => {
    const { fn, calls } = recordingFakeSpawn(['01-simple-text.ndjson']);
    const host = new CDKHost({ binaryPath: '/fake/claude', spawnFn: fn });
    const session = await host.startSession({ cwd: '/x', sessionId: 'caller-supplied-uuid' });
    await collect(session.send('p'));
    expect(session.id).toBe('caller-supplied-uuid');
    const args = calls[0]?.args.join(' ') ?? '';
    expect(args).toMatch(/--session-id\s+caller-supplied-uuid/);
  });
});

describe('CDKHost.resumeSession', () => {
  it('first send already uses --resume (skips --session-id)', async () => {
    const { fn, calls } = recordingFakeSpawn(['01-simple-text.ndjson']);
    const host = new CDKHost({ binaryPath: '/fake/claude', spawnFn: fn });
    const session = await host.resumeSession('existing-session-id', { cwd: '/x' });
    await collect(session.send('continue'));
    const args = calls[0]?.args.join(' ') ?? '';
    expect(args).toMatch(/--resume\s+existing-session-id/);
    expect(args).not.toMatch(/--session-id/);
    expect(session.id).toBe('existing-session-id');
  });
});

describe('CDKSession.abort', () => {
  it('kills the child and yields a synthesized session.aborted event', async () => {
    const fakeSpawn = neverEndingFakeSpawn();
    const session = new CDKSession(
      { cwd: '/x' },
      { binaryPath: '/fake/claude', spawnFn: fakeSpawn.fn, now: () => 9999 },
    );
    const iter = session.send('hang')[Symbol.asyncIterator]();
    // Consume one event to ensure the stream is live.
    const first = await iter.next();
    expect(first.done).toBe(false);
    // Now abort
    await session.abort();
    expect(fakeSpawn.killSignaled).toBe(true);
    // Drain remaining
    const rest: CDKEvent[] = [];
    while (true) {
      const r = await iter.next();
      if (r.done) break;
      rest.push(r.value);
    }
    const aborted = rest.find((e) => e.type === 'session.aborted');
    expect(aborted).toBeDefined();
    if (aborted && aborted.type === 'session.aborted') {
      expect(aborted.reason).toBe('user');
      expect(aborted.ts).toBe(9999);
    }
  });

  it('subsequent send() throws after abort', async () => {
    const fakeSpawn = neverEndingFakeSpawn();
    const session = new CDKSession(
      { cwd: '/x' },
      { binaryPath: '/fake/claude', spawnFn: fakeSpawn.fn },
    );
    const iter = session.send('hang')[Symbol.asyncIterator]();
    await iter.next(); // consume init
    await session.abort();
    while (!(await iter.next()).done) {
      /* drain */
    }
    await expect(collect(session.send('again'))).rejects.toThrow(/aborted/);
  });
});

describe('CDKSession.close', () => {
  it('subsequent send() throws after close', async () => {
    const { fn } = recordingFakeSpawn(['01-simple-text.ndjson']);
    const session = new CDKSession(
      { cwd: '/x' },
      { binaryPath: '/fake/claude', spawnFn: fn },
    );
    await session.close();
    await expect(collect(session.send('hi'))).rejects.toThrow(/closed|aborted/);
  });
});
