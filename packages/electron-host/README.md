# @claude-cdk/electron-host

Electron main-process glue for [CDK](https://github.com/darkharasho/claude-cdk).
Wraps `@claude-cdk/core` with `ipcMain` handlers so a renderer-process client
(`@claude-cdk/electron-client`) can drive sessions over IPC.

## Install

```bash
npm install @claude-cdk/electron-host
```

`electron` is a peer dependency.

## Usage

In your Electron main process:

```ts
import { app, ipcMain, BrowserWindow } from 'electron';
import { CDKHost } from '@claude-cdk/electron-host';

app.whenReady().then(() => {
  const host = new CDKHost();
  host.bindIpc(ipcMain);

  const win = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile('index.html');
});
```

In your preload:

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cdk', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_e, ...args) => listener(...args));
    return () => ipcRenderer.removeListener(channel, listener as never);
  },
});
```

The renderer then uses `@claude-cdk/electron-client` against `window.cdk`.

## Channels registered

`cdk:detect`, `cdk:startSession`, `cdk:send`, `cdk:abort`, `cdk:close`,
`cdk:listSessions`, plus per-session event channels of the form
`cdk:event:<sessionId>`.

See [`examples/minimal-electron`](https://github.com/darkharasho/claude-cdk/tree/main/examples/minimal-electron)
for an end-to-end runnable app.

## License

MIT
