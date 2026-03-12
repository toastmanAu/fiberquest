/**
 * game-server.js — FiberQuest WebSocket server
 *
 * Bridges tournament events → connected HMI displays (ESP32-S3, browsers, etc.)
 * Listens on ws://0.0.0.0:<port> (default 8765)
 *
 * Inbound events from main process (via emit):
 *   tournament_list  — list of available tournaments
 *   game_start       — game has begun
 *   score            — player score update
 *   timer            — countdown timer tick
 *   status           — status string (waiting, starting, etc.)
 *   winner           — game over, winner announced
 *
 * Outbound (clients → server):
 *   join             — player wants to join a tournament { tournamentId }
 *   ping             — keepalive
 *
 * Protocol: newline-delimited JSON over WebSocket text frames.
 */

'use strict';

const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');

class GameServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.port   WebSocket port (default 8765)
   */
  constructor(opts = {}) {
    super();
    this.port = opts.port || 8765;
    this._wss = null;
    this._clients = new Set();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start() {
    return new Promise((resolve, reject) => {
      this._wss = new WebSocketServer({ port: this.port });

      this._wss.on('listening', () => {
        console.log(`[GameServer] WebSocket listening on ws://0.0.0.0:${this.port}`);
        resolve();
      });

      this._wss.on('error', (err) => {
        console.error('[GameServer] Error:', err.message);
        reject(err);
      });

      this._wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress;
        console.log(`[GameServer] Client connected: ${ip} (total: ${this._clients.size + 1})`);
        this._clients.add(ws);

        // Send current state to newly connected client
        this._sendWelcome(ws);

        ws.on('message', (data) => this._handleMessage(ws, data, ip));
        ws.on('close', () => {
          this._clients.delete(ws);
          console.log(`[GameServer] Client disconnected: ${ip} (total: ${this._clients.size})`);
        });
        ws.on('error', (err) => {
          console.error(`[GameServer] Client error (${ip}):`, err.message);
          this._clients.delete(ws);
        });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this._wss) return resolve();
      for (const ws of this._clients) {
        try { ws.close(); } catch (_) {}
      }
      this._clients.clear();
      this._wss.close(() => {
        console.log('[GameServer] WebSocket server stopped');
        resolve();
      });
    });
  }

  // ── Inbound (main process calls these) ───────────────────────────────────

  /** Broadcast a tournament list to all connected HMI clients */
  sendTournamentList(items) {
    this._broadcast({ event: 'tournament_list', items });
  }

  /** Notify all clients a game has started */
  sendGameStart({ game, player1, player2 }) {
    this._state = { game, player1, player2, scores: [0, 0], timer: null, status: 'LIVE' };
    this._broadcast({ event: 'game_start', game, player1, player2 });
  }

  /** Push a score update for one player (0-indexed) */
  sendScore(playerIdx, value) {
    if (this._state) this._state.scores[playerIdx] = value;
    this._broadcast({ event: 'score', player: playerIdx, value });
  }

  /** Push a timer update */
  sendTimer(seconds) {
    if (this._state) this._state.timer = seconds;
    this._broadcast({ event: 'timer', seconds });
  }

  /** Push a status string ("Waiting for players...", "LIVE", etc.) */
  sendStatus(msg) {
    if (this._state) this._state.status = msg;
    this._broadcast({ event: 'status', msg });
  }

  /** Announce winner with Fiber payout amount in shannons */
  sendWinner({ name, payoutShannons = 0 }) {
    this._broadcast({ event: 'winner', name, payout_shannons: payoutShannons });
    this._state = null;
  }

  /** Clients currently connected */
  get clientCount() {
    return this._clients.size;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this._clients) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(msg, (err) => {
          if (err) {
            console.error('[GameServer] Send error:', err.message);
            this._clients.delete(ws);
          }
        });
      }
    }
  }

  /** Send current game state to a freshly connected client */
  _sendWelcome(ws) {
    if (!this._state) {
      ws.send(JSON.stringify({ event: 'status', msg: 'Waiting for tournament...' }));
      return;
    }
    const { game, player1, player2, scores, timer, status } = this._state;
    const msgs = [
      { event: 'game_start', game, player1, player2 },
      { event: 'score', player: 0, value: scores[0] },
      { event: 'score', player: 1, value: scores[1] },
      { event: 'status', msg: status },
    ];
    if (timer !== null) msgs.push({ event: 'timer', seconds: timer });
    for (const m of msgs) {
      if (ws.readyState === 1) ws.send(JSON.stringify(m));
    }
  }

  _handleMessage(ws, data, ip) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }

    if (msg.event === 'ping') {
      ws.send(JSON.stringify({ event: 'pong' }));
      return;
    }

    if (msg.event === 'join') {
      console.log(`[GameServer] ${ip} wants to join tournament ${msg.tournamentId}`);
      this.emit('join', { ws, tournamentId: msg.tournamentId });
      return;
    }

    console.log(`[GameServer] Unknown event from ${ip}:`, msg.event);
  }
}

module.exports = GameServer;
