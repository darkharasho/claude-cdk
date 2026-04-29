import { describe, expect, it } from 'vitest';
import { CDKHost } from '../src/index.js';

describe('@claude-cdk/electron-host smoke', () => {
  it('exports a CDKHost subclass with bindIpc that accepts a structural ipcMain', () => {
    const host = new CDKHost();
    const fakeIpc = { handle: () => {}, on: () => {} };
    expect(() => host.bindIpc(fakeIpc)).not.toThrow();
  });
});
