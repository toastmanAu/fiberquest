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
  // Tournament
  tournament: {
    create:    (opts)          => ipcRenderer.invoke('tournament:create', opts),
    addPlayer: (tId, pId, name) => ipcRenderer.invoke('tournament:addPlayer', tId, pId, name),
    markPaid:  (tId, pId)      => ipcRenderer.invoke('tournament:markPaid', tId, pId),
    status:    (tId)           => ipcRenderer.invoke('tournament:status', tId),
    end:       (tId)           => ipcRenderer.invoke('tournament:end', tId),
    sendPayout: (tId, inv)     => ipcRenderer.invoke('tournament:sendPayout', tId, inv),
    onEvent:   (cb)            => ipcRenderer.on('tournament:event', (_, data) => cb(data)),
  },
  // Games
  games: {
    list: () => ipcRenderer.invoke('games:list'),
  },
  // Config
  config: () => ipcRenderer.invoke('config:get'),
});
