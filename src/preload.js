const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to renderer process via contextBridge
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getVersion: () => ipcRenderer.invoke('get-version'),

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
  onXmppRoomSubject: (callback) => ipcRenderer.on('xmpp-room-subject', callback),
  onXmppChatState: (callback) => ipcRenderer.on('xmpp-chat-state', callback),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
  onOpenChat: (callback) => ipcRenderer.on('open-chat', callback),
  onAppFocus: (callback) => ipcRenderer.on('app-focus', callback),
  onAppBlur: (callback) => ipcRenderer.on('app-blur', callback),
  onTrayStatus: (callback) => ipcRenderer.on('tray-status', callback),

  // IPC senders
  xmppConnect: (account) => ipcRenderer.send('xmpp-connect', account),
  xmppDisconnect: (data) => ipcRenderer.send('xmpp-disconnect', data),
  xmppSendMessage: (data) => ipcRenderer.send('xmpp-send-message', data),
  xmppSendPresence: (data) => ipcRenderer.send('xmpp-send-presence', data),
  xmppSendChatState: (data) => ipcRenderer.send('xmpp-send-chat-state', data),
  xmppJoinRoom: (data) => ipcRenderer.send('xmpp-join-room', data),
  xmppLeaveRoom: (data) => ipcRenderer.send('xmpp-leave-room', data),
  xmppAddContact: (data) => ipcRenderer.send('xmpp-add-contact', data),
  xmppRemoveContact: (data) => ipcRenderer.send('xmpp-remove-contact', data),
  xmppUpdateContactGroups: (data) => ipcRenderer.send('xmpp-update-contact-groups', data),
  saveAccounts: (accounts) => ipcRenderer.send('save-accounts', accounts),
  openLink: (url) => ipcRenderer.send('open-link', url),
  setLaunchOnStartup: (data) => ipcRenderer.send('set-launch-on-startup', data),
  showNotification: (data) => ipcRenderer.send('show-notification', data),

  // IPC invokes (can return data)
  loadAccounts: () => ipcRenderer.invoke('load-accounts'),
  loadEmoticons: () => ipcRenderer.invoke('load-emoticons'),
  loadMessageHistory: (data) => ipcRenderer.invoke('load-message-history', data),
  discoverRooms: (data) => ipcRenderer.invoke('discover-rooms', data),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
});
