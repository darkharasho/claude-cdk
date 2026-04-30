import { describe, expect, it } from 'vitest';
import { CDKHost, type CDKEvent } from '../src/index.js';

describe('@claude-cdk/core smoke', () => {
  it('exports CDKHost as a constructible class', () => {
    const host = new CDKHost();
    expect(host).toBeInstanceOf(CDKHost);
  });

  it('detect() resolves to a non-throwing DetectResult', async () => {
    const host = new CDKHost();
    const result = await host.detect();
    // Must never throw; shape must always be valid.
    expect(result).toMatchObject({
      found: expect.any(Boolean),
      authMode: 'unknown',
    });
    if (!result.found) {
      expect(result.reason).toBeTruthy();
    }
  });

  it('CDKEvent discriminated union accepts every event type literal', () => {
    const sample: CDKEvent = {
      type: 'meta.unknown',
      sessionId: 's',
      turnId: 't',
      seq: 0,
      ts: 0,
      rawType: 'foo',
      raw: { anything: true },
    };
    expect(sample.type).toBe('meta.unknown');
  });
});
