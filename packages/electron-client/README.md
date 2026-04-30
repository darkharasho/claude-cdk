# @claude-cdk/electron-client

Electron renderer-process client for [CDK](https://github.com/darkharasho/claude-cdk).
Speaks to `@claude-cdk/electron-host` over IPC and exposes the same shape as
`@claude-cdk/core` — including `AsyncIterable<CDKEvent>` streams.

Designed to work under `contextIsolation: true` and `sandbox: true`. No Node
APIs in the renderer; no closures cross the IPC boundary.

## Install

```bash
npm install @claude-cdk/electron-client
```

## Usage

In your preload, expose an `IpcBridge`:

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cdk', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    ipcRenderer.on(channel, (_e, ...args) => listener(...args));
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
```

In the renderer:

```ts
import { CDKClient } from '@claude-cdk/electron-client';

const client = new CDKClient(window.cdk);

const session = await client.startSession({ cwd: '/path/to/project' });

for await (const ev of session.send('hello')) {
  if (ev.type === 'assistant.text_delta') {
    document.getElementById('out')!.textContent += ev.delta;
  }
}
```

## What's in here

- `CDKClient` — mirrors `CDKHost`: `detect()`, `startSession()`, `resumeSession()`, `listSessions()`
- `Session` — same surface as core: `send()`, `abort()`, `close()`
- `IpcBridge` type — the contract your preload must satisfy

See [`examples/minimal-electron`](https://github.com/darkharasho/claude-cdk/tree/main/examples/minimal-electron)
for a working preload + renderer setup.

## License

MIT
