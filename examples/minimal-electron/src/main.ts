/**
 * Electron main process. Spawns CDKHost, binds it to ipcMain, and opens a
 * single window with contextIsolation + sandbox enabled — the design's
 * non-negotiable security baseline.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { CDKHost } from '@claude-cdk/electron-host';

const cdk = new CDKHost();
cdk.bindIpc(ipcMain);

// Renderer asks for sensible defaults at startup (cwd, etc.) — we don't
// want to expose `process.env` directly to the renderer.
ipcMain.handle('app:getDefaults', () => ({
  cwd: process.env.HOME ?? process.env.USERPROFILE ?? '/',
}));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(path.join(__dirname, 'public', 'index.html'));
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
