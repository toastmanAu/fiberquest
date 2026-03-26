/**
 * FiberQuest — RAM Event Engine
 * Universal RetroArch sidecar. Polls RetroArch READ_CORE_MEMORY UDP,
 * evaluates game definitions to detect economic events, fires Fiber payments.
 */
'use strict';

const dgram = require('dgram');
const { EventEmitter } = require('events');
const FiberClient = require('./fiber-client');
const fs   = require('fs');
const path = require('path');

const RA_HOST   = process.env.RA_HOST    || '127.0.0.1';
const RA_PORT   = parseInt(process.env.RA_PORT   || '55355');
const POLL_HZ   = parseInt(process.env.POLL_HZ   || '20');
const FIBER_RPC = process.env.FIBER_RPC_URL || 'http://127.0.0.1:8227';

function loadGameDef(gameId) {
  const defPath = path.join(__dirname, '..', 'games', `${gameId}.json`);
  if (!fs.existsSync(defPath)) throw new Error(`Game definition not found: ${defPath}`);
  return JSON.parse(fs.readFileSync(defPath, 'utf8'));
}

function listGames() {
  const gamesDir = path.join(__dirname, '..', 'games');
  if (!fs.existsSync(gamesDir)) return [];
  return fs.readdirSync(gamesDir).filter(f => f.endsWith('.json')).map(f => {
    const def = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8'));
    return { id: def.id, name: def.name, core: def.core };
  });
}

class RetroArchClient {
  constructor(host, port) {
    this.host = host; this.port = port;
    this.socket = dgram.createSocket('udp4');
    this.pending = new Map();
    this._useLegacyRAM = false; // fallback to READ_CORE_RAM for older RetroArch / handhelds
    this.socket.on('message', (msg) => this._onMessage(msg.toString().trim()));
  }
  bind() { return new Promise(r => this.socket.bind(0, r)); }
  close() { try { this.socket.close(); } catch (_) {} }
  _normalizeAddr(addr) {
    // "0x04B9" → "0x4b9", "4b9" → "0x4b9"
    const stripped = addr.toLowerCase().replace(/^0x/, '').replace(/^0+/, '') || '0';
    return '0x' + stripped;
  }
  // Strip 0x7E WRAM prefix for READ_CORE_RAM (legacy path doesn't use bank prefix)
  _stripWramPrefix(addr) {
    const stripped = addr.toLowerCase().replace(/^0x/, '');
    if (stripped.startsWith('7e')) return stripped.slice(2).replace(/^0+/, '') || '0';
    return stripped.replace(/^0+/, '') || '0';
  }
  readMemory(addr, size = 1) {
    return new Promise((resolve, reject) => {
      let key;
      let cmd;
      if (this._useLegacyRAM) {
        // Legacy: READ_CORE_RAM <addr_no_prefix> <size> — no 0x prefix, no 7E bank
        const legacyAddr = this._stripWramPrefix(addr);
        key = '0x' + legacyAddr;  // key matches what response will normalize to
        cmd = `READ_CORE_RAM ${legacyAddr} ${size}\n`;
      } else {
        key = this._normalizeAddr(addr);
        cmd = `READ_CORE_MEMORY ${addr} ${size}\n`;
      }
      this.pending.set(key, resolve);

      const buf = Buffer.from(cmd);
      this.socket.send(buf, 0, buf.length, this.port, this.host, err => { if (err) reject(err); });
      setTimeout(() => {
        if (this.pending.has(key)) { this.pending.delete(key); resolve(null); }
      }, 200);
    });
  }
  _onMessage(msg) {
    const parts = msg.split(' ');
    const cmd = parts[0];

    // Handle both READ_CORE_MEMORY and READ_CORE_RAM responses
    if (cmd !== 'READ_CORE_MEMORY' && cmd !== 'READ_CORE_RAM') return;

    // Auto-detect: if READ_CORE_MEMORY returns "no memory map defined", switch to legacy
    if (cmd === 'READ_CORE_MEMORY' && msg.includes('no memory map defined')) {
      if (!this._useLegacyRAM) {
        console.log('[RetroArch] READ_CORE_MEMORY not supported — switching to READ_CORE_RAM (legacy mode)');
        this._useLegacyRAM = true;
      }
      // Resolve pending with null so it retries next poll cycle with legacy command
      const addr = this._normalizeAddr(parts[1]);
      const cb = this.pending.get(addr);
      if (cb) { this.pending.delete(addr); cb(null); }
      return;
    }

    // For legacy READ_CORE_RAM, the addr doesn't have 0x prefix — normalize it
    const rawAddr = parts[1];
    const addr = this._normalizeAddr(rawAddr);

    // Error response: "READ_CORE_RAM 7e0575 -1"
    if (parts[2] === '-1') {
      const cb = this.pending.get(addr);
      if (cb) { this.pending.delete(addr); cb(null); }
      return;
    }

    // Extract all bytes from response
    const bytes = parts.slice(2).map(b => parseInt(b, 16));

    // Reconstruct value: single byte or multi-byte little-endian
    let value = 0;
    for (let i = 0; i < bytes.length; i++) {
      value |= (bytes[i] << (i * 8));  // Little-endian: LSB first
    }

    const cb = this.pending.get(addr);
    if (cb) { this.pending.delete(addr); cb(value); }
  }
}

function evaluateGuard(guard, value) {
  switch (guard.condition) {
    case 'above': return value > guard.value;
    case 'below': return value < guard.value;
    case 'equals': return value === guard.value;
    case 'not_equals': return value !== guard.value;
    default: return true;
  }
}

function evaluateCondition(condition, cur, prev) {
  switch (condition.condition) {
    case 'reached_zero': return prev > 0 && cur === 0;
    case 'changed_to': return cur === condition.value && prev !== condition.value;
    case 'decreased_by_more_than': return (prev - cur) > condition.value;
    case 'changed': return cur !== prev;
    case 'above': return cur > condition.value;
    case 'below': return cur < condition.value;
    default: return false;
  }
}

class RamEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.ra      = new RetroArchClient(opts.raHost || RA_HOST, opts.raPort || RA_PORT);
    this.fiber   = new FiberClient(opts.fiberRpc || FIBER_RPC);
    this.gameDef = null;
    this.state   = {};
    this.running = false;
    this._interval = null;
  }

  loadGame(gameId) {
    this.gameDef = loadGameDef(gameId);
    this.state = {};
    console.log(`[RamEngine] Loaded: ${this.gameDef.name}`);
    return this.gameDef;
  }

  async start() {
    if (!this.gameDef) throw new Error('No game loaded. Call loadGame(id) first.');
    await this.ra.bind();
    this.running = true;
    this._interval = setInterval(() => this._poll(), Math.round(1000 / POLL_HZ));
    console.log(`[RamEngine] Polling ${this.gameDef.name} at ${POLL_HZ}Hz`);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this._interval);
    this.ra.close();
    console.log('[RamEngine] Stopped.');
  }

  async _poll() {
    if (!this.gameDef || !this.running) return;
    // Support both {addresses: {id: {addr, size}}} and {ram_addresses: [{name, address, type}]}
    let addrEntries;
    if (this.gameDef.addresses && typeof this.gameDef.addresses === 'object' && !Array.isArray(this.gameDef.addresses)) {
      addrEntries = Object.entries(this.gameDef.addresses).map(([id, def]) => ({ id, addr: def.addr, size: def.size || 1 }));
    } else {
      const raw = this.gameDef.ram_addresses || this.gameDef.addresses || {};
      if (Array.isArray(raw)) {
        addrEntries = raw.map(def => ({ id: def.name || def.id, addr: def.address, size: def.size || 1 }));
      } else {
        addrEntries = Object.entries(raw).map(([id, def]) => ({ id, addr: def.address || def.addr, size: def.size || 1 }));
      }
    }
    const reads = addrEntries.map(async ({ id, addr, size }) => {
      const value = await this.ra.readMemory(addr, size);
      return { id, value };
    });
    const results = await Promise.all(reads);
    let anyChange = false;
    for (const { id, value } of results) {
      if (value === null) continue;
      const previous = this.state[id] ?? value;
      if (value !== previous) anyChange = true;
      this.state[id] = value;
      for (const event of (this.gameDef.events || [])) {
        if (event.trigger.address !== id) continue;
        if (evaluateCondition(event.trigger, value, previous)) {
          // Guard: optional condition on another address that must also be true
          if (event.guard) {
            const guardVal = this.state[event.guard.address];
            if (guardVal === undefined || !evaluateGuard(event.guard, guardVal)) {
              continue;  // Guard not satisfied — skip this event
            }
          }
          console.log(`[RamEngine] Event: ${event.id} — ${event.description}`);
          this.emit('game_event', { event, state: { ...this.state } });
          this.emit('payment_needed', {
            eventId: event.id,
            direction: event.payment?.direction,
            amount_ckb: event.payment?.amount_ckb,
            description: event.description,
          });
        }
      }
    }
    if (anyChange) this.emit('state_update', { ...this.state });
  }
}

if (require.main === module) {
  const gameId = process.argv[2] || 'sf2-turbo';
  const engine = new RamEngine();
  console.log('Available games:', listGames().map(g => g.id));
  try { engine.loadGame(gameId); } catch (e) { console.error(e.message); process.exit(1); }
  engine.on('game_event',     e => console.log('[EVENT]', e.event.id));
  engine.on('payment_needed', e => console.log('[PAYMENT]', e));
  engine.start().then(() => console.log('Running. Ctrl+C to stop.'));
  process.on('SIGINT', () => { engine.stop(); process.exit(0); });
}

module.exports = { RamEngine, RetroArchClient, loadGameDef, listGames };
