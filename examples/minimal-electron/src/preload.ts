/**
 * Preload script. Exposes a minimal IpcBridge to the renderer via
 * contextBridge — exactly what @claude-cdk/electron-client expects.
 *
 * Only `invoke` and `on` cross the boundary. No closures, no node APIs.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('cdk', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const handler = (_e: IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

contextBridge.exposeInMainWorld('app', {
  getDefaults: () => ipcRenderer.invoke('app:getDefaults'),
});
