/**
 * Phase 6 E2E: launches the example app under Electron via Playwright's
 * `_electron`, exercises the full IPC bridge under contextIsolation +
 * sandbox, and asserts the right CDK events flow back to the renderer.
 *
 * Two suites:
 *   - smoke (always on): boots Electron, confirms `window.cdk` is exposed
 *     by contextBridge, and round-trips `cdk:detect` through ipcMain.
 *   - integration (opt-in via RUN_CDK_INTEGRATION_TESTS=1): runs a real
 *     Haiku prompt and asserts `session.init` and `session.done` arrive.
 *
 * Run from the example dir:
 *   pnpm --filter minimal-electron test:e2e
 *   RUN_CDK_INTEGRATION_TESTS=1 pnpm --filter minimal-electron test:e2e
 */

import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';

// CDKEvent imported as a type-only reference for the renderer-side listener.
type CDKEvent = { type: string; sessionId: string };

const RUN_INTEGRATION = process.env.RUN_CDK_INTEGRATION_TESTS === '1';
const APP_ROOT = path.resolve(__dirname, '..');

let app: ElectronApplication;
let page: Page;

beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(APP_ROOT, 'dist/main.js')],
    cwd: APP_ROOT,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe('e2e: contextBridge + ipcMain round-trip', () => {
  it('exposes window.cdk with invoke + on', async () => {
    const shape = await page.evaluate(() => ({
      hasCdk: typeof (window as unknown as { cdk?: unknown }).cdk === 'object',
      hasInvoke:
        typeof (window as unknown as { cdk?: { invoke?: unknown } }).cdk?.invoke === 'function',
      hasOn: typeof (window as unknown as { cdk?: { on?: unknown } }).cdk?.on === 'function',
    }));
    expect(shape).toEqual({ hasCdk: true, hasInvoke: true, hasOn: true });
  });

  it('cdk:detect round-trips through the host', async () => {
    const result = await page.evaluate(async () => {
      const cdk = (window as unknown as { cdk: { invoke: (c: string) => Promise<unknown> } }).cdk;
      return cdk.invoke('cdk:detect');
    });
    expect(result).toMatchObject({
      found: expect.any(Boolean),
    });
  });
});

describe.runIf(RUN_INTEGRATION)('e2e integration: real Haiku turn', () => {
  it('startSession + send streams session.init then session.done', async () => {
    const events = await page.evaluate(async (): Promise<CDKEvent[]> => {
      const cdk = (
        window as unknown as {
          cdk: {
            invoke: (c: string, ...a: unknown[]) => Promise<unknown>;
            on: (c: string, l: (...args: unknown[]) => void) => () => void;
          };
        }
      ).cdk;

      const sessionId = (await cdk.invoke('cdk:startSession', {
        cwd: '/tmp',
        model: 'claude-haiku-4-5-20251001',
        noSessionPersistence: true,
        permissionMode: 'bypassPermissions',
      })) as string;

      const collected: CDKEvent[] = [];
      const done = new Promise<void>((resolve) => {
        const off = cdk.on(`cdk:event:${sessionId}`, (...args) => {
          const ev = args[0] as CDKEvent;
          collected.push(ev);
          if (ev.type === 'session.done') {
            off();
            resolve();
          }
        });
      });

      await cdk.invoke('cdk:send', sessionId, 'reply with the single word: pong');
      await done;
      await cdk.invoke('cdk:close', sessionId);
      return collected;
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('session.init');
    expect(types).toContain('session.done');
  }, 60_000);
});
