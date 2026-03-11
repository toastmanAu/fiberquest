/**
 * FiberClient — Node.js client for Fiber Network RPC
 * 
 * The first open-source Node.js Fiber client.
 * Tested against fnn v0.7.x
 * 
 * Usage:
 *   const client = new FiberClient('http://127.0.0.1:8227');
 *   const channels = await client.listChannels();
 */

'use strict';

const http = require('http');

class FiberClient {
  /**
   * @param {string} rpcUrl - Fiber RPC endpoint, e.g. 'http://127.0.0.1:8227'
   * @param {object} opts
   * @param {number} opts.timeout - Request timeout in ms (default 10000)
   * @param {boolean} opts.debug - Log all RPC calls
   */
  constructor(rpcUrl, opts = {}) {
    this.rpcUrl = rpcUrl;
    this.timeout = opts.timeout || 10000;
    this.debug = opts.debug || false;
    this._id = 0;
  }

  // ── Low-level RPC ─────────────────────────────────────────────────────────

  async rpc(method, params = []) {
    const id = ++this._id;
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id });

    if (this.debug) console.log(`[FiberClient] → ${method}`, JSON.stringify(params));

    const url = new URL(this.rpcUrl);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname || '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (this.debug) console.log(`[FiberClient] ← ${method}`, JSON.stringify(parsed).slice(0, 200));
            if (parsed.error) {
              const err = new Error(parsed.error.message || 'RPC error');
              err.code = parsed.error.code;
              err.data = parsed.error.data;
              reject(err);
            } else {
              resolve(parsed.result);
            }
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}\nRaw: ${data.slice(0, 200)}`));
          }
        });
      });

      req.setTimeout(this.timeout, () => {
        req.destroy(new Error(`RPC timeout after ${this.timeout}ms: ${method}`));
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── Node info ─────────────────────────────────────────────────────────────

  /** Get local Fiber node info (pubkey, peer_id, addresses) */
  async getNodeInfo() {
    return this.rpc('node_info');
  }

  /** Get local Fiber node peer ID */
  async getGraphNodes(params = {}) {
    return this.rpc('graph_nodes', [params]);
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  /**
   * List all payment channels
   * @param {object} params
   * @param {string} [params.peer_id] - Filter by peer ID
   * @param {number} [params.limit] - Max results
   * @param {string} [params.after] - Cursor for pagination
   */
  async listChannels(params = {}) {
    return this.rpc('list_channels', [params]);
  }

  /**
   * Open a new payment channel with a peer
   * @param {string} peerId - Remote peer's node ID (hex pubkey)
   * @param {string|bigint} fundingAmount - Channel capacity in shannons (hex string e.g. "0x2540BE400")
   * @param {object} opts
   * @param {string} [opts.public] - Whether channel is public (default true)
   * @param {string} [opts.funding_fee_rate] - Fee rate in shannons/KB
   */
  async openChannel(peerId, fundingAmount, opts = {}) {
    return this.rpc('open_channel', [{
      peer_id: peerId,
      funding_amount: typeof fundingAmount === 'bigint'
        ? '0x' + fundingAmount.toString(16)
        : fundingAmount,
      public: opts.public !== false,
      ...opts,
    }]);
  }

  /**
   * Close a channel cooperatively
   * @param {string} channelId - Channel ID (hex)
   * @param {object} opts
   * @param {string} [opts.closing_fee_rate] - Fee rate for closing tx
   */
  async shutdownChannel(channelId, opts = {}) {
    return this.rpc('shutdown_channel', [{
      channel_id: channelId,
      ...opts,
    }]);
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  /**
   * Create a new invoice (BOLT11-style) to receive payment
   * @param {string|bigint} amount - Amount in shannons (hex string)
   * @param {string} description - Human-readable invoice description
   * @param {object} opts
   * @param {number} [opts.expiry] - Expiry in seconds (default 3600)
   */
  async newInvoice(amount, description, opts = {}) {
    return this.rpc('new_invoice', [{
      amount: typeof amount === 'bigint'
        ? '0x' + amount.toString(16)
        : amount,
      currency: opts.currency || 'Fibb',  // Required: "Fibb" for mainnet, "Fibt" for testnet
      description,
      expiry: opts.expiry ? '0x' + opts.expiry.toString(16) : '0xe10',  // hex seconds
      ...opts,
    }]);
  }

  /**
   * Send a payment using an invoice
   * @param {string} invoice - BOLT11 invoice string
   * @param {object} opts
   * @param {string} [opts.timeout] - Payment timeout in seconds
   */
  async sendPayment(invoice, opts = {}) {
    return this.rpc('send_payment', [{
      invoice,
      ...opts,
    }]);
  }

  /**
   * List recent payments (sent and received)
   * @param {object} params
   * @param {number} [params.limit]
   * @param {string} [params.after]
   */
  async listPayments(params = {}) {
    return this.rpc('list_payments', [params]);
  }

  // ── Peers ─────────────────────────────────────────────────────────────────

  /**
   * Connect to a remote Fiber peer
   * @param {string} peerId - Peer node ID (hex pubkey)
   * @param {string[]} addresses - Multiaddr strings e.g. ['/ip4/1.2.3.4/tcp/8228']
   */
  async connectPeer(peerId, addresses) {
    return this.rpc('connect_peer', [{
      peer_id: peerId,
      address: addresses[0], // Primary address
    }]);
  }

  /** List connected peers */
  async listPeers() {
    return this.rpc('list_peers', [{}]);
  }

  // ── Convenience helpers ───────────────────────────────────────────────────

  /**
   * Convert CKB to shannons (hex string for RPC)
   * @param {number} ckb
   * @returns {string} hex shannon string
   */
  static ckbToShannon(ckb) {
    return '0x' + BigInt(Math.round(ckb * 1e8)).toString(16);
  }

  /**
   * Convert shannons (hex) to CKB number
   * @param {string} hex
   * @returns {number}
   */
  static shannonToCkb(hex) {
    return Number(BigInt(hex)) / 1e8;
  }

  /**
   * Health check — returns true if node is reachable
   */
  async isAlive() {
    try {
      await this.getNodeInfo();
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = FiberClient;
