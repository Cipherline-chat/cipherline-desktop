'use strict';
// Preload for the PATTERN window only. contextIsolation + sandbox stay ON, like the real app.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('matrix', {
  stat: (counter, tMs) => ipcRenderer.send('pattern-stat', counter, tMs),
});
