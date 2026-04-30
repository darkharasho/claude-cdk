/**
 * Event taxonomy for CDK. Mirrors the discriminated union in DESIGN.md.
 * Wire reality: the CLI's stream-json format does not carry turnId/seq/ts;
 * the parser synthesizes them. The `meta.unknown` variant is the
 * forward-compatibility escape hatch — any unrecognized stream-json event
 * is wrapped here verbatim. Do not tighten.
 */

export interface BaseEvent {
  type: string;
  sessionId: string;
  turnId: string;
  seq: number;
  ts: number;
  uuid?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export type PermissionMode =
  | 'default'
  | 'auto'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'plan';

export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'pending' | string;
  error?: string;
}

export interface PluginInfo {
  name: string;
  version?: string;
  path?: string;
  source?: string;
  status?: 'loaded' | 'failed' | string;
}

export interface SessionInitEvent extends BaseEvent {
  type: 'session.init';
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  tools: string[];
  mcpServers: McpServerInfo[];
  plugins: PluginInfo[];
  slashCommands: string[];
  agents: string[];
  skills: string[];
  cliVersion: string;
  outputStyle?: string;
  apiKeySource: 'none' | 'user' | 'project' | 'anthropic' | string;
  authMode: 'subscription' | 'apikey' | 'unknown';
  fastModeState?: string;
  analyticsDisabled?: boolean;
  memoryPaths?: Record<string, string>;
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
  durationApiMs?: number;
  numTurns?: number;
  isError: boolean;
  apiErrorStatus?: number | null;
  terminalReason?: string;
  permissionDenials?: { toolName: string; toolUseId: string; toolInput: unknown }[];
  modelUsage?: Record<string, unknown>;
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
  model?: string;
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

/**
 * Informational permission-request event. The CLI in `-p` mode does not
 * support runtime permission prompts; tools must be preapproved via
 * SessionOptions. This event is synthesized by the parser when it sees a
 * denied tool_result, so consumers can surface denials in their UI.
 */
export interface PermissionRequestEvent extends BaseEvent {
  type: 'tool.permission_request';
  toolName: string;
  toolUseId: string;
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

export interface HookStartedEvent extends BaseEvent {
  type: 'system.hook_started';
  hookId: string;
  hookName: string;
  hookEvent: string;
}

export interface HookResponseEvent extends BaseEvent {
  type: 'system.hook_response';
  hookId: string;
  hookName: string;
  hookEvent: string;
  outcome: 'success' | 'failure' | string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  output?: string;
}

export interface PostTurnSummaryEvent extends BaseEvent {
  type: 'system.post_turn_summary';
  summarizesUuid: string;
  statusCategory: string;
  statusDetail: string;
  needsAction: string;
}

export interface SystemStatusEvent extends BaseEvent {
  type: 'system.status';
  status: string;
}

export interface RateLimitEvent extends BaseEvent {
  type: 'system.rate_limit';
  status: 'allowed' | 'rejected' | string;
  rateLimitType: string;
  resetsAt?: number;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

// ── Meta / forward-compat ────────────────────────────────────────────────────

export interface UsageUpdateEvent extends BaseEvent {
  type: 'meta.usage';
  usage: TokenUsage;
}

/**
 * Forward-compatibility escape hatch. Any stream-json event the parser does
 * not recognize gets wrapped here verbatim. CLI updates that add new event
 * types must continue to flow through. Never tighten.
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
  | HookStartedEvent
  | HookResponseEvent
  | PostTurnSummaryEvent
  | SystemStatusEvent
  | RateLimitEvent
  | UsageUpdateEvent
  | UnknownEvent;

export type CDKEventType = CDKEvent['type'];
