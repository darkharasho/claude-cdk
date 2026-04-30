import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { detectClaude } from '../src/detect.js';

/**
 * Build a fake child_process.spawn that emits provided stdout/stderr and exit
 * code. Returns a function with the same call signature as `spawn`.
 */
function fakeSpawn(stdout: string, stderr = '', exitCode = 0) {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
    };
    child.stdout = Readable.from([Buffer.from(stdout)]);
    child.stderr = Readable.from([Buffer.from(stderr)]);
    setImmediate(() => child.emit('close', exitCode));
    return child;
  }) as never;
}

const onlyExists = (paths: string[]) => async (p: string) => paths.includes(p);

describe('detectClaude', () => {
  it('returns found:false with a reason when binary is nowhere', async () => {
    const result = await detectClaude({
      env: { PATH: '/nope:/also-nope' },
      platform: 'linux',
      homedir: () => '/home/u',
      fileExists: async () => false,
    });
    expect(result.found).toBe(false);
    expect(result.authMode).toBe('unknown');
    expect(result.reason).toMatch(/not found/);
  });

  it('finds binary on PATH and parses the version', async () => {
    const result = await detectClaude({
      env: { PATH: '/nope:/usr/bin' },
      platform: 'linux',
      homedir: () => '/home/u',
      fileExists: onlyExists(['/usr/bin/claude']),
      spawnFn: fakeSpawn('2.1.119 (Claude Code)\n'),
    });
    expect(result.found).toBe(true);
    expect(result.binaryPath).toBe('/usr/bin/claude');
    expect(result.cliVersion).toBe('2.1.119');
    expect(result.authMode).toBe('unknown');
  });

  it('falls back to ~/.local/bin when PATH lookup misses', async () => {
    const result = await detectClaude({
      env: { PATH: '/nope' },
      platform: 'linux',
      homedir: () => '/home/u',
      fileExists: onlyExists(['/home/u/.local/bin/claude']),
      spawnFn: fakeSpawn('1.0.0 (Claude Code)\n'),
    });
    expect(result.found).toBe(true);
    expect(result.binaryPath).toBe('/home/u/.local/bin/claude');
  });

  it('honors an explicit binaryPath without searching', async () => {
    const result = await detectClaude({
      binaryPath: '/custom/path/claude',
      env: { PATH: '/nope' },
      platform: 'linux',
      homedir: () => '/home/u',
      fileExists: onlyExists(['/custom/path/claude']),
      spawnFn: fakeSpawn('9.9.9 (Claude Code)\n'),
    });
    expect(result.found).toBe(true);
    expect(result.binaryPath).toBe('/custom/path/claude');
  });

  it('returns found:false when --version exits non-zero', async () => {
    const result = await detectClaude({
      env: { PATH: '/usr/bin' },
      platform: 'linux',
      homedir: () => '/home/u',
      fileExists: onlyExists(['/usr/bin/claude']),
      spawnFn: fakeSpawn('', 'oh no', 1),
    });
    expect(result.found).toBe(false);
    expect(result.binaryPath).toBe('/usr/bin/claude');
    expect(result.reason).toMatch(/exited with code 1/);
    expect(result.reason).toMatch(/oh no/);
  });

  it('returns found:false (without throwing) when spawn errors', async () => {
    const result = await detectClaude({
      env: { PATH: '/usr/bin' },
      platform: 'linux',
      homedir: () => '/home/u',
      fileExists: onlyExists(['/usr/bin/claude']),
      spawnFn: (() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
        };
        child.stdout = Readable.from([]);
        child.stderr = Readable.from([]);
        setImmediate(() => child.emit('error', new Error('boom')));
        return child;
      }) as never,
    });
    expect(result.found).toBe(false);
    expect(result.reason).toMatch(/boom/);
  });

  it('searches Windows-specific install locations when platform is win32', async () => {
    const result = await detectClaude({
      env: { PATH: 'C:\\nope', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\u',
      fileExists: onlyExists(['C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd']),
      spawnFn: fakeSpawn('2.1.119 (Claude Code)\r\n'),
    });
    expect(result.found).toBe(true);
    expect(result.binaryPath).toBe('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
  });

  it('parses a version with no parenthetical', async () => {
    const result = await detectClaude({
      env: { PATH: '/usr/bin' },
      platform: 'linux',
      homedir: () => '/home/u',
      fileExists: onlyExists(['/usr/bin/claude']),
      spawnFn: fakeSpawn('2.0.0\n'),
    });
    expect(result.found).toBe(true);
    expect(result.cliVersion).toBe('2.0.0');
  });
});
