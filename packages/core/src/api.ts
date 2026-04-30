/**
 * Public API surface for CDK. See DESIGN.md §Public API for the contract.
 * All implementations here are stubs that will be filled in during later phases.
 */

import type { CDKEvent, PermissionMode } from './events.js';

export interface DetectResult {
  found: boolean;
  binaryPath?: string;
  cliVersion?: string;
  authMode: 'subscription' | 'apikey' | 'unknown';
  reason?: string;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface SessionOptions {
  cwd: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Restrict the built-in tool set. */
  tools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissionMode?: PermissionMode;
  /**
   * Pass `--bare`. Requires `ANTHROPIC_API_KEY` (OAuth/keychain are not read).
   * Default `false`. Subscription users must leave this off.
   */
  bare?: boolean;
  /** Pass `--include-partial-messages` for delta streaming. */
  includePartialMessages?: boolean;
  /** Pass `--include-hook-events`. */
  includeHookEvents?: boolean;
  /** Pass `--no-session-persistence`. */
  noSessionPersistence?: boolean;
  /** Pass `--session-id <uuid>` to pre-assign a session UUID. */
  sessionId?: string;
  /** Pass `--resume <id>` to resume an existing session. */
  resumeSessionId?: string;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface CDKHostOptions {
  binaryPath?: string;
  env?: Record<string, string>;
}

export interface Session {
  readonly id: string;
  send(prompt: string): AsyncIterable<CDKEvent>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
