const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('signalTrail', {
  status: () => invoke('recorder:status'),
  start: (settings) => invoke('recorder:start', settings),
  stop: (summary) => invoke('recorder:stop', summary),
  recordEvent: (type, payload) => invoke('recorder:event', type, payload),
  captureScreenshot: (options) => invoke('recorder:capture-screenshot', options),
  saveScreenshotFrame: (frame, metadata) => invoke('recorder:screenshot-frame', frame, metadata),
  cursor: () => invoke('recorder:cursor'),
  activeContext: () => invoke('recorder:active-context'),
  saveVideoChunk: (chunk, metadata) => invoke('recorder:video-chunk', chunk, metadata),
  listSessions: () => invoke('recorder:sessions'),
  getSessionDetail: (id) => invoke('recorder:session-detail', id),
  getDatabase: () => invoke('recorder:database'),
  revealSession: (id) => invoke('recorder:reveal-session', id),
  revealSessionFile: (id, fileKind) => invoke('recorder:reveal-session-file', id, fileKind),
  revealDatabase: () => invoke('recorder:reveal-database'),
  onRecorderEvent: (callback) => {
    const listener = (_event, record) => callback(record);
    ipcRenderer.on('recorder:event-appended', listener);
    return () => ipcRenderer.removeListener('recorder:event-appended', listener);
  }
});
