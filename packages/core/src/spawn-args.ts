/**
 * Pure function: turn SessionOptions + a prompt into the CLI argv to pass to
 * `claude`. Verified against CLI 2.1.119; see fixtures/README.md and DESIGN.md
 * §Phase 1 for the canonical arg shape.
 *
 * Two modes:
 *   - **Single-shot** (default in Phase 1): prompt is supplied via argv. The
 *     CLI's default `--input-format text` applies. Single turn, then exit.
 *   - **Streaming** (`prompt: undefined`, `inputFormat: 'stream-json'`):
 *     prompt arrives via stdin as stream-json. Used by Phase 3 multi-turn.
 */

import type { SessionOptions } from './api.js';

export interface BuildSpawnArgsOptions {
  /** When set, included as trailing argv. Omit for streaming-input mode. */
  prompt?: string;
  /** Force `--input-format stream-json`. Required for streaming input. */
  streamingInput?: boolean;
  /**
   * Override `options.resumeSessionId` for cases where the caller is
   * reconnecting to a known session.
   */
  resumeSessionId?: string;
}

export function buildSpawnArgs(opts: SessionOptions, extra: BuildSpawnArgsOptions = {}): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (extra.streamingInput) {
    args.push('--input-format', 'stream-json');
  }

  if (opts.bare) args.push('--bare');
  if (opts.includePartialMessages) args.push('--include-partial-messages');
  if (opts.includeHookEvents) args.push('--include-hook-events');
  if (opts.noSessionPersistence) args.push('--no-session-persistence');

  if (opts.model) args.push('--model', opts.model);
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);

  if (opts.allowedTools && opts.allowedTools.length) {
    args.push('--allowed-tools', ...opts.allowedTools);
  }
  if (opts.disallowedTools && opts.disallowedTools.length) {
    args.push('--disallowed-tools', ...opts.disallowedTools);
  }
  if (opts.tools && opts.tools.length) {
    args.push('--tools', ...opts.tools);
  }

  if (opts.mcpServers && Object.keys(opts.mcpServers).length) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
  }

  const resumeId = extra.resumeSessionId ?? opts.resumeSessionId;
  if (resumeId) {
    args.push('--resume', resumeId);
  } else if (opts.sessionId) {
    args.push('--session-id', opts.sessionId);
  }

  if (extra.prompt !== undefined) {
    args.push(extra.prompt);
  }

  return args;
}
