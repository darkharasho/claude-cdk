/**
 * Public API surface for CDK. See DESIGN.md §Public API for the contract.
 * All implementations here are stubs that will be filled in during later phases.
 */

import type { CDKEvent } from './events.js';

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
  mcpServers?: Record<string, McpServerConfig>;
  systemPrompt?: string;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  createdAt: number;
  lastActiveAt: number;
}

export type PermissionDecision = 'allow' | 'deny' | 'always_allow';

export interface CDKHostOptions {
  binaryPath?: string;
  env?: Record<string, string>;
}

export interface Session {
  readonly id: string;
  send(prompt: string): AsyncIterable<CDKEvent>;
  respondToPermission(requestId: string, decision: PermissionDecision): void;
  abort(): Promise<void>;
  close(): Promise<void>;
}
