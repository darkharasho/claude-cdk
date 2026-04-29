# CDK — Claude Development Kit

A distributable framework that lets Electron apps drive a user's already-installed
`claude` CLI. Zero auth handling — the CLI resolves its own credentials.

> **Status:** Phase 0 scaffold. See [DESIGN.md](./DESIGN.md) for the full plan.

## Packages

- **`@claude-cdk/core`** — process spawn, stream parser, session manager, event types. No Electron dependency.
- **`@claude-cdk/electron-host`** — `ipcMain` glue around core.
- **`@claude-cdk/electron-client`** — renderer-process client over IPC.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Requires Node 20+ and `pnpm` (enable via `corepack enable`).
