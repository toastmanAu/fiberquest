/**
 * FiberQuest — Electron main process
 * Manages: UDP poller (RetroArch RAM), Fiber sidecar, game server, IPC
 */

'use strict';

const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs   = require('fs');
const { Worker } = require('worker_threads');
const GameServer = require('./game-server');
const FiberClient = require('./fiber-client');
const { TournamentManager } = require('./tournament-manager');
const { detectAll, pickBestNode, pickBestCkbNode, startNodeService, launchInstaller } = require('./fiber-setup');

// ── Secure key storage ──────────────────────────────────────────────────────

function keysPath() {
  return path.join(app.getPath('userData'), 'fiberquest-keys.enc');
}

function saveSecureKey(name, value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable');
  const all = loadAllKeys();
  all[name] = safeStorage.encryptString(value).toString('base64');
  fs.writeFileSync(keysPath(), JSON.stringify(all));
}

function loadSecureKey(name) {
  try {
    const all = loadAllKeys();
    if (!all[name]) return null;
    return safeStorage.decryptString(Buffer.from(all[name], 'base64'));
  } catch (_) { return null; }
}

function loadAllKeys() {
  try { return JSON.parse(fs.readFileSync(keysPath(), 'utf8')); }
  catch (_) { return {}; }
}

function deleteSecureKey(name) {
  const all = loadAllKeys();
  delete all[name];
  fs.writeFileSync(keysPath(), JSON.stringify(all));
}

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
  fiberRpcUrl:                 process.env.FIBER_RPC_URL    || 'http://127.0.0.1:8227',
  fiberAuthToken:              process.env.FIBER_AUTH_TOKEN || null,
  ckbRpcUrl:                   process.env.CKB_RPC_URL      || 'https://testnet.ckbapp.dev/',
  gameServerPort:              8765,
  retroarchHost:               '127.0.0.1',
  retroarchUdp:                55355,
  defaultEntryFee:             100,
  defaultPlayers:              2,
  defaultMinPlayers:           2,
  defaultTimeLimit:            10,
  defaultCurrency:             'Fibt',
  defaultRegistrationMinutes:  10,
  settlementBufferSec:         30,
  devMode:                     false,
  retroarchBin:                'retroarch',
  romsDir:                     '',
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
    fiberClient = new FiberClient(CONFIG.fiberRpcUrl, { debug: CONFIG.devMode, authToken: CONFIG.fiberAuthToken });
  }
  return next;
}

const CONFIG = loadConfig();

// ── State ──────────────────────────────────────────────────────────────────

let mainWindow;
let gameServer;
let fiberClient;
let tournamentManager;
let agentWallet = null;

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

  // ── Fiber node setup / auto-detection ────────────────────────────────────

  ipcMain.handle('fiber:detect', async () => {
    const { fiber, ckb, bestFiber, bestCkb } = await detectAll()
    return { nodes: fiber, best: bestFiber, ckb, bestCkb }
  })

  ipcMain.handle('fiber:startService', async (_, nodeJson) => {
    const result = startNodeService(nodeJson)
    if (result.ok) {
      // Give the service a moment to come up then re-query
      await new Promise(r => setTimeout(r, 2000))
      const nodes = await detectFiberNodes()
      const updated = nodes.find(n => n.prefix === nodeJson.prefix)
      return { ok: true, node: updated || nodeJson }
    }
    return result
  })

  ipcMain.handle('fiber:install', () => {
    return launchInstaller()
  })

  ipcMain.handle('fiber:applyDetected', async (_, rpcUrl, ckbRpcUrl) => {
    const updates = {}
    if (rpcUrl) {
      CONFIG.fiberRpcUrl = rpcUrl
      fiberClient = new FiberClient(CONFIG.fiberRpcUrl, { debug: CONFIG.devMode, authToken: CONFIG.fiberAuthToken })
      if (tournamentManager) tournamentManager.fiberRpc = rpcUrl
      updates.fiberRpcUrl = rpcUrl
    }
    if (ckbRpcUrl) {
      CONFIG.ckbRpcUrl = ckbRpcUrl
      updates.ckbRpcUrl = ckbRpcUrl
    }
    saveConfig(updates)
    return { ok: true, rpcUrl, ckbRpcUrl }
  })

  // Game server control
  ipcMain.handle('game:status', async () => ({
    port: CONFIG.gameServerPort,
    running: !!gameServer,
    clients: gameServer ? gameServer.clientCount : 0,
  }));

  // RetroArch UDP ping
  // Send a message to RetroArch OSD (same UDP port as RAM polling)
  ipcMain.handle('retroarch:showMsg', async (_, msg) => {
    const dgram = require('dgram');
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      const cmd = Buffer.from(`SHOW_MSG ${msg}\n`);
      sock.send(cmd, CONFIG.retroarchUdp, CONFIG.retroarchHost, (err) => {
        sock.close();
        resolve({ ok: !err, error: err?.message });
      });
    });
  });

  // Set controller port mapping for a tournament (playerId → gamepad index)
  ipcMain.handle('tournament:setControllerMap', (_, tId, map) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    t._controllerMap = map; // { 'player-0': 0, 'player-1': 1 }
    console.log(`[Main] Controller map set for ${tId}:`, map);
    return { ok: true };
  });

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

  // Agent — CKB wallet (key stored encrypted via safeStorage)
  ipcMain.handle('agent:setKey', async (_, privateKey) => {
    try {
      saveSecureKey('ckbPrivateKey', privateKey);
      agentWallet = _initAgentWallet(privateKey);
      if (tournamentManager) {
        tournamentManager.wallet     = agentWallet;
        tournamentManager.chainStore = _initChainStore(agentWallet);
      }
      return { ok: true, address: agentWallet.address };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('agent:clearKey', () => {
    deleteSecureKey('ckbPrivateKey');
    agentWallet = null;
    if (tournamentManager) {
      tournamentManager.wallet     = null;
      tournamentManager.chainStore = null;
    }
    return { ok: true };
  });

  ipcMain.handle('agent:status', async () => {
    if (!agentWallet) return { active: false, configured: false };
    try {
      const balance = await agentWallet.getBalance();
      return { active: true, configured: true, address: agentWallet.address, balanceCkb: balance };
    } catch (e) {
      return { active: true, configured: true, address: agentWallet.address, balanceCkb: null, error: e.message };
    }
  });

  // Chain — tournament discovery
  ipcMain.handle('chain:scan', async () => {
    if (!tournamentManager?.chainStore) return { ok: false, reason: 'Agent key not configured' };
    try {
      const tournaments = await tournamentManager.scanChain();
      return { ok: true, tournaments };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  // QR code generation
  ipcMain.handle('qr:generate', async (_, text) => {
    const QRCode = require('qrcode');
    return QRCode.toDataURL(text, { errorCorrectionLevel: 'L', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
  });

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
    console.log(`[Main] retroarch:launch called — gameId=${gameId}`);
    const h = CONFIG.retroarchHost;
    const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1';
    if (!isLocal) { console.log('[Main] RetroArch not local, skipping'); return { ok: false, reason: 'RetroArch is not on this machine' }; }

    const gamesDir = path.join(__dirname, '../games');
    let game;
    try {
      const file = path.join(gamesDir, `${gameId}.json`);
      game = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return { ok: false, reason: `Game not found: ${gameId}` };
    }

    const romPath = _findRom(game.rom_name);
    console.log(`[Main] ROM lookup: ${game.rom_name} → ${romPath || 'NOT FOUND'}`);
    if (!romPath) return { ok: false, reason: `ROM not found: ${game.rom_name}` };

    const { spawn } = require('child_process');
    // Launch via bash in a new session to escape Electron's GPU process group
    const cmd = `${CONFIG.retroarchBin} -L "${game.core}" "${romPath}" > /tmp/retroarch-launch.log 2>&1`;

    try {
      const child = spawn('bash', ['-c', cmd], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
      console.log(`[Main] RetroArch spawned via bash, PID=${child.pid}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
}

// ── Tournament IPC handlers ────────────────────────────────────────────────

function setupTournamentIPC() {
  const fs = require('fs');

  ipcMain.handle('tournament:create', async (_, opts) => {
    const merged = {
      registrationMinutes: CONFIG.defaultRegistrationMinutes,
      settlementBufferMs:  CONFIG.settlementBufferSec * 1000,
      minPlayers:          CONFIG.defaultMinPlayers,
      ...opts,
    };
    const t = await tournamentManager.create(merged);
    tournamentManager.startPaymentPolling(3000);
    return t.status();
  });

  ipcMain.handle('tournament:addPlayer', async (_, tId, playerId, name) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    return t.addPlayer(playerId, name, {});
  });

  // Step 2: given player address, build the raw tx and return JoyID sign URL
  ipcMain.handle('tournament:connectPlayer', (_, tId, playerId) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    return t.connectPlayer(playerId);
  });

  ipcMain.handle('tournament:buildPlayerPayTx', async (_, tId, playerId, playerAddress) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    return t.buildPlayerPayTx(playerId, playerAddress);
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
        .map(f => {
          const game = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8'));
          game.romAvailable = !!_findRom(game.rom_name);
          return game;
        });
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

  tm.on('invoice',           data => { console.log('[TM→UI] invoice', data);            push('invoice', data); });
  tm.on('player_registered', data => { console.log('[TM→UI] player_registered', data); push('player_registered', data); });
  tm.on('connect_qr',        data => { console.log('[TM→UI] connect_qr', data);         push('connect_qr', data); });
  tm.on('sign_url',          data => { console.log('[TM→UI] sign_url', data);           push('sign_url', data); });
  tm.on('deposit_timeout',   data => { console.log('[TM→UI] deposit_timeout', data);    push('deposit_timeout', data); });
  tm.on('player_paid',       data => { console.log('[TM→UI] player_paid', data);        push('player_paid', data); });
  tm.on('started',           data => { console.log('[TM→UI] started', data);      push('started', data); });
  tm.on('scores',            data => { console.log('[TM→UI] scores', data);       push('scores', data); });
  tm.on('winner',            data => { console.log('[TM→UI] winner', data);       push('winner', data); });
  tm.on('settling',          data => { console.log('[TM→UI] settling', data);     push('settling', data); });
  tm.on('complete',          data => { console.log('[TM→UI] complete', data);     push('complete', data); });
  tm.on('cancelled',         data => { console.log('[TM→UI] cancelled', data);    push('cancelled', data); });
  tm.on('registration_closed', data => { push('registration_closed', data); });
  tm.on('chain_escrow',      data => { push('chain_escrow', data); });
  tm.on('player_connected',  data => { push('player_connected', data); });
  tm.on('error',             err  => { console.error('[TM→UI] error', err);
    const msg = err instanceof Error ? err.message : (err?.message || String(err));
    push('error', { message: msg, playerId: err?.playerId, name: err?.name }); });
}

// ── ROM discovery ──────────────────────────────────────────────────────────

function _romSearchDirs() {
  const home = require('os').homedir();
  const dirs = [];
  // User-configured dir first
  if (CONFIG.romsDir) dirs.push(CONFIG.romsDir);
  // Common locations
  const candidates = [
    path.join(home, 'roms'),
    path.join(home, 'ROMs'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    '/media/' + (process.env.USER || 'phill'),
    '/mnt',
  ];
  for (const d of candidates) {
    try {
      // Also search one level of subdirs (roms/snes/, roms/nes/, etc.)
      if (fs.existsSync(d)) {
        dirs.push(d);
        for (const sub of fs.readdirSync(d)) {
          const full = path.join(d, sub);
          try { if (fs.statSync(full).isDirectory()) dirs.push(full); } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return [...new Set(dirs)];
}

function _findRom(romName) {
  if (!romName) return null;
  // Base name without extension for fuzzy matching
  const baseName = path.basename(romName, path.extname(romName)).toLowerCase();
  const compressedExts = ['.7z', '.zip', '.gz'];

  for (const dir of _romSearchDirs()) {
    // Exact match
    const exact = path.join(dir, romName);
    try { if (fs.existsSync(exact)) return exact; } catch (_) {}

    // Fuzzy: scan dir for files whose stem starts with baseName
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const fBase = path.basename(f, path.extname(f)).toLowerCase();
        const fExt  = path.extname(f).toLowerCase();
        const allExts = [path.extname(romName).toLowerCase(), ...compressedExts];
        if (fBase.startsWith(baseName) && allExts.includes(fExt)) {
          return path.join(dir, f);
        }
      }
    } catch (_) {}
  }
  return null;
}

// ── App lifecycle ──────────────────────────────────────────────────────────

function _initAgentWallet(privateKey) {
  const { AgentWallet } = require('./agent-wallet');
  return new AgentWallet({ privateKey, rpcUrl: CONFIG.ckbRpcUrl });
}

function _initChainStore(wallet) {
  const { ChainStore } = require('./chain-store');
  return new ChainStore({ wallet, rpcUrl: CONFIG.ckbRpcUrl });
}

app.whenReady().then(async () => {
  // Auto-detect local Fiber + CKB nodes if running on defaults (no saved config)
  try {
    const { bestFiber, bestCkb } = await detectAll()
    if (bestFiber?.rpcUrl && CONFIG.fiberRpcUrl === 'http://127.0.0.1:8227') {
      CONFIG.fiberRpcUrl = bestFiber.rpcUrl
      console.log(`[Main] Auto-detected Fiber node: ${bestFiber.rpcUrl} (${bestFiber.network || '?'}, source=${bestFiber.source})`)
    }
    if (bestCkb?.source !== 'public' && CONFIG.ckbRpcUrl === 'https://testnet.ckbapp.dev/') {
      CONFIG.ckbRpcUrl = bestCkb.rpcUrl
      console.log(`[Main] Auto-detected CKB node: ${bestCkb.rpcUrl} (${bestCkb.type}, source=${bestCkb.source})`)
    }
  } catch (e) {
    console.warn('[Main] Node auto-detect failed:', e.message)
  }

  // Init Fiber client
  fiberClient = new FiberClient(CONFIG.fiberRpcUrl, { debug: CONFIG.devMode, authToken: CONFIG.fiberAuthToken });
  const alive = await fiberClient.isAlive();
  console.log(`[Main] Fiber node at ${CONFIG.fiberRpcUrl}: ${alive ? '✅ connected' : '❌ unreachable'}`);

  // Load stored CKB agent key (encrypted)
  const storedKey = loadSecureKey('ckbPrivateKey');
  if (storedKey) {
    try {
      agentWallet = _initAgentWallet(storedKey);
      console.log(`[Main] Agent wallet loaded: ${agentWallet.address}`);
    } catch (e) {
      console.warn('[Main] Failed to load agent wallet:', e.message);
    }
  }

  // Start game server (HMI WebSocket bridge)
  gameServer = new GameServer({
    port: CONFIG.gameServerPort,
    debug: CONFIG.devMode,
  });
  await gameServer.start();

  // Tournament manager → wire events to HMI
  tournamentManager = new TournamentManager({
    fiberRpc:       CONFIG.fiberRpcUrl,
    fiberAuthToken: CONFIG.fiberAuthToken,
    wallet:         agentWallet || undefined,
  });
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
