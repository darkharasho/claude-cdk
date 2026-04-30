# CDK — Claude Development Kit

A distributable framework that lets Electron apps drive a user's already-installed
Claude Code CLI without touching auth, OAuth, or API keys. Each consumer
authenticates `claude` themselves; CDK is purely a process driver and event bus.

---

## Goals

- Distributable npm package consumed by multiple Electron apps
- Zero auth handling — the CLI resolves its own credentials
- Stream-first event model (no fake request/response over a streaming protocol)
- Clean main-process / renderer-process split for Electron
- Forward-compatible with CLI updates

## Non-goals (initial release)

- API key management
- Hosted / server-side usage
- Replacing the official Agent SDK for non-Electron contexts
- Modeling or persisting transcripts (the CLI already does this in `~/.claude/projects/`)

---

## Architecture

Monorepo with three packages:

- **`@claude-cdk/core`** — process spawn, stream parser, session manager, event types. No Electron dependency. Independently usable from any Node script.
- **`@claude-cdk/electron-host`** — thin glue that registers `ipcMain` handlers around core.
- **`@claude-cdk/electron-client`** — renderer-process client speaking to the host over IPC, exposing the same shape as core.

Keeping core Electron-free is the single most important architectural choice.
It makes the package testable without spinning up Electron and lets non-Electron
consumers benefit later if you want.

---

## Event Taxonomy

All events share a base shape:

```ts
interface BaseEvent {
  type: string;        // discriminator
  sessionId: string;   // which session (from wire `session_id`)
  turnId: string;      // which turn within the session (synthesized by parser)
  seq: number;         // monotonic per-session sequence number (synthesized)
  ts: number;          // ms epoch (synthesized on receive)
  uuid?: string;       // wire `uuid`, when present
}
```

> **Wire reality.** The CLI's stream-json wire format does not carry
> `turnId`/`seq`/`ts`. The parser synthesizes them: `seq` is a monotonic
> counter per session, `ts` is `Date.now()` at receive, `turnId` is bumped
> on each new user→result turn boundary. Wire `session_id` and `uuid` map
> through verbatim.

### Lifecycle

```ts
interface SessionInitEvent extends BaseEvent {
  type: "session.init";
  model: string;
  cwd: string;
  permissionMode: "default" | "auto" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan";
  tools: string[];                                                    // wire `tools`
  mcpServers: { name: string; status: "connected" | "failed" | "pending"; error?: string }[];
  plugins:    { name: string; version?: string; path?: string; source?: string }[];
  slashCommands: string[];
  agents: string[];
  skills: string[];
  cliVersion: string;                                                 // wire `claude_code_version`
  outputStyle?: string;
  apiKeySource: "none" | "user" | "project" | "anthropic" | string;   // observed: "none" for OAuth/keychain
  authMode: "subscription" | "apikey" | "unknown";                    // derived from apiKeySource
  fastModeState?: string;
  analyticsDisabled?: boolean;
  memoryPaths?: Record<string, string>;
}

interface SessionReadyEvent extends BaseEvent {
  type: "session.ready";
}

interface SessionDoneEvent extends BaseEvent {
  type: "session.done";
  stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "error" | "aborted";
  result?: string;                            // final assistant text, if any
  usage: TokenUsage;
  costUsd?: number;
  durationMs: number;                         // wire `duration_ms`
  durationApiMs?: number;                     // wire `duration_api_ms`
  numTurns?: number;                          // wire `num_turns`
  isError: boolean;                           // wire `is_error`
  apiErrorStatus?: number | null;             // wire `api_error_status`, e.g. 404
  terminalReason?: string;                    // wire `terminal_reason`, e.g. "completed"
  permissionDenials?: { toolName: string; toolUseId: string; toolInput: unknown }[];
  modelUsage?: Record<string, unknown>;       // wire `modelUsage`, per-model breakdown
}

interface SessionErrorEvent extends BaseEvent {
  type: "session.error";
  error: { code: string; message: string; recoverable: boolean };
}

interface SessionAbortedEvent extends BaseEvent {
  type: "session.aborted";
  reason: "user" | "timeout" | "parent_exit";
}
```

### Assistant content

```ts
interface AssistantMessageStartEvent extends BaseEvent {
  type: "assistant.message_start";
  messageId: string;
}

interface AssistantTextDeltaEvent extends BaseEvent {
  type: "assistant.text_delta";
  messageId: string;
  delta: string;
}

interface AssistantThinkingDeltaEvent extends BaseEvent {
  type: "assistant.thinking_delta";
  messageId: string;
  delta: string;
}

interface AssistantMessageCompleteEvent extends BaseEvent {
  type: "assistant.message_complete";
  messageId: string;
  text: string;          // full concatenated text
  thinking?: string;     // full thinking, if any
}
```

### Tool use

```ts
interface ToolUseStartEvent extends BaseEvent {
  type: "tool.use_start";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolUseCompleteEvent extends BaseEvent {
  type: "tool.use_complete";
  toolUseId: string;
}

interface ToolResultEvent extends BaseEvent {
  type: "tool.result";
  toolUseId: string;
  result: unknown;
  isError: boolean;
}

interface PermissionRequestEvent extends BaseEvent {
  type: "tool.permission_request";
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  rationale?: string;
}
```

> **Permission flow in `-p` mode is preapproval-only.** The CLI does not
> prompt interactively; non-allowed tool calls are auto-denied with a
> synthetic `tool_result` carrying `is_error: true`. The parser emits
> `tool.permission_request` informationally when it sees this denial
> pattern (and from `result.permission_denials` retroactively). Consumers
> configure tools up-front via `SessionOptions.allowedTools` /
> `disallowedTools` / `permissionMode`. There is no runtime
> `respondToPermission()` API in this CLI version.

### System

```ts
interface ApiRetryEvent extends BaseEvent {
  type: "system.api_retry";
  attempt: number;
  delayMs: number;
  reason: string;
}

interface CompactionEvent extends BaseEvent {
  type: "system.compaction";
  tokensBefore: number;
  tokensAfter: number;
}

interface PluginInstallEvent extends BaseEvent {
  type: "system.plugin_install";
  name: string;
  status: "starting" | "complete" | "failed";
  error?: string;
}

interface WarningEvent extends BaseEvent {
  type: "system.warning";
  message: string;
  code?: string;
}

interface HookStartedEvent extends BaseEvent {
  type: "system.hook_started";
  hookId: string;
  hookName: string;          // e.g. "SessionStart:startup"
  hookEvent: string;         // e.g. "SessionStart"
}

interface HookResponseEvent extends BaseEvent {
  type: "system.hook_response";
  hookId: string;
  hookName: string;
  hookEvent: string;
  outcome: "success" | "failure" | string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  output?: string;           // raw `output` field from wire
}

interface PostTurnSummaryEvent extends BaseEvent {
  type: "system.post_turn_summary";
  summarizesUuid: string;
  statusCategory: string;    // e.g. "review_ready"
  statusDetail: string;
  needsAction: string;
}

interface SystemStatusEvent extends BaseEvent {
  type: "system.status";
  status: string;            // e.g. "requesting"
}

interface RateLimitEvent extends BaseEvent {
  type: "system.rate_limit";
  status: "allowed" | "rejected" | string;
  rateLimitType: string;     // e.g. "five_hour"
  resetsAt?: number;         // epoch seconds
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}
```

### Meta / forward-compat

```ts
interface UsageUpdateEvent extends BaseEvent {
  type: "meta.usage";
  usage: TokenUsage;
}

interface UnknownEvent extends BaseEvent {
  type: "meta.unknown";
  rawType: string;
  raw: unknown;          // pass-through of unrecognized stream-json blob
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}
```

### Discriminated union

```ts
export type CDKEvent =
  | SessionInitEvent | SessionReadyEvent | SessionDoneEvent
  | SessionErrorEvent | SessionAbortedEvent
  | AssistantMessageStartEvent | AssistantTextDeltaEvent
  | AssistantThinkingDeltaEvent | AssistantMessageCompleteEvent
  | ToolUseStartEvent | ToolUseCompleteEvent | ToolResultEvent
  | PermissionRequestEvent
  | ApiRetryEvent | CompactionEvent | PluginInstallEvent | WarningEvent
  | HookStartedEvent | HookResponseEvent | PostTurnSummaryEvent
  | SystemStatusEvent | RateLimitEvent
  | UsageUpdateEvent | UnknownEvent;
```

The `meta.unknown` event is the forward-compatibility escape hatch. Any
stream-json event the parser doesn't recognize gets wrapped and passed through
verbatim, so a CLI update that adds new event types never breaks consumers.

---

## Public API

```ts
class CDKHost {
  constructor(opts?: { binaryPath?: string; env?: Record<string, string> });

  detect(): Promise<DetectResult>;
  startSession(opts: SessionOptions): Promise<Session>;
  resumeSession(sessionId: string): Promise<Session>;
  listSessions(): Promise<SessionMeta[]>;

  // Electron host only:
  bindIpc(ipcMain: Electron.IpcMain): void;
}

interface DetectResult {
  found: boolean;
  binaryPath?: string;
  cliVersion?: string;
  authMode: "subscription" | "apikey" | "unknown";
  reason?: string;       // populated when found === false
}

interface SessionOptions {
  cwd: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[];                    // restrict the built-in tool set
  mcpServers?: Record<string, McpServerConfig>;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissionMode?: "default" | "auto" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan";
  bare?: boolean;                      // pass --bare; requires ANTHROPIC_API_KEY (no OAuth/keychain)
  includePartialMessages?: boolean;    // pass --include-partial-messages for delta streaming
  includeHookEvents?: boolean;         // pass --include-hook-events
  noSessionPersistence?: boolean;      // pass --no-session-persistence
  sessionId?: string;                  // pass --session-id <uuid>
  resumeSessionId?: string;            // pass --resume <id>
}

class Session {
  readonly id: string;
  send(prompt: string): AsyncIterable<CDKEvent>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
```

> **No `respondToPermission()` API.** As documented under §Event Taxonomy,
> the CLI in `-p` mode does not support runtime permission prompts.
> Tools are configured up-front via `allowedTools`/`disallowedTools`/
> `permissionMode` and denied calls are surfaced through
> `tool.permission_request` events for the consumer's UI.

`detect()` must **never throw**. Return `{ found: false, reason }` on failure
so callers can render a "Claude Code not installed" UI state.

---

## Implementation Plan

### Phase 0 — Scaffold (1–2 hrs)

- pnpm monorepo with the three packages above
- TypeScript strict, ESM, dual-build via tsup
- Vitest, ESLint, Prettier, GitHub Actions for lint + test
- Minimum Node target = Electron's bundled Node (currently 20.x)
- Stub all exports from the Event Taxonomy and Public API sections so the
  whole graph type-checks end-to-end before any logic exists

**Done when:** `pnpm -r build && pnpm -r test` is green with empty test files.

### Phase 1 — Detect & spawn (½ day)

- `detect()`: search `PATH` plus common install locations
  (`/usr/local/bin`, `~/.npm-global/bin`, `~/.local/bin`, `%APPDATA%\npm`),
  run `claude --version`, parse the result
- Auth state detection beyond "binary works" is unreliable without making a
  real call. Initial contract: `authMode: "unknown"`. Improve later if needed.
- Spawn wrapper around the CLI in `-p` (print) mode with stream-json output.
  **Verified arg shape against CLI 2.1.119:**

  ```
  claude -p
         --output-format stream-json
         --verbose                              # required for stream events
         --input-format stream-json             # for streaming input
         [--include-partial-messages]           # opt-in delta streaming
         [--allowed-tools <list>]
         [--disallowed-tools <list>]
         [--tools <list>]                       # restrict built-in set
         [--model <name>]
         [--system-prompt <text>] | [--append-system-prompt <text>]
         [--mcp-config <path-or-json>]
         [--permission-mode default|auto|acceptEdits|bypassPermissions|dontAsk|plan]
         [--no-session-persistence]
         [--session-id <uuid>] | [--resume <id>]
         [--bare]                               # opt-in; forces ANTHROPIC_API_KEY
  ```

  - `--cwd` does **not** exist as a CLI flag. Working directory is set on
    the child process via `spawn(cmd, args, { cwd })`.
  - When the prompt is passed as argv, redirect stdin to `/dev/null` to
    avoid the CLI's "no stdin in 3s" warning.
  - `--bare` forces `ANTHROPIC_API_KEY`/`apiKeyHelper` auth; OAuth and
    keychain are not read in bare mode. So `bare: true` is incompatible
    with subscription-only users. Default `bare: false`.

- Handle child process lifecycle: kill on parent exit, forward `SIGINT`,
  capture stderr for diagnostics.

### Phase 2 — Stream parser (½ day)

- Newline-delimited JSON parser as a backpressure-aware Transform stream
- Map each raw stream-json event to a `CDKEvent`
- Unrecognized events → `meta.unknown` preserving the full raw payload
- **Build a fixture corpus**: run real `claude -p` against a representative
  set of prompts and save the stream-json output to `fixtures/`:
  - simple text response
  - response with one tool use
  - response with multiple tool uses
  - response that triggers a permission prompt
  - response with extended thinking
  - response that errors mid-stream
  - response that retries an API call
- All parser unit tests run against fixtures, no network needed.

This phase is the highest-leverage part of the project. Good fixtures make
every later phase trivial to verify.

### Phase 3 — Session manager (1 day)

- One child process per session
- `send()` returns an `AsyncIterable<CDKEvent>` that yields until
  `session.done` or `session.error`
- Sessions are reusable across multiple `send()` calls (multi-turn)
- `abort()` signals the child, drains pending events, emits
  `session.aborted`, resolves
- Concurrent sessions = independent child processes; no shared state in core
- Session metadata cached in memory; canonical state lives in
  `~/.claude/projects/` and is reached via the CLI's own resume mechanism

### Phase 4 — Permission flow (resolved during Phase 1 research)

**Resolved.** Possibility (2) wins. In `-p` mode the CLI does **not**
prompt interactively. Non-allowed tool calls are auto-denied with a
synthetic `tool_result` carrying `is_error: true` and content
`"Claude requested permissions to use <tool>, but you haven't granted it yet."`
The model adapts on its own; the final `result` event lists every denial in
`permission_denials`. There is no stdin protocol for responding.

**Implementation:**

- The parser emits `tool.permission_request` informationally when it sees a
  denied `tool_result` block, and retroactively from
  `result.permission_denials` if any survived to the result without a prior
  per-block denial.
- `Session.respondToPermission()` is **not part of the API** — there's
  nothing to respond to.
- Consumers configure tools up-front via `SessionOptions.allowedTools`,
  `disallowedTools`, `tools`, and `permissionMode`. Document this clearly.
- See `fixtures/07-permission-denied.ndjson` for the canonical denial wire
  pattern that Phase 2 must parse.

### Phase 5 — Electron IPC (½ day)

- `CDKHost.bindIpc(ipcMain)` registers handlers:
  `cdk:detect`, `cdk:startSession`, `cdk:send`, `cdk:respond`,
  `cdk:abort`, `cdk:listSessions`
- `CDKClient` in the renderer wraps `ipcRenderer.invoke` + `ipcRenderer.on`
- Stream events: host pushes via `webContents.send('cdk:event:<sessionId>', ev)`,
  client exposes them as `AsyncIterable` using a small adapter
- Per-session channel namespace prevents cross-talk
- All event payloads are already JSON-safe by design; permission responses are
  `(requestId, decision)` strings — no closures crossing the boundary
- Must work under `contextIsolation: true` and `sandbox: true`. Use
  `contextBridge` in the example app.

### Phase 6 — Tests (ongoing, formalize here)

- **Unit** — parser against fixtures, session lifecycle with a mock spawn
- **Integration** — real CLI on a dev machine, tagged tests opted-in via env var
- **E2E** — example Electron app launched headlessly with Playwright, sends a
  trivial prompt, asserts the right events arrive

### Phase 7 — Examples & docs

- `examples/minimal-electron` — single-window app with a textarea + streaming
  response pane, ~150 LOC including UI
- README with: install, ten-line minimal example, event taxonomy table,
  permission model, "what CDK does not do"
- CHANGELOG, semver, tested-against-CLI-versions matrix

---

## Risks & open questions

- **Stream-json schema drift.** The CLI is updated frequently. Mitigations:
  fixture-based tests, `meta.unknown` passthrough, public compatibility matrix.
- **`--bare` is API-key-only.** `--bare` forces `ANTHROPIC_API_KEY` and
  refuses OAuth/keychain reads, breaking subscription auth. Default off;
  exposed as `SessionOptions.bare` for API-key consumers who want a
  minimal context (no hooks, plugins, CLAUDE.md).
- **Permission flow in `-p` mode is preapproval-only.** ~~Unclear~~
  resolved (Phase 1). No runtime prompt protocol; consumers must
  preapprove tools.
- **Windows subprocess management.** Meaningfully different from Unix. Test
  on Windows in Phase 1, not Phase 6.
- **Electron context isolation / sandbox.** The renderer client must work
  under both. Bake this into the example app from day one.

---

## Handing this to Claude Code

Drop this file into the repo as `DESIGN.md` and start a fresh Claude Code
session with:

> Read DESIGN.md. Start with Phase 0. Set up the monorepo, get the type
> definitions from the Event Taxonomy section compiling end-to-end across all
> three packages, then stop and show me the structure before moving to Phase 1.

Phase-by-phase prompting keeps Claude Code from over-reaching. After each
phase, review what was built and confirm the assumptions before the next.
The fixture corpus in Phase 2 is the highest-leverage investment in the
whole project — push to get those fixtures real and complete before the
parser logic.
