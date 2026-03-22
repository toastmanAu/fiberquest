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
    this.id        = `t_${Date.now()}`;
    this.gameId    = opts.gameId;
    this.modeId    = opts.mode || 'highest_score';
    this.entryFee  = opts.entryFee || 10;           // CKB
    this.maxPlayers = opts.players || 2;
    this.timeLimitMs = (opts.timeLimitMinutes || 5) * 60 * 1000;
    this.raHost    = opts.raHost || '127.0.0.1';
    this.raPort    = opts.raPort || 55355;
    this.currency  = opts.currency || 'Fibb';       // Fibb=mainnet, Fibt=testnet

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

    const amountShannon = FiberClient.ckbToShannon(this.entryFee);
    const description   = `FiberQuest: ${this.gameDef.name} — ${this.mode?.name || this.modeId} — ${name}`;

    console.log(`[Tournament] Generating entry invoice for ${name} (${this.entryFee} CKB)...`);
    const invoiceResult = await this.fiber.newInvoice(amountShannon, description, {
      currency: this.currency,
      expiry: 0xe10,  // 3600 seconds — FiberClient converts to hex string
    });

    const entryInvoice  = invoiceResult.invoice_address;
    const paymentHash   = invoiceResult.payment_hash;
    const payoutInvoice = opts.payoutInvoice || null;

    if (payoutInvoice) {
      console.log(`[Tournament] Payout invoice registered for ${name} ✅ (autonomous payout ready)`);
    } else {
      console.log(`[Tournament] ⚠️  No payout invoice for ${name} — will emit payout_needed on win`);
    }

    this.players[playerId] = {
      name,
      entryInvoice,
      paymentHash,
      payoutInvoice,   // null = manual payout needed; set = agent pays automatically
      paid: false,
      score: 0,
      joinedAt: Date.now(),
    };
    this.scores[playerId] = 0;
    this.state = 'WAITING_PLAYERS';

    console.log(`[Tournament] Player ${name} registered. Entry invoice: ${entryInvoice.slice(0, 40)}...`);
    this.emit('invoice', {
      playerId,
      name,
      invoice: entryInvoice,   // kept as 'invoice' for backwards compat
      amount_ckb: this.entryFee,
      payoutReady: !!payoutInvoice,
    });

    return { playerId, name, entryInvoice, amount_ckb: this.entryFee, payoutReady: !!payoutInvoice };
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
      // Multi-player: try p1_ / p2_ prefixed addresses
      for (let i = 0; i < playerIds.length; i++) {
        const pid = playerIds[i];
        const prefix = `p${i + 1}_`;
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
      } else {
        // ── Manual payout — no invoice registered, ask host ──────────────────
        console.log(`[Tournament] ⚠️  No payout invoice for ${p.name} — emitting payout_needed`);
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
    this.emit('complete', {
      tournamentId: this.id,
      winner: { playerId, name: player?.name, score: winner.score },
      board,
      payouts: results,
      totalPot,
    });
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
    this.fiberRpc   = opts.fiberRpc || process.env.FIBER_RPC_URL || 'http://127.0.0.1:8227';
    this.fiber      = new FiberClient(this.fiberRpc);
    this.tournaments = new Map();
    this._pollInterval = null;
  }

  /**
   * Create a new tournament.
   * @param {object} opts
   * @param {string} opts.gameId           - e.g. 'tetris-nes'
   * @param {string} opts.mode             - tournament mode id e.g. 'highest_score'
   * @param {number} opts.entryFee         - CKB per player
   * @param {number} opts.players          - number of players (default 2)
   * @param {number} opts.timeLimitMinutes - override default time limit
   * @param {string} opts.currency         - 'Fibb' (mainnet) or 'Fibt' (testnet)
   * @returns {Tournament}
   */
  create(opts) {
    const t = new Tournament(opts, this.fiber);
    this.tournaments.set(t.id, t);

    // Bubble events up
    t.on('invoice',       e => this.emit('invoice',       { tournamentId: t.id, ...e }));
    t.on('player_paid',   e => this.emit('player_paid',   { tournamentId: t.id, ...e }));
    t.on('started',       e => this.emit('started',       e));
    t.on('scores',        e => this.emit('scores',        { tournamentId: t.id, scores: e }));
    t.on('winner',        e => this.emit('winner',        { tournamentId: t.id, ...e }));
    t.on('payout_needed', e => this.emit('payout_needed', { tournamentId: t.id, ...e }));
    t.on('payout_sent',   e => this.emit('payout_sent',   { tournamentId: t.id, ...e }));
    t.on('complete',      e => this.emit('complete',      e));
    t.on('error',         e => this.emit('error',         e));

    return t;
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
