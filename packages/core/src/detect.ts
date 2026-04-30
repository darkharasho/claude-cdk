/**
 * Detect the user's installed `claude` CLI. Per DESIGN.md §Public API,
 * `detect()` MUST NEVER THROW — return `{ found: false, reason }` on failure
 * so callers can render a "Claude Code not installed" UI state.
 *
 * Search order:
 *   1. `opts.binaryPath` if provided (caller already knows where it is)
 *   2. `PATH` lookup
 *   3. Common per-platform install locations
 *
 * Auth state cannot be reliably determined without making a real call, so
 * `authMode: "unknown"` until the first session emits a `session.init` event
 * (which carries `apiKeySource`).
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir as osHomedir, platform as osPlatform } from 'node:os';
import { posix, win32 } from 'node:path';
import type { DetectResult } from './api.js';

export interface DetectOptions {
  /** Skip search; verify this exact path. */
  binaryPath?: string;
  /** Inject `child_process.spawn` for tests. */
  spawnFn?: typeof spawn;
  /** Inject a file-existence check for tests. */
  fileExists?: (path: string) => Promise<boolean>;
  /** Override `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override `os.platform()`. */
  platform?: NodeJS.Platform;
  /** Override `os.homedir()`. */
  homedir?: () => string;
}

const UNIX_FIXED_LOCATIONS = [
  '/usr/local/bin/claude',
  '/usr/bin/claude',
  '/opt/homebrew/bin/claude',
];

const HOME_RELATIVE_LOCATIONS = [
  '.npm-global/bin/claude',
  '.local/bin/claude',
  '.bun/bin/claude',
  '.deno/bin/claude',
  'bin/claude',
];

export async function detectClaude(opts: DetectOptions = {}): Promise<DetectResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? osPlatform();
  const homedir = opts.homedir ?? osHomedir;
  const fileExists =
    opts.fileExists ??
    (async (p: string) => {
      try {
        await access(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

  const candidates = collectCandidates({ binaryPath: opts.binaryPath, env, platform, homedir });

  let foundPath: string | undefined;
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      foundPath = candidate;
      break;
    }
  }

  if (!foundPath) {
    return {
      found: false,
      authMode: 'unknown',
      reason: 'claude binary not found on PATH or common install locations',
    };
  }

  try {
    const { stdout, stderr, code } = await runCommand(foundPath, ['--version'], opts.spawnFn);
    if (code !== 0) {
      return {
        found: false,
        binaryPath: foundPath,
        authMode: 'unknown',
        reason: `claude --version exited with code ${code}: ${stderr.trim() || '(no stderr)'}`,
      };
    }
    return {
      found: true,
      binaryPath: foundPath,
      cliVersion: parseVersion(stdout),
      authMode: 'unknown',
    };
  } catch (err) {
    return {
      found: false,
      binaryPath: foundPath,
      authMode: 'unknown',
      reason: `claude --version failed: ${(err as Error).message}`,
    };
  }
}

function collectCandidates(args: {
  binaryPath?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: () => string;
}): string[] {
  const isWin = args.platform === 'win32';
  const path = isWin ? win32 : posix;
  const candidates: string[] = [];
  if (args.binaryPath) candidates.push(args.binaryPath);

  const exe = isWin ? 'claude.cmd' : 'claude';
  if (args.env.PATH) {
    for (const dir of args.env.PATH.split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, exe));
    }
  }

  if (isWin) {
    if (args.env.APPDATA) candidates.push(path.join(args.env.APPDATA, 'npm', 'claude.cmd'));
    if (args.env.LOCALAPPDATA) {
      candidates.push(path.join(args.env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
    }
  } else {
    candidates.push(...UNIX_FIXED_LOCATIONS);
    const home = args.homedir();
    for (const rel of HOME_RELATIVE_LOCATIONS) {
      candidates.push(path.join(home, rel));
    }
  }

  // Dedupe while preserving order.
  const seen = new Set<string>();
  return candidates.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

function parseVersion(stdout: string): string {
  // CLI 2.1.119 outputs: "2.1.119 (Claude Code)\n"
  const trimmed = stdout.trim();
  const match = /^(\S+)\s*(?:\(.*\))?/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCommand(
  cmd: string,
  args: string[],
  spawnFn?: typeof spawn,
): Promise<CommandResult> {
  const sp = spawnFn ?? spawn;
  return new Promise((resolve, reject) => {
    const child = sp(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
