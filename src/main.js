/**
 * FiberQuest — Electron main process
 * Manages: UDP poller (RetroArch RAM), Fiber sidecar, game server, IPC
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Worker } = require('worker_threads');
const GameServer = require('./game-server');
const FiberClient = require('./fiber-client');

// ── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  fiberRpcUrl:    process.env.FIBER_RPC_URL    || 'http://127.0.0.1:8227',
  gameServerPort: parseInt(process.env.GAME_PORT || '8765'),
  retroarchUdp:   parseInt(process.env.RA_PORT   || '55355'),
  devMode:        process.env.NODE_ENV === 'development',
};

// ── State ──────────────────────────────────────────────────────────────────

let mainWindow;
let gameServer;
let fiberClient;

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d0d',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    // Retro title bar
    title: 'FiberQuest',
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (CONFIG.devMode) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC handlers ───────────────────────────────────────────────────────────

function setupIPC() {
  // Fiber RPC passthrough
  ipcMain.handle('fiber:rpc', async (_, method, params) => {
    return fiberClient.rpc(method, params);
  });

  ipcMain.handle('fiber:nodeInfo', async () => {
    return fiberClient.getNodeInfo();
  });

  ipcMain.handle('fiber:listChannels', async () => {
    return fiberClient.listChannels();
  });

  ipcMain.handle('fiber:listPayments', async (_, params) => {
    return fiberClient.listPayments(params);
  });

  ipcMain.handle('fiber:newInvoice', async (_, amount, description) => {
    return fiberClient.newInvoice(amount, description);
  });

  ipcMain.handle('fiber:sendPayment', async (_, invoice) => {
    return fiberClient.sendPayment(invoice);
  });

  // Game server control
  ipcMain.handle('game:status', async () => ({
    port: CONFIG.gameServerPort,
    running: !!gameServer,
  }));

  // Config
  ipcMain.handle('config:get', () => CONFIG);
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Init Fiber client
  fiberClient = new FiberClient(CONFIG.fiberRpcUrl, { debug: CONFIG.devMode });
  const alive = await fiberClient.isAlive();
  console.log(`[Main] Fiber node at ${CONFIG.fiberRpcUrl}: ${alive ? '✅ connected' : '❌ unreachable'}`);

  // Start game server
  gameServer = new GameServer({
    port: CONFIG.gameServerPort,
    fiberRpcUrl: CONFIG.fiberRpcUrl,
    debug: CONFIG.devMode,
  });
  gameServer.start();

  // Setup IPC
  setupIPC();

  // Create window
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (gameServer) gameServer.stop();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
