/**
 * FiberQuest — Tournament Manager
 *
 * Wires the RAM event engine to Fiber Network payments.
 * Lifecycle: CREATE → WAITING_PLAYERS → ACTIVE → SCORING → COMPLETE
 *
 * Usage:
 *   const tm = new TournamentManager({ fiberRpc: 'http://127.0.0.1:8227' });
 *   const t = await tm.create({ gameId: 'tetris-nes', mode: 'highest_score', entryFee: 10, players: 2 });
 *   t.on('invoice', ({ playerId, invoice }) => showQR(invoice));
 *   t.on('started', () => console.log('GO!'));
 *   t.on('scores', (scores) => updateUI(scores));
 *   t.on('complete', ({ winner, payoutTx }) => console.log('Winner:', winner));
 *   await t.start();
 */

'use strict';

const { EventEmitter } = require('events');
const { RamEngine, loadGameDef } = require('./ram-engine');
const FiberClient = require('./fiber-client');
const { ChainStore, STATE: CHAIN_STATE } = require('./chain-store');

// ── BCD decoder ──────────────────────────────────────────────────────────────

function bcdByte(b) {
  return (((b >> 4) & 0xf) * 10) + (b & 0xf);
}

/**
 * Decode a multi-byte BCD score from RAM state.
 * @param {object} state  - current RAM state {addr_name: value}
 * @param {object} fmt    - score_format from game def
 * @returns {number}
 */
function decodeBcdScore(state, fmt) {
  if (!fmt || fmt.type !== 'bcd_multi') return null;
  let score = 0;
  for (const key of fmt.addresses) {
    score = score * 100 + bcdByte(state[key] ?? 0);
  }
  return score;
}

/**
 * Decode the primary "score" value for a game from current RAM state.
 * Handles: bcd_multi, single uint8/uint16, lives-based scores.
 */
function decodeScore(state, gameDef, mode) {
  const tracked = mode?.tracked_field;

  // BCD multi-byte score
  if (gameDef.score_format?.type === 'bcd_multi' &&
      (!tracked || tracked === 'score')) {
    const s = decodeBcdScore(state, gameDef.score_format);
    if (s !== null) return s;
  }

  // Direct field by tracked_field name
  if (tracked && state[tracked] !== undefined) {
    return state[tracked];
  }

  // Fallback: look for a 'score' key in state
  if (state.score !== undefined) return state.score;

  // Fallback: lines for tetris-style games
  if (tracked === 'lines') {
    const lo = state.lines_lo ?? 0;
    const hi = state.lines_hi ?? 0;
    return bcdByte(hi) * 100 + bcdByte(lo);
  }

  // Lives-based: some survival games score by lives remaining
  if (tracked === 'lives' || tracked === 'survival') {
    return state.p1_lives ?? state.lives ?? 0;
  }

  return 0;
}

// ── Tournament ────────────────────────────────────────────────────────────────

class Tournament extends EventEmitter {
  constructor(opts, fiber) {
    super();
    const ts = Date.now();
    this.id        = opts.id || `fq_${(require('crypto').createHash('sha256')
                       .update(`${opts.gameId || 'game'}-${ts}`)
                       .digest('hex')).slice(0, 8)}_${ts}`;
    this.gameId    = opts.gameId;
    this.modeId    = opts.mode || 'highest_score';
    this.entryFee  = opts.entryFee || 10;           // CKB
    this.minPlayers = opts.minPlayers || 2;
    this.maxPlayers = opts.players || 2;
    this.timeLimitMs = (opts.timeLimitMinutes || 5) * 60 * 1000;
    this.raHost    = opts.raHost || '127.0.0.1';
    this.raPort    = opts.raPort || 55355;
    this.currency  = opts.currency || 'Fibb';       // Fibb=mainnet, Fibt=testnet
    // Registration window — default 10 min from creation
    this.registrationDeadline = opts.registrationDeadline || (Date.now() + 10 * 60 * 1000);
    // Buffer after game ends before payout — allows result submission + on-chain finality
    this.settlementBufferMs = opts.settlementBufferMs || 30000; // 30s default

    this.fiber     = fiber;
    this.gameDef   = loadGameDef(this.gameId);
    this.mode      = this.gameDef.tournament_modes?.find(m => m.id === this.modeId)
                     || this.gameDef.tournament_modes?.[0];

    this.state     = 'CREATED';
    this.players   = {};     // { playerId: { name, invoice, paid, score, paymentHash } }
    this.scores    = {};     // { playerId: number }
    this.engine    = null;
    this._timer    = null;
    this._startedAt = null;
    this.chainOutPoint = null;  // Set after escrow cell is written on-chain
    this.createdAt = opts.createdAt || Date.now();

    console.log(`[Tournament] Created ${this.id} — ${this.gameId} / ${this.modeId} — ${this.entryFee} CKB × ${this.maxPlayers}p`);
  }

  // ── Player registration ────────────────────────────────────────────────────

  /**
   * Register a player and generate their entry invoice.
   * @param {string} playerId       - unique ID (e.g. 'player1', wallet address, etc)
   * @param {string} name           - display name
   * @param {object} opts
   * @param {string} opts.payoutInvoice - BOLT11 invoice for payout (player generates this
   *                                      on their Fiber node before joining). If provided,
   *                                      the agent will pay autonomously on win — no human needed.
   * @returns {object} { playerId, entryInvoice, amount_ckb, payoutReady }
   */
  async addPlayer(playerId, name = playerId, opts = {}) {
    if (this.state !== 'CREATED' && this.state !== 'WAITING_PLAYERS') {
      throw new Error(`Cannot add player in state ${this.state}`);
    }
    if (this.players[playerId]) {
      throw new Error(`Player ${playerId} already registered`);
    }

    const payoutInvoice = opts.payoutInvoice || null;
    const fiberPeerId   = opts.fiberPeerId   || null; // player's Fiber node peer ID
    const fiberAddr     = opts.fiberAddr     || null; // player's Fiber node address (multiaddr)

    // Slot index is position in registration order (stable, 0-based)
    const slotIndex = Object.keys(this.players).length;

    // ── Fiber invoice path (used when wallet flow hasn't built the tx yet) ─────
    // The full L1 path is in buildPlayerPayTx() — called after player provides address.
    let entryInvoice = null, paymentHash = null;
    if (!this._wallet) {
      const amountShannon = FiberClient.ckbToShannon(this.entryFee);
      const description   = `FiberQuest: ${this.gameDef.name} — ${this.mode?.name || this.modeId} — ${name}`;
      console.log(`[Tournament] Generating Fiber entry invoice for ${name} (${this.entryFee} CKB)...`);
      const invoiceResult = await this.fiber.newInvoice(amountShannon, description, {
        currency: this.currency,
        expiry: 0xe10,
      });
      entryInvoice = invoiceResult.invoice_address;
      paymentHash  = invoiceResult.payment_hash;
    }

    if (payoutInvoice) {
      console.log(`[Tournament] Payout invoice registered for ${name} ✅`);
    } else {
      console.log(`[Tournament] ⚠️  No payout invoice for ${name} — will emit payout_needed on win`);
    }

    this.players[playerId] = {
      name,
      slotIndex,
      entryInvoice,
      paymentHash,
      payoutInvoice,
      paid: false,
      score: 0,
      joinedAt: Date.now(),
      senderAddress: null,
      depositCell: null,
      signUrl: null,     // set by buildPlayerPayTx after address is provided
      fiberPeerId,
      fiberAddr,
    };
    this.scores[playerId] = 0;
    this.state = 'WAITING_PLAYERS';

    console.log(`[Tournament] Player ${name} registered at slot ${slotIndex} — awaiting address for L1 tx build`);
    this.emit('player_registered', { playerId, name, slotIndex, amount_ckb: this.entryFee });

    return { playerId, name, slotIndex, amount_ckb: this.entryFee, payoutReady: !!payoutInvoice };
  }

  /**
   * JoyID connect step — generate a connect QR for the player.
   * Player scans QR in JoyID app → agent receives their address via callback →
   * automatically calls buildPlayerPayTx → emits sign_url.
   *
   * Emits: connect_qr({ playerId, name, connectUrl })
   *
   * @param {string} playerId
   * @returns {{ playerId, connectUrl }}
   */
  connectPlayer (playerId) {
    const player = this.players[playerId]
    if (!player) throw new Error(`Unknown player: ${playerId}`)
    if (!this._wallet) throw new Error('Agent wallet not configured')

    const connectUrl = this._wallet.buildJoyIDConnectUrl(({ address }) => {
      console.log(`[Tournament] JoyID connect callback for ${player.name} — address ${address}`)
      this.buildPlayerPayTx(playerId, address).catch(e => {
        console.error(`[Tournament] buildPlayerPayTx failed for ${player.name}:`, e.message)
        this.emit('error', new Error(`Pay tx build failed for ${player.name}: ${e.message}`))
      })
    })

    console.log(`[Tournament] JoyID connect URL for ${player.name}: ${connectUrl}`)
    this.emit('connect_qr', { playerId, name: player.name, connectUrl })
    return { playerId, connectUrl }
  }

  /**
   * Step 2 of player registration (L1 path):
   * Given the player's CKB address, build a raw deposit transaction and return
   * the JoyID deep-link URL for them to scan and sign.
   *
   * After this call a per-slot watcher starts polling the chain for the
   * specific outputData marker. No snapshot ambiguity — each slot has a unique marker.
   *
   * @param {string} playerId
   * @param {string} playerAddress  — player's CKB address (from their JoyID wallet)
   * @returns {{ playerId, signUrl, dataMarker, rawTx }}
   */
  async buildPlayerPayTx (playerId, playerAddress) {
    const player = this.players[playerId];
    if (!player) throw new Error(`Unknown player: ${playerId}`);
    if (player.paid) throw new Error(`${player.name} already paid`);
    if (!this._wallet) throw new Error('Agent wallet not configured');

    const { rawTx, dataMarker } = await this._wallet.buildPlayerDepositTx(
      playerAddress, this.id, player.slotIndex, this.entryFee
    );

    // Register callback — JoyID will redirect phone browser here with signed tx
    const callbackUrl = this._wallet.registerJoyIDCallback(async (signedTx) => {
      console.log(`[Tournament] JoyID callback received for ${player.name} — submitting tx`);
      try {
        const txHash = await this._wallet.sendRawTx(signedTx);
        console.log(`[Tournament] ✅ JoyID deposit submitted for ${player.name}: ${txHash}`);
      } catch (e) {
        console.error(`[Tournament] ❌ JoyID deposit submit failed for ${player.name}:`, e.message);
        this.emit('error', new Error(`JoyID deposit submit failed for ${player.name}: ${e.message}`));
      }
      // Chain watcher will detect the marker and call markPaid
    });

    const signUrl = this._wallet.buildJoyIDSignTxUrl(rawTx, playerAddress, callbackUrl);

    player.signUrl       = signUrl;
    player.senderAddress = playerAddress;
    player.dataMarker    = dataMarker;

    console.log(`[Tournament] Built L1 deposit tx for ${player.name} — marker ${dataMarker}`);
    console.log(`[Tournament] JoyID callback: ${callbackUrl}`);
    this.emit('sign_url', { playerId, name: player.name, signUrl, dataMarker });

    // Start per-slot chain watcher now that we have the marker
    this._watchSlotDeposit(playerId, dataMarker);

    return { playerId, signUrl, dataMarker, rawTx };
  }

  /**
   * Set or update a player's payout invoice after registration.
   * Useful when players submit it async (e.g. scan QR on a second screen).
   * @param {string} playerId
   * @param {string} payoutInvoice - BOLT11 invoice from the player's Fiber node
   */
  setPayoutInvoice(playerId, payoutInvoice) {
    if (!this.players[playerId]) throw new Error(`Unknown player: ${playerId}`);
    this.players[playerId].payoutInvoice = payoutInvoice;
    console.log(`[Tournament] Payout invoice set for ${this.players[playerId].name} ✅`);
    this.emit('payout_invoice_set', { playerId, name: this.players[playerId].name });
  }

  /**
   * Mark a player as paid (call after verifying their payment arrived).
   * Auto-starts if all players have paid.
   */
  markPaid(playerId) {
    if (!this.players[playerId]) throw new Error(`Unknown player: ${playerId}`);
    this.players[playerId].paid = true;
    console.log(`[Tournament] ${this.players[playerId].name} paid ✅`);
    this.emit('player_paid', { playerId, name: this.players[playerId].name });

    const allPaid = Object.values(this.players).length === this.maxPlayers &&
                    Object.values(this.players).every(p => p.paid);
    if (allPaid) {
      console.log('[Tournament] All players paid — starting automatically');
      this.start().catch(e => this.emit('error', e));
    }
  }

  // ── L1 deposit watcher (per-slot, data-marker based) ─────────────────────

  /**
   * Watch for a specific player's deposit using their unique outputData marker.
   * Each slot polls independently — no shared state, no collision risk.
   *
   * Called automatically by buildPlayerPayTx after the tx is built.
   */
  _watchSlotDeposit (playerId, dataMarker) {
    const player      = this.players[playerId];
    const intervalMs  = 6000;
    const deadline    = this.registrationDeadline + 60_000; // 1 min grace after reg closes
    console.log(`[Tournament] Slot watcher started for ${player.name} — marker ${dataMarker}`);

    const tick = async () => {
      if (player.paid) return;  // already marked paid, stop
      if (this.state !== 'WAITING_PLAYERS' && this.state !== 'CREATED') return;
      try {
        const cell = await this._wallet.findDepositByMarker(dataMarker);
        if (cell) {
          console.log(`[Tournament] ✅ L1 deposit confirmed for ${player.name} — ${cell.outPoint.txHash}`);
          player.depositCell = cell;
          // senderAddress already set from playerAddress in buildPlayerPayTx
          this.markPaid(playerId);
          return;  // done
        }
        console.log(`[Tournament] Waiting for ${player.name} deposit (marker ${dataMarker})…`);
      } catch (e) {
        console.warn(`[Tournament] Slot watcher error for ${player.name}:`, e.message);
      }
      if (Date.now() < deadline) {
        setTimeout(tick, intervalMs);
      } else {
        console.warn(`[Tournament] Deposit timeout for ${player.name}`);
        this.emit('deposit_timeout', { playerId, name: player.name });
      }
    };
    tick();
  }

  // ── Payment polling ───────────────────────────────────────────────────────

  /**
   * Poll Fiber for incoming payments matching player invoices.
   * Call this periodically while in WAITING_PLAYERS state.
   */
  async pollPayments() {
    if (this.state !== 'WAITING_PLAYERS') return;
    try {
      const payments = await this.fiber.listPayments({ limit: 50 });
      const received = payments?.payments || [];
      for (const p of received) {
        if (p.status !== 'Success') continue;
        for (const [pid, player] of Object.entries(this.players)) {
          if (!player.paid && p.payment_hash === player.paymentHash) {
            this.markPaid(pid);
          }
        }
      }
    } catch (e) {
      // list_payments can return Unauthorized if biscuit auth enabled — non-fatal
      if (!e.message?.includes('Unauthorized')) {
        console.warn('[Tournament] Payment poll error:', e.message);
      }
    }
  }

  // ── Game start ────────────────────────────────────────────────────────────

  /**
   * Start the tournament. Attach RAM engine, begin scoring.
   */
  async start() {
    if (this.state === 'ACTIVE') return;
    if (this.state !== 'WAITING_PLAYERS' && this.state !== 'CREATED') {
      throw new Error(`Cannot start in state ${this.state}`);
    }

    const unpaid = Object.entries(this.players).filter(([,p]) => !p.paid);
    if (unpaid.length > 0 && process.env.REQUIRE_PAYMENT !== 'false') {
      throw new Error(`Waiting for payment from: ${unpaid.map(([id]) => id).join(', ')}`);
    }

    this.state     = 'ACTIVE';
    this._startedAt = Date.now();

    // Start RAM engine
    this.engine = new RamEngine({
      raHost: this.raHost,
      raPort: this.raPort,
      fiberRpc: 'disabled',  // We handle payments here, not in the engine
    });
    this.engine.loadGame(this.gameId);

    this.engine.on('game_event', ({ event, state }) => {
      this._onGameEvent(event, state);
    });

    await this.engine.start();

    // Time limit
    if (this.timeLimitMs > 0) {
      this._timer = setTimeout(() => this._endTournament('time_limit'), this.timeLimitMs);
    }

    console.log(`[Tournament] STARTED — ${this.gameDef.name} / ${this.mode?.name || this.modeId}`);
    console.log(`[Tournament] Time limit: ${this.timeLimitMs / 60000} min`);
    this.emit('started', {
      tournamentId: this.id,
      game: this.gameDef.name,
      mode: this.mode?.name,
      players: Object.entries(this.players).map(([id, p]) => ({ id, name: p.name })),
      timeLimitMs: this.timeLimitMs,
    });

    return this;
  }

  // ── Score tracking ────────────────────────────────────────────────────────

  _onGameEvent(event, ramState) {
    if (this.state !== 'ACTIVE') return;

    // Update scores from current RAM state
    this._updateScores(ramState);

    // Check win condition
    const mode = this.mode;
    if (mode?.win_condition === 'first_to_value' && mode?.target_value) {
      for (const [pid, score] of Object.entries(this.scores)) {
        if (score >= mode.target_value) {
          this._endTournament('target_reached', pid);
          return;
        }
      }
    }

    // Emit score update
    this.emit('scores', { scores: this._getScoreBoard(), scoreMax: this.mode?.score_max || 100 });
  }

  _updateScores(ramState) {
    // For single-player games: all players share the same RAM
    // Multi-player: game defs should have per-player address prefixes (p1_, p2_)
    const playerIds = Object.keys(this.players);

    if (playerIds.length === 1) {
      const score = decodeScore(ramState, this.gameDef, this.mode);
      this.scores[playerIds[0]] = score;
      this.players[playerIds[0]].score = score;
    } else {
      // Multi-player: use controller map if set, otherwise fall back to registration order
      for (let i = 0; i < playerIds.length; i++) {
        const pid = playerIds[i];
        // _controllerMap: { 'player-0': 0, 'player-1': 1 } — gamepad index = port (0-based)
        const port = this._controllerMap?.[pid] ?? i;
        const prefix = `p${port + 1}_`;
        const playerState = {};

        // Extract this player's addresses (p1_lives → lives etc)
        for (const [k, v] of Object.entries(ramState)) {
          if (k.startsWith(prefix)) {
            playerState[k.slice(prefix.length)] = v;
          } else {
            playerState[k] = v;  // shared addresses
          }
        }

        const score = decodeScore(playerState, this.gameDef, this.mode);
        this.scores[pid] = score;
        this.players[pid].score = score;
      }
    }
  }

  _getScoreBoard() {
    const scoreMax = this.mode?.score_max || 100;
    return Object.entries(this.scores)
      .map(([id, score]) => ({
        playerId: id,
        name: this.players[id]?.name || id,
        score,
        pct: Math.round(Math.min(100, (score / scoreMax) * 100)),
        paid: this.players[id]?.paid,
      }))
      .sort((a, b) => b.score - a.score);
  }

  // ── Tournament end + payout ───────────────────────────────────────────────

  async _endTournament(reason, forcedWinner = null) {
    if (this.state !== 'ACTIVE') return;
    this.state = 'SCORING';

    clearTimeout(this._timer);
    if (this.engine) this.engine.stop();

    console.log(`[Tournament] Ended — reason: ${reason}`);

    // Determine winner
    const board   = this._getScoreBoard();
    const winner  = forcedWinner
      ? { playerId: forcedWinner, ...this.players[forcedWinner] }
      : board[0];

    if (!winner) {
      this.emit('error', new Error('No winner could be determined'));
      return;
    }

    const totalPot = this.entryFee * Object.keys(this.players).length;
    console.log(`[Tournament] Winner: ${winner.name || winner.playerId} — score ${winner.score}`);
    console.log(`[Tournament] Pot: ${totalPot} CKB`);
    console.log(`[Tournament] Final scores:`, board.map(p => `${p.name}: ${p.score}`).join(', '));

    this.emit('winner', { winner, board, reason, totalPot });

    // Settlement buffer — allows result submission and on-chain finality
    this.state = 'SETTLING';
    const settlesAt = Date.now() + this.settlementBufferMs;
    console.log(`[Tournament] Settlement buffer: ${this.settlementBufferMs / 1000}s — pays out at ${new Date(settlesAt).toISOString()}`);
    this.emit('settling', { winner, board, reason, totalPot, settlesAt, settlementBufferMs: this.settlementBufferMs });

    // Update chain state if we have a cell
    if (this._chainStore && this.chainOutPoint) {
      this._chainStore.beginSettlement(this.chainOutPoint, this._chainData(), winner.playerId)
        .then(({ txHash, outPoint }) => { this.chainOutPoint = outPoint; })
        .catch(e => console.warn('[Tournament] Chain settlement update failed:', e.message));
    }

    await new Promise(r => setTimeout(r, this.settlementBufferMs));

    // Payout
    await this._payout(winner, totalPot, board);
  }

  async _payout(winner, totalPot, board) {
    this.state = 'PAYING';
    const playerId = winner.playerId || Object.keys(this.players)[0];
    const player   = this.players[playerId];

    // Payout structure
    const mode = this.mode;
    let payouts = [];

    if (mode?.payout_structure === 'top2_split') {
      // 70/30 split
      payouts = [
        { playerId: board[0]?.playerId, share: 0.7 },
        { playerId: board[1]?.playerId, share: 0.3 },
      ].filter(p => p.playerId);
    } else {
      // Winner takes all
      payouts = [{ playerId, share: 1.0 }];
    }

    const results = [];
    for (const { playerId: pid, share } of payouts) {
      const payout_ckb = totalPot * share;
      const p = this.players[pid];
      if (!p) continue;

      const reason = share === 1.0 ? 'winner_takes_all' : `top2_${Math.round(share * 100)}pct`;
      console.log(`[Tournament] Paying ${p.name}: ${payout_ckb} CKB (${reason})`);

      if (p.payoutInvoice) {
        // ── Autonomous payout — player pre-registered their invoice ──────────
        try {
          console.log(`[Tournament] Sending autonomous payout to ${p.name}...`);
          const result = await this.fiber.sendPayment(p.payoutInvoice);
          console.log(`[Tournament] ✅ Payout sent to ${p.name}:`, result?.payment_hash || result);
          this.emit('payout_sent', {
            playerId: pid,
            name: p.name,
            amount_ckb: payout_ckb,
            reason,
            result,
          });
          results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'sent', result });
        } catch (e) {
          console.error(`[Tournament] ❌ Autonomous payout failed for ${p.name}:`, e.message);
          // Fall back to manual — emit payout_needed so host can retry
          this.emit('payout_needed', { playerId: pid, name: p.name, amount_ckb: payout_ckb, reason, error: e.message });
          results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'failed', error: e.message });
        }
      } else if (p.senderAddress && this._wallet) {
        // ── L1 payout — deposit was via JoyID, send back to sender address ───
        try {
          console.log(`[Tournament] Sending L1 payout to ${p.name} @ ${p.senderAddress}...`);
          const txHash = await this._wallet.sendL1Payment(p.senderAddress, payout_ckb);
          console.log(`[Tournament] ✅ L1 payout sent to ${p.name} — tx: ${txHash}`);
          this.emit('payout_sent', { playerId: pid, name: p.name, amount_ckb: payout_ckb, reason, txHash });
          results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'sent', txHash });
        } catch (e) {
          console.error(`[Tournament] ❌ L1 payout failed for ${p.name}:`, e.message);
          this.emit('payout_needed', { playerId: pid, name: p.name, amount_ckb: payout_ckb, reason, error: e.message });
          results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'failed', error: e.message });
        }
      } else {
        // ── Manual payout — no invoice and no sender address ─────────────────
        console.log(`[Tournament] ⚠️  No payout path for ${p.name} — emitting payout_needed`);
        this.emit('payout_needed', {
          playerId: pid,
          name: p.name,
          amount_ckb: payout_ckb,
          reason,
          hint: `Call t.sendPayout(invoice) or t.setPayoutInvoice('${pid}', invoice) then retry`,
        });
        results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'pending' });
      }
    }

    this.state = 'COMPLETE';
    console.log('[Tournament] Complete.');

    // Update chain cell to COMPLETE
    if (this._chainStore && this.chainOutPoint) {
      this._chainStore.completeTournament(this.chainOutPoint, this._chainData())
        .catch(e => console.warn('[Tournament] Chain complete update failed:', e.message));
    }

    this.emit('complete', {
      tournamentId: this.id,
      winner: { playerId, name: player?.name, score: winner.score },
      board,
      payouts: results,
      totalPot,
    });
  }

  /** Snapshot of chain-serialisable tournament data */
  _chainData() {
    return {
      id:                   this.id,
      state:                this.state,
      gameId:               this.gameId,
      modeId:               this.modeId,
      entryFee:             this.entryFee,
      currency:             this.currency,
      minPlayers:           this.minPlayers,
      maxPlayers:           this.maxPlayers,
      timeLimitMinutes:     this.timeLimitMs / 60000,
      registrationDeadline: this.registrationDeadline,
      settlementBufferMs:   this.settlementBufferMs,
      players:              Object.entries(this.players).map(([id, p]) => ({
                              id,
                              name:        p.name,
                              paid:        p.paid,
                              paymentHash: p.paymentHash,
                              fiberPeerId: p.fiberPeerId || null,
                              fiberAddr:   p.fiberAddr   || null,
                            })),
      winner:               this.winner || null,
      createdAt:            this.createdAt,
    };
  }

  /**
   * Manually send a payout invoice payment.
   * Call this after receiving a player's payout invoice (from payout_needed event).
   * @param {string} invoice - BOLT11 invoice from winner's Fiber node
   */
  async sendPayout(invoice) {
    console.log(`[Tournament] Sending payout via invoice: ${invoice.slice(0, 40)}...`);
    const result = await this.fiber.sendPayment(invoice);
    console.log(`[Tournament] Payout sent:`, result);
    this.emit('payout_sent', { invoice, result });
    return result;
  }

  // ── Manual controls ───────────────────────────────────────────────────────

  /** Force end the tournament early */
  async end(reason = 'manual') {
    return this._endTournament(reason);
  }

  /** Current status snapshot */
  status() {
    return {
      id:         this.id,
      state:      this.state,
      gameId:     this.gameId,
      modeId:     this.modeId,
      game:       this.gameDef?.name,
      mode:       this.mode?.name,
      entryFee:   this.entryFee,
      maxPlayers: this.maxPlayers,
      players:    Object.entries(this.players).map(([id, p]) => ({
                    id, name: p.name, paid: p.paid, score: p.score
                  })),
      scores:     this._getScoreBoard(),
      startedAt:  this._startedAt,
      elapsedMs:  this._startedAt ? Date.now() - this._startedAt : 0,
      timeLimitMs: this.timeLimitMs,
    };
  }
}

// ── TournamentManager ─────────────────────────────────────────────────────────

class TournamentManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.fiberRpc       = opts.fiberRpc || process.env.FIBER_RPC_URL || 'http://127.0.0.1:18226';
    this.fiberAuthToken = opts.fiberAuthToken || process.env.FIBER_AUTH_TOKEN || null;
    this.fiber          = new FiberClient(this.fiberRpc, { authToken: this.fiberAuthToken });
    this.tournaments = new Map();
    this._pollInterval = null;

    // Chain store + agent wallet — optional, requires CKB_PRIVATE_KEY
    this.chainStore = null;
    this.wallet     = null;
    if (opts.wallet || process.env.CKB_PRIVATE_KEY) {
      try {
        const { AgentWallet } = require('./agent-wallet');
        this.wallet     = opts.wallet || new AgentWallet();
        this.chainStore = new ChainStore({ wallet: this.wallet });
        console.log(`[TournamentManager] Agent wallet: ${this.wallet.address}`);
      } catch (e) {
        console.warn('[TournamentManager] Chain store disabled:', e.message);
      }
    }
  }

  /**
   * Create a new tournament and write escrow cell to CKB.
   * @param {object} opts
   * @param {string} opts.gameId                - e.g. 'tetris-nes'
   * @param {string} opts.mode                  - tournament mode id e.g. 'highest_score'
   * @param {number} opts.entryFee              - CKB per player
   * @param {number} opts.minPlayers            - minimum to proceed (default 2)
   * @param {number} opts.players               - max players (default 2)
   * @param {number} opts.timeLimitMinutes      - game time limit
   * @param {number} opts.registrationMinutes   - registration window (default 10)
   * @param {number} opts.settlementBufferMs    - buffer after game ends (default 30000)
   * @param {string} opts.currency              - 'Fibb' (mainnet) or 'Fibt' (testnet)
   * @returns {Tournament}
   */
  async create(opts) {
    const registrationMs = (opts.registrationMinutes || 10) * 60 * 1000;
    const t = new Tournament({
      ...opts,
      registrationDeadline: Date.now() + registrationMs,
    }, this.fiber);
    t._wallet = this.wallet;
    this.tournaments.set(t.id, t);

    // Bubble events up
    t.on('invoice',       e => this.emit('invoice',       { tournamentId: t.id, ...e }));
    t.on('player_paid',   e => this.emit('player_paid',   { tournamentId: t.id, ...e }));
    t.on('started',       e => this.emit('started',       e));
    t.on('scores',        e => this.emit('scores',        { tournamentId: t.id, scores: e }));
    t.on('winner',        e => this.emit('winner',        { tournamentId: t.id, ...e }));
    t.on('settling',      e => this.emit('settling',      { tournamentId: t.id, ...e }));
    t.on('payout_needed', e => this.emit('payout_needed', { tournamentId: t.id, ...e }));
    t.on('payout_sent',   e => this.emit('payout_sent',   { tournamentId: t.id, ...e }));
    t.on('complete',      e => this.emit('complete',      e));
    t.on('error',         e => this.emit('error',         e));

    // Write escrow cell to CKB (async — non-blocking, logs result)
    if (this.chainStore) {
      t._chainStore = this.chainStore;
      this._writeEscrowCell(t).catch(e =>
        console.warn('[TournamentManager] Escrow cell write failed:', e.message)
      );
    }

    // Early snapshot as fallback — _writeEscrowCell will overwrite with a post-escrow snapshot
    if (this.wallet) {
      this.wallet.snapshotOutpoints()
        .then(snap => {
          if (!t._depositSnapshot) {  // don't overwrite the post-escrow snapshot
            t._depositSnapshot = snap;
            console.log(`[TournamentManager] Deposit snapshot (early): ${snap.size} cells`);
          }
        })
        .catch(() => {});
    }

    // Registration deadline check
    const msUntilDeadline = t.registrationDeadline - Date.now();
    setTimeout(() => this._checkRegistrationDeadline(t), msUntilDeadline);

    return t;
  }

  async _writeEscrowCell(t) {
    let fiberPeerId = '';
    try {
      const info = await this.fiber.getNodeInfo();
      fiberPeerId = info.node_id || '';
    } catch (_) {}

    const { txHash, outPoint } = await this.chainStore.createEscrowCell({
      ...t._chainData(),
      fiberPeerId,
    });
    t.chainOutPoint = outPoint;
    console.log(`[TournamentManager] Escrow cell on-chain: ${txHash}`);
    this.emit('chain_escrow', { tournamentId: t.id, txHash, outPoint });

    // Re-snapshot AFTER escrow tx confirms so its change output isn't mistaken for a deposit
    if (this.wallet) {
      t._depositSnapshot = await this.wallet.snapshotOutpoints();
      console.log(`[TournamentManager] Deposit snapshot updated post-escrow: ${t._depositSnapshot.size} cells`);
    }
  }

  async _checkRegistrationDeadline(t) {
    if (t.state !== 'CREATED' && t.state !== 'WAITING_PLAYERS') return;
    const paidPlayers = Object.values(t.players).filter(p => p.paid).length;
    const metMin = paidPlayers >= t.minPlayers;

    console.log(`[TournamentManager] Registration deadline reached for ${t.id}: ${paidPlayers}/${t.minPlayers} paid`);

    if (!metMin) {
      console.log(`[TournamentManager] Min players not met — cancelling ${t.id}`);
      t.state = 'CANCELLED';
      this.emit('cancelled', { tournamentId: t.id, reason: 'min_players_not_met', paidPlayers, minPlayers: t.minPlayers });
      // Update chain cell
      if (this.chainStore && t.chainOutPoint) {
        await this.chainStore.closeRegistration(t.chainOutPoint, t._chainData())
          .catch(e => console.warn('Chain cancel failed:', e.message));
      }
      // TODO: refund entry fees via Fiber
    } else {
      console.log(`[TournamentManager] Min players met — activating ${t.id}`);
      if (this.chainStore && t.chainOutPoint) {
        const { outPoint } = await this.chainStore.closeRegistration(t.chainOutPoint, t._chainData())
          .catch(e => { console.warn('Chain funding failed:', e.message); return {}; });
        if (outPoint) t.chainOutPoint = outPoint;
      }
      this.emit('registration_closed', { tournamentId: t.id, paidPlayers });
    }
  }

  /**
   * Scan CKB for all FiberQuest tournament cells and return their state.
   * Works across all FiberQuest instances — no central server needed.
   */
  /**
   * Scan CKB for FiberQuest tournament cells.
   * With no arguments: returns ALL tournaments from ALL organizers globally.
   * With a tournamentId: returns that specific tournament's cell.
   * @param {string} [tournamentId]
   */
  async scanChain (tournamentId) {
    if (!this.chainStore) throw new Error('Chain store not configured (set CKB_PRIVATE_KEY)');
    return this.chainStore.scanTournaments(tournamentId);
  }

  get(id) { return this.tournaments.get(id); }
  list()  { return [...this.tournaments.values()].map(t => t.status()); }

  /** Start polling all waiting tournaments for incoming payments */
  startPaymentPolling(intervalMs = 5000) {
    this._pollInterval = setInterval(async () => {
      for (const t of this.tournaments.values()) {
        if (t.state === 'WAITING_PLAYERS') {
          await t.pollPayments().catch(e =>
            console.warn('[TournamentManager] Poll error:', e.message)
          );
        }
      }
    }, intervalMs);
    console.log(`[TournamentManager] Payment polling every ${intervalMs}ms`);
  }

  stopPaymentPolling() {
    clearInterval(this._pollInterval);
  }
}

// ── CLI demo mode ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const gameId = process.argv[2] || 'tetris-nes';
  const mode   = process.argv[3] || 'highest_score';

  console.log('\n🎮 FiberQuest Tournament Manager — Demo Mode');
  console.log(`   Game: ${gameId} / Mode: ${mode}`);
  console.log(`   RetroArch must be running with the correct ROM loaded.\n`);

  const tm = new TournamentManager({
    fiberRpc: process.env.FIBER_RPC_URL || 'http://127.0.0.1:18227',
  });

  (async () => {
    // Check Fiber
    const alive = await tm.fiber.isAlive();
    if (!alive) {
      console.warn('⚠️  Fiber node unreachable at', tm.fiberRpc);
      console.warn('   Set FIBER_RPC_URL or start the SSH tunnel.');
    } else {
      const info = await tm.fiber.getNodeInfo();
      console.log('✅ Fiber node:', info.node_id?.slice(0, 20) + '...');
      const chs = await tm.fiber.listChannels();
      const ch = chs?.channels?.[0];
      if (ch) {
        const localCkb = FiberClient.shannonToCkb(ch.local_balance);
        console.log(`   Channel: ${ch.channel_id?.slice(0, 16)}... local=${localCkb} CKB\n`);
      }
    }

    // Create tournament
    const t = tm.create({
      gameId,
      mode,
      entryFee: 1,   // 1 CKB for demo
      players: 1,    // single-player for demo
      timeLimitMinutes: 1,
      currency: process.env.CURRENCY || 'Fibb',
    });

    t.on('invoice', ({ name, invoice, amount_ckb }) => {
      console.log(`\n💳 Invoice for ${name} (${amount_ckb} CKB):`);
      console.log(`   ${invoice}\n`);
    });

    t.on('started', ({ game, mode: m }) => {
      console.log(`\n🏁 TOURNAMENT STARTED — ${game} / ${m}`);
      console.log('   Playing for 1 minute...\n');
    });

    t.on('scores', (board) => {
      process.stdout.write('\r   Scores: ' +
        board.map(p => `${p.name}: ${p.score}`).join(' | ') + '     ');
    });

    t.on('winner', ({ winner, board, reason }) => {
      console.log(`\n\n🏆 WINNER: ${winner.name} with score ${winner.score}`);
      console.log(`   Reason: ${reason}`);
      console.log('   Final board:');
      board.forEach((p, i) => console.log(`   ${i+1}. ${p.name}: ${p.score}`));
    });

    t.on('payout_sent', ({ name, amount_ckb, result }) => {
      console.log(`\n💸 Payout SENT: ${amount_ckb} CKB → ${name}`);
      console.log(`   Payment hash: ${result?.payment_hash || '(see result)'}`);
    });

    t.on('payout_needed', ({ name, amount_ckb, hint }) => {
      console.log(`\n⚠️  Manual payout needed: ${amount_ckb} CKB → ${name}`);
      if (hint) console.log(`   Hint: ${hint}`);
    });

    t.on('complete', ({ winner, totalPot, payouts }) => {
      console.log(`\n✅ Tournament complete. Pot: ${totalPot} CKB`);
      const sent    = payouts.filter(p => p.status === 'sent').length;
      const pending = payouts.filter(p => p.status === 'pending').length;
      const failed  = payouts.filter(p => p.status === 'failed').length;
      console.log(`   Payouts: ${sent} sent, ${pending} pending, ${failed} failed`);
      process.exit(0);
    });

    t.on('error', e => { console.error('\n❌ Error:', e.message); });

    // Register demo player (REQUIRE_PAYMENT=false skips invoice check for demo)
    // Set PAYOUT_INVOICE env var to test autonomous payout path:
    //   PAYOUT_INVOICE=fibb1... node src/tournament-manager.js
    process.env.REQUIRE_PAYMENT = 'false';
    const payoutInvoice = process.env.PAYOUT_INVOICE || null;
    if (payoutInvoice) {
      console.log('💰 Payout invoice provided — autonomous payout will fire on win\n');
    } else {
      console.log('⚠️  No PAYOUT_INVOICE set — manual payout path (payout_needed event)\n');
    }
    await t.addPlayer('player1', 'Player 1', { payoutInvoice });

    // Start immediately (no payment required in demo mode)
    t.markPaid('player1');

  })().catch(e => { console.error('Fatal:', e); process.exit(1); });
}

module.exports = { TournamentManager, Tournament };
