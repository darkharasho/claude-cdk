/**
 * Spawn the `claude` CLI as a child process and yield CDKEvents from its
 * stream-json stdout. Internal helper used by the session manager (Phase 3).
 *
 * The child is started with stdin set to 'ignore' (the CLI prints a 3s
 * warning otherwise) for single-shot mode. For streaming-input mode, callers
 * pass `stdinMode: 'pipe'` and write JSON messages to `child.stdin`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { CDKEvent } from './events.js';
import { StreamParser } from './parser.js';

export interface SpawnCliOptions {
  binaryPath: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 'ignore' for single-shot, 'pipe' for streaming-input multi-turn. */
  stdinMode?: 'ignore' | 'pipe';
  /** Inject `child_process.spawn` for tests. */
  spawnFn?: typeof spawn;
}

export interface SpawnHandle {
  child: ChildProcess;
  events: AsyncIterable<CDKEvent>;
  stderr: Promise<string>;
  exitCode: Promise<number>;
}

export function spawnCli(opts: SpawnCliOptions): SpawnHandle {
  const sp = opts.spawnFn ?? spawn;
  const child = sp(opts.binaryPath, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdinMode ?? 'ignore', 'pipe', 'pipe'],
  });

  const parser = new StreamParser();

  let stderrAccumulated = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrAccumulated += chunk.toString('utf8');
  });

  const stderr = new Promise<string>((resolve) => {
    child.on('close', () => resolve(stderrAccumulated));
  });

  const exitCode = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
  });

  return {
    child,
    events: iterateEvents(child.stdout, parser),
    stderr,
    exitCode,
  };
}

async function* iterateEvents(
  stdout: Readable | null,
  parser: StreamParser,
): AsyncIterable<CDKEvent> {
  if (!stdout) return;
  let buffer = '';
  for await (const chunk of stdout) {
    buffer += (chunk as Buffer).toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) {
        for (const ev of parser.parseLine(line)) yield ev;
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) {
    for (const ev of parser.parseLine(buffer)) yield ev;
  }
}
