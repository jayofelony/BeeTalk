const { contextBridge, ipcRenderer } = require('electron');
const { version } = require('../package.json');

// Expose safe APIs to renderer process via contextBridge
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getVersion: () => version,

  // Window controls
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  windowFocus: () => ipcRenderer.send('window-focus'),

  // IPC event listeners - pass through directly to match ipcRenderer.on signature
  onXmppStatus: (callback) => ipcRenderer.on('xmpp-status', callback),
  onXmppRoster: (callback) => ipcRenderer.on('xmpp-roster', callback),
  onXmppMessage: (callback) => ipcRenderer.on('xmpp-message', callback),
  onXmppPresence: (callback) => ipcRenderer.on('xmpp-presence', callback),
  onXmppParticipants: (callback) => ipcRenderer.on('xmpp-participants', callback),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),

  // IPC senders
  xmppConnect: (account) => ipcRenderer.send('xmpp-connect', account),
  xmppDisconnect: (data) => ipcRenderer.send('xmpp-disconnect', data),
  xmppSendMessage: (data) => ipcRenderer.send('xmpp-send-message', data),
  xmppSendPresence: (data) => ipcRenderer.send('xmpp-send-presence', data),
  xmppJoinRoom: (data) => ipcRenderer.send('xmpp-join-room', data),
  xmppLeaveRoom: (data) => ipcRenderer.send('xmpp-leave-room', data),
  saveAccounts: (accounts) => ipcRenderer.send('save-accounts', accounts),
  openLink: (url) => ipcRenderer.send('open-link', url),

  // IPC invokes (can return data)
  loadAccounts: () => ipcRenderer.invoke('load-accounts'),
  loadEmoticons: () => ipcRenderer.invoke('load-emoticons'),
  loadMessageHistory: (data) => ipcRenderer.invoke('load-message-history', data),
  discoverRooms: (data) => ipcRenderer.invoke('discover-rooms', data),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
});
