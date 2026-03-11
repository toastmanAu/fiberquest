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
  // Config
  config: () => ipcRenderer.invoke('config:get'),
});
