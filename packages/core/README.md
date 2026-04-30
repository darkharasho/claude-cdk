# @claude-cdk/core

Electron-free core of [CDK](https://github.com/darkharasho/claude-cdk). Spawns
the user's installed `claude` CLI, parses its `stream-json` output into a
typed event stream, and manages multi-turn sessions. Usable from any Node 20+
script — no Electron dependency.

## Install

```bash
npm install @claude-cdk/core
```

The user's machine must have the `claude` CLI installed and authenticated.
CDK does not handle auth.

## Usage

```ts
import { CDKHost } from '@claude-cdk/core';

const host = new CDKHost();

const detect = await host.detect();
if (!detect.found) throw new Error(detect.reason);

const session = await host.startSession({ cwd: process.cwd() });
for await (const ev of session.send('say hi in five words')) {
  if (ev.type === 'assistant.text_delta') process.stdout.write(ev.delta);
  if (ev.type === 'session.done') console.log('\n→', ev.stopReason);
}
await session.close();
```

## What's in here

- `CDKHost` — `detect()`, `startSession()`, `resumeSession()`, `listSessions()`
- `CDKSession` — `send()` returns `AsyncIterable<CDKEvent>`; `abort()`, `close()`
- `StreamParser` — newline-delimited JSON → discriminated `CDKEvent` union
- `detectClaude()`, `buildSpawnArgs()`, `spawnCli()` — lower-level building blocks
- All event types and the `CDKEvent` union

See the [root README](https://github.com/darkharasho/claude-cdk#readme) for the
full event taxonomy, permission model, and CLI compatibility matrix.

## License

MIT
