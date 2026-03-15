const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipx', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  getVideoInfo: (filePath) => ipcRenderer.invoke('get-video-info', filePath),
  chooseOutputPath: (defaultName) => ipcRenderer.invoke('choose-output-path', defaultName),
  exportClip: (params) => ipcRenderer.invoke('export-clip', params),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  showInExplorer: (filePath) => ipcRenderer.invoke('show-in-explorer', filePath),
  openXPost: () => ipcRenderer.invoke('open-x-post'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getDetectedEncoder: () => ipcRenderer.invoke('get-detected-encoder'),
  extractWaveform: (params) => ipcRenderer.invoke('extract-waveform', params),
  onExportProgress: (cb) => ipcRenderer.on('export-progress', (_, val) => cb(val)),
  offExportProgress: () => ipcRenderer.removeAllListeners('export-progress'),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  saveProject: (data) => ipcRenderer.invoke('save-project', data),
  loadProject: () => ipcRenderer.invoke('load-project')
});
