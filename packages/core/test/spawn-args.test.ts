import { describe, expect, it } from 'vitest';
import { buildSpawnArgs } from '../src/spawn-args.js';

describe('buildSpawnArgs', () => {
  const baseOpts = { cwd: '/tmp/x' };

  it('emits the canonical single-shot arg shape with no options', () => {
    const args = buildSpawnArgs(baseOpts, { prompt: 'hello' });
    expect(args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', 'hello']);
  });

  it('omits prompt when streamingInput is set, and adds --input-format', () => {
    const args = buildSpawnArgs(baseOpts, { streamingInput: true });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
    ]);
    expect(args).not.toContain('hello');
  });

  it('passes through booleans as flags', () => {
    const args = buildSpawnArgs(
      {
        ...baseOpts,
        bare: true,
        includePartialMessages: true,
        includeHookEvents: true,
        noSessionPersistence: true,
      },
      { prompt: 'p' },
    );
    expect(args).toContain('--bare');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--include-hook-events');
    expect(args).toContain('--no-session-persistence');
  });

  it('passes through string options as flag/value pairs', () => {
    const args = buildSpawnArgs(
      {
        ...baseOpts,
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'Be terse.',
        appendSystemPrompt: 'Reply in lowercase.',
        permissionMode: 'bypassPermissions',
      },
      { prompt: 'p' },
    );
    expect(args).toContain('--model');
    expect(args).toContain('claude-haiku-4-5-20251001');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('Be terse.');
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('Reply in lowercase.');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
  });

  it('expands tool lists into space-separated multi-arg form', () => {
    const args = buildSpawnArgs(
      { ...baseOpts, allowedTools: ['Read', 'Bash(git *)'], disallowedTools: ['Edit'] },
      { prompt: 'p' },
    );
    const allowedIdx = args.indexOf('--allowed-tools');
    expect(allowedIdx).toBeGreaterThan(-1);
    expect(args[allowedIdx + 1]).toBe('Read');
    expect(args[allowedIdx + 2]).toBe('Bash(git *)');
    const disallowedIdx = args.indexOf('--disallowed-tools');
    expect(args[disallowedIdx + 1]).toBe('Edit');
  });

  it('serializes mcpServers as a JSON --mcp-config blob', () => {
    const args = buildSpawnArgs(
      {
        ...baseOpts,
        mcpServers: {
          local: { command: 'mcp-server', args: ['--port', '0'] },
        },
      },
      { prompt: 'p' },
    );
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const json = JSON.parse(args[idx + 1] ?? '{}');
    expect(json).toEqual({
      mcpServers: { local: { command: 'mcp-server', args: ['--port', '0'] } },
    });
  });

  it('--resume takes precedence over --session-id when both are set', () => {
    const args = buildSpawnArgs(
      {
        ...baseOpts,
        sessionId: 'a',
        resumeSessionId: 'b',
      },
      { prompt: 'p' },
    );
    expect(args).toContain('--resume');
    expect(args).toContain('b');
    expect(args).not.toContain('--session-id');
  });

  it('extra.resumeSessionId overrides options.resumeSessionId', () => {
    const args = buildSpawnArgs(
      { ...baseOpts, resumeSessionId: 'fromOptions' },
      { resumeSessionId: 'fromExtra' },
    );
    const idx = args.indexOf('--resume');
    expect(args[idx + 1]).toBe('fromExtra');
  });

  it('omits empty tool lists', () => {
    const args = buildSpawnArgs(
      { ...baseOpts, allowedTools: [], disallowedTools: [], tools: [] },
      { prompt: 'p' },
    );
    expect(args).not.toContain('--allowed-tools');
    expect(args).not.toContain('--disallowed-tools');
    expect(args).not.toContain('--tools');
  });

  it('omits --mcp-config when empty', () => {
    const args = buildSpawnArgs({ ...baseOpts, mcpServers: {} }, { prompt: 'p' });
    expect(args).not.toContain('--mcp-config');
  });

  it('places the prompt last so trailing argv is the prompt', () => {
    const args = buildSpawnArgs(
      { ...baseOpts, model: 'foo', allowedTools: ['Read'] },
      { prompt: 'do the thing' },
    );
    expect(args[args.length - 1]).toBe('do the thing');
  });
});
