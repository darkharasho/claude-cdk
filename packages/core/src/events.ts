/**
 * Event taxonomy for CDK. Mirrors the discriminated union defined in DESIGN.md.
 * The `meta.unknown` variant is the forward-compatibility escape hatch — any
 * stream-json event the parser does not recognize is wrapped here verbatim.
 */

export interface BaseEvent {
  type: string;
  sessionId: string;
  turnId: string;
  seq: number;
  ts: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export interface SessionInitEvent extends BaseEvent {
  type: 'session.init';
  model: string;
  cwd: string;
  allowedTools: string[];
  mcpServers: { name: string; status: 'connected' | 'failed'; error?: string }[];
  plugins: { name: string; version: string; status: 'loaded' | 'failed' }[];
  cliVersion: string;
}

export interface SessionReadyEvent extends BaseEvent {
  type: 'session.ready';
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'error'
  | 'aborted';

export interface SessionDoneEvent extends BaseEvent {
  type: 'session.done';
  stopReason: StopReason;
  result?: string;
  usage: TokenUsage;
  costUsd?: number;
  durationMs: number;
}

export interface SessionErrorEvent extends BaseEvent {
  type: 'session.error';
  error: { code: string; message: string; recoverable: boolean };
}

export interface SessionAbortedEvent extends BaseEvent {
  type: 'session.aborted';
  reason: 'user' | 'timeout' | 'parent_exit';
}

// ── Assistant content ────────────────────────────────────────────────────────

export interface AssistantMessageStartEvent extends BaseEvent {
  type: 'assistant.message_start';
  messageId: string;
}

export interface AssistantTextDeltaEvent extends BaseEvent {
  type: 'assistant.text_delta';
  messageId: string;
  delta: string;
}

export interface AssistantThinkingDeltaEvent extends BaseEvent {
  type: 'assistant.thinking_delta';
  messageId: string;
  delta: string;
}

export interface AssistantMessageCompleteEvent extends BaseEvent {
  type: 'assistant.message_complete';
  messageId: string;
  text: string;
  thinking?: string;
}

// ── Tool use ─────────────────────────────────────────────────────────────────

export interface ToolUseStartEvent extends BaseEvent {
  type: 'tool.use_start';
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolUseCompleteEvent extends BaseEvent {
  type: 'tool.use_complete';
  toolUseId: string;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool.result';
  toolUseId: string;
  result: unknown;
  isError: boolean;
}

export interface PermissionRequestEvent extends BaseEvent {
  type: 'tool.permission_request';
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  rationale?: string;
}

// ── System ───────────────────────────────────────────────────────────────────

export interface ApiRetryEvent extends BaseEvent {
  type: 'system.api_retry';
  attempt: number;
  delayMs: number;
  reason: string;
}

export interface CompactionEvent extends BaseEvent {
  type: 'system.compaction';
  tokensBefore: number;
  tokensAfter: number;
}

export interface PluginInstallEvent extends BaseEvent {
  type: 'system.plugin_install';
  name: string;
  status: 'starting' | 'complete' | 'failed';
  error?: string;
}

export interface WarningEvent extends BaseEvent {
  type: 'system.warning';
  message: string;
  code?: string;
}

// ── Meta / forward-compat ────────────────────────────────────────────────────

export interface UsageUpdateEvent extends BaseEvent {
  type: 'meta.usage';
  usage: TokenUsage;
}

/**
 * Forward-compatibility escape hatch. Any stream-json event the parser does
 * not recognize gets wrapped here verbatim so a CLI update that adds new
 * event types never breaks consumers. Do not tighten — keep loose forever.
 */
export interface UnknownEvent extends BaseEvent {
  type: 'meta.unknown';
  rawType: string;
  raw: unknown;
}

// ── Discriminated union ──────────────────────────────────────────────────────

export type CDKEvent =
  | SessionInitEvent
  | SessionReadyEvent
  | SessionDoneEvent
  | SessionErrorEvent
  | SessionAbortedEvent
  | AssistantMessageStartEvent
  | AssistantTextDeltaEvent
  | AssistantThinkingDeltaEvent
  | AssistantMessageCompleteEvent
  | ToolUseStartEvent
  | ToolUseCompleteEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | ApiRetryEvent
  | CompactionEvent
  | PluginInstallEvent
  | WarningEvent
  | UsageUpdateEvent
  | UnknownEvent;

export type CDKEventType = CDKEvent['type'];
