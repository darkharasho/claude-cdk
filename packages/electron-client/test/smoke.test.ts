import { describe, expect, it } from 'vitest';
import { CDKClient } from '../src/index.js';

describe('@claude-cdk/electron-client smoke', () => {
  it('CDKClient can be constructed with a structural ipc bridge', () => {
    const bridge = {
      invoke: async () => undefined,
      on: () => () => {},
    };
    const client = new CDKClient(bridge);
    expect(client).toBeInstanceOf(CDKClient);
  });
});
