# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project
follows [Semantic Versioning](https://semver.org/) once it leaves 0.x.

## [0.1.0] — 2026-04-29

Initial pre-release. All seven phases of the DESIGN.md plan are implemented.

### Added

- **`@claude-cdk/core`** — Electron-free process driver:
  - `detectClaude()` — locate the CLI on `PATH` and common install dirs;
    never throws (returns `{ found: false, reason }` on failure).
  - `buildSpawnArgs()` / `spawnCli()` — `claude -p` with `stream-json`
    input/output, child lifecycle (`tree-kill` on abort, kill on parent
    exit).
  - `StreamParser` — newline-delimited JSON → `CDKEvent` discriminated
    union. Unknown blobs forwarded verbatim as `meta.unknown`.
  - `CDKSession` — multi-turn sessions via the CLI's `--resume` mechanism;
    `send()` returns `AsyncIterable<CDKEvent>`; `abort()` and `close()`.
  - `CDKHost` — top-level entry point: `detect()`, `startSession()`,
    `resumeSession()`, `listSessions()`.
- **`@claude-cdk/electron-host`** — `CDKHost.bindIpc(ipcMain)` registering
  `cdk:detect`, `cdk:startSession`, `cdk:send`, `cdk:abort`, `cdk:close`,
  `cdk:listSessions`. Per-session event channel namespacing.
- **`@claude-cdk/electron-client`** — renderer-side `CDKClient` wrapping
  the `IpcBridge` shape exposed via `contextBridge`. Events surface as
  `AsyncIterable<CDKEvent>`. Works under `contextIsolation: true` and
  `sandbox: true`.
- **`examples/minimal-electron`** — single-window Electron app
  demonstrating end-to-end use: streaming text/thinking, tool-use
  display, abort, and multi-turn.
- Fixture corpus under `fixtures/` covering simple text, single/multiple
  tool use, permission refusal, extended thinking, mid-stream error, and
  API retries. All parser unit tests run against fixtures.

### Known limitations

- **No runtime permission protocol.** `claude -p` does not expose one.
  Consumers must preapprove tools via `allowedTools` or `permissionMode`.
  `tool.permission_request` events are informational only.
- **`--bare` is API-key-only.** Forces `ANTHROPIC_API_KEY` and refuses
  OAuth/keychain reads. Off by default; opt in via `SessionOptions.bare`.

### Tested platforms

- Linux (ubuntu-latest), Windows (windows-latest), and macOS
  (macos-latest) in CI on every push.

### Tested CLI versions

- `claude` 2.1.123 (Claude Code)
