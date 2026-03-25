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

  // Formula-based score (e.g. "levels_complete * 100 + p1_lives * 10 + p1_bananas")
  const formula = mode?.score_formula;
  if (formula) {
    try {
      // Replace variable names with values from state, then evaluate
      const expr = formula.replace(/[a-z_][a-z0-9_]*/gi, (name) => {
        return String(state[name] ?? 0);
      });
      // Safe eval — only arithmetic operators and numbers
      if (/^[\d\s+\-*/().]+$/.test(expr)) {
        return Math.round(Function('"use strict"; return (' + expr + ')')());
      }
    } catch (_) {}
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

    // ── Distributed mode ──────────────────────────────────────────────────
    this.tournamentMode   = opts.tournamentMode || 'local';  // 'local' | 'distributed'
    this.myPlayerId       = opts.myPlayerId || null;          // which player THIS agent represents
    this.mySlotIndex      = opts.mySlotIndex ?? null;         // assigned slot for distributed joins
    this.scoreSubmissions = {};                                // { playerId: { score, koCount, eventLogHash, submittedAt } }
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

    // Slot index — distributed joins use assigned slot, local uses registration order
    const slotIndex = opts.slotIndex ?? (
      (this.mySlotIndex !== null && playerId === this.myPlayerId)
        ? this.mySlotIndex
        : Object.keys(this.players).length
    );

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

    // Distributed: set myPlayerId to first registered player if not already set (organiser)
    if (this.tournamentMode === 'distributed' && !this.myPlayerId) {
      this.myPlayerId = playerId;
      console.log(`[Tournament] Set myPlayerId to ${playerId} (organiser)`);
    }

    // Distributed mode: auto-populate local Fiber peer info for this player
    if (this.tournamentMode === 'distributed' && playerId === this.myPlayerId && this.fiber) {
      try {
        const info = await this.fiber.getNodeInfo();
        this.players[playerId].fiberPeerId = info.node_id || info.peer_id;
        const addrs = info.addresses || info.listening_addresses || [];
        this.players[playerId].fiberAddr = addrs[0] || null;
        console.log(`[Tournament] Auto-set Fiber peer info for ${name}: ${this.players[playerId].fiberPeerId?.slice(0, 16)}...`);
      } catch (e) {
        console.warn(`[Tournament] Could not get Fiber node info: ${e.message}`);
      }
    }

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

    const connectUrl = this._wallet.buildJoyIDConnectUrl(({ address, keyType }) => {
      console.log(`[Tournament] JoyID connect callback for ${player.name} — address ${address} keyType ${keyType}`)

      // Reject duplicate accounts — each player must use a separate JoyID account
      const duplicate = Object.entries(this.players).find(
        ([id, p]) => id !== playerId && p.senderAddress === address
      )
      if (duplicate) {
        const [, dp] = duplicate
        console.error(`[Tournament] Duplicate JoyID account for ${player.name} — already registered to ${dp.name}`)
        this.emit('error', {
          message: `This JoyID account is already registered to ${dp.name}. Each player must use a separate account.`,
          playerId,
          name: player.name,
        })
        return
      }

      player.senderAddress = address
      player.joyidKeyType  = keyType
      this.emit('player_connected', { playerId, name: player.name, address })
      this.buildPlayerPayTx(playerId, address).catch(e => {
        console.error(`[Tournament] buildPlayerPayTx failed for ${player.name}:`, e.message)
        this.emit('error', { message: e.message, playerId, name: player.name })
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

    // Build the raw deposit tx — agent builds it, player just signs the challenge hash
    const depositOpts = {};
    if (this.tournamentMode === 'distributed' && this._organizerAddress) {
      depositOpts.destinationAddress = this._organizerAddress;
    }
    const { rawTx, dataMarker } = await this._wallet.buildPlayerDepositTx(
      playerAddress, this.id, player.slotIndex, this.entryFee, depositOpts
    );

    // Extract cbId from callback URL so we can link raw tx to signed response
    const callbackUrl = this._wallet.registerJoyIDCallback(async (payload) => {
      // payload is SignMessageResponseData: { signature, message, pubkey, keyType, challenge }
      console.log(`[Tournament] JoyID sign-message callback for ${player.name}`);
      try {
        const signedTx = this._wallet.assembleSignedTx(cbId, payload);
        require('fs').writeFileSync('/tmp/fq-signed-tx.json', JSON.stringify(signedTx, null, 2));
        console.log(`[Tournament] Assembled signed tx for ${player.name} — submitting (dumped to /tmp/fq-signed-tx.json)`);
        const txHash = await this._wallet.sendRawTx(signedTx);
        console.log(`[Tournament] ✅ Deposit submitted for ${player.name}: ${txHash}`);
      } catch (e) {
        console.error(`[Tournament] ❌ Deposit failed for ${player.name}:`, e.message);
        this.emit('error', new Error(`Deposit failed for ${player.name}: ${e.message}`));
      }
    });
    const cbId = callbackUrl.split('/joyid/').pop().split('?')[0];

    // /sign-message with redirect — works like /auth (no window.opener needed).
    // Player signs the tx challenge hash; we assemble the full signed tx on callback.
    const signUrl = await this._wallet.buildJoyIDSignTxUrl(rawTx, playerAddress, callbackUrl, { entryFeeCkb: this.entryFee });

    player.signUrl       = signUrl;
    player.senderAddress = playerAddress;
    player.dataMarker    = dataMarker;

    console.log(`[Tournament] Sign-message URL for ${player.name} — marker ${dataMarker}`);
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

    // ── Distributed: scan organizer's cells for deposit markers from remote players ──
    if (this.tournamentMode === 'distributed' && this._wallet) {
      try {
        const { depositDataMarker } = require('./agent-wallet');
        // Scan for deposit markers for each slot we don't know is paid
        for (let slot = 0; slot < this.maxPlayers; slot++) {
          const marker = depositDataMarker(this.id, slot);
          const existingPlayer = Object.values(this.players).find(p => p.slotIndex === slot);
          if (existingPlayer?.paid) continue; // already confirmed

          const cell = await this._wallet.findDepositByMarker(marker);
          if (cell) {
            const pid = existingPlayer ? Object.keys(this.players).find(k => this.players[k].slotIndex === slot) : `remote-${slot}`;
            if (!existingPlayer) {
              // Discovered a remote player's deposit
              this.players[pid] = {
                name: `Player ${slot + 1} (remote)`,
                slotIndex: slot,
                paid: true,
                score: 0,
                joinedAt: Date.now(),
                depositCell: cell,
                senderAddress: null,
                payoutInvoice: null,
                entryInvoice: null,
                paymentHash: null,
                fiberPeerId: null,
                fiberAddr: null,
              };
              this.scores[pid] = 0;
              console.log(`[Tournament] Discovered remote deposit for slot ${slot} — marker ${marker.slice(0, 30)}...`);
              this.emit('player_paid', { playerId: pid, name: `Player ${slot + 1} (remote)` });
            } else {
              existingPlayer.paid = true;
              existingPlayer.depositCell = cell;
              console.log(`[Tournament] Deposit confirmed for slot ${slot} (${existingPlayer.name})`);
              this.emit('player_paid', { playerId: pid, name: existingPlayer.name });
            }
          }
        }
        // Check if all slots filled and paid
        const paidCount = Object.values(this.players).filter(p => p.paid).length;
        if (paidCount >= this.maxPlayers) {
          console.log('[Tournament] All players paid (distributed) — starting');
          this.start().catch(e => this.emit('error', e));
          return;
        }
      } catch (e) {
        // Non-fatal — will retry next poll
      }
    }

    // ── Fiber payment check (local mode) ─────────────────────────────────
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

    // Distributed: connect to all peers' Fiber nodes for settlement readiness
    if (this.tournamentMode === 'distributed') {
      await this.ensurePeerMesh().catch(e => console.warn('[Tournament] Peer mesh failed:', e.message));
    }

    // Use the shared RAM engine from main.js if available (already polling),
    // otherwise start our own. The shared engine is preferred because it's
    // already connected and logging to the session file.
    if (this._sharedRamEngine) {
      this.engine = this._sharedRamEngine;
      this.engine.on('game_event', ({ event, state }) => {
        this._onGameEvent(event, state);
      });
      this.engine.on('state_update', (state) => this._checkRoundGate(state));
      console.log('[Tournament] Using shared RAM engine (already polling)');
    } else {
      this.engine = new RamEngine({
        raHost: this.raHost,
        raPort: this.raPort,
        fiberRpc: 'disabled',
      });
      this.engine.loadGame(this.gameId);
      this.engine.on('game_event', ({ event, state }) => {
        this._onGameEvent(event, state);
      });
      this.engine.on('state_update', (state) => this._checkRoundGate(state));
      await this.engine.start();
    }

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

    // Write all phase timestamps to chain — every agent syncs to these
    if (this._chainStore && this.tournamentMode === 'distributed') {
      const SYNC_DELAY_MS = 30000;  // 30s for chain confirmation + polling
      const SUBMISSION_WINDOW_MS = 60000; // 60s to submit scores after game ends

      const startsAt           = Date.now() + SYNC_DELAY_MS;
      const endsAt             = startsAt + this.timeLimitMs;
      const submissionDeadline = endsAt + SUBMISSION_WINDOW_MS;
      const resolvesAt         = submissionDeadline;

      this._startsAt           = startsAt;
      this._endsAt             = endsAt;
      this._submissionDeadline = submissionDeadline;
      this._resolvesAt         = resolvesAt;

      // Set our timer to the synced end time
      clearTimeout(this._timer);
      this._startedAt = startsAt;
      this._timer = setTimeout(() => this._endTournament('time_limit'), endsAt - Date.now());

      console.log(`[Tournament] Phase timestamps:`);
      console.log(`  startsAt:           ${new Date(startsAt).toISOString()} (in ${SYNC_DELAY_MS/1000}s)`);
      console.log(`  endsAt:             ${new Date(endsAt).toISOString()}`);
      console.log(`  submissionDeadline: ${new Date(submissionDeadline).toISOString()}`);
      console.log(`  resolvesAt:         ${new Date(resolvesAt).toISOString()}`);

      this._chainStore.scanTournaments(this.id).then(cells => {
        if (cells[0]) {
          this._chainStore.activateTournament(cells[0].outPoint, {
            ...cells[0], ...this._chainData(),
            startsAt, endsAt, submissionDeadline, resolvesAt
          })
            .then(r => console.log(`[Tournament] Chain cell updated to ACTIVE: ${r.txHash}`))
            .catch(e => console.warn(`[Tournament] Chain ACTIVE update failed: ${e.message}`));
        }
      }).catch(() => {});
    }

    return this;
  }

  // ── Score tracking ────────────────────────────────────────────────────────

  _checkRoundGate(ramState) {
    if (this.state !== 'ACTIVE') return;
    if (!this._koLocked) return;
    const mode = this.mode;
    if (!mode || mode.win_condition !== 'first_to_kos') return;

    const healthMax = this.gameDef.ram_addresses?.p1_health?.max || 161;
    const p1h = ramState.p1_health ?? 0;
    const p2h = ramState.p2_health ?? 0;
    const timer = ramState.timer ?? 0;

    // Phase 1: wait for both healths to reset to max AND timer is active
    if (!this._roundReady && p1h >= healthMax && p2h >= healthMax && timer > 0) {
      this._roundReady = true;
      this._peakTimer = timer;
      console.log(`[Tournament] Round reset detected — health maxed, timer=${timer}`);
    }
    // Phase 2: timer has ticked down from peak → new round confirmed
    if (this._roundReady && this._peakTimer > 0 && timer > 0 && timer < this._peakTimer) {
      this._koLocked = false;
      this._roundReady = false;
      this._peakTimer = 0;
      console.log(`[Tournament] New round confirmed — KO detection unlocked (timer ${timer})`);
    }
  }

  _onGameEvent(event, ramState) {
    if (this.state !== 'ACTIVE') return;

    // Track events for distributed mode event log hash
    if (!this._sessionEvents) this._sessionEvents = [];
    this._sessionEvents.push({ id: event.id, t: Date.now() });

    // Update scores from current RAM state
    this._updateScores(ramState);

    // ── KO-based win condition (fighting games) ──────────────────────────
    const mode = this.mode;
    if (mode?.win_condition === 'first_to_kos' && mode?.ko_events) {
      if (!this._koCount) this._koCount = {};
      if (this._koLocked === undefined) this._koLocked = false;
      if (this._roundReady === undefined) this._roundReady = true;
      if (this._peakTimer === undefined) this._peakTimer = 0;

      // Check round gate on every event too
      this._checkRoundGate(ramState);

      const playerIds = Object.keys(this.players);
      const isKoEvent = event.id === mode.ko_events.p1_dies || event.id === mode.ko_events.p2_dies;

      if (isKoEvent && this._koLocked) {
        // Ignore — waiting for new round
      } else if (event.id === mode.ko_events.p1_dies) {
        // P1 died → P2 scores a KO
        const p2id = playerIds[1] || 'p2';
        this._koCount[p2id] = (this._koCount[p2id] || 0) + 1;
        this.scores[p2id] = this._koCount[p2id];
        this._koLocked = true;
        this._roundReady = false;
        console.log(`[Tournament] KO! ${p2id} now has ${this._koCount[p2id]} KOs`);
      } else if (event.id === mode.ko_events.p2_dies) {
        // P2 died → P1 scores a KO
        const p1id = playerIds[0] || 'p1';
        this._koCount[p1id] = (this._koCount[p1id] || 0) + 1;
        this.scores[p1id] = this._koCount[p1id];
        this._koLocked = true;
        this._roundReady = false;
        console.log(`[Tournament] KO! ${p1id} now has ${this._koCount[p1id]} KOs`);
      }
      // Check for winner
      const target = mode.target_kos || 2;
      for (const [pid, kos] of Object.entries(this._koCount)) {
        if (kos >= target) {
          console.log(`[Tournament] WINNER: ${pid} with ${kos} KOs`);
          this._endTournament('ko_target_reached', pid);
          return;
        }
      }
    }

    // ── Score-based win condition ─────────────────────────────────────────
    if (mode?.win_condition === 'first_to_value' && mode?.target_value) {
      for (const [pid, score] of Object.entries(this.scores)) {
        if (score >= mode.target_value) {
          this._endTournament('target_reached', pid);
          return;
        }
      }
    }

    // Emit score update
    this.emit('scores', { scores: this._getScoreBoard(), scoreMax: mode?.target_kos || mode?.score_max || 100 });
  }

  _updateScores(ramState) {
    // Distributed: only update the local player's score from RAM
    if (this.tournamentMode === 'distributed' && this.myPlayerId) {
      const score = decodeScore(ramState, this.gameDef, this.mode);
      if (score !== this.scores[this.myPlayerId]) {
        console.log(`[Tournament] Distributed score update: ${score} (state keys: ${Object.keys(ramState).join(',')} vals: ${Object.values(ramState).join(',')})`);
      }
      this.scores[this.myPlayerId] = score;
      if (this.players[this.myPlayerId]) this.players[this.myPlayerId].score = score;
      return;
    }

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

  // ── Fiber peer mesh ─────────────────────────────────────────────────────

  /**
   * Connect to all other players' Fiber nodes and verify reachability.
   * Reads peer info from on-chain tournament cell or local player records.
   * Call this before tournament starts to guarantee settlement paths exist.
   */
  async ensurePeerMesh() {
    if (!this.fiber) return;
    const myInfo = await this.fiber.getNodeInfo().catch(() => null);
    if (!myInfo) { console.warn('[Tournament] Cannot get local Fiber node info'); return; }

    const myPeerId = myInfo.node_id || myInfo.peer_id;
    console.log(`[Tournament] My Fiber peer: ${myPeerId}`);

    for (const [pid, p] of Object.entries(this.players)) {
      if (pid === this.myPlayerId) continue; // skip self
      if (!p.fiberPeerId || !p.fiberAddr) {
        console.warn(`[Tournament] ${p.name} missing Fiber peer info — skipping`);
        continue;
      }
      try {
        await this.fiber.connectPeer(p.fiberPeerId, [p.fiberAddr]);
        console.log(`[Tournament] ✅ Connected to ${p.name}'s Fiber node (${p.fiberPeerId.slice(0, 16)}...)`);
      } catch (e) {
        // Already connected is fine
        if (e.message?.includes('already connected') || e.message?.includes('exists')) {
          console.log(`[Tournament] Already connected to ${p.name}`);
        } else {
          console.warn(`[Tournament] ⚠️  Cannot connect to ${p.name}: ${e.message}`);
        }
      }
    }

    // Check existing channels — do we need to open any?
    try {
      const channels = await this.fiber.listChannels();
      const channelPeers = new Set((channels || []).map(c => c.peer_id || c.remote_peer_id));
      for (const [pid, p] of Object.entries(this.players)) {
        if (pid === this.myPlayerId) continue;
        if (p.fiberPeerId && channelPeers.has(p.fiberPeerId)) {
          console.log(`[Tournament] Channel exists with ${p.name} ✅`);
        } else if (p.fiberPeerId) {
          console.log(`[Tournament] No channel with ${p.name} — will route via network or open on demand`);
        }
      }
    } catch (e) {
      console.warn(`[Tournament] Channel check failed: ${e.message}`);
    }
  }

  // ── Distributed tournament methods ──────────────────────────────────────

  /**
   * Submit this agent's local score data on-chain (distributed mode).
   */
  async _submitMyScore() {
    if (!this.myPlayerId) { console.warn('[Tournament] No myPlayerId — skipping score submit'); return; }
    if (!this._wallet && !this._chainStore?.wallet) {
      console.warn('[Tournament] No wallet — score cell cannot be written');
      return;
    }
    const wallet = this._wallet || this._chainStore?.wallet;
    const crypto = require('crypto');
    const score = this.scores[this.myPlayerId] || 0;
    const koCount = this._koCount?.[this.myPlayerId] || 0;

    const sessionEvents = (this._sessionEvents || []).map(e => `${e.id}:${e.t}`).join('|');
    const eventLogHash = '0x' + crypto.createHash('sha256').update(sessionEvents).digest('hex');

    const scoreData = { score, koCount, eventLogHash };
    this.scoreSubmissions[this.myPlayerId] = { ...scoreData, submittedAt: Date.now() };

    // Write score as a standalone cell — no contention with tournament cell
    if (!this._chainStore) {
      const { ChainStore } = require('./chain-store');
      this._chainStore = new ChainStore({ wallet });
    }
    try {
      const organizerAddr = this._organizerAddress || wallet.address;
      const result = await this._chainStore.submitScoreCell(wallet, this.id, this.myPlayerId, scoreData, organizerAddr);
      console.log(`[Tournament] ✅ Score cell on-chain: ${this.myPlayerId} score=${score} tx=${result.txHash}`);
      return result;
    } catch (e) {
      console.error(`[Tournament] ❌ Score cell write failed: ${e.message}`);
    }
  }

  /**
   * Accept a remote agent's score submission (organizer only, distributed mode).
   */
  acceptScoreSubmission(playerId, scoreData) {
    if (this.tournamentMode !== 'distributed') throw new Error('Not a distributed tournament');
    if (!this.players[playerId]) throw new Error(`Unknown player: ${playerId}`);
    this.scoreSubmissions[playerId] = {
      score:        scoreData.score,
      koCount:      scoreData.koCount || 0,
      eventLogHash: scoreData.eventLogHash || null,
      submittedAt:  Date.now(),
    };
    console.log(`[Tournament] Score received from ${playerId}: score=${scoreData.score} KOs=${scoreData.koCount}`);

    // Check if all players have submitted
    const allSubmitted = Object.keys(this.players).every(pid => this.scoreSubmissions[pid]);
    if (allSubmitted) {
      console.log('[Tournament] All scores submitted — resolving winner');
      this._resolveDistributedWinner();
    }
  }

  /**
   * Deterministic winner resolution from on-chain score data.
   * All agents running this on the same data MUST reach the same result.
   */
  _resolveDistributedWinner() {
    const sorted = Object.entries(this.scoreSubmissions)
      .map(([pid, s]) => ({ playerId: pid, score: s.score, koCount: s.koCount }))
      .sort((a, b) => b.score - a.score || a.playerId.localeCompare(b.playerId)); // deterministic tiebreak

    const winner = sorted[0];
    console.log(`[Tournament] Distributed winner: ${winner.playerId} (score=${winner.score})`);
    this._endTournament('distributed_consensus', winner.playerId);
  }

  /**
   * Poll chain for score submissions from other agents (non-organizer distributed mode).
   */
  startDistributedPolling(intervalMs = 10000) {
    if (this._distributedPollInterval) return;
    this._distributedPollInterval = setInterval(async () => {
      if (this.state === 'COMPLETE' || this.state === 'PAYING') {
        clearInterval(this._distributedPollInterval);
        return;
      }
      try {
        const cells = await this._chainStore?.scanTournaments(this.id);
        if (!cells?.length) return;
        const cell = cells[0];
        // Scan for per-agent score cells (not the tournament cell's scoreSubmissions)
        if (this.state === 'SETTLING') {
          const wallet = this._wallet || this._chainStore?.wallet;
          if (wallet) {
            try {
              const organizerAddr = this._organizerAddress || wallet.address;
              const scoreCells = await this._chainStore.scanScoreCells(wallet, this.id, organizerAddr);
              for (const sc of scoreCells) {
                if (!this.scoreSubmissions[sc.playerId]) {
                  this.scoreSubmissions[sc.playerId] = sc;
                  console.log(`[Tournament] Chain: found score cell for ${sc.playerId} — score=${sc.score}`);
                }
              }
              const allSubmitted = Object.keys(this.players).every(pid => this.scoreSubmissions[pid]);
              if (allSubmitted) {
                clearInterval(this._distributedPollInterval);
                console.log('[Tournament] All scores on-chain — resolving winner');
                this._resolveDistributedWinner();
              }
            } catch (_) {}
          }
        }
        // Detect state changes from organizer (only fire once)
        if (cell.state === 'ACTIVE' && (this.state === 'WAITING_PLAYERS' || this.state === 'CREATED') && !this._distributedStarted) {
          this._distributedStarted = true;

          // Read all phase timestamps from chain
          const startsAt           = cell.startsAt || Date.now();
          const endsAt             = cell.endsAt || (startsAt + this.timeLimitMs);
          const submissionDeadline = cell.submissionDeadline || (endsAt + 60000);
          const resolvesAt         = cell.resolvesAt || submissionDeadline;

          this._startsAt           = startsAt;
          this._endsAt             = endsAt;
          this._submissionDeadline = submissionDeadline;
          this._resolvesAt         = resolvesAt;

          const waitMs = Math.max(0, startsAt - Date.now());
          console.log(`[Tournament] Chain: ACTIVE — phases:`);
          console.log(`  starts in ${Math.round(waitMs/1000)}s, ends at ${new Date(endsAt).toISOString()}`);
          console.log(`  submission deadline: ${new Date(submissionDeadline).toISOString()}`);

          // Wait until synced start, then launch
          setTimeout(() => {
            this._startedAt = startsAt;
            this.emit('started', {
              tournamentId: this.id,
              game: this.gameDef?.name,
              mode: this.mode?.name,
              players: Object.entries(this.players).map(([id, p]) => ({ id, name: p.name })),
              timeLimitMs: this.timeLimitMs,
            });
            this.start().catch(e => console.error('[Tournament] Auto-start failed:', e.message));
          }, waitMs);

          // Set timer to fire at endsAt — same moment as organiser
          const endDelay = Math.max(0, endsAt - Date.now());
          this._timer = setTimeout(() => this._endTournament('time_limit'), endDelay);
          console.log(`[Tournament] Timer set: game ends in ${Math.round(endDelay/1000)}s`);
        }

        // Detect tournament complete — show results
        if (cell.state === 'COMPLETE' && this.state !== 'COMPLETE' && this.state !== 'PAYING') {
          console.log(`[Tournament] Chain: tournament COMPLETE — winner: ${cell.winner}`);
          clearInterval(this._distributedPollInterval);
          if (this.engine) this.engine.stop();
          this.state = 'COMPLETE';
          const board = this._getScoreBoard();
          const winner = cell.winner ? { playerId: cell.winner, name: this.players[cell.winner]?.name || cell.winner } : board[0];
          this.emit('winner', { winner, board, reason: 'distributed_consensus', totalPot: this.entryFee * this.maxPlayers, isDraw: false });
          this.emit('complete', { tournamentId: this.id, winner, board, payouts: [], totalPot: this.entryFee * this.maxPlayers, isDraw: false });
        }
      } catch (e) {
        // Non-fatal — will retry next interval
      }
    }, intervalMs);
  }

  async _endTournament(reason, forcedWinner = null) {
    if (this.state !== 'ACTIVE' && reason !== 'distributed_consensus') return;
    if (this.state !== 'ACTIVE' && this.state !== 'SETTLING') return;

    // ── Distributed mode: ALL agents follow the same path ──────────────
    // 1. Submit own score to chain
    // 2. Poll chain for all scores
    // 3. Resolve winner when all found (or timeout)
    // This is identical for organiser and participant.
    if (this.tournamentMode === 'distributed' && !this.myPlayerId) {
      this.myPlayerId = Object.keys(this.players)[0];
    }
    if (this.tournamentMode === 'distributed' && reason !== 'distributed_consensus') {
      this.state = 'SETTLING';
      clearTimeout(this._timer);
      if (this.engine) this.engine.stop();

      const myScore = this.scores[this.myPlayerId] || 0;
      console.log(`[Tournament] Settling — my score: ${myScore} (${this.myPlayerId})`);

      // Step 1: Submit own score
      await this._submitMyScore();

      // Step 2: Emit settling to UI
      this.emit('settling', { reason, tournamentId: this.id, message: `Score submitted: ${myScore}. Waiting for other agents...` });

      // Step 3: Poll chain aggressively for all scores (every 5s during settling)
      this.startDistributedPolling(5000);

      // Step 4: Resolve at submissionDeadline — same moment on all agents
      const deadline = this._submissionDeadline || (Date.now() + 120000);
      const resolveDelay = Math.max(10000, deadline - Date.now()); // at least 10s
      console.log(`[Tournament] Will resolve in ${Math.round(resolveDelay/1000)}s (submission deadline)`);
      setTimeout(() => {
        if (this.state === 'SETTLING') {
          console.log('[Tournament] Settlement timeout (2min) — resolving with available data');
          for (const pid of Object.keys(this.players)) {
            if (!this.scoreSubmissions[pid]) {
              const localScore = this.scores[pid] || 0;
              this.scoreSubmissions[pid] = { score: localScore, koCount: 0, submittedAt: Date.now() };
              console.log(`[Tournament] ${pid} using local score: ${localScore}`);
            }
          }
          this._resolveDistributedWinner();
        }
      }, SETTLEMENT_TIMEOUT_MS);
      return;
    }

    this.state = 'SCORING';

    clearTimeout(this._timer);
    if (this.engine) this.engine.stop();

    console.log(`[Tournament] Ended — reason: ${reason}`);

    // Determine winner
    const board   = this._getScoreBoard();
    const isDraw  = !forcedWinner && board.length >= 2 && board[0].score === board[1].score;
    const winner  = forcedWinner
      ? { playerId: forcedWinner, ...this.players[forcedWinner] }
      : board[0];

    if (!winner) {
      this.emit('error', new Error('No winner could be determined'));
      return;
    }

    const totalPot = this.entryFee * Object.keys(this.players).length;

    // Add payout amounts to board for UI display
    for (const entry of board) {
      if (isDraw) {
        entry.payout = Math.round(totalPot / board.length);
      } else if (entry.playerId === (winner.playerId || forcedWinner)) {
        entry.payout = totalPot;
      } else {
        entry.payout = 0;
      }
    }

    if (isDraw) {
      console.log(`[Tournament] DRAW — scores tied at ${board[0].score}. ${winner.name} adjudicated winner. Refunding all players.`);
    } else {
      console.log(`[Tournament] Winner: ${winner.name || winner.playerId} — score ${winner.score}`);
    }
    console.log(`[Tournament] Pot: ${totalPot} CKB`);
    console.log(`[Tournament] Final scores:`, board.map(p => `${p.name}: ${p.score}`).join(', '));

    this.emit('winner', { winner, board, reason, totalPot, isDraw });

    // Settlement buffer — allows result submission and on-chain finality
    this.state = 'SETTLING';
    const settlesAt = Date.now() + this.settlementBufferMs;
    console.log(`[Tournament] Settlement buffer: ${this.settlementBufferMs / 1000}s — pays out at ${new Date(settlesAt).toISOString()}`);
    this.emit('settling', { winner, board, reason, totalPot, settlesAt, settlementBufferMs: this.settlementBufferMs });

    // Skip chain state update during settlement — it competes with payout for the
    // same agent cells, causing RBF rejection. Payout is the priority.
    // Chain state will be updated to COMPLETE after payout succeeds.
    console.log('[Tournament] Skipping chain settlement update (payout priority)');

    // Brief buffer before payout
    await new Promise(r => setTimeout(r, 5000));

    // Payout
    await this._payout(winner, totalPot, board, isDraw);
  }

  async _payout(winner, totalPot, board, isDraw = false) {
    this.state = 'PAYING';
    const playerId = winner.playerId || Object.keys(this.players)[0];
    const player   = this.players[playerId];

    // ── Distributed mode: losers pay winner via Fiber channels ───────────
    if (this.tournamentMode === 'distributed' && !isDraw) {
      const loserCount = Object.keys(this.players).length - 1;
      const perLoserCkb = this.entryFee; // each loser pays their entry fee to winner

      if (this.myPlayerId === playerId) {
        // I won — generate invoice for total winnings, publish to chain
        console.log(`[Tournament] I won! Generating invoice for ${perLoserCkb * loserCount} CKB from ${loserCount} losers`);
        if (this.fiber) {
          try {
            const totalShannon = BigInt(Math.round(perLoserCkb * loserCount * 1e8));
            const inv = await this.fiber.newInvoice(totalShannon, `FQ win: ${this.id}`, { currency: this.currency });
            const winnerInvoice = inv?.invoice_address;
            console.log(`[Tournament] Winner invoice: ${winnerInvoice?.slice(0, 40)}...`);

            // Write invoice to chain so losers can read it
            if (this._chainStore) {
              const cells = await this._chainStore.scanTournaments(this.id).catch(() => []);
              if (cells.length > 0) {
                await this._chainStore.updateCell(cells[0].outPoint, {
                  ...cells[0], state: 'COMPLETE', winner: playerId, winnerInvoice
                }).catch(e => console.warn('[Tournament] Chain invoice write failed:', e.message));
              }
            }
            this.emit('winner_invoice', { invoice: winnerInvoice, amount_ckb: perLoserCkb * loserCount });
          } catch (e) {
            console.warn(`[Tournament] Invoice generation failed: ${e.message}`);
          }
        }
      } else {
        // I lost — read winner's invoice from chain and pay via Fiber
        console.log(`[Tournament] I lost — looking for winner's invoice to pay ${perLoserCkb} CKB`);
        let winnerInvoice = null;

        // Poll chain for winner's invoice (they may not have written it yet)
        const maxWaitMs = 60000;
        const pollMs = 5000;
        const start = Date.now();
        while (!winnerInvoice && Date.now() - start < maxWaitMs) {
          try {
            const cells = await this._chainStore?.scanTournaments(this.id);
            if (cells?.[0]?.winnerInvoice) {
              winnerInvoice = cells[0].winnerInvoice;
            }
          } catch (_) {}
          if (!winnerInvoice) await new Promise(r => setTimeout(r, pollMs));
        }

        if (winnerInvoice && this.fiber) {
          try {
            const result = await this.fiber.sendPayment(winnerInvoice);
            console.log(`[Tournament] ✅ Fiber payout sent to winner: ${result?.payment_hash || 'ok'}`);
            this.emit('payout_sent', { playerId, name: player?.name, amount_ckb: perLoserCkb, result });
            board.find(b => b.playerId === this.myPlayerId && (b.payout = -perLoserCkb));
          } catch (e) {
            console.error(`[Tournament] ❌ Fiber payout to winner failed: ${e.message}`);
            this.emit('payout_needed', { playerId, name: player?.name, amount_ckb: perLoserCkb, error: e.message });
          }
        } else {
          console.warn(`[Tournament] Could not find winner's invoice — manual payout needed`);
          this.emit('payout_needed', { playerId, name: player?.name, amount_ckb: perLoserCkb, error: 'Winner invoice not found' });
        }
      }
      // Skip the local payout flow below — distributed settlement is complete
      this.state = 'COMPLETE';
      this.emit('complete', { tournamentId: this.id, winner: { playerId, name: player?.name, score: winner.score }, board, payouts: [], totalPot, isDraw });
      return;
    }

    // Payout structure
    const mode = this.mode;
    let payouts = [];

    if (isDraw) {
      // Draw — refund all players equally
      const playerCount = Object.keys(this.players).length;
      payouts = Object.keys(this.players).map(pid => ({
        playerId: pid,
        share: 1.0 / playerCount,
      }));
      console.log(`[Tournament] Draw payout: refunding ${this.entryFee} CKB to each of ${playerCount} players`);
    } else if (mode?.payout_structure === 'top2_split') {
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

    // Collect L1 payouts to batch into a single tx (avoids RBF conflicts)
    const l1Batch = [];
    const fiberPayouts = [];
    const manualPayouts = [];

    for (const { playerId: pid, share } of payouts) {
      const payout_ckb = totalPot * share;
      const p = this.players[pid];
      if (!p) continue;
      const reason = share === 1.0 ? 'winner_takes_all' : `top2_${Math.round(share * 100)}pct`;

      if (p.payoutInvoice) {
        fiberPayouts.push({ pid, p, payout_ckb, reason });
      } else if (p.senderAddress && this._wallet) {
        l1Batch.push({ pid, p, payout_ckb, reason });
      } else {
        manualPayouts.push({ pid, p, payout_ckb, reason });
      }
    }

    // ── Batch L1 payouts in one transaction ──────────────────────────────────
    if (l1Batch.length > 0 && this._wallet) {
      const recipients = l1Batch.map(({ p, payout_ckb }) => ({
        toAddress: p.senderAddress,
        amountCkb: payout_ckb,
      }));
      const names = l1Batch.map(x => `${x.p.name}: ${x.payout_ckb} CKB`).join(', ');
      console.log(`[Tournament] Batch L1 payout: ${names}`);
      try {
        const txHash = await this._wallet.sendL1BatchPayment(recipients);
        console.log(`[Tournament] ✅ Batch L1 payout sent — tx: ${txHash}`);
        for (const { pid, p, payout_ckb, reason } of l1Batch) {
          this.emit('payout_sent', { playerId: pid, name: p.name, amount_ckb: payout_ckb, reason, txHash });
          results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'sent', txHash });
        }
      } catch (e) {
        console.error(`[Tournament] ❌ Batch L1 payout failed:`, e.message);
        for (const { pid, p, payout_ckb, reason } of l1Batch) {
          this.emit('payout_needed', { playerId: pid, name: p.name, amount_ckb: payout_ckb, reason, error: e.message });
          results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'failed', error: e.message });
        }
      }
    }

    // ── Fiber invoice payouts (sequential — each is a separate channel payment) ─
    for (const { pid, p, payout_ckb, reason } of fiberPayouts) {
      try {
        console.log(`[Tournament] Sending Fiber payout to ${p.name}...`);
        const result = await this.fiber.sendPayment(p.payoutInvoice);
        console.log(`[Tournament] ✅ Payout sent to ${p.name}:`, result?.payment_hash || result);
        this.emit('payout_sent', { playerId: pid, name: p.name, amount_ckb: payout_ckb, reason, result });
        results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'sent', result });
      } catch (e) {
        console.error(`[Tournament] ❌ Fiber payout failed for ${p.name}:`, e.message);
        this.emit('payout_needed', { playerId: pid, name: p.name, amount_ckb: payout_ckb, reason, error: e.message });
        results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'failed', error: e.message });
      }
    }

    // ── Manual payouts (no path available) ───────────────────────────────────
    for (const { pid, p, payout_ckb, reason } of manualPayouts) {
      console.log(`[Tournament] ⚠️  No payout path for ${p.name} — emitting payout_needed`);
      this.emit('payout_needed', { playerId: pid, name: p.name, amount_ckb: payout_ckb, reason });
      results.push({ playerId: pid, name: p.name, amount_ckb: payout_ckb, status: 'pending' });
    }

    this.state = 'COMPLETE';
    console.log('[Tournament] Complete.');

    // Chain state updates disabled — they race with payout for the same agent cells,
    // causing the payout to be RBF-replaced. Payout delivery is the priority.
    // TODO: use separate cell pools for chain state vs payouts

    this.emit('complete', {
      tournamentId: this.id,
      winner: { playerId, name: player?.name, score: winner.score },
      board,
      payouts: results,
      totalPot,
      isDraw,
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
      tournamentMode:       this.tournamentMode,
      organizerAddress:     this._wallet?.address || null,
      scoreSubmissions:     Object.keys(this.scoreSubmissions).length > 0 ? this.scoreSubmissions : null,
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
      id:             this.id,
      state:          this.state,
      gameId:         this.gameId,
      modeId:         this.modeId,
      game:           this.gameDef?.name,
      mode:           this.mode?.name,
      entryFee:       this.entryFee,
      maxPlayers:     this.maxPlayers,
      tournamentMode: this.tournamentMode,
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

    // Create tournament data file
    const { TournamentLogger } = require('./session-logger');
    t._logger = new TournamentLogger(t.id, {
      gameId:   t.gameId,
      mode:     t.modeId,
      entryFee: t.entryFee,
      currency: t.currency,
    });

    // Bubble events up
    const log = (evt, data) => { if (t._logger) t._logger.addEvent({ event: evt, ...data }); };
    t.on('invoice',           e => { log('invoice', e);           this.emit('invoice',           { tournamentId: t.id, ...e }); });
    t.on('player_registered', e => { log('player_registered', e); this.emit('player_registered', { tournamentId: t.id, ...e }); });
    t.on('connect_qr',        e => { this.emit('connect_qr',        { tournamentId: t.id, ...e }); });
    t.on('player_connected',  e => { log('player_connected', e);  this.emit('player_connected',  { tournamentId: t.id, ...e }); });
    t.on('sign_url',          e => { this.emit('sign_url',          { tournamentId: t.id, ...e }); });
    t.on('deposit_timeout',   e => { log('deposit_timeout', e);   this.emit('deposit_timeout',   { tournamentId: t.id, ...e }); });
    t.on('player_paid',       e => { log('player_paid', e);       this.emit('player_paid',       { tournamentId: t.id, ...e }); });
    t.on('started',           e => { log('started', e); t._logger?.update({ state: 'ACTIVE' }); this.emit('started', e); });
    t.on('scores',            e => { t._logger?.updateScores(e);  this.emit('scores',            { tournamentId: t.id, scores: e }); });
    t.on('winner',            e => { log('winner', e);            this.emit('winner',            { tournamentId: t.id, ...e }); });
    t.on('settling',          e => { log('settling', e); t._logger?.update({ state: 'SETTLING' }); this.emit('settling', { tournamentId: t.id, ...e }); });
    t.on('payout_needed',     e => { log('payout_needed', e);     this.emit('payout_needed',     { tournamentId: t.id, ...e }); });
    t.on('payout_sent',       e => { log('payout_sent', e);       this.emit('payout_sent',       { tournamentId: t.id, ...e }); });
    t.on('complete',          e => { t._logger?.complete(e);      this.emit('complete',          e); });
    t.on('error',             e => { log('error', e);             this.emit('error',             e); });

    // Write escrow cell to CKB (async — non-blocking, logs result)
    // Skip for distributed joins — the escrow already exists on-chain
    if (this.chainStore && !opts.skipEscrow) {
      t._chainStore = this.chainStore;
      this._writeEscrowCell(t).catch(e =>
        console.warn('[TournamentManager] Escrow cell write failed:', e.message)
      );
    } else if (this.chainStore) {
      t._chainStore = this.chainStore;
    } else {
      // Ensure a read-only chain store is always available for distributed scanning/submission
      const { ChainStore } = require('./chain-store');
      t._chainStore = new ChainStore({ rpcUrl: this.ckbRpcUrl || 'https://testnet.ckbapp.dev/', wallet: this.wallet });
    }

    // Early snapshot as fallback — _writeEscrowCell will overwrite with a post-escrow snapshot
    if (this.wallet && !opts.skipEscrow) {
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
  acceptScoreSubmission(tournamentId, playerId, scoreData) {
    const t = this.tournaments.get(tournamentId);
    if (!t) throw new Error(`Tournament not found: ${tournamentId}`);
    return t.acceptScoreSubmission(playerId, scoreData);
  }
  getActive() {
    for (const t of this.tournaments.values()) {
      if (t.state === 'ACTIVE' || t.state === 'WAITING_PLAYERS') return t;
    }
    return null;
  }
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
