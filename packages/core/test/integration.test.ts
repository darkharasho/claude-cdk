/**
 * Integration tests that hit the real `claude` CLI. Skipped by default;
 * opt in via `RUN_CDK_INTEGRATION_TESTS=1`.
 *
 *   RUN_CDK_INTEGRATION_TESTS=1 pnpm --filter @claude-cdk/core test
 *
 * These cost real money/usage. Use Haiku and short prompts only.
 */

import { describe, expect, it } from 'vitest';
import { CDKHost, type CDKEvent } from '../src/index.js';

const RUN = process.env.RUN_CDK_INTEGRATION_TESTS === '1';

describe.runIf(RUN)('integration: real claude CLI', () => {
  it('detect() finds claude on PATH and reads its version', async () => {
    const host = new CDKHost();
    const result = await host.detect();
    expect(result.found).toBe(true);
    expect(result.binaryPath).toBeTruthy();
    expect(result.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
  }, 15_000);

  it('startSession + send replays a real Haiku turn end-to-end', async () => {
    const host = new CDKHost();
    const session = await host.startSession({
      cwd: process.cwd(),
      model: 'claude-haiku-4-5-20251001',
      noSessionPersistence: true,
    });

    const events: CDKEvent[] = [];
    for await (const ev of session.send('Reply with exactly the word: hello')) {
      events.push(ev);
    }

    const init = events.find((e) => e.type === 'session.init');
    const done = events.find((e) => e.type === 'session.done');
    expect(init).toBeDefined();
    expect(done).toBeDefined();
    if (done && done.type === 'session.done') {
      expect(done.isError).toBe(false);
      expect(done.result?.toLowerCase()).toContain('hello');
    }
  }, 60_000);
});

// Always emit a placeholder so this file shows up in the runner even when
// integration tests are skipped.
describe.skipIf(RUN)('integration: real claude CLI (skipped)', () => {
  it.skip('set RUN_CDK_INTEGRATION_TESTS=1 to run real-CLI integration tests', () => {});
});
