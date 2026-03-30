'use strict'

/**
 * tx-logger.js — Transaction audit log for FiberQuest
 *
 * Logs every chain transaction with: timestamp, type, txHash,
 * status, cell data, addresses involved. Written to a JSON lines
 * file for post-mortem debugging.
 */

const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(process.env.HOME || '.', '.fiberquest-logs')
const LOG_FILE = path.join(LOG_DIR, `tx-log-${new Date().toISOString().slice(0,10)}.jsonl`)

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

function log (entry) {
  const record = {
    ts: new Date().toISOString(),
    ...entry,
  }
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n')
  } catch (e) {
    console.error('[TxLog] Write failed:', e.message)
  }
  // Also log to console for live visibility
  const emoji = record.status === 'success' ? '✅' : record.status === 'error' ? '❌' : '📝'
  console.log(`[TxLog] ${emoji} ${record.type} ${record.txHash?.slice(0, 16) || ''} ${record.status || ''} ${record.detail || ''}`)
}

module.exports = {
  // Tournament cell operations
  tournamentCreated (txHash, tournamentId, data) {
    log({ type: 'TC_CREATE', txHash, tournamentId, status: 'submitted', cellData: summarize(data) })
  },
  tournamentUpdated (txHash, tournamentId, newState, data) {
    log({ type: 'TC_UPDATE', txHash, tournamentId, status: 'submitted', newState, cellData: summarize(data) })
  },
  tournamentUpdateFailed (tournamentId, newState, error) {
    log({ type: 'TC_UPDATE', tournamentId, status: 'error', newState, error: error?.message || String(error) })
  },

  // Intent cells
  intentCreated (txHash, tournamentId, playerAddress) {
    log({ type: 'INTENT_CREATE', txHash, tournamentId, status: 'submitted', playerAddress })
  },
  intentConsumed (txHash, tournamentId, playerAddress) {
    log({ type: 'INTENT_CONSUME', txHash, tournamentId, status: 'submitted', playerAddress })
  },

  // Score cells
  scoreSubmitted (txHash, tournamentId, playerId, score, destAddress) {
    log({ type: 'SCORE_SUBMIT', txHash, tournamentId, status: 'submitted', playerId, score, destAddress })
  },
  scoreSubmitFailed (tournamentId, playerId, score, error) {
    log({ type: 'SCORE_SUBMIT', tournamentId, status: 'error', playerId, score, error: error?.message || String(error) })
  },
  scoreFound (tournamentId, playerId, score, source) {
    log({ type: 'SCORE_FOUND', tournamentId, status: 'found', playerId, score, source })
  },

  // Score scan results
  scoreScanResult (tournamentId, found, total, orgAddr, ownAddr) {
    log({ type: 'SCORE_SCAN', tournamentId, status: 'scanned', found, totalCellsSearched: total, organizerAddress: orgAddr?.slice(0, 30), ownAddress: ownAddr?.slice(0, 30) })
  },

  // Deposits / payments
  depositSubmitted (txHash, tournamentId, playerId, amount, fromAddress, toAddress) {
    log({ type: 'DEPOSIT', txHash, tournamentId, status: 'submitted', playerId, amount, fromAddress, toAddress })
  },

  // Confirmation
  txConfirmed (txHash, blockNumber) {
    log({ type: 'TX_CONFIRM', txHash, status: 'success', blockNumber })
  },
  txTimeout (txHash, waitedMs) {
    log({ type: 'TX_CONFIRM', txHash, status: 'timeout', waitedMs })
  },

  // Settlement
  winnerResolved (tournamentId, winnerId, winnerScore, allScores) {
    log({ type: 'WINNER_RESOLVED', tournamentId, status: 'success', winnerId, winnerScore, allScores })
  },
  payoutSent (txHash, tournamentId, winnerId, amount) {
    log({ type: 'PAYOUT', txHash, tournamentId, status: 'submitted', winnerId, amount })
  },

  // UTXO operations
  cellSplit (txHash, inputCount, outputCount) {
    log({ type: 'CELL_SPLIT', txHash, status: 'submitted', inputCount, outputCount })
  },

  // Generic
  event (type, detail) {
    log({ type, status: 'info', detail })
  },

  // Read logs
  getLogPath () { return LOG_FILE },
  readLogs (lines = 50) {
    try {
      const content = fs.readFileSync(LOG_FILE, 'utf8')
      return content.trim().split('\n').slice(-lines).map(l => JSON.parse(l))
    } catch (_) { return [] }
  },
}

function summarize (data) {
  if (!data) return null
  return {
    state: data.state,
    players: (data.players || []).map(p => ({ id: p.id, address: p.address?.slice(0, 20), paid: p.paid })),
    organizerAddress: data.organizerAddress?.slice(0, 30),
    registeredPlayers: data.registeredPlayers,
    startBlock: data.startBlock,
    endBlock: data.endBlock,
  }
}
