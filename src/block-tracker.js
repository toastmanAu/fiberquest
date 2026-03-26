'use strict';

/**
 * block-tracker.js — CKB block tip tracker with dual-mode (WebSocket / smart poll)
 *
 * Provides block-aware events instead of dumb interval polling.
 * Tracks rolling average block time for time estimates.
 *
 * Usage:
 *   const tracker = new BlockTracker({ rpcUrl: 'https://testnet.ckbapp.dev/' });
 *   await tracker.start();
 *   tracker.on('block', (header) => { ... });
 *   tracker.getEstimatedTime(10); // ms for ~10 blocks
 *
 * Future: Add option for users to configure their own local CKB node with
 * WebSocket subscription support (ws://localhost:8114) for instant block
 * notifications instead of polling. The infrastructure is already here —
 * just needs a UI setting for custom WS endpoint.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const POLL_INTERVAL_MS   = 2000;  // 2s tip check (tiny response)
const BLOCK_HISTORY_SIZE = 20;    // rolling window for avg block time
const WS_RECONNECT_MS    = 5000;  // reconnect delay on WebSocket failure

class BlockTracker extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.rpcUrl      = opts.rpcUrl || process.env.CKB_RPC_URL || 'https://testnet.ckbapp.dev/';
    this.mode        = 'poll';       // 'websocket' | 'poll'
    this.tipHeader   = null;         // { number, hash, timestamp }
    this.avgBlockTime = 10500;       // default ~10.5s, updated from real data
    this._blockTimes = [];           // rolling window of block time deltas (ms)
    this._pollTimer  = null;
    this._ws         = null;
    this._wsUrl      = null;
    this._running    = false;
    this._rpcId      = 0;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    // Seed tip + block time history
    await this._seedBlockHistory();

    // Try WebSocket first, fall back to polling
    const wsUrl = this._deriveWsUrl();
    if (wsUrl) {
      try {
        await this._startWebSocket(wsUrl);
        return; // WebSocket mode active
      } catch (e) {
        console.log(`[BlockTracker] WebSocket failed (${e.message}), using poll mode`);
      }
    }

    this._startPolling();
  }

  stop() {
    this._running = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  /** Estimate time in ms for a given number of blocks */
  getEstimatedTime(blockCount) {
    return Math.round(blockCount * this.avgBlockTime);
  }

  /** Get blocks remaining until targetBlock + estimated time */
  getBlocksUntil(targetBlock) {
    if (!this.tipHeader) return { blocks: null, estimatedMs: null };
    const remaining = Math.max(0, targetBlock - this.tipHeader.number);
    return {
      blocks: remaining,
      estimatedMs: this.getEstimatedTime(remaining),
    };
  }

  /** Get current tip info */
  getTip() {
    return this.tipHeader ? { ...this.tipHeader } : null;
  }

  /** Get tracker status for IPC */
  getInfo() {
    return {
      mode:         this.mode,
      tipNumber:    this.tipHeader?.number || null,
      tipHash:      this.tipHeader?.hash || null,
      tipTimestamp: this.tipHeader?.timestamp || null,
      avgBlockTime: this.avgBlockTime,
      running:      this._running,
    };
  }

  // ── WebSocket mode ──────────────────────────────────────────────────────

  _deriveWsUrl() {
    // Try to derive WebSocket URL from HTTP RPC URL
    // http://host:port → ws://host:port
    // https://host → wss://host
    try {
      const url = new URL(this.rpcUrl);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      else if (url.protocol === 'https:') url.protocol = 'wss:';
      else return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  _startWebSocket(wsUrl) {
    return new Promise((resolve, reject) => {
      this._wsUrl = wsUrl;
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connect timeout'));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        this._ws = ws;
        this.mode = 'websocket';
        console.log(`[BlockTracker] WebSocket connected: ${wsUrl}`);

        // Subscribe to new_tip_header
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'subscribe',
          params: ['new_tip_header'],
          id: ++this._rpcId,
        }));

        this.emit('ready', this.getInfo());
        resolve();
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Subscription response (initial)
          if (msg.id && msg.result) return;
          // Subscription notification
          if (msg.params?.result) {
            this._handleNewHeader(msg.params.result);
          }
        } catch (e) {
          console.warn('[BlockTracker] WS parse error:', e.message);
        }
      });

      ws.on('close', () => {
        console.log('[BlockTracker] WebSocket closed');
        this._ws = null;
        if (this._running && !this._wsFailed) {
          // Reconnect once — if it fails again, stay on polling
          setTimeout(() => {
            if (!this._running) return;
            console.log('[BlockTracker] Attempting WebSocket reconnect...');
            this._startWebSocket(wsUrl).catch(() => {
              console.log('[BlockTracker] Reconnect failed, staying on poll mode');
              this._wsFailed = true;
              if (!this._pollTimer) this._startPolling();
            });
          }, WS_RECONNECT_MS);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // ── Poll mode ───────────────────────────────────────────────────────────

  _startPolling() {
    this.mode = 'poll';
    console.log(`[BlockTracker] Polling mode: ${this.rpcUrl} every ${POLL_INTERVAL_MS}ms`);
    this.emit('ready', this.getInfo());

    this._pollTimer = setInterval(async () => {
      try {
        const header = await this._rpcGetTipHeader();
        if (!header) return;
        const num = this._parseHexNumber(header.number);
        if (this.tipHeader && num <= this.tipHeader.number) return; // no new block
        this._handleNewHeader(header);
      } catch (e) {
        // Transient RPC errors — don't crash, just skip this tick
      }
    }, POLL_INTERVAL_MS);
  }

  // ── Shared block processing ─────────────────────────────────────────────

  _handleNewHeader(rawHeader) {
    const header = {
      number:    this._parseHexNumber(rawHeader.number),
      hash:      rawHeader.hash,
      timestamp: this._parseHexNumber(rawHeader.timestamp),
    };

    // Update block time rolling average
    if (this.tipHeader) {
      const delta = header.timestamp - this.tipHeader.timestamp;
      if (delta > 0 && delta < 120000) { // sanity: ignore >2min gaps
        this._blockTimes.push(delta);
        if (this._blockTimes.length > BLOCK_HISTORY_SIZE) {
          this._blockTimes.shift();
        }
        this.avgBlockTime = Math.round(
          this._blockTimes.reduce((a, b) => a + b, 0) / this._blockTimes.length
        );
      }
    }

    this.tipHeader = header;
    this.emit('block', header);
  }

  // ── Seed block history on startup ───────────────────────────────────────

  async _seedBlockHistory() {
    try {
      const tipHeader = await this._rpcGetTipHeader();
      if (!tipHeader) return;

      const tipNum = this._parseHexNumber(tipHeader.number);
      const tipTs  = this._parseHexNumber(tipHeader.timestamp);
      this.tipHeader = { number: tipNum, hash: tipHeader.hash, timestamp: tipTs };

      // Fetch last BLOCK_HISTORY_SIZE headers to calculate avg block time
      const headers = [];
      const startBlock = Math.max(0, tipNum - BLOCK_HISTORY_SIZE);
      for (let i = startBlock; i <= tipNum; i++) {
        const h = await this._rpcGetHeaderByNumber(i);
        if (h) headers.push({
          number: i,
          timestamp: this._parseHexNumber(h.timestamp),
        });
      }

      // Calculate deltas
      this._blockTimes = [];
      for (let i = 1; i < headers.length; i++) {
        const delta = headers[i].timestamp - headers[i - 1].timestamp;
        if (delta > 0 && delta < 120000) {
          this._blockTimes.push(delta);
        }
      }

      if (this._blockTimes.length > 0) {
        this.avgBlockTime = Math.round(
          this._blockTimes.reduce((a, b) => a + b, 0) / this._blockTimes.length
        );
      }

      console.log(`[BlockTracker] Seeded: tip=${tipNum}, avgBlockTime=${this.avgBlockTime}ms (${(this.avgBlockTime/1000).toFixed(1)}s) from ${this._blockTimes.length} samples`);
    } catch (e) {
      console.warn('[BlockTracker] Seed failed:', e.message);
    }
  }

  // ── RPC helpers ─────────────────────────────────────────────────────────

  async _rpc(method, params = []) {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++this._rpcId }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  }

  async _rpcGetTipHeader() {
    return this._rpc('get_tip_header');
  }

  async _rpcGetHeaderByNumber(blockNumber) {
    const hex = '0x' + blockNumber.toString(16);
    return this._rpc('get_header_by_number', [hex]);
  }

  _parseHexNumber(hex) {
    if (typeof hex === 'number') return hex;
    return Number(BigInt(hex));
  }
}

module.exports = { BlockTracker };
