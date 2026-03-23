/**
 * Electron preload — exposes safe IPC bridge to renderer
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fiberquest', {
  // Fiber
  fiber: {
    nodeInfo:     ()           => ipcRenderer.invoke('fiber:nodeInfo'),
    listChannels: ()           => ipcRenderer.invoke('fiber:listChannels'),
    listPayments: (params)     => ipcRenderer.invoke('fiber:listPayments', params),
    newInvoice:   (amt, desc)  => ipcRenderer.invoke('fiber:newInvoice', amt, desc),
    sendPayment:  (invoice)    => ipcRenderer.invoke('fiber:sendPayment', invoice),
    rpc:          (m, p)       => ipcRenderer.invoke('fiber:rpc', m, p),
  },
  // Game
  game: {
    status: () => ipcRenderer.invoke('game:status'),
  },
  // Service health checks
  health: {
    retroarch:      () => ipcRenderer.invoke('retroarch:ping'),
    channelSummary: () => ipcRenderer.invoke('fiber:channelSummary'),
  },
  // Tournament
  tournament: {
    create:       (opts)               => ipcRenderer.invoke('tournament:create', opts),
    addPlayer:    (tId, pId, name)     => ipcRenderer.invoke('tournament:addPlayer', tId, pId, name),
    buildPayTx:   (tId, pId, addr)     => ipcRenderer.invoke('tournament:buildPlayerPayTx', tId, pId, addr),
    markPaid:     (tId, pId)           => ipcRenderer.invoke('tournament:markPaid', tId, pId),
    status:       (tId)                => ipcRenderer.invoke('tournament:status', tId),
    end:          (tId)                => ipcRenderer.invoke('tournament:end', tId),
    sendPayout:   (tId, inv)           => ipcRenderer.invoke('tournament:sendPayout', tId, inv),
    onEvent:      (cb)                 => ipcRenderer.on('tournament:event', (_, data) => cb(data)),
  },
  // Games
  games: {
    list: () => ipcRenderer.invoke('games:list'),
  },
  // RetroArch
  retroarch: {
    isLocal:     ()       => ipcRenderer.invoke('retroarch:isLocal'),
    check:       ()       => ipcRenderer.invoke('retroarch:check'),
    install:     (method) => ipcRenderer.invoke('retroarch:install', method),
    pickRomsDir: ()       => ipcRenderer.invoke('retroarch:pickRomsDir'),
    launch:      (gameId) => ipcRenderer.invoke('retroarch:launch', gameId),
    showMsg:     (msg)    => ipcRenderer.invoke('retroarch:showMsg', msg),
  },
  // Tournament controller assignment
  controllerMap: {
    set: (tId, map) => ipcRenderer.invoke('tournament:setControllerMap', tId, map),
  },
  // Auto-updater
  updater: {
    check:    ()   => ipcRenderer.invoke('update:check'),
    install:  ()   => ipcRenderer.invoke('update:install'),
    onEvent:  (cb) => ipcRenderer.on('update:event', (_, data) => cb(data)),
  },
  // Config
  config: {
    get:      ()        => ipcRenderer.invoke('config:get'),
    save:     (updates) => ipcRenderer.invoke('config:save', updates),
    defaults: ()        => ipcRenderer.invoke('config:defaults'),
  },
  // Agent — CKB on-chain wallet
  agent: {
    setKey:   (key)  => ipcRenderer.invoke('agent:setKey', key),
    clearKey: ()     => ipcRenderer.invoke('agent:clearKey'),
    status:   ()     => ipcRenderer.invoke('agent:status'),
  },
  // Chain — tournament discovery
  chain: {
    scan: () => ipcRenderer.invoke('chain:scan'),
  },
  // QR code generation
  qr: {
    generate: (text) => ipcRenderer.invoke('qr:generate', text),
  },
});
