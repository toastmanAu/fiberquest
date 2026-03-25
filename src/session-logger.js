/**
 * FiberQuest — Session Logger
 *
 * Writes per-session and per-tournament data files to data/.
 * Every game launch creates a session file. If a tournament is active,
 * events are also written to the tournament's data file.
 *
 * Files:
 *   data/session-<gameId>-<timestamp>.jsonl   — raw RAM events + metadata
 *   data/tournament-<tournamentId>.json       — tournament lifecycle + final results
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

class SessionLogger {
  constructor(gameId) {
    ensureDataDir();
    this.gameId     = gameId;
    this.startedAt  = new Date().toISOString();
    this.ts         = Date.now();
    this.filename   = `session-${gameId}-${this.ts}.jsonl`;
    this.filepath   = path.join(DATA_DIR, this.filename);
    this.eventCount = 0;
    this.tournamentId = null;

    // Write session header
    this._append({
      type: 'session_start',
      gameId,
      startedAt: this.startedAt,
    });
  }

  linkTournament(tournamentId) {
    this.tournamentId = tournamentId;
    this._append({ type: 'tournament_linked', tournamentId });
  }

  logRamState(state) {
    this.eventCount++;
    this._append({ type: 'ram', t: Date.now(), state });
  }

  logGameEvent(event, state) {
    this._append({ type: 'game_event', t: Date.now(), eventId: event.id, description: event.description, state });
  }

  logScores(scores) {
    this._append({ type: 'scores', t: Date.now(), scores });
  }

  close(reason) {
    this._append({ type: 'session_end', t: Date.now(), reason, eventCount: this.eventCount });
  }

  _append(obj) {
    try {
      fs.appendFileSync(this.filepath, JSON.stringify(obj) + '\n');
    } catch (e) {
      console.warn('[SessionLogger] Write failed:', e.message);
    }
  }
}

class TournamentLogger {
  constructor(tournamentId, opts = {}) {
    ensureDataDir();
    this.tournamentId = tournamentId;
    this.filename     = `tournament-${tournamentId}.json`;
    this.filepath     = path.join(DATA_DIR, this.filename);

    // Initialize tournament data file
    this.data = {
      tournamentId,
      gameId:     opts.gameId,
      mode:       opts.mode,
      entryFee:   opts.entryFee,
      currency:   opts.currency,
      players:    opts.players || [],
      createdAt:  new Date().toISOString(),
      state:      'CREATED',
      events:     [],
      scores:     {},
      result:     null,
    };
    this._flush();
  }

  update(fields) {
    Object.assign(this.data, fields);
    this._flush();
  }

  addEvent(event) {
    this.data.events.push({ t: Date.now(), ...event });
    this._flush();
  }

  updateScores(scores) {
    this.data.scores = scores;
    this._flush();
  }

  complete(result) {
    this.data.state  = 'COMPLETE';
    this.data.result = result;
    this.data.completedAt = new Date().toISOString();
    this._flush();
  }

  _flush() {
    try {
      fs.writeFileSync(this.filepath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn('[TournamentLogger] Write failed:', e.message);
    }
  }
}

module.exports = { SessionLogger, TournamentLogger, DATA_DIR };
