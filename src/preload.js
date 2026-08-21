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
  setLaunchOnStartup: (data) => ipcRenderer.send('set-launch-on-startup', data),

  // IPC invokes (can return data)
  loadAccounts: () => ipcRenderer.invoke('load-accounts'),
  loadEmoticons: () => ipcRenderer.invoke('load-emoticons'),
  loadMessageHistory: (data) => ipcRenderer.invoke('load-message-history', data),
  discoverRooms: (data) => ipcRenderer.invoke('discover-rooms', data),
  checkUpdate: () => ipcRenderer.invoke('check-update'),

  // EVE Online character management
  eveLinkCharacter: (data) => ipcRenderer.invoke('eve-link-character', data),
  eveUnlinkCharacter: (data) => ipcRenderer.invoke('eve-unlink-character', data),
  eveGetCharacters: (data) => ipcRenderer.invoke('eve-get-characters', data),
  eveGetSystems: (data) => ipcRenderer.invoke('eve-get-systems', data),
  eveGetSystemByName: (data) => ipcRenderer.invoke('eve-get-system-by-name', data),
  eveLoadRegionMap: (data) => ipcRenderer.invoke('eve-load-region-map', data),
  eveLoadRegionById: (data) => ipcRenderer.invoke('eve-load-region-by-id', data),
  eveGetRegionConnections: (data) => ipcRenderer.invoke('eve-get-region-connections', data),
  eveGetAllRegions: () => ipcRenderer.invoke('eve-get-all-regions'),
  eveSearchUniverse: (data) => ipcRenderer.invoke('eve-search-universe', data),
  eveGetWallet: (data) => ipcRenderer.invoke('eve-get-wallet', data),
  eveSetAutopilot: (data) => ipcRenderer.invoke('eve-set-autopilot', data),
  eveGetAutopilotWaypoint: (data) => ipcRenderer.invoke('eve-get-autopilot-waypoint', data),
  onEveCharacterLinked: (callback) => ipcRenderer.on('eve-character-linked', callback),
  onEveLocationUpdate: (callback) => ipcRenderer.on('eve-location-update', callback),

  // EVE Intel Channel Parser
  eveDetectLogsFolder: () => ipcRenderer.invoke('eve-detect-logs-folder'),
  eveGetIntelChannels: (data) => ipcRenderer.invoke('eve-get-intel-channels', data),
  eveReadIntelChannel: (data) => ipcRenderer.invoke('eve-read-intel-channel', data),
  validateNeutralName: (data) => ipcRenderer.invoke('validate-neutral-name', data),
  getNeutralValidation: (data) => ipcRenderer.invoke('get-neutral-validation', data),
  onEveIntelUpdate: (callback) => ipcRenderer.on('eve-intel-update', callback),
});
