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
  sessionId: string;   // which session
  turnId: string;      // which turn within the session
  seq: number;         // monotonic per-session sequence number
  ts: number;          // ms epoch
}
```

### Lifecycle

```ts
interface SessionInitEvent extends BaseEvent {
  type: "session.init";
  model: string;
  cwd: string;
  allowedTools: string[];
  mcpServers: { name: string; status: "connected" | "failed"; error?: string }[];
  plugins:    { name: string; version: string; status: "loaded" | "failed" }[];
  cliVersion: string;
}

interface SessionReadyEvent extends BaseEvent {
  type: "session.ready";
}

interface SessionDoneEvent extends BaseEvent {
  type: "session.done";
  stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "error" | "aborted";
  result?: string;       // final assistant text, if any
  usage: TokenUsage;
  costUsd?: number;
  durationMs: number;
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
  requestId: string;     // pass to session.respondToPermission()
  toolName: string;
  input: Record<string, unknown>;
  rationale?: string;
}
```

> Permission **responses** are not events. They're a method call on the session:
> `session.respondToPermission(requestId, decision)`. This avoids shipping
> closures across the IPC boundary, which is fragile.

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
  mcpServers?: Record<string, McpServerConfig>;
  systemPrompt?: string;
}

class Session {
  readonly id: string;
  send(prompt: string): AsyncIterable<CDKEvent>;
  respondToPermission(requestId: string, decision: PermissionDecision): void;
  abort(): Promise<void>;
  close(): Promise<void>;
}

type PermissionDecision = "allow" | "deny" | "always_allow";
```

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
- Spawn wrapper around the CLI in `--bare` mode with stream-json output.
  Tentative arg shape (verify against `claude -p --help` first):

  ```
  claude --bare -p --output-format stream-json --verbose
         --input-format stream-json
         [--allowedTools ...]
         [--cwd ...]
         [--resume <sessionId>]
  ```

- Handle child process lifecycle: kill on parent exit (`tree-kill`), forward
  `SIGINT`, capture stderr for diagnostics.

**Research item:** the exact stdin/stdout contract of `claude --bare` with
`--input-format stream-json`. Run it manually and save a few example sessions
before locking in the spawn args.

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

### Phase 4 — Permission flow (½ day, has unknowns)

**Research first.** Confirm how `claude --bare` actually surfaces permission
prompts and accepts responses. Possibilities:
1. Stream-json events on stdout, JSON responses written to stdin
2. Only preapproval via `--allowedTools`; runtime prompts unsupported in `--bare`
3. Some other mechanism

Once confirmed:
- If (1): wire `respondToPermission()` to write the response to the child's stdin
- If (2): document that consumers must preapprove tools via
  `allowedTools`, and `tool.permission_request` becomes informational only
- If (3): adapt as needed

Don't guess. Run the real CLI and observe.

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
- **Permission flow in `--bare`.** Genuinely unclear without checking. May
  force a docs-level workaround.
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
