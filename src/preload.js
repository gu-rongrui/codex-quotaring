const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexBalance', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  openUsage: () => ipcRenderer.invoke('app:open-usage'),
  togglePanel: () => ipcRenderer.invoke('app:toggle-panel'),
  hidePanel: () => ipcRenderer.invoke('app:hide-panel'),
  showSettingsPanel: () => ipcRenderer.invoke('app:show-settings-panel'),
  openSettingsPage: () => ipcRenderer.invoke('app:show-settings-panel'),
  hideSettingsPage: () => ipcRenderer.invoke('app:hide-settings-page'),
  hideTrayMenu: () => ipcRenderer.invoke('app:hide-tray-menu'),
  quit: () => ipcRenderer.invoke('app:quit'),
  saveConfig: (config) => ipcRenderer.invoke('app:save-config', config),
  onUsageUpdate: (callback) => ipcRenderer.on('usage:update', (_event, payload) => callback(payload)),
  onShowSettings: (callback) => ipcRenderer.on('settings:show', () => callback())
});
