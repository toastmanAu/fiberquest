/**
 * FiberQuest Game Server — FGSP v0.1
 * 
 * WebSocket server implementing the FiberQuest Game State Protocol.
 * Handles: Texas Hold'em state, player actions, payment triggers
 * 
 * Run standalone: node src/game-server.js
 * Or require from Electron main process.
 */

'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const FiberClient = require('./fiber-client');

// ── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8765;
const BUY_IN_CKB   = 100;   // Default buy-in per player
const BIG_BLIND    = 2;     // In CKB
const SMALL_BLIND  = 1;

// ── FGSP Message Types ─────────────────────────────────────────────────────

const MSG = {
  // Server → Client
  WELCOME:            'FGSP_WELCOME',
  GAME_STATE_UPDATE:  'FGSP_GAME_STATE_UPDATE',
  PAYMENT_REQUEST:    'FGSP_PAYMENT_REQUEST',
  ERROR:              'FGSP_ERROR',
  CHAT:               'FGSP_CHAT',

  // Client → Server
  CONNECT:            'FGSP_CONNECT',
  PLAYER_ACTION:      'FGSP_PLAYER_ACTION',
  PAYMENT_CONFIRM:    'FGSP_PAYMENT_CONFIRM',
};

// ── Game State ─────────────────────────────────────────────────────────────

function createGameState() {
  return {
    phase: 'WAITING',   // WAITING | BUY_IN | PRE_FLOP | FLOP | TURN | RIVER | SHOWDOWN
    players: {},        // { playerId: { name, chips, cards, status, fiberInvoice } }
    pot: 0,
    communityCards: [],
    currentBet: 0,
    currentPlayer: null,
    round: 0,
    winner: null,
    lastAction: null,
    payments: [],       // Log of all Fiber payments
  };
}

// ── GameServer class ───────────────────────────────────────────────────────

class GameServer {
  constructor(opts = {}) {
    this.port = opts.port || DEFAULT_PORT;
    this.fiberRpcUrl = opts.fiberRpcUrl || 'http://127.0.0.1:8227';
    this.fiber = new FiberClient(this.fiberRpcUrl, { debug: opts.debug });
    this.wss = null;
    this.clients = new Map(); // ws → { playerId, name }
    this.state = createGameState();
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on('connection', (ws) => this._onConnect(ws));
    console.log(`[GameServer] FGSP server listening on ws://0.0.0.0:${this.port}`);
    return this;
  }

  stop() {
    if (this.wss) this.wss.close();
  }

  // ── Connection handling ──────────────────────────────────────────────────

  _onConnect(ws) {
    console.log('[GameServer] Client connected');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this._handleMessage(ws, msg);
      } catch (e) {
        this._send(ws, MSG.ERROR, { message: 'Invalid JSON' });
      }
    });

    ws.on('close', () => {
      const info = this.clients.get(ws);
      if (info) {
        console.log(`[GameServer] Player ${info.name} disconnected`);
        delete this.state.players[info.playerId];
        this.clients.delete(ws);
        this._broadcast(MSG.GAME_STATE_UPDATE, this.state);
      }
    });

    ws.on('error', (err) => {
      console.error('[GameServer] WebSocket error:', err.message);
    });
  }

  _handleMessage(ws, msg) {
    switch (msg.type) {
      case MSG.CONNECT:
        this._handlePlayerConnect(ws, msg);
        break;
      case MSG.PLAYER_ACTION:
        this._handlePlayerAction(ws, msg);
        break;
      case MSG.PAYMENT_CONFIRM:
        this._handlePaymentConfirm(ws, msg);
        break;
      default:
        this._send(ws, MSG.ERROR, { message: `Unknown message type: ${msg.type}` });
    }
  }

  // ── Player join ──────────────────────────────────────────────────────────

  _handlePlayerConnect(ws, msg) {
    const playerId = `p${Date.now()}`;
    const name = msg.name || `Player${Object.keys(this.state.players).length + 1}`;

    this.clients.set(ws, { playerId, name });
    this.state.players[playerId] = {
      name,
      chips: 0,         // Loaded after buy-in
      cards: [],
      status: 'JOINED', // JOINED | ACTIVE | FOLDED | ALL_IN | OUT
      fiberNodeId: msg.fiberNodeId || null,
      fiberInvoice: null,
    };

    console.log(`[GameServer] Player ${name} joined as ${playerId}`);

    this._send(ws, MSG.WELCOME, {
      playerId,
      name,
      state: this.state,
      buyInCkb: BUY_IN_CKB,
    });

    this._broadcast(MSG.GAME_STATE_UPDATE, this.state);

    // Trigger buy-in if enough players
    const joined = Object.values(this.state.players).filter(p => p.status === 'JOINED');
    if (joined.length >= 2 && this.state.phase === 'WAITING') {
      setTimeout(() => this._startBuyIn(), 1000);
    }
  }

  // ── Buy-in phase ─────────────────────────────────────────────────────────

  async _startBuyIn() {
    this.state.phase = 'BUY_IN';
    console.log('[GameServer] Starting buy-in phase');

    // Generate Fiber invoice for each player
    for (const [playerId, player] of Object.entries(this.state.players)) {
      try {
        const invoice = await this.fiber.newInvoice(
          FiberClient.ckbToShannon(BUY_IN_CKB),
          `FiberQuest buy-in — ${player.name}`,
          { expiry: 300 }
        );
        player.fiberInvoice = invoice.invoice_address || invoice;
        player.status = 'AWAITING_PAYMENT';

        // Find the client websocket for this player
        for (const [ws, info] of this.clients.entries()) {
          if (info.playerId === playerId) {
            this._send(ws, MSG.PAYMENT_REQUEST, {
              type: 'BUY_IN',
              amount_ckb: BUY_IN_CKB,
              invoice: player.fiberInvoice,
              description: `Pay ${BUY_IN_CKB} CKB to join the game`,
              expires_in: 300,
            });
            break;
          }
        }
      } catch (e) {
        console.error(`[GameServer] Failed to create invoice for ${player.name}:`, e.message);
      }
    }

    this._broadcast(MSG.GAME_STATE_UPDATE, this.state);
  }

  // ── Payment confirmation ─────────────────────────────────────────────────

  async _handlePaymentConfirm(ws, msg) {
    const info = this.clients.get(ws);
    if (!info) return;

    const player = this.state.players[info.playerId];
    if (!player) return;

    console.log(`[GameServer] Payment confirmed by ${player.name}: ${msg.paymentHash}`);

    // TODO: verify payment on Fiber node
    // For now, trust client confirmation (hackathon mode)
    player.chips = BUY_IN_CKB;
    player.status = 'ACTIVE';

    this.state.payments.push({
      type: 'BUY_IN',
      player: player.name,
      amount_ckb: BUY_IN_CKB,
      hash: msg.paymentHash,
      ts: Date.now(),
    });

    this._broadcast(MSG.GAME_STATE_UPDATE, this.state);

    // Start game if all players paid
    const allPaid = Object.values(this.state.players).every(p => p.status === 'ACTIVE');
    if (allPaid && Object.keys(this.state.players).length >= 2) {
      setTimeout(() => this._startRound(), 1500);
    }
  }

  // ── Texas Hold'em round ───────────────────────────────────────────────────

  _startRound() {
    const players = Object.entries(this.state.players).filter(([, p]) => p.status === 'ACTIVE');
    if (players.length < 2) return;

    this.state.round++;
    this.state.phase = 'PRE_FLOP';
    this.state.pot = 0;
    this.state.communityCards = [];
    this.state.currentBet = BIG_BLIND;
    this.state.winner = null;

    // Deal 2 cards to each player (placeholder — full deck in v2)
    const deck = this._shuffleDeck();
    let cardIdx = 0;
    for (const [, player] of players) {
      player.cards = [deck[cardIdx++], deck[cardIdx++]];
      player.currentBet = 0;
    }

    // Blinds
    const [sbId, sbPlayer] = players[0];
    const [bbId, bbPlayer] = players[1];
    sbPlayer.chips -= SMALL_BLIND;
    bbPlayer.chips -= BIG_BLIND;
    this.state.pot = SMALL_BLIND + BIG_BLIND;
    this.state.currentPlayer = players.length > 2 ? players[2][0] : sbId;

    console.log(`[GameServer] Round ${this.state.round} started — ${players.length} players`);
    this._broadcast(MSG.GAME_STATE_UPDATE, this._stateForBroadcast());
  }

  _stateForBroadcast() {
    // Don't leak other players' hole cards
    const safeState = JSON.parse(JSON.stringify(this.state));
    for (const player of Object.values(safeState.players)) {
      if (player.status !== 'SHOWDOWN') {
        player.cards = player.cards.map(() => '??');
      }
    }
    return safeState;
  }

  // ── Player actions ────────────────────────────────────────────────────────

  async _handlePlayerAction(ws, msg) {
    const info = this.clients.get(ws);
    if (!info) return;

    const player = this.state.players[info.playerId];
    if (!player || this.state.currentPlayer !== info.playerId) {
      this._send(ws, MSG.ERROR, { message: 'Not your turn' });
      return;
    }

    const action = msg.action; // FOLD | CHECK | CALL | RAISE | ALL_IN
    const amount = msg.amount || 0;

    console.log(`[GameServer] ${player.name} → ${action}${amount ? ' ' + amount : ''}`);

    switch (action) {
      case 'FOLD':
        player.status = 'FOLDED';
        break;
      case 'CHECK':
        break;
      case 'CALL':
        const callAmount = Math.min(this.state.currentBet - (player.currentBet || 0), player.chips);
        player.chips -= callAmount;
        this.state.pot += callAmount;
        // Trigger Fiber payment
        this._requestPayment(ws, info.playerId, callAmount, 'CALL');
        break;
      case 'RAISE':
        const raiseAmount = Math.min(amount, player.chips);
        player.chips -= raiseAmount;
        this.state.pot += raiseAmount;
        this.state.currentBet = raiseAmount;
        this._requestPayment(ws, info.playerId, raiseAmount, 'RAISE');
        break;
      case 'ALL_IN':
        this.state.pot += player.chips;
        this._requestPayment(ws, info.playerId, player.chips, 'ALL_IN');
        player.chips = 0;
        player.status = 'ALL_IN';
        break;
    }

    this.state.lastAction = { player: player.name, action, amount, ts: Date.now() };
    this._advanceTurn();
    this._broadcast(MSG.GAME_STATE_UPDATE, this._stateForBroadcast());
  }

  async _requestPayment(ws, playerId, amountCkb, reason) {
    try {
      const invoice = await this.fiber.newInvoice(
        FiberClient.ckbToShannon(amountCkb),
        `FiberQuest ${reason} — ${amountCkb} CKB`,
        { expiry: 60 }
      );
      this._send(ws, MSG.PAYMENT_REQUEST, {
        type: reason,
        amount_ckb: amountCkb,
        invoice: invoice.invoice_address || invoice,
        description: `${reason}: ${amountCkb} CKB`,
        expires_in: 60,
      });
    } catch (e) {
      console.error(`[GameServer] Invoice creation failed for ${reason}:`, e.message);
    }
  }

  _advanceTurn() {
    const activePlayers = Object.keys(this.state.players).filter(
      id => ['ACTIVE', 'ALL_IN'].includes(this.state.players[id].status)
    );
    if (activePlayers.length <= 1) {
      this._endRound(activePlayers[0]);
      return;
    }
    const idx = activePlayers.indexOf(this.state.currentPlayer);
    this.state.currentPlayer = activePlayers[(idx + 1) % activePlayers.length];
  }

  _endRound(winnerId) {
    this.state.phase = 'SHOWDOWN';
    const winner = winnerId ? this.state.players[winnerId] : null;
    if (winner) {
      winner.chips += this.state.pot;
      this.state.winner = { id: winnerId, name: winner.name, pot: this.state.pot };
      this.state.pot = 0;
      console.log(`[GameServer] Round over — ${winner.name} wins ${this.state.winner.pot} CKB`);
    }
    this._broadcast(MSG.GAME_STATE_UPDATE, this.state);
    setTimeout(() => this._startRound(), 5000);
  }

  // ── Deck ──────────────────────────────────────────────────────────────────

  _shuffleDeck() {
    const suits = ['♠','♥','♦','♣'];
    const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    const deck = suits.flatMap(s => ranks.map(r => r + s));
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // ── Broadcast helpers ──────────────────────────────────────────────────────

  _send(ws, type, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...data, ts: Date.now() }));
    }
  }

  _broadcast(type, data) {
    const msg = JSON.stringify({ type, ...data, ts: Date.now() });
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}

// ── Standalone entry point ─────────────────────────────────────────────────

if (require.main === module) {
  const port = parseInt(process.env.PORT || DEFAULT_PORT);
  const fiberUrl = process.env.FIBER_RPC_URL || 'http://127.0.0.1:8227';

  const server = new GameServer({ port, fiberRpcUrl: fiberUrl, debug: true });
  server.start();

  process.on('SIGINT', () => {
    console.log('\n[GameServer] Shutting down...');
    server.stop();
    process.exit(0);
  });
}

module.exports = GameServer;
