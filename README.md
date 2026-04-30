# CDK — Claude Development Kit

A distributable framework that lets Electron apps drive a user's already-installed
`claude` CLI. Zero auth handling — the CLI resolves its own credentials.

> **Status:** 0.1.0 (pre-release). All phases of the [DESIGN.md](./DESIGN.md)
> plan are implemented. See the [compatibility matrix](#cli-compatibility) for
> tested CLI versions.

## Packages

- **`@claude-cdk/core`** — process spawn, stream parser, session manager, event types. No Electron dependency.
- **`@claude-cdk/electron-host`** — `ipcMain` glue around core.
- **`@claude-cdk/electron-client`** — renderer-process client over IPC.

## Install

```bash
npm install @claude-cdk/core
# Electron consumers also want:
npm install @claude-cdk/electron-host @claude-cdk/electron-client
```

The user's machine must have the `claude` CLI installed and authenticated
(via `claude login` or `ANTHROPIC_API_KEY`). CDK does not handle auth.

## Ten-line minimal example

```ts
import { CDKHost } from '@claude-cdk/core';

const host = new CDKHost();
const session = await host.startSession({ cwd: process.cwd() });
for await (const ev of session.send('say hi in five words')) {
  if (ev.type === 'assistant.text_delta') process.stdout.write(ev.delta);
  if (ev.type === 'session.done') console.log('\n→', ev.stopReason);
}
await session.close();
```

For a full Electron app (main + preload + renderer with streaming UI, abort,
multi-turn), see [`examples/minimal-electron`](./examples/minimal-electron).

## Event taxonomy

All events share `{ type, sessionId, turnId, seq, ts }`. The discriminated
union is exported as `CDKEvent`.

| Group     | Type                                    | When                                             |
| --------- | --------------------------------------- | ------------------------------------------------ |
| Lifecycle | `session.init`                          | Child started, model/cwd/tools/MCP/plugins known |
|           | `session.ready`                         | Ready for first prompt                           |
|           | `session.done`                          | Turn finished — stopReason, usage, costUsd       |
|           | `session.error`                         | Recoverable or fatal error                       |
|           | `session.aborted`                       | `abort()` or parent exit                         |
| Assistant | `assistant.message_start`               | New assistant message in stream                  |
|           | `assistant.text_delta`                  | Streaming text chunk                             |
|           | `assistant.thinking_delta`              | Streaming extended-thinking chunk                |
|           | `assistant.message_complete`            | Final concatenated text/thinking                 |
| Tool use  | `tool.use_start`                        | Model invoked a tool                             |
|           | `tool.use_complete`                     | Invocation block closed                          |
|           | `tool.result`                           | Tool returned (success or error)                 |
|           | `tool.permission_request`               | Informational only — see permission model below  |
| System    | `system.api_retry`                      | CLI retried an API call                          |
|           | `system.compaction`                     | Conversation auto-compacted                      |
|           | `system.plugin_install`                 | Plugin install lifecycle                         |
|           | `system.warning`                        | Non-fatal warning                                |
|           | `system.hook_started` / `hook_response` | User hook ran                                    |
|           | `system.post_turn_summary`              | End-of-turn summary                              |
|           | `system.status` / `rate_limit`          | Status/rate-limit signals                        |
| Meta      | `meta.usage`                            | Mid-turn token usage update                      |
|           | `meta.unknown`                          | Forward-compat passthrough — see below           |

`meta.unknown` is the forward-compatibility escape hatch: any stream-json
blob the parser doesn't recognize is wrapped verbatim and forwarded. CLI
updates that introduce new event types do not break consumers.

## Permission model

Phase 1 research confirmed: `claude -p` (with or without `--bare`) does not
support a runtime permission-prompt protocol. There is no stdin-side
response channel for "approve this Bash call." Consequences:

- **Preapprove tools via `SessionOptions.allowedTools`** (or
  `permissionMode: 'acceptEdits' | 'bypassPermissions'`) when starting a
  session. Anything not preapproved will be refused by the CLI mid-turn.
- `tool.permission_request` events are **informational only** — they tell
  you the model wanted a tool that wasn't allowed. There is no
  `respondToPermission()` method; closures don't cross IPC anyway.
- For interactive UX (Electron app surfacing an "Allow this tool?" dialog),
  the consumer pattern is: catch the refusal, ask the user, restart the
  turn with an expanded `allowedTools`.

## What CDK does not do

- **No auth.** No API-key storage, no OAuth flow, no keychain reads. The
  CLI handles all of that. CDK just spawns it.
- **No transcript modeling.** The CLI already persists transcripts to
  `~/.claude/projects/`. Resume via `SessionOptions.resumeSessionId`.
- **No runtime permission prompts.** See above.
- **No hosted/server usage.** CDK is a local process driver. Don't ship it
  behind a public API.
- **No Agent SDK replacement.** For non-Electron, non-CLI-driving use
  cases, use the official Agent SDK instead.

## CLI compatibility

CDK is tested against the following `claude` CLI versions:

| CLI version | Status    | Notes                            |
| ----------- | --------- | -------------------------------- |
| 2.1.123     | ✅ tested | Development baseline (Phase 1–7) |

Older versions may work — `meta.unknown` ensures unrecognized events pass
through rather than crash — but are not in CI. If you hit a schema
mismatch, file an issue with the offending stream-json blob.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Requires Node 20+ and `pnpm` (enable via `corepack enable`). See
[DESIGN.md](./DESIGN.md) for architecture and the phased build plan, and
[CHANGELOG.md](./CHANGELOG.md) for release notes.
