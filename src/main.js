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
const TournamentManager = require('./tournament-manager');

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
let tournamentManager;

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

  // Start game server (HMI WebSocket bridge)
  gameServer = new GameServer({
    port: CONFIG.gameServerPort,
    debug: CONFIG.devMode,
  });
  await gameServer.start();

  // Tournament manager → wire events to HMI
  tournamentManager = new TournamentManager({ fiberRpc: CONFIG.fiberRpcUrl });
  _wireTournamentToHMI(tournamentManager);

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

// ── Tournament → HMI bridge ────────────────────────────────────────────────

function _wireTournamentToHMI(tm) {
  // Push tournament list to any connected display on manager create
  tm.on('tournament_created', (t) => {
    const items = tm.list().map(x => ({
      id: x.id, game: x.gameId, entryFee: x.entryFee, players: x.playerCount,
    }));
    gameServer.sendTournamentList(items);
    gameServer.sendStatus(`Tournament ready: ${t.gameId}`);
  });

  // Game start → all displays show Live screen
  tm.on('started', ({ gameId, players }) => {
    const names = players || ['Player 1', 'Player 2'];
    gameServer.sendGameStart({
      game: gameId || 'FiberQuest',
      player1: names[0] || 'Player 1',
      player2: names[1] || 'Player 2',
    });
    gameServer.sendStatus('LIVE');
  });

  // Live score updates
  tm.on('scores', ({ scores }) => {
    if (!Array.isArray(scores)) return;
    scores.forEach((entry, idx) => {
      const val = typeof entry === 'object' ? (entry.score ?? entry.value ?? 0) : entry;
      gameServer.sendScore(idx, val);
    });
  });

  // Winner / payout → trigger winner screen on all displays
  tm.on('winner', ({ winner, totalPot }) => {
    const shannons = totalPot ? Math.round(totalPot * 1e8) : 0;
    gameServer.sendWinner({ name: winner?.name || 'Winner', payoutShannons: shannons });
  });

  // Fiber invoice → send status with QR hint
  tm.on('invoice', ({ name, invoice }) => {
    gameServer.sendStatus(`${name}: scan QR to enter`);
    // ESP32 WS client can render QR if it receives invoice event
    // Broadcast raw invoice for displays that support it
    if (gameServer.clientCount > 0) {
      // Extra event for capable displays
      gameServer._broadcast({ event: 'invoice', player: name, bolt11: invoice });
    }
  });

  tm.on('player_paid', ({ name }) => {
    gameServer.sendStatus(`${name} paid — waiting...`);
  });

  tm.on('error', (err) => {
    console.error('[HMI bridge] Tournament error:', err.message);
    gameServer.sendStatus('Error — check console');
  });
}

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
