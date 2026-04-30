# minimal-electron

The smallest end-to-end example of CDK in an Electron app. Demonstrates:

- **Main process**: `CDKHost.bindIpc(ipcMain)` — registers `cdk:*` handlers
- **Preload**: `contextBridge.exposeInMainWorld('cdk', { invoke, on })` — the
  exact `IpcBridge` shape `@claude-cdk/electron-client` expects
- **Renderer**: `new CDKClient(window.cdk)` driving a single window with a
  textarea, streaming text/thinking deltas, tool-use display, abort, and
  multi-turn via `client.startSession` (re-uses session id with `--resume`)

Runs under `contextIsolation: true` and `sandbox: true` — no Node in the
renderer, no closures crossing the IPC boundary.

## Run

From the repo root:

```bash
pnpm install
pnpm --filter minimal-electron start
```

This builds the main, preload, and bundled renderer (esbuild IIFE), then
launches Electron.

## What you should see

A dark window. Type a prompt, hit `Cmd/Ctrl+Enter` (or click **Send**), and
watch:

- `init · model=…` in the status bar once `session.init` arrives
- Thinking deltas in dim italic, text deltas in regular text
- Tool calls (`↳ Read({"file_path":…})`) and their results
- `done · …ms · in=… out=… · $0.0XX` when the turn finishes

**New session** clears state and starts fresh next send. **Abort** kills the
current turn (tree-kills the child process and any MCP descendants).

## Auth

By default the example does **not** pass `--bare`, so the CLI uses your
existing subscription/keychain login. If you want to test API-key mode,
edit `src/renderer.ts` and add `bare: true` to the `startSession` options
(then make sure `ANTHROPIC_API_KEY` is set in the environment that
launches Electron).

## Layout

```
src/
├── main.ts           # BrowserWindow + CDKHost.bindIpc + 'app:getDefaults'
├── preload.ts        # contextBridge: window.cdk + window.app
├── renderer.ts       # CDKClient + DOM
└── public/
    ├── index.html
    └── style.css
```

Total: ~270 LOC across all files including HTML and CSS — small enough to
read end-to-end in five minutes.
