/**
 * The bridge src/components/WindowControls.tsx looks for.
 *
 * It is deliberately tiny: the UI gets exactly four ways to affect the window and no
 * access to Node, the file system or IPC in general.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulanDesktop', {
  minimize: () => ipcRenderer.send('pulan:window', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('pulan:window', 'toggle-maximize'),
  close: () => ipcRenderer.send('pulan:window', 'close'),
  isMaximized: () => ipcRenderer.invoke('pulan:window:is-maximized'),
  onMaximizedChange: (listener) => {
    ipcRenderer.on('pulan:window:maximized', (_event, maximized) => listener(maximized));
  },
});
