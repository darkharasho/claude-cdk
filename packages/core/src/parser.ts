/**
 * Stream-json parser for the Claude Code CLI's `-p --output-format stream-json`
 * wire protocol. Pure function over fixtures: feed it raw lines, get CDKEvents.
 *
 * The wire format does not carry `seq`/`ts`/`turnId`. We synthesize them:
 *   - `seq` is a monotonic counter, reset when the session id changes
 *   - `ts`  is `now()` at receive (injectable for tests)
 *   - `turnId` is a counter bumped on each `result` event boundary
 *
 * Forward compatibility: anything we don't recognize becomes `meta.unknown`
 * carrying the full raw payload. Never tighten — this is the escape hatch
 * that lets CDK survive CLI updates without breaking consumers.
 */

import type {
  AssistantMessageCompleteEvent,
  AssistantMessageStartEvent,
  AssistantTextDeltaEvent,
  AssistantThinkingDeltaEvent,
  BaseEvent,
  CDKEvent,
  HookResponseEvent,
  HookStartedEvent,
  PermissionMode,
  PermissionRequestEvent,
  PostTurnSummaryEvent,
  RateLimitEvent,
  SessionDoneEvent,
  SessionInitEvent,
  SystemStatusEvent,
  ToolResultEvent,
  ToolUseStartEvent,
  UnknownEvent,
} from './events.js';

export interface StreamParserOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const PERMISSION_DENIED_RE =
  /Claude requested permissions to use ([\w.\-:]+), but you haven't granted it yet/i;

export class StreamParser {
  private seq = 0;
  private turnId = 0;
  private sessionId = '';
  private readonly now: () => number;

  /** Tracks pending tool_use inputs by id, so we can pair denials back to inputs. */
  private readonly toolUseInputs = new Map<string, Record<string, unknown>>();

  constructor(opts: StreamParserOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Parse a single raw NDJSON line (string) or an already-parsed object. */
  parseLine(input: unknown): CDKEvent[] {
    let wire: Record<string, unknown>;
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return [];
      try {
        wire = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return [this.unknown('non-json', input)];
      }
    } else if (input && typeof input === 'object') {
      wire = input as Record<string, unknown>;
    } else {
      return [this.unknown('non-object', input)];
    }

    if (typeof wire.session_id === 'string' && wire.session_id !== this.sessionId) {
      this.sessionId = wire.session_id;
      this.seq = 0;
      this.turnId = 0;
    }

    const type = wire.type;
    const subtype = typeof wire.subtype === 'string' ? wire.subtype : null;

    switch (type) {
      case 'system':
        return this.parseSystem(wire, subtype);
      case 'assistant':
        return this.parseAssistant(wire);
      case 'user':
        return this.parseUser(wire);
      case 'rate_limit_event':
        return [this.makeRateLimit(wire)];
      case 'stream_event':
        return this.parseStreamEvent(wire);
      case 'result': {
        const out = this.parseResult(wire, subtype);
        this.turnId += 1;
        return out;
      }
      default:
        return [this.unknown(String(type ?? '<no-type>'), wire)];
    }
  }

  // ── Dispatch helpers ───────────────────────────────────────────────────────

  private parseSystem(wire: Record<string, unknown>, subtype: string | null): CDKEvent[] {
    switch (subtype) {
      case 'init':
        return [this.makeInit(wire)];
      case 'hook_started':
        return [this.makeHookStarted(wire)];
      case 'hook_response':
        return [this.makeHookResponse(wire)];
      case 'post_turn_summary':
        return [this.makePostTurnSummary(wire)];
      case 'status':
        return [this.makeSystemStatus(wire)];
      default:
        return [this.unknown(`system/${subtype ?? 'null'}`, wire)];
    }
  }

  private parseAssistant(wire: Record<string, unknown>): CDKEvent[] {
    const message = wire.message as Record<string, unknown> | undefined;
    if (!message) return [this.unknown('assistant', wire)];
    const messageId = String(message.id ?? '');
    const model = typeof message.model === 'string' ? message.model : undefined;
    const content = (message.content as unknown[]) ?? [];
    const uuid = typeof wire.uuid === 'string' ? wire.uuid : undefined;

    const events: CDKEvent[] = [];
    const startEv: AssistantMessageStartEvent = {
      type: 'assistant.message_start',
      ...this.base(uuid),
      messageId,
      ...(model ? { model } : {}),
    };
    events.push(startEv);

    let fullText = '';
    let fullThinking = '';

    for (const blockUnknown of content) {
      const block = blockUnknown as Record<string, unknown>;
      const blockType = block.type;
      if (blockType === 'text') {
        const text = String(block.text ?? '');
        fullText += text;
        const ev: AssistantTextDeltaEvent = {
          type: 'assistant.text_delta',
          ...this.base(),
          messageId,
          delta: text,
        };
        events.push(ev);
      } else if (blockType === 'thinking') {
        const thinking = String(block.thinking ?? '');
        fullThinking += thinking;
        const ev: AssistantThinkingDeltaEvent = {
          type: 'assistant.thinking_delta',
          ...this.base(),
          messageId,
          delta: thinking,
        };
        events.push(ev);
      } else if (blockType === 'tool_use') {
        const toolUseId = String(block.id ?? '');
        const toolName = String(block.name ?? '');
        const input = (block.input as Record<string, unknown>) ?? {};
        this.toolUseInputs.set(toolUseId, input);
        const ev: ToolUseStartEvent = {
          type: 'tool.use_start',
          ...this.base(),
          toolUseId,
          toolName,
          input,
        };
        events.push(ev);
      } else {
        events.push(this.unknown(`assistant.content/${String(blockType)}`, block));
      }
    }

    const completeEv: AssistantMessageCompleteEvent = {
      type: 'assistant.message_complete',
      ...this.base(),
      messageId,
      text: fullText,
      ...(fullThinking ? { thinking: fullThinking } : {}),
    };
    events.push(completeEv);

    return events;
  }

  private parseUser(wire: Record<string, unknown>): CDKEvent[] {
    const message = wire.message as Record<string, unknown> | undefined;
    if (!message) return [this.unknown('user', wire)];
    const content = (message.content as unknown[]) ?? [];
    const events: CDKEvent[] = [];

    for (const blockUnknown of content) {
      const block = blockUnknown as Record<string, unknown>;
      if (block.type !== 'tool_result') {
        events.push(this.unknown(`user.content/${String(block.type)}`, block));
        continue;
      }
      const toolUseId = String(block.tool_use_id ?? '');
      const result = block.content;
      const isError = block.is_error === true;

      const ev: ToolResultEvent = {
        type: 'tool.result',
        ...this.base(),
        toolUseId,
        result,
        isError,
      };
      events.push(ev);

      if (isError && typeof result === 'string') {
        const match = PERMISSION_DENIED_RE.exec(result);
        if (match) {
          const toolName = match[1] ?? '<unknown>';
          const input = this.toolUseInputs.get(toolUseId) ?? {};
          const permEv: PermissionRequestEvent = {
            type: 'tool.permission_request',
            ...this.base(),
            toolName,
            toolUseId,
            input,
            rationale: 'denied: tool not in allowed-tools and -p mode does not prompt',
          };
          events.push(permEv);
        }
      }
    }

    return events;
  }

  private parseStreamEvent(wire: Record<string, unknown>): CDKEvent[] {
    const inner = wire.event as Record<string, unknown> | undefined;
    if (!inner) return [this.unknown('stream_event', wire)];
    const innerType = inner.type;
    const messageId = (() => {
      const m = inner.message as Record<string, unknown> | undefined;
      return m && typeof m.id === 'string' ? m.id : '';
    })();
    const uuid = typeof wire.uuid === 'string' ? wire.uuid : undefined;

    switch (innerType) {
      case 'message_start': {
        const msg = (inner.message as Record<string, unknown>) ?? {};
        const ev: AssistantMessageStartEvent = {
          type: 'assistant.message_start',
          ...this.base(uuid),
          messageId: String(msg.id ?? ''),
          ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
        };
        return [ev];
      }
      case 'content_block_delta': {
        const delta = (inner.delta as Record<string, unknown>) ?? {};
        if (delta.type === 'text_delta') {
          const ev: AssistantTextDeltaEvent = {
            type: 'assistant.text_delta',
            ...this.base(uuid),
            messageId,
            delta: String(delta.text ?? ''),
          };
          return [ev];
        }
        if (delta.type === 'thinking_delta') {
          const ev: AssistantThinkingDeltaEvent = {
            type: 'assistant.thinking_delta',
            ...this.base(uuid),
            messageId,
            delta: String(delta.thinking ?? ''),
          };
          return [ev];
        }
        // signature_delta and input_json_delta are passed through as unknown
        // for now; we don't have a typed event for them yet.
        return [this.unknown(`stream_event/content_block_delta/${String(delta.type)}`, inner)];
      }
      case 'message_stop': {
        // We can't reconstruct full text without state across deltas; emit a
        // placeholder complete event with empty text. Consumers wanting
        // concatenated text should accumulate from the deltas they observe.
        const ev: AssistantMessageCompleteEvent = {
          type: 'assistant.message_complete',
          ...this.base(uuid),
          messageId,
          text: '',
        };
        return [ev];
      }
      case 'content_block_start':
      case 'content_block_stop':
      case 'message_delta':
        return [this.unknown(`stream_event/${String(innerType)}`, inner)];
      default:
        return [this.unknown(`stream_event/${String(innerType)}`, inner)];
    }
  }

  private parseResult(wire: Record<string, unknown>, _subtype: string | null): CDKEvent[] {
    const ev: SessionDoneEvent = {
      type: 'session.done',
      ...this.base(typeof wire.uuid === 'string' ? wire.uuid : undefined),
      stopReason: (wire.stop_reason as SessionDoneEvent['stopReason']) ?? 'end_turn',
      ...(typeof wire.result === 'string' ? { result: wire.result } : {}),
      usage: this.mapUsage(wire.usage),
      ...(typeof wire.total_cost_usd === 'number' ? { costUsd: wire.total_cost_usd } : {}),
      durationMs: Number(wire.duration_ms ?? 0),
      ...(typeof wire.duration_api_ms === 'number' ? { durationApiMs: wire.duration_api_ms } : {}),
      ...(typeof wire.num_turns === 'number' ? { numTurns: wire.num_turns } : {}),
      isError: wire.is_error === true,
      apiErrorStatus: (wire.api_error_status as number | null | undefined) ?? null,
      ...(typeof wire.terminal_reason === 'string'
        ? { terminalReason: wire.terminal_reason }
        : {}),
      ...(Array.isArray(wire.permission_denials)
        ? {
            permissionDenials: (wire.permission_denials as Record<string, unknown>[]).map(
              (d) => ({
                toolName: String(d.tool_name ?? ''),
                toolUseId: String(d.tool_use_id ?? ''),
                toolInput: d.tool_input,
              }),
            ),
          }
        : {}),
      ...(wire.modelUsage && typeof wire.modelUsage === 'object'
        ? { modelUsage: wire.modelUsage as Record<string, unknown> }
        : {}),
    };
    return [ev];
  }

  // ── Constructors for individual event types ────────────────────────────────

  private makeInit(wire: Record<string, unknown>): SessionInitEvent {
    const apiKeySource = String(wire.apiKeySource ?? 'unknown');
    const authMode: SessionInitEvent['authMode'] =
      apiKeySource === 'none' ? 'subscription' : apiKeySource === 'unknown' ? 'unknown' : 'apikey';

    const mcpRaw = (wire.mcp_servers as Record<string, unknown>[] | undefined) ?? [];
    const mcpServers = mcpRaw.map((m) => ({
      name: String(m.name ?? ''),
      status: String(m.status ?? 'unknown') as 'connected' | 'failed' | 'pending' | string,
      ...(typeof m.error === 'string' ? { error: m.error } : {}),
    }));

    const pluginsRaw = (wire.plugins as Record<string, unknown>[] | undefined) ?? [];
    const plugins = pluginsRaw.map((p) => ({
      name: String(p.name ?? ''),
      ...(typeof p.version === 'string' ? { version: p.version } : {}),
      ...(typeof p.path === 'string' ? { path: p.path } : {}),
      ...(typeof p.source === 'string' ? { source: p.source } : {}),
    }));

    return {
      type: 'session.init',
      ...this.base(typeof wire.uuid === 'string' ? wire.uuid : undefined),
      model: String(wire.model ?? ''),
      cwd: String(wire.cwd ?? ''),
      permissionMode: (wire.permissionMode as PermissionMode) ?? 'default',
      tools: (wire.tools as string[] | undefined) ?? [],
      mcpServers,
      plugins,
      slashCommands: (wire.slash_commands as string[] | undefined) ?? [],
      agents: (wire.agents as string[] | undefined) ?? [],
      skills: (wire.skills as string[] | undefined) ?? [],
      cliVersion: String(wire.claude_code_version ?? ''),
      ...(typeof wire.output_style === 'string' ? { outputStyle: wire.output_style } : {}),
      apiKeySource,
      authMode,
      ...(typeof wire.fast_mode_state === 'string'
        ? { fastModeState: wire.fast_mode_state }
        : {}),
      ...(typeof wire.analytics_disabled === 'boolean'
        ? { analyticsDisabled: wire.analytics_disabled }
        : {}),
      ...(wire.memory_paths && typeof wire.memory_paths === 'object'
        ? { memoryPaths: wire.memory_paths as Record<string, string> }
        : {}),
    };
  }

  private makeHookStarted(wire: Record<string, unknown>): HookStartedEvent {
    return {
      type: 'system.hook_started',
      ...this.base(typeof wire.uuid === 'string' ? wire.uuid : undefined),
      hookId: String(wire.hook_id ?? ''),
      hookName: String(wire.hook_name ?? ''),
      hookEvent: String(wire.hook_event ?? ''),
    };
  }

  private makeHookResponse(wire: Record<string, unknown>): HookResponseEvent {
    return {
      type: 'system.hook_response',
      ...this.base(typeof wire.uuid === 'string' ? wire.uuid : undefined),
      hookId: String(wire.hook_id ?? ''),
      hookName: String(wire.hook_name ?? ''),
      hookEvent: String(wire.hook_event ?? ''),
      outcome: String(wire.outcome ?? ''),
      exitCode: Number(wire.exit_code ?? 0),
      ...(typeof wire.stdout === 'string' ? { stdout: wire.stdout } : {}),
      ...(typeof wire.stderr === 'string' ? { stderr: wire.stderr } : {}),
      ...(typeof wire.output === 'string' ? { output: wire.output } : {}),
    };
  }

  private makePostTurnSummary(wire: Record<string, unknown>): PostTurnSummaryEvent {
    return {
      type: 'system.post_turn_summary',
      ...this.base(typeof wire.uuid === 'string' ? wire.uuid : undefined),
      summarizesUuid: String(wire.summarizes_uuid ?? ''),
      statusCategory: String(wire.status_category ?? ''),
      statusDetail: String(wire.status_detail ?? ''),
      needsAction: String(wire.needs_action ?? ''),
    };
  }

  private makeSystemStatus(wire: Record<string, unknown>): SystemStatusEvent {
    return {
      type: 'system.status',
      ...this.base(typeof wire.uuid === 'string' ? wire.uuid : undefined),
      status: String(wire.status ?? ''),
    };
  }

  private makeRateLimit(wire: Record<string, unknown>): RateLimitEvent {
    const info = (wire.rate_limit_info as Record<string, unknown> | undefined) ?? {};
    return {
      type: 'system.rate_limit',
      ...this.base(typeof wire.uuid === 'string' ? wire.uuid : undefined),
      status: String(info.status ?? ''),
      rateLimitType: String(info.rateLimitType ?? ''),
      ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}),
      ...(typeof info.overageStatus === 'string' ? { overageStatus: info.overageStatus } : {}),
      ...(typeof info.overageDisabledReason === 'string'
        ? { overageDisabledReason: info.overageDisabledReason }
        : {}),
      ...(typeof info.isUsingOverage === 'boolean'
        ? { isUsingOverage: info.isUsingOverage }
        : {}),
    };
  }

  // ── Common helpers ─────────────────────────────────────────────────────────

  private mapUsage(raw: unknown): SessionDoneEvent['usage'] {
    const u = (raw as Record<string, unknown> | undefined) ?? {};
    return {
      inputTokens: Number(u.input_tokens ?? 0),
      outputTokens: Number(u.output_tokens ?? 0),
      ...(typeof u.cache_read_input_tokens === 'number'
        ? { cacheReadTokens: u.cache_read_input_tokens }
        : {}),
      ...(typeof u.cache_creation_input_tokens === 'number'
        ? { cacheCreationTokens: u.cache_creation_input_tokens }
        : {}),
    };
  }

  private base(uuid?: string): Pick<BaseEvent, 'sessionId' | 'turnId' | 'seq' | 'ts' | 'uuid'> {
    return {
      sessionId: this.sessionId,
      turnId: String(this.turnId),
      seq: this.seq++,
      ts: this.now(),
      ...(uuid ? { uuid } : {}),
    };
  }

  private unknown(rawType: string, raw: unknown): UnknownEvent {
    return {
      type: 'meta.unknown',
      ...this.base(),
      rawType,
      raw,
    };
  }
}

/**
 * Convenience: parse a full NDJSON string (one JSON object per line) into a
 * flat list of CDKEvents. Useful for fixture-driven tests.
 */
export function parseNdjson(ndjson: string, opts?: StreamParserOptions): CDKEvent[] {
  const parser = new StreamParser(opts);
  const out: CDKEvent[] = [];
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    out.push(...parser.parseLine(line));
  }
  return out;
}
