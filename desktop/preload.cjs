'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dswhale', {
  invoke: (action, payload) => ipcRenderer.invoke('dswhale:action', action, payload),
  onState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('dswhale:state', listener);
    return () => ipcRenderer.removeListener('dswhale:state', listener);
  },
});
