'use strict'

/**
 * fiber-setup.js — Detect local Fiber nodes and CKB nodes for FiberQuest
 *
 * Detection strategy (Fiber):
 *  1. Running processes  — pgrep fnn, parse --config arg
 *  2. Common RPC ports   — probe 8226/8227 and any discovered ports
 *  3. ckb-access layout  — ~/.fiber[-mainnet|-testnet]/bin/fnn
 *  4. Binary in PATH     — which fnn
 *  5. Common manual dirs — ~/fnn, ~/fiber, /opt/fiber, etc.
 *  6. Systemd services   — systemctl --user list-units *fiber* *fnn*
 *
 * Detection strategy (CKB node):
 *  1. Running processes  — pgrep ckb / ckb-light-client
 *  2. Common RPC ports   — probe 8114 (full node default), 9000 (light default)
 *  3. Common install dirs
 *  4. Binary in PATH
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const { execSync, spawnSync, spawn } = require('child_process')

// ── Constants ─────────────────────────────────────────────────────────────────

const HOME = os.homedir()

// ckb-access known prefixes + service names (also scans ALL ~/.fiber* dirs below)
const CKB_ACCESS_PREFIXES = ['.fiber', '.fiber-testnet', '.fiber-mainnet']
const CKB_ACCESS_SERVICES = { '.fiber': 'fiber', '.fiber-testnet': 'fiber-testnet', '.fiber-mainnet': 'fiber-mainnet' }

/**
 * Return all ~/.fiber* directories that contain bin/fnn.
 * This covers ckb-access layouts AND any custom name like ~/.fiber-dt, ~/.fiber-pi, etc.
 */
function globFiberDirs () {
  try {
    return fs.readdirSync(HOME)
      .filter(name => name.startsWith('.fiber'))
      .map(name => path.join(HOME, name))
      .filter(dir => fs.existsSync(path.join(dir, 'bin', 'fnn')))
  } catch { return [] }
}

// Common manual install directories (relative to HOME or absolute)
const FIBER_SEARCH_DIRS = [
  path.join(HOME, 'fnn'),
  path.join(HOME, 'fiber'),
  path.join(HOME, '.local', 'share', 'fnn'),
  '/opt/fiber',
  '/opt/fnn',
  '/usr/local/share/fnn',
]

// Default Fiber RPC ports (testnet=8226, mainnet=8227)
const FIBER_DEFAULT_PORTS = [8226, 8227, 8228, 8229]

// CKB node binary names and default ports
const CKB_FULL_PORTS   = [8114, 8115]
const CKB_LIGHT_PORTS  = [9000, 9001, 8116]

// ── RPC probe helpers ─────────────────────────────────────────────────────────

async function probeRpc (url, method = 'get_node_info', timeout = 1500) {
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 1 }),
      signal:  AbortSignal.timeout(timeout),
    })
    const json = await res.json()
    return json.result || null
  } catch {
    return null
  }
}

async function probeCkbRpc (url, timeout = 1500) {
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', method: 'get_blockchain_info', params: [], id: 1 }),
      signal:  AbortSignal.timeout(timeout),
    })
    const json = await res.json()
    return json.result || null
  } catch {
    return null
  }
}

// ── Process detection ─────────────────────────────────────────────────────────

/**
 * Find running fnn processes and extract their --config paths.
 * Returns array of { pid, configPath }
 */
function findRunningFnnProcesses () {
  const results = []
  try {
    // pgrep -a returns "PID cmdline"
    const out = execSync('pgrep -a fnn 2>/dev/null || true', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim()
    for (const line of out.split('\n').filter(Boolean)) {
      const [pid, ...args] = line.split(/\s+/)
      const configIdx = args.indexOf('--config')
      const configPath = configIdx >= 0 ? args[configIdx + 1] : null
      results.push({ pid: parseInt(pid), configPath })
    }
  } catch {}
  return results
}

function findRunningCkbProcesses () {
  const results = []
  try {
    const out = execSync('pgrep -a "^ckb$|^ckb-light-client$" 2>/dev/null || pgrep -af "ckb " 2>/dev/null || true',
      { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim()
    for (const line of out.split('\n').filter(Boolean)) {
      const [pid, ...args] = line.split(/\s+/)
      const binary = args[0] || ''
      const isLight = binary.includes('light-client') || args.includes('light-client')
      results.push({ pid: parseInt(pid), isLight, args })
    }
  } catch {}
  return results
}

// ── Config file parsers ───────────────────────────────────────────────────────

function parseYamlField (content, field) {
  const re = new RegExp(`^\\s*${field}:\\s*["']?([^"'\\n]+)["']?`, 'm')
  const m  = content.match(re)
  return m ? m[1].trim() : null
}

/**
 * Parse fnn config.yml — returns { rpcAddr, network, p2pAddr }
 */
function parseFnnConfig (configPath) {
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    // RPC section — find listening_addr that looks like host:port (not /ip4/... p2p)
    const rpcSection = content.match(/^rpc:[\s\S]*?listening_addr:\s*["']?([\d.]+:\d+)["']?/m)
    const rpcAddr  = rpcSection ? rpcSection[1] : null
    const network  = parseYamlField(content, 'chain')
    const p2pMatch = content.match(/listening_addr:\s*["']?(\/ip4[^"'\n]+)["']?/)
    const p2pAddr  = p2pMatch ? p2pMatch[1] : null
    return { rpcAddr, network, p2pAddr }
  } catch {
    return {}
  }
}

/**
 * Parse CKB full node config (ckb.toml) — returns { rpcAddr, network }
 */
function parseCkbToml (tomlPath) {
  try {
    const content = fs.readFileSync(tomlPath, 'utf8')
    const listenMatch = content.match(/listen_address\s*=\s*["']([^"']+)["']/)
    const rpcAddr     = listenMatch ? listenMatch[1].replace('tcp://', '') : null
    const chainMatch  = content.match(/chain\s*=\s*["']([^"']+)["']/)
    const network     = chainMatch ? chainMatch[1] : null
    return { rpcAddr, network }
  } catch {
    return {}
  }
}

// ── Systemd helpers ───────────────────────────────────────────────────────────

function isServiceActive (name) {
  try { execSync(`systemctl --user is-active ${name}`, { stdio: 'pipe' }); return true }
  catch { return false }
}

function findFiberServices () {
  try {
    const out = execSync('systemctl --user list-units --type=service --all --no-pager --plain 2>/dev/null | grep -i "fnn\\|fiber" || true',
      { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] })
    return out.split('\n')
      .filter(Boolean)
      .map(line => line.split(/\s+/)[0].replace('.service',''))
      .filter(Boolean)
  } catch { return [] }
}

// ── Binary path search ────────────────────────────────────────────────────────

function findBinary (name) {
  try {
    const result = execSync(`which ${name} 2>/dev/null || true`, { encoding: 'utf8' }).trim()
    return result || null
  } catch { return null }
}

function findBinaryInDirs (name, dirs) {
  for (const dir of dirs) {
    const candidates = [
      path.join(dir, name),
      path.join(dir, 'bin', name),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

// ── Config file search ────────────────────────────────────────────────────────

function findFnnConfig (startDir) {
  const candidates = [
    path.join(startDir, 'config.yml'),
    path.join(startDir, 'data', 'config.yml'),
    path.join(startDir, 'config', 'config.yml'),
  ]
  return candidates.find(p => fs.existsSync(p)) || null
}

// ── Main detection functions ──────────────────────────────────────────────────

/**
 * Detect all available local Fiber (fnn) nodes.
 *
 * Each result:
 * {
 *   source:    'process' | 'ckb-access' | 'port-probe' | 'binary-search',
 *   prefix:    '.fiber-testnet' | null,
 *   installDir: '/home/user/.fiber-testnet' | null,
 *   configPath: '/home/user/.fiber-testnet/data/config.yml' | null,
 *   rpcAddr:   '127.0.0.1:8226',
 *   rpcUrl:    'http://127.0.0.1:8226',
 *   network:   'testnet' | 'mainnet' | null,
 *   installed:  true,
 *   running:    false,
 *   reachable:  true,
 *   nodeInfo:   { ... } | null,
 *   service:    'fiber-testnet' | null,
 * }
 */
async function detectFiberNodes () {
  const seen   = new Set()   // deduplicate by rpcUrl
  const nodes  = []

  function addNode (node) {
    const key = node.rpcUrl || `${node.installDir}`
    if (seen.has(key)) return
    seen.add(key)
    nodes.push(node)
  }

  // ── 1. Running processes ────────────────────────────────────────────────────
  const procs = findRunningFnnProcesses()
  for (const { pid, configPath } of procs) {
    const cfg     = configPath ? parseFnnConfig(configPath) : {}
    const rpcAddr = cfg.rpcAddr || null
    const rpcUrl  = rpcAddr ? `http://${rpcAddr}` : null
    const nodeInfo = rpcUrl ? await probeRpc(rpcUrl) : null
    addNode({
      source:     'process',
      pid,
      prefix:     null,
      installDir: configPath ? path.dirname(path.dirname(configPath)) : null,
      configPath: configPath || null,
      rpcAddr,
      rpcUrl,
      network:    cfg.network || null,
      installed:  true,
      running:    true,
      reachable:  !!nodeInfo,
      nodeInfo,
      service:    null,
    })
  }

  // ── 2. All ~/.fiber* directories (ckb-access + any custom naming) ───────────
  const fiberDirs = globFiberDirs()
  for (const installDir of fiberDirs) {
    const prefix     = path.basename(installDir)
    const configPath = path.join(installDir, 'data', 'config.yml')
    const cfg        = fs.existsSync(configPath) ? parseFnnConfig(configPath) : {}
    // Service name: known prefixes use known names, others derive from prefix
    const service    = CKB_ACCESS_SERVICES[prefix] || prefix.replace(/^\./, '')
    const running    = isServiceActive(service)
    const network    = cfg.network ||
                       (prefix.includes('testnet') ? 'testnet' : prefix.includes('mainnet') ? 'mainnet' : null)
    const rpcAddr    = cfg.rpcAddr || `127.0.0.1:${network === 'testnet' ? 8226 : 8227}`
    const rpcUrl     = `http://${rpcAddr}`
    const nodeInfo   = await probeRpc(rpcUrl)

    addNode({
      source:     'ckb-access',
      prefix,
      installDir,
      configPath: fs.existsSync(configPath) ? configPath : null,
      rpcAddr,
      rpcUrl,
      network,
      installed:  true,
      running,
      reachable:  !!nodeInfo,
      nodeInfo,
      service,
    })
  }

  // ── 3. Probe common ports (catches any running fnn regardless of install method) ──
  for (const port of FIBER_DEFAULT_PORTS) {
    for (const host of ['127.0.0.1', 'localhost']) {
      const rpcUrl  = `http://${host}:${port}`
      const nodeInfo = await probeRpc(rpcUrl)
      if (!nodeInfo) continue
      addNode({
        source:     'port-probe',
        prefix:     null,
        installDir: null,
        configPath: null,
        rpcAddr:    `${host}:${port}`,
        rpcUrl,
        network:    port === 8226 ? 'testnet' : port === 8227 ? 'mainnet' : null,
        installed:  true,
        running:    true,
        reachable:  true,
        nodeInfo,
        service:    null,
      })
    }
  }

  // ── 4. Binary search (installed but not running) ────────────────────────────
  const fnnBin = findBinary('fnn') || findBinaryInDirs('fnn', FIBER_SEARCH_DIRS)
  if (fnnBin) {
    // Try to find a config near the binary
    const binDir    = path.dirname(fnnBin)
    const baseDir   = path.dirname(binDir) // parent of bin/
    const configPath = findFnnConfig(baseDir) || findFnnConfig(binDir)
    const cfg        = configPath ? parseFnnConfig(configPath) : {}
    const rpcAddr    = cfg.rpcAddr || '127.0.0.1:8227'
    const rpcUrl     = `http://${rpcAddr}`
    const nodeInfo   = await probeRpc(rpcUrl)
    // Find any related systemd service
    const services   = findFiberServices()
    const service    = services[0] || null
    const running    = service ? isServiceActive(service) : false

    addNode({
      source:     'binary-search',
      prefix:     null,
      installDir: baseDir,
      configPath,
      rpcAddr,
      rpcUrl,
      network:    cfg.network || null,
      installed:  true,
      running,
      reachable:  !!nodeInfo,
      nodeInfo,
      service,
    })
  }

  // ── 5. Systemd services not yet found ──────────────────────────────────────
  const allServices = findFiberServices()
  for (const svc of allServices) {
    const running = isServiceActive(svc)
    if (!running) continue
    // Service is active but we haven't detected it yet — probe likely ports
    for (const port of FIBER_DEFAULT_PORTS) {
      const rpcUrl  = `http://127.0.0.1:${port}`
      const nodeInfo = await probeRpc(rpcUrl)
      if (!nodeInfo) continue
      addNode({
        source:     'systemd',
        prefix:     null,
        installDir: null,
        configPath: null,
        rpcAddr:    `127.0.0.1:${port}`,
        rpcUrl,
        network:    port === 8226 ? 'testnet' : port === 8227 ? 'mainnet' : null,
        installed:  true,
        running:    true,
        reachable:  true,
        nodeInfo,
        service:    svc,
      })
      break
    }
  }

  return nodes
}

/**
 * Detect local CKB nodes (full node + light client).
 *
 * Each result:
 * {
 *   type:      'full' | 'light',
 *   source:    'process' | 'port-probe' | 'binary-search',
 *   rpcUrl:    'http://127.0.0.1:8114',
 *   network:   'testnet' | 'mainnet' | null,
 *   running:   true,
 *   reachable: true,
 *   info:      { chain, is_initial_block_download, ... } | null,
 * }
 */
async function detectCkbNodes () {
  const seen  = new Set()
  const nodes = []

  function addNode (node) {
    const key = node.rpcUrl
    if (seen.has(key)) return
    seen.add(key)
    nodes.push(node)
  }

  // ── 1. Running processes ────────────────────────────────────────────────────
  const procs = findRunningCkbProcesses()
  for (const { pid, isLight } of procs) {
    const ports    = isLight ? CKB_LIGHT_PORTS : CKB_FULL_PORTS
    for (const port of ports) {
      const rpcUrl = `http://127.0.0.1:${port}`
      const info   = await probeCkbRpc(rpcUrl)
      if (!info) continue
      addNode({
        type:      isLight ? 'light' : 'full',
        source:    'process',
        pid,
        rpcUrl,
        network:   info.chain?.includes('testnet') ? 'testnet' : info.chain?.includes('mainnet') ? 'mainnet' : null,
        running:   true,
        reachable: true,
        info,
      })
      break
    }
  }

  // ── 2. Probe common CKB ports ───────────────────────────────────────────────
  for (const [ports, type] of [[CKB_FULL_PORTS, 'full'], [CKB_LIGHT_PORTS, 'light']]) {
    for (const port of ports) {
      const rpcUrl = `http://127.0.0.1:${port}`
      const info   = await probeCkbRpc(rpcUrl)
      if (!info) continue
      addNode({
        type,
        source:    'port-probe',
        rpcUrl,
        network:   info.chain?.includes('testnet') ? 'testnet' : info.chain?.includes('mainnet') ? 'mainnet' : null,
        running:   true,
        reachable: true,
        info,
      })
    }
  }

  // ── 3. Binary in PATH / common dirs (installed but not running) ─────────────
  for (const [bin, type] of [['ckb', 'full'], ['ckb-light-client', 'light']]) {
    const binPath = findBinary(bin)
    if (!binPath) continue
    const ports   = type === 'full' ? CKB_FULL_PORTS : CKB_LIGHT_PORTS
    const rpcUrl  = `http://127.0.0.1:${ports[0]}`
    addNode({
      type,
      source:    'binary-search',
      binPath,
      rpcUrl,
      network:   null,
      running:   false,
      reachable: false,
      info:      null,
    })
  }

  return nodes
}

/**
 * Pick the best Fiber node for FiberQuest (prefer reachable testnet).
 */
function pickBestFiberNode (nodes) {
  if (!nodes.length) return null
  return (
    nodes.find(n => n.reachable && n.network === 'testnet') ||
    nodes.find(n => n.reachable) ||
    nodes.find(n => n.running   && n.network === 'testnet') ||
    nodes.find(n => n.running) ||
    nodes.find(n => n.network === 'testnet') ||
    nodes[0]
  )
}

/**
 * Pick the best CKB node for the agent wallet / ChainStore.
 * Falls back to public testnet endpoint if nothing local is found.
 */
function pickBestCkbNode (nodes) {
  const local =
    nodes.find(n => n.reachable && n.network === 'testnet' && n.type === 'light') ||
    nodes.find(n => n.reachable && n.network === 'testnet') ||
    nodes.find(n => n.reachable) ||
    null
  return local
    ? { rpcUrl: local.rpcUrl, source: local.source, type: local.type, network: local.network }
    : { rpcUrl: 'https://testnet.ckbapp.dev/', source: 'public', type: 'public', network: 'testnet' }
}

/**
 * Run full detection for both Fiber and CKB nodes.
 * Returns { fiber: [...], ckb: [...], bestFiber, bestCkb }
 */
async function detectAll () {
  const [fiber, ckb] = await Promise.all([detectFiberNodes(), detectCkbNodes()])
  return {
    fiber,
    ckb,
    bestFiber: pickBestFiberNode(fiber),
    bestCkb:   pickBestCkbNode(ckb),
  }
}

// ── Service management ────────────────────────────────────────────────────────

function startNodeService (node) {
  if (!node.service) return { ok: false, error: 'No systemd service associated with this node' }
  try {
    execSync(`systemctl --user start ${node.service}`, { stdio: 'pipe' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function launchInstaller () {
  const cmd = `bash <(curl -fsSL https://raw.githubusercontent.com/toastmanAu/ckb-access/main/fiber/install.sh)`
  const terminals = [
    ['gnome-terminal', ['--', 'bash', '-c', `${cmd}; exec bash`]],
    ['xterm',          ['-e', `bash -c '${cmd}; exec bash'`]],
    ['konsole',        ['--noclose', '-e', 'bash', '-c', cmd]],
    ['xfce4-terminal', ['-e', `bash -c '${cmd}; exec bash'`]],
  ]
  for (const [bin, args] of terminals) {
    try {
      execSync(`which ${bin}`, { stdio: 'pipe' })
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true, terminal: bin, pid: child.pid }
    } catch {}
  }
  return {
    ok:    false,
    error: `No terminal emulator found.\n\nInstall manually:\n${cmd}`,
  }
}

// Legacy export names for backward compat with existing main.js calls
const detectFiberNodes_  = detectFiberNodes
const pickBestNode       = pickBestFiberNode

module.exports = {
  detectFiberNodes,
  detectCkbNodes,
  detectAll,
  pickBestNode,
  pickBestFiberNode,
  pickBestCkbNode,
  startNodeService,
  launchInstaller,
}
