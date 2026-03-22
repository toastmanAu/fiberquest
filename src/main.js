/**
 * FiberQuest — Electron main process
 * Manages: UDP poller (RetroArch RAM), Fiber sidecar, game server, IPC
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');
const { Worker } = require('worker_threads');
const GameServer = require('./game-server');
const FiberClient = require('./fiber-client');
const { TournamentManager } = require('./tournament-manager');

// electron-updater — no-ops gracefully in dev/unpackaged mode
let autoUpdater;
try {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload        = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null; // suppress verbose log; we push events to UI
} catch (_) {
  autoUpdater = null;
}

// ── Config ─────────────────────────────────────────────────────────────────

const CONFIG_DEFAULTS = {
  fiberRpcUrl:       'http://127.0.0.1:8227',
  gameServerPort:    8765,
  retroarchHost:     '192.168.68.84',
  retroarchUdp:      55355,
  defaultEntryFee:   100,
  defaultPlayers:    2,
  defaultTimeLimit:  10,
  defaultCurrency:   'Fibt',
  devMode:           false,
  retroarchBin:      'retroarch',
  romsDir:           '',
};

function getConfigPath() {
  return path.join(app.getPath('userData'), 'fiberquest-config.json');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    return { ...CONFIG_DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...CONFIG_DEFAULTS };
  }
}

function saveConfig(updates) {
  const current = loadConfig();
  const next = { ...current, ...updates };
  fs.writeFileSync(getConfigPath(), JSON.stringify(next, null, 2));
  // Apply live to CONFIG
  Object.assign(CONFIG, next);
  // Reconnect fiber client if URL changed
  if (updates.fiberRpcUrl && fiberClient) {
    fiberClient = new FiberClient(CONFIG.fiberRpcUrl, { debug: CONFIG.devMode });
  }
  return next;
}

const CONFIG = loadConfig();

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
    clients: gameServer ? gameServer.clientCount : 0,
  }));

  // RetroArch UDP ping
  ipcMain.handle('retroarch:ping', async () => {
    const dgram = require('dgram');
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        try { sock.close(); } catch (_) {}
        resolve(result);
      };
      sock.on('message', (msg) => {
        finish({ ok: true, response: msg.toString().trim() });
      });
      sock.on('error', () => finish({ ok: false }));
      setTimeout(() => finish({ ok: false, reason: 'timeout' }), 1500);
      const cmd = Buffer.from('GET_STATUS\n');
      sock.send(cmd, CONFIG.retroarchUdp, CONFIG.retroarchHost, (err) => {
        if (err) finish({ ok: false, reason: err.message });
      });
    });
  });

  // Fiber channel summary (for status bar)
  ipcMain.handle('fiber:channelSummary', async () => {
    try {
      const channels = await fiberClient.listChannels();
      const list = channels?.channels || channels || [];
      const ready = list.filter(c =>
        c.state === 'CHANNEL_READY' ||
        c.status === 'CHANNEL_READY' ||
        c.state?.state_name === 'CHANNEL_READY'
      ).length;
      return { ok: true, total: list.length, ready };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Config
  ipcMain.handle('config:get', () => ({ ...CONFIG }));
  ipcMain.handle('config:save', (_, updates) => saveConfig(updates));
  ipcMain.handle('config:defaults', () => ({ ...CONFIG_DEFAULTS }));

  // RetroArch check / first-run setup
  ipcMain.handle('retroarch:check', async () => {
    const { execSync } = require('child_process');
    const bin = CONFIG.retroarchBin || 'retroarch';
    try {
      const p = execSync(`which ${bin}`, { encoding: 'utf8' }).trim();
      return { found: true, path: p };
    } catch (_) {
      return { found: false };
    }
  });

  ipcMain.handle('retroarch:install', async (_, method) => {
    const { exec } = require('child_process');
    const cmds = {
      snap: 'snap install retroarch',
      apt:  'pkexec apt-get install -y retroarch',
      flatpak: 'flatpak install -y flathub org.libretro.RetroArch',
    };
    const cmd = cmds[method];
    if (!cmd) return { ok: false, reason: 'Unknown method: ' + method };
    return new Promise((resolve) => {
      exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) { resolve({ ok: false, reason: stderr || err.message }); }
        else      { resolve({ ok: true }); }
      });
    });
  });

  ipcMain.handle('retroarch:pickRomsDir', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select ROMs Directory',
      properties: ['openDirectory'],
      buttonLabel: 'Select ROMs Folder',
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const romsDir = result.filePaths[0];
    saveConfig({ romsDir });
    return { canceled: false, romsDir };
  });

  // RetroArch launch (only when RetroArch is local)
  ipcMain.handle('retroarch:isLocal', () => {
    const h = CONFIG.retroarchHost;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  });

  ipcMain.handle('retroarch:launch', async (_, gameId) => {
    const h = CONFIG.retroarchHost;
    const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1';
    if (!isLocal) return { ok: false, reason: 'RetroArch is not on this machine' };

    const gamesDir = path.join(__dirname, '../games');
    let game;
    try {
      const file = path.join(gamesDir, `${gameId}.json`);
      game = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return { ok: false, reason: `Game not found: ${gameId}` };
    }

    const { spawn } = require('child_process');
    const romPath = CONFIG.romsDir
      ? path.join(CONFIG.romsDir, game.rom_name)
      : game.rom_name;
    const args = ['-L', game.core, romPath, '--fullscreen'];

    try {
      const child = spawn(CONFIG.retroarchBin, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
}

// ── Tournament IPC handlers ────────────────────────────────────────────────

function setupTournamentIPC() {
  const fs = require('fs');

  ipcMain.handle('tournament:create', (_, opts) => {
    const t = tournamentManager.create(opts);
    tournamentManager.startPaymentPolling(3000);
    return t.status();
  });

  ipcMain.handle('tournament:addPlayer', async (_, tId, playerId, name) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    return t.addPlayer(playerId, name, {});
  });

  ipcMain.handle('tournament:markPaid', (_, tId, playerId) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    t.markPaid(playerId);
  });

  ipcMain.handle('tournament:status', (_, tId) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    return t.status();
  });

  ipcMain.handle('tournament:end', (_, tId) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    return t.end('manual');
  });

  ipcMain.handle('tournament:sendPayout', (_, tId, invoice) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    return t.sendPayout(invoice);
  });

  ipcMain.handle('games:list', () => {
    const gamesDir = path.join(__dirname, '../games');
    try {
      return fs.readdirSync(gamesDir)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')));
    } catch (e) {
      console.error('[Games] Failed to load:', e);
      return [];
    }
  });
}

// ── Tournament → Renderer bridge (push events) ──────────────────────────────

function _wireTournamentToRenderer(tm) {
  const push = (event, data) => {
    if (mainWindow) mainWindow.webContents.send('tournament:event', { event, ...data });
  };

  tm.on('invoice',      data => { console.log('[TM→UI] invoice', data); push('invoice', data); });
  tm.on('player_paid',  data => { console.log('[TM→UI] player_paid', data); push('player_paid', data); });
  tm.on('started',      data => { console.log('[TM→UI] started', data); push('started', data); });
  tm.on('scores',       data => { console.log('[TM→UI] scores', data); push('scores', data); });
  tm.on('winner',       data => { console.log('[TM→UI] winner', data); push('winner', data); });
  tm.on('complete',     data => { console.log('[TM→UI] complete', data); push('complete', data); });
  tm.on('error',        err => { console.error('[TM→UI] error', err); push('error', { message: err.message }); });
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
  setupTournamentIPC();

  // Create window
  createWindow();

  // Wire tournament events to Electron window (after createWindow)
  _wireTournamentToRenderer(tournamentManager);

  // Auto-updater (runs after window so update events can reach renderer)
  setupUpdater();
});

// ── Auto-updater ───────────────────────────────────────────────────────────

function setupUpdater() {
  if (!autoUpdater) return;

  const push = (event, data) => {
    if (mainWindow) mainWindow.webContents.send('update:event', { event, ...data });
  };

  autoUpdater.on('update-available',  info     => push('available',  { version: info.version, releaseDate: info.releaseDate }));
  autoUpdater.on('download-progress', progress => push('progress',   { percent: Math.round(progress.percent), bytesPerSecond: progress.bytesPerSecond }));
  autoUpdater.on('update-downloaded', info     => push('ready',      { version: info.version }));
  autoUpdater.on('error',             err      => console.warn('[Updater]', err.message));

  ipcMain.handle('update:install', () => {
    if (autoUpdater) { setImmediate(() => autoUpdater.quitAndInstall(false, true)); }
  });
  ipcMain.handle('update:check', async () => {
    if (!autoUpdater) return { available: false };
    try { await autoUpdater.checkForUpdates(); return { ok: true }; }
    catch (e) { return { ok: false, reason: e.message }; }
  });

  // Check 8 seconds after launch so we don't slow startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(e => console.warn('[Updater] check failed:', e.message));
  }, 8000);
}

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
