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
const { RamEngine } = require('./ram-engine');
const { SessionLogger, TournamentLogger } = require('./session-logger');

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
  retroarchBin:                path.join(__dirname, '../scripts/launch-retroarch.sh'),
  romsDir:                     '',
};

function getConfigPath() {
  return path.join(app.getPath('userData'), 'fiberquest-config.json');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    const saved = JSON.parse(raw);
    // Never let stale saved values override code defaults for these keys —
    // they depend on install paths or auto-detection that may have changed.
    delete saved.retroarchBin;
    return { ...CONFIG_DEFAULTS, ...saved };
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
let activeRamEngine  = null;   // Always-on RAM engine (started on game launch)
let activeSession    = null;   // SessionLogger for current game session

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  // Adapt to screen size — use 90% of available display, capped at defaults
  const { screen } = require('electron');
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(1280, Math.round(screenW * 0.95));
  const winH = Math.min(800, Math.round(screenH * 0.95));

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 640,
    minHeight: 480,
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
    try {
      // Chain scan only needs CKB RPC, not a wallet — create a read-only chain store if needed
      if (tournamentManager?.chainStore) {
        const tournaments = await tournamentManager.scanChain();
        return { ok: true, tournaments };
      }
      // Fallback: create a temporary read-only chain store
      const { ChainStore } = require('./chain-store');
      const cs = new ChainStore({ rpcUrl: CONFIG.ckbRpcUrl });
      const tournaments = await cs.scanTournaments();
      return { ok: true, tournaments };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  // QR code generation
  ipcMain.handle('qr:generate', async (_, text) => {
    const QRCode = require('qrcode');
    return QRCode.toDataURL(text, { errorCorrectionLevel: 'L', margin: 1, scale: 10, color: { dark: '#000000', light: '#ffffff' } });
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

  // ── RetroArch config patcher ─────────────────────────────────────────────
  // Ensures settings required by FiberQuest are applied before each launch.
  function _patchRetroArchConfig() {
    const candidates = [
      path.join(process.env.HOME || '', '.var/app/org.libretro.RetroArch/config/retroarch/retroarch.cfg'),  // flatpak
      path.join(process.env.HOME || '', '.config/retroarch/retroarch.cfg'),  // native
    ];
    const cfgPath = candidates.find(p => fs.existsSync(p));
    if (!cfgPath) { console.warn('[Main] RetroArch config not found, skipping patch'); return; }

    let cfg = fs.readFileSync(cfgPath, 'utf8');
    const patches = {
      'pause_nonactive': '"false"',
      'network_cmd_enable': '"true"',
      'network_cmd_port': '"55355"',
    };
    let changed = false;
    for (const [key, val] of Object.entries(patches)) {
      const re = new RegExp(`^${key}\\s*=\\s*".*"`, 'm');
      if (re.test(cfg)) {
        const before = cfg;
        cfg = cfg.replace(re, `${key} = ${val}`);
        if (cfg !== before) changed = true;
      } else {
        cfg += `\n${key} = ${val}`;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(cfgPath, cfg);
      console.log(`[Main] RetroArch config patched: ${Object.keys(patches).join(', ')}`);
    }
  }

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

    const romPath = _findRom(game.rom_name, game.system || game.platform);
    console.log(`[Main] ROM lookup: ${game.rom_name} → ${romPath || 'NOT FOUND'}`);
    if (!romPath) return { ok: false, reason: `ROM not found: ${game.rom_name}` };

    const { spawn } = require('child_process');
    const dgram = require('dgram');

    try {
      // Ensure RetroArch config is set for FiberQuest (no pause on unfocus, UDP enabled)
      _patchRetroArchConfig();

      // Use flatpak RetroArch (1.22.2) — the PPA 1.21.0 segfaults with -L.
      // Strip Electron/npm env vars that can interfere with flatpak sandbox.
      const cleanEnv = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith('ELECTRON_') && !k.startsWith('CHROME_') && !k.startsWith('npm_') &&
            k !== 'NODE_ENV' && k !== 'NODE' && k !== 'INIT_CWD') {
          cleanEnv[k] = v;
        }
      }
      // Electron's Chromium runtime causes RetroArch to SIGSEGV when spawned
      // as a child process (any method: spawn, exec, fork). Workaround: write
      // the launch command to a file. A separate watcher script (ra-watcher.sh)
      // picks it up and launches RetroArch from a clean process tree.
      // Start watcher: ./scripts/ra-watcher.sh (run in a separate terminal)
      // Build launch command with display env vars for Wayland/X11 compatibility.
      // Detect display even if Electron doesn't have it (e.g. launched from bare terminal).
      const displayEnv = [];
      const uid = process.getuid?.() ?? 1000;
      const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
      const waylandSocket = `${runtimeDir}/wayland-0`;
      if (process.env.WAYLAND_DISPLAY) {
        displayEnv.push(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}`);
      } else if (fs.existsSync(waylandSocket)) {
        displayEnv.push('WAYLAND_DISPLAY=wayland-0');
        console.log('[Main] Auto-detected Wayland socket for RetroArch launch');
      }
      if (process.env.DISPLAY) displayEnv.push(`DISPLAY=${process.env.DISPLAY}`);
      displayEnv.push(`XDG_RUNTIME_DIR=${runtimeDir}`);
      const envPrefix = displayEnv.join(' ') + ' ';
      const launchCmd = `${envPrefix}flatpak run org.libretro.RetroArch -L "${game.core}" "${romPath}"`;
      console.log(`[Main] Launch cmd: ${launchCmd.slice(0, 200)}...`);
      fs.writeFileSync('/tmp/fq-ra-launch.cmd', launchCmd);
      console.log(`[Main] RetroArch launch queued: ${game.name || gameId}`);

      // Stop any existing RAM engine session
      if (activeRamEngine) { activeRamEngine.stop(); activeRamEngine = null; }
      if (activeSession) { activeSession.close('new_game_launched'); activeSession = null; }

      // Start always-on RAM engine + session logger for this game
      activeSession = new SessionLogger(gameId);
      activeRamEngine = new RamEngine({
        raHost: CONFIG.retroarchHost,
        raPort: CONFIG.retroarchUdp,
      });
      activeRamEngine.loadGame(gameId);

      // Link to active tournament if one exists for this game
      const activeTournament = tournamentManager?.getActive?.();
      if (activeTournament && activeTournament.gameId === gameId) {
        activeSession.linkTournament(activeTournament.id);
        // Share RAM engine with the tournament so it gets score updates
        activeTournament._sharedRamEngine = activeRamEngine;
        activeRamEngine.on('game_event', ({ event, state }) => {
          activeTournament._onGameEvent(event, state);
        });
        activeRamEngine.on('state_update', (state) => activeTournament._checkRoundGate?.(state));
        console.log(`[Main] Shared RAM engine with active tournament ${activeTournament.id}`);
      }

      activeRamEngine.on('game_event', ({ event, state }) => {
        activeSession.logGameEvent(event, state);
        if (mainWindow) mainWindow.webContents.send('ram:event', { eventId: event.id, state });
      });

      // Log RAM state changes (throttled — every 50th change to avoid huge files)
      let stateLogCount = 0;
      activeRamEngine.on('state_update', (state) => {
        if (++stateLogCount % 50 === 0) activeSession.logRamState(state);
        if (mainWindow) mainWindow.webContents.send('ram:state', state);
      });

      // Delayed start — give RetroArch a few seconds to boot + load core
      setTimeout(async () => {
        try {
          await activeRamEngine.start();
          console.log(`[Main] RAM engine polling ${game.name || gameId}`);
        } catch (e) {
          console.warn(`[Main] RAM engine failed to start: ${e.message}`);
        }
      }, 4000);

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
    // Share the always-on RAM engine so tournament doesn't create a duplicate
    if (activeRamEngine && merged.gameId === activeRamEngine.gameDef?.id) {
      t._sharedRamEngine = activeRamEngine;
    }
    // Link session logger to tournament
    if (activeSession) activeSession.linkTournament(t.id);
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
          const romPath = _findRom(game.rom_name, game.system || game.platform);
          game.romAvailable = !!romPath;
          game.romPath = romPath || null;

          // Implicit CRC32 verification
          if (romPath && game.rom_hashes?.crc32) {
            const actual = computeCrc32(romPath);
            game.romHash = actual;
            game.romVerified = actual === game.rom_hashes.crc32;
          } else if (romPath) {
            // ROM found but no reference hash in game def
            game.romHash = computeCrc32(romPath);
            game.romVerified = null; // unknown — no reference
          } else {
            game.romHash = null;
            game.romVerified = null;
          }
          return game;
        });
    } catch (e) {
      console.error('[Games] Failed to load:', e);
      return [];
    }
  });

  ipcMain.handle('games:verifyRom', (_, gameId) => {
    const gamesDir = path.join(__dirname, '../games');
    const gamePath = path.join(gamesDir, `${gameId}.json`);
    if (!fs.existsSync(gamePath)) return { error: 'Game not found' };
    const game = JSON.parse(fs.readFileSync(gamePath, 'utf8'));
    const romPath = _findRom(game.rom_name, game.system || game.platform);
    if (!romPath) return { match: false, error: 'ROM not found', expected: game.rom_hashes?.crc32 || null };
    const actual = computeCrc32(romPath);
    const expected = game.rom_hashes?.crc32 || null;
    return {
      match: expected ? actual === expected : null,
      expected,
      actual,
      path: romPath,
    };
  });

  // ── Distributed tournament: submit score ─────────────────────────────────
  ipcMain.handle('tournament:submitScore', async (_, tId, playerId, scoreData) => {
    const t = tournamentManager.get(tId);
    if (!t) throw new Error('Tournament not found: ' + tId);
    return t.acceptScoreSubmission(playerId, scoreData);
  });

  // ── Distributed tournament: join an existing on-chain tournament ─────────
  ipcMain.handle('tournament:joinDistributed', async (_, tournamentId, myPlayerId, myName) => {
    // Use existing chain store or create a read-only one for scanning
    let chainStore = tournamentManager.chainStore;
    if (!chainStore) {
      const { ChainStore } = require('./chain-store');
      chainStore = new ChainStore({ rpcUrl: CONFIG.ckbRpcUrl });
    }
    const cells = await chainStore.scanTournaments(tournamentId);
    if (!cells.length) throw new Error('Tournament not found on chain: ' + tournamentId);
    const cell = cells[0];

    // Determine slot index — count existing deposits on organizer's cells to find next slot
    const { depositDataMarker } = require('./agent-wallet');
    let mySlotIndex = 0;
    if (agentWallet) {
      // Scan organizer's cells for existing deposit markers to find next open slot
      // We can't scan remote cells, so count based on chain cell player count
      mySlotIndex = (cell.players || []).length;  // next slot after existing players
    }
    // Fallback: use maxPlayers - 1 (last slot) if we can't determine
    if (mySlotIndex === 0 && cell.maxPlayers > 1) mySlotIndex = 1;
    console.log(`[Main] Joining as slot ${mySlotIndex} (${(cell.players || []).length} existing players on chain)`);

    // Create a local tournament mirror from on-chain data (skip escrow — we're joining, not creating)
    const t = await tournamentManager.create({
      id:               cell.id,
      gameId:           cell.gameId,
      mode:             cell.modeId,
      entryFee:         cell.entryFee,
      players:          cell.maxPlayers,
      timeLimitMinutes: cell.timeLimitMinutes,
      currency:         cell.currency,
      tournamentMode:   'distributed',
      myPlayerId:       myPlayerId,
      mySlotIndex:      mySlotIndex,
      skipEscrow:       true,
      organizerAddress: cell.organizerAddress,
    });
    t._organizerAddress = cell.organizerAddress;

    // Share the active RAM engine if game is already running
    if (activeRamEngine && cell.gameId === activeRamEngine.gameDef?.id) {
      t._sharedRamEngine = activeRamEngine;
    }

    // Auto-register this player with the correct slot index
    await t.addPlayer(myPlayerId, myName, { slotIndex: mySlotIndex });
    console.log(`[Main] Auto-registered ${myName} at slot ${mySlotIndex}`);

    // Start polling chain for state changes
    t.startDistributedPolling();
    console.log(`[Main] Joined distributed tournament ${tournamentId} as ${myPlayerId} slot ${mySlotIndex} (organizer: ${cell.organizerAddress?.slice(0,30)}...)`);
    return { ...t.status(), organizerAddress: cell.organizerAddress };
  });
}

// ── Distributed score relay HTTP server ────────────────────────────────────
// Remote agents POST score submissions here. Organizer writes them on-chain.
let _scoreRelayServer = null;
function startScoreRelay(port = 8767) {
  if (_scoreRelayServer) return;
  const http = require('http');
  _scoreRelayServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/score') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { tournamentId, playerId, scoreData } = JSON.parse(body);
          tournamentManager.acceptScoreSubmission(tournamentId, playerId, scoreData);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.method === 'GET' && req.url.startsWith('/tournament/')) {
      // Allow remote agents to query tournament state
      const tId = req.url.split('/tournament/')[1];
      const t = tournamentManager.get(tId);
      if (t) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(t.status()));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  _scoreRelayServer.listen(port, '0.0.0.0', () => {
    console.log(`[Main] Score relay server listening on :${port}`);
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

// ── CRC32 computation ─────────────────────────────────────────────────────

const _crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  _crc32Table[i] = c;
}

function computeCrc32(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = _crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, '0');
  } catch (e) {
    console.error('[CRC32] Failed to hash:', filePath, e.message);
    return null;
  }
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

function _findRom(romName, system) {
  if (!romName) return null;
  // Base name without extension for fuzzy matching
  const baseName = path.basename(romName, path.extname(romName)).toLowerCase();
  const compressedExts = ['.7z', '.zip', '.gz'];

  // Build search dirs — prioritize system-specific subdir (e.g. ~/roms/snes/)
  const allDirs = _romSearchDirs();
  const systemAliases = {
    snes: ['snes', 'super nintendo', 'super_nes'],
    nes: ['nes', 'famicom'],
    gba: ['gba', 'gameboy advance'],
    md: ['megadrive', 'genesis', 'md'],
    sms: ['mastersystem', 'sms', 'master system'],
    arcade: ['arcade', 'mame', 'fbneo'],
    n64: ['n64', 'nintendo 64'],
  };
  const aliases = systemAliases[system] || [system];
  const priorityDirs = [];
  const otherDirs = [];
  for (const dir of allDirs) {
    const dirName = path.basename(dir).toLowerCase();
    if (system && aliases.some(a => dirName.includes(a))) {
      priorityDirs.push(dir);
    } else {
      otherDirs.push(dir);
    }
  }
  const searchDirs = [...priorityDirs, ...otherDirs];

  for (const dir of searchDirs) {
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

// ── RetroArch launch watcher ──────────────────────────────────────────────
// ra-watcher.sh polls /tmp/fq-ra-launch.cmd and launches RetroArch outside
// Electron's process tree (avoids SIGSEGV from Chromium GPU sandbox).
let _raWatcherProc = null;
function _startRaWatcher() {
  const watcherScript = path.join(__dirname, '..', 'scripts', 'ra-watcher.sh');
  if (!fs.existsSync(watcherScript)) {
    console.warn('[Main] ra-watcher.sh not found, RetroArch launch disabled');
    return;
  }
  const { spawn } = require('child_process');
  _raWatcherProc = spawn('bash', [watcherScript], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _raWatcherProc.stdout.on('data', d => console.log(`[ra-watcher] ${d.toString().trim()}`));
  _raWatcherProc.stderr.on('data', d => console.warn(`[ra-watcher] ${d.toString().trim()}`));
  _raWatcherProc.unref();
  console.log(`[Main] ra-watcher started (PID ${_raWatcherProc.pid})`);
}
app.on('will-quit', () => {
  if (_raWatcherProc) { try { process.kill(-_raWatcherProc.pid); } catch (_) {} }
});

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

  // Auto-detect biscuit auth token — always re-scan (token files may change)
  {
    const tokenPaths = [
      path.join(process.env.HOME || '', '.fiber-testnet', '.secrets', 'biscuit-token.txt'),
      path.join(process.env.HOME || '', '.fiber-mainnet', '.secrets', 'biscuit-token.txt'),
      path.join(process.env.HOME || '', '.fiber', '.secrets', 'biscuit-token.txt'),
    ];
    for (const tp of tokenPaths) {
      try {
        const token = fs.readFileSync(tp, 'utf8').trim();
        if (token) {
          CONFIG.fiberAuthToken = token;
          saveConfig({ fiberAuthToken: token });
          console.log(`[Main] Auto-detected biscuit token: ${tp}`);
          break;
        }
      } catch (_) {}
    }
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
    raHost:         CONFIG.retroarchHost,
    raPort:         CONFIG.retroarchUdp,
  });
  _wireTournamentToHMI(tournamentManager);

  // Setup IPC
  setupIPC();
  setupTournamentIPC();

  // Start RetroArch launch watcher (file-based IPC to avoid Electron SIGSEGV)
  _startRaWatcher();

  // Start score relay for distributed tournaments
  startScoreRelay(8767);

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
