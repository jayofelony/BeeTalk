const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { client, xml } = require('@xmpp/client');
const { isValidJid, isValidMessageType, checkMamSupport, tlsOnlyCredentials, compareVersions } = require('./lib/xmpp-helpers');
const { watchConnection } = require('./lib/connection');
const { unwrapCarbon, chatState, CARBONS, CHATSTATES, CHAT_STATES } = require('./lib/stanzas');
// keytar is only used to migrate passwords saved by older versions; it is optional
let keytar = null;
try { keytar = require('keytar'); } catch {}

const store = new Store();
const KEYTAR_SERVICE = 'BeeTalk';
const GSF_SERVER = 'goonfleet.com';
const GSF_PORT = 5222;
const OLD_KEYTAR_SERVICE = 'Gabber'; // for migration


let mainWindow;
let tray;
let unreadCount = 0;

const connections    = {};  // accountId -> { _xmpp, account }

// Ensure OS-level app identity uses BeeTalk instead of the Electron default name.
app.setName('BeeTalk');


// ─────────────────────────────────────────────
//  Credential Management (safeStorage)
// ─────────────────────────────────────────────
// Passwords are encrypted with the OS keychain (DPAPI / Keychain / libsecret)
// via safeStorage and stored as base64 in electron-store under `passwords`.
function savePassword(accountId, password) {
  if (!safeStorage.isEncryptionAvailable()) {
    console.error(`Cannot save password for ${accountId}: OS encryption unavailable`);
    return false;
  }
  try {
    const passwords = store.get('passwords', {});
    passwords[accountId] = safeStorage.encryptString(password).toString('base64');
    store.set('passwords', passwords);
    return true;
  } catch (err) {
    console.error(`Failed to save password for ${accountId}:`, err);
    return false;
  }
}

async function getPassword(accountId) {
  const encrypted = store.get('passwords', {})[accountId];
  if (encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (err) {
      console.error(`Failed to decrypt password for ${accountId}:`, err);
      return null;
    }
  }
  return migrateKeytarPassword(accountId);
}

// One-time migration from keytar (current and old 'Gabber' service names)
async function migrateKeytarPassword(accountId) {
  if (!keytar) return null;
  for (const service of [KEYTAR_SERVICE, OLD_KEYTAR_SERVICE]) {
    try {
      const password = await keytar.getPassword(service, accountId);
      if (!password) continue;
      console.log(`Migrating password for account ${accountId} from keytar (${service}) to safeStorage...`);
      if (savePassword(accountId, password)) {
        try {
          await keytar.deletePassword(service, accountId);
        } catch (err) {
          console.warn(`Failed to clean up keytar entry for ${accountId}:`, err.message);
        }
      }
      return password;
    } catch (err) {
      console.warn(`Failed to read keytar entry for ${accountId}:`, err.message);
    }
  }
  return null;
}

function deletePassword(accountId) {
  const passwords = store.get('passwords', {});
  if (!(accountId in passwords)) return;
  delete passwords[accountId];
  store.set('passwords', passwords);
}

// ─────────────────────────────────────────────
//  Window
// ─────────────────────────────────────────────
function createWindow() {
  const windowIconPath = process.platform === 'win32'
    ? path.join(__dirname, '../assets/icon.ico')
    : path.join(__dirname, '../assets/icon-linux.png');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    backgroundColor: '#111113',
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false,
    icon: windowIconPath
  });

  // The window only ever shows index.html; links open in the system browser via 'open-link'
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', e => e.preventDefault());

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // When started at login, stay in the tray (Windows passes --hidden, macOS reports it)
  const startHidden = process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  mainWindow.once('ready-to-show', () => { if (!startHidden) mainWindow.show(); });

  mainWindow.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('focus', () => {
    unreadCount = 0;
    tray && tray.setToolTip('BeeTalk');
    send('app-focus');
  });

  mainWindow.on('blur', () => {
    send('app-blur');
  });
}

// ─────────────────────────────────────────────
//  Tray
// ─────────────────────────────────────────────
function createTray() {
  const { nativeImage } = require('electron');
  let icon;
  try { icon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray.png')); }
  catch { icon = nativeImage.createEmpty(); }

  tray = new Tray(icon);
  tray.setToolTip('BeeTalk');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    {
      label: 'Set status', submenu: [
        { label: 'Available',      click: () => send('tray-status', 'available') },
        { label: 'Away',           click: () => send('tray-status', 'away') },
        { label: 'Do Not Disturb', click: () => send('tray-status', 'dnd') },
      ]
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));

  tray.on('click', () => mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus()));
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

// Validation and XMPP helpers live in ./lib/xmpp-helpers.js (unit-tested)
function isDebugMode() {
  return process.env.DEBUG === 'true' || process.env.DEBUG_BEETALK === 'true';
}

// ─────────────────────────────────────────────
//  XMPP connection management
// ─────────────────────────────────────────────

// Cleanly destroy an existing connection without triggering reconnect
async function destroyConnection(id) {
  if (!connections[id]) return;
  const old = connections[id]._xmpp;
  connections[id].watcher?.stop();
  delete connections[id];
  try { old.reconnect.stop(); } catch {}
  try { old.removeAllListeners(); } catch {}
  try { await old.stop(); } catch {}
}

// @xmpp/client instances CANNOT be reused after stop(). Always create fresh.
async function connectXmpp(account) {
  const { id, username, server, port } = account;

  await destroyConnection(id);

  // Retrieve password from encrypted storage
  let password = await getPassword(id);

  if (!password) {
    // Password not stored - this might be an old account with a plaintext password
    console.error(`No password found for account ${id}`);
    console.log(`Account details: username=${username}, server=${server}`);

    // Try getting it from store as fallback (old format)
    const storedAccounts = store.get('accounts', []);
    const storedAccount = storedAccounts.find(acc => acc.id === id);

    if (storedAccount && storedAccount.password) {
      console.log('Found password in old config format, migrating to safeStorage...');
      password = storedAccount.password;
      savePassword(id, password);
      // Remove from plaintext storage
      delete storedAccount.password;
      store.set('accounts', storedAccounts);
    } else {
      send('xmpp-status', {
        id,
        status: 'error',
        error: 'Password not found. Please re-add the account with your password.'
      });
      return;
    }
  }

  console.log(`Connecting to XMPP server for account ${id}...`);

  const xmpp = client({
    service: `xmpp://${server}:${port || 5222}`,
    domain:  server,
    // Called right before SASL: refuse to send the password unless STARTTLS succeeded,
    // so a network attacker stripping the STARTTLS offer can't read it.
    credentials: tlsOnlyCredentials(() => xmpp, { username, password }, () => {
      send('xmpp-status', { id, status: 'error', error: 'Server connection is not encrypted; refusing to send password.' });
      destroyConnection(id);
    })
  });

  connections[id] = { _xmpp: xmpp, account };
  const isCurrent = () => connections[id]?._xmpp === xmpp;
  send('xmpp-status', { id, status: 'connecting' });

  // Reconnect/backoff, resumed sessions and keepalive: see src/lib/connection.js
  const watcher = watchConnection(xmpp, {
    isCurrent,
    onOnline: ({ resumed }) => {
      send('xmpp-status', { id, status: 'online', jid: xmpp.jid.toString(), resumed });
      // A resumed session (XEP-0198) keeps presence, roster, rooms and carbons on the server
      if (resumed) return;
      connections[id].mamSupported = checkMamSupport(xmpp);
      xmpp.send(xml('presence')).catch(() => {});
      xmpp.send(xml('iq', { type: 'get', id: 'roster1' }, xml('query', { xmlns: 'jabber:iq:roster' }))).catch(() => {});
      // Message carbons (XEP-0280): also receive DMs sent/received by our other devices
      xmpp.iqCaller.request(xml('iq', { type: 'set' }, xml('enable', { xmlns: CARBONS })), 10000).catch(() => {});
    },
    onOffline: () => send('xmpp-status', { id, status: 'offline' }),
    onError: error => send('xmpp-status', { id, status: 'error', error }),
    onAuthFail: error => {
      send('xmpp-status', { id, status: 'authfail', error });
      destroyConnection(id);
    }
  });
  connections[id].watcher = watcher;

  xmpp.on('stanza', stanza => handleStanza(id, stanza));
  xmpp.start().catch(watcher.handleError);
}

// outgoing: a message we sent from another device (a "sent" carbon); `from` is then the peer
function handleMessage(accountId, stanza, outgoing) {
  const body = stanza.getChildText('body');
  const subject = stanza.getChildText('subject');
  const type = stanza.attrs.type || 'chat';
  const from = outgoing ? stanza.attrs.to : stanza.attrs.from;
  if (!from) return;
  const senderName = from.split('@')[0];

  // Handle room subject (MOTD) - can come with or without body
  if (type === 'groupchat' && subject) {
    const roomJid = from.split('/')[0];
    send('xmpp-room-subject', { accountId, roomJid, subject });
    if (!body) return;
  }

  // Typing notifications (XEP-0085), DMs only
  const state = type !== 'groupchat' && !outgoing ? chatState(stanza) : null;
  if (state) send('xmpp-chat-state', { accountId, from, state });

  if (!body) return;

  // Get timestamp from delay element if present (history / offline messages), otherwise use now
  let ts = Date.now();
  const delayEl = stanza.getChild('delay', 'urn:xmpp:delay');
  const delayed = !!(delayEl && delayEl.attrs.stamp);
  // For directorbot, don't include timestamps
  if (senderName === 'directorbot') {
    ts = 0;
  } else if (delayed) {
    ts = new Date(delayEl.attrs.stamp).getTime();
  }

  send('xmpp-message', { accountId, from, body, type, ts, delayed, outgoing });

  // Notifications are decided by the renderer (it knows DND, settings and the user's nick)
  if (!delayed && !outgoing && !mainWindow.isFocused()) {
    unreadCount++;
    tray && tray.setToolTip(`BeeTalk (${unreadCount} unread)`);
  }
}

function handleStanza(accountId, stanza) {
  const name = stanza.name;

  if (name === 'iq') {
    const query = stanza.getChild('query', 'jabber:iq:roster');
    // Roster data is only valid from our own server/account (RFC 6120 §8.1.2.1), not other users
    const xmpp = connections[accountId]?._xmpp;
    const from = stanza.attrs.from;
    if (query && from && from !== xmpp?.jid?.bare().toString() && from !== xmpp?.jid?.domain) return;
    if (query) {
      const contacts = query.getChildren('item').map(item => ({
        jid:          item.attrs.jid,
        name:         item.attrs.name || item.attrs.jid.split('@')[0],
        subscription: item.attrs.subscription,
        groups:       item.getChildren('group').map(g => g.getText())
      }));
      send('xmpp-roster', { accountId, contacts });
    }
    return;
  }

  if (name === 'message') {
    const xmpp = connections[accountId]?._xmpp;
    const myBare = xmpp?.jid ? xmpp.jid.bare().toString() : '';
    const carbon = unwrapCarbon(stanza, myBare);
    if (carbon === null) return;  // forged or empty carbon
    if (carbon) {
      // A copy from one of our other devices: DMs only (carbons never cover rooms)
      const type = carbon.message.attrs.type || 'normal';
      if (type === 'chat' || type === 'normal') handleMessage(accountId, carbon.message, carbon.direction === 'sent');
      return;
    }
    handleMessage(accountId, stanza, false);
    return;
  }

  if (name === 'presence') {
    // Extract MUC user jid if available (for non-anonymous rooms)
    let mucJid = null;
    const xEl = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
    if (xEl) {
      const itemEl = xEl.getChild('item');
      if (itemEl && itemEl.attrs.jid) {
        mucJid = itemEl.attrs.jid;
      }
    }
    send('xmpp-presence', {
      accountId,
      from: stanza.attrs.from,
      type: stanza.attrs.type || 'available',
      show: stanza.getChildText('show') || 'available',
      mucJid: mucJid  // actual JID of participant (if available)
    });
    return;
  }
}

// ─────────────────────────────────────────────
//  IPC from renderer
// ─────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close',    () => mainWindow.hide());
ipcMain.on('window-focus',    () => {
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

ipcMain.on('xmpp-connect', (e, account) => {
  // Connect with the stored account, never the renderer's copy, so the renderer
  // can't point a stored password at another server.
  const stored = store.get('accounts', []).find(a => a.id === account?.id);
  if (!stored) return;
  connectXmpp({ ...stored, server: GSF_SERVER, port: GSF_PORT }).catch(err => {
    console.error('Connection error:', err);
    send('xmpp-status', { id: stored.id, status: 'error', error: err.message });
  });
});
ipcMain.on('xmpp-disconnect', (e, { id })  => destroyConnection(id));

ipcMain.on('xmpp-send-message', (e, { accountId, to, body, type }) => {
  const c = connections[accountId];
  if (!c) return;

  // Validate parameters
  if (!isValidJid(to)) {
    console.error(`Invalid JID in xmpp-send-message: ${to}`);
    return;
  }
  if (typeof body !== 'string' || body.trim().length === 0) {
    console.error('Empty message body in xmpp-send-message');
    return;
  }
  const msgType = type || 'chat';
  if (!isValidMessageType(msgType)) {
    console.error(`Invalid message type in xmpp-send-message: ${msgType}`);
    return;
  }

  // Chat messages carry <active/> (XEP-0085): lets the other side know we support typing notifications
  const extra = msgType === 'chat' ? [xml('active', { xmlns: CHATSTATES })] : [];
  c._xmpp.send(xml('message', { to, type: msgType }, xml('body', {}, body), ...extra)).catch(() => {});
});

ipcMain.on('xmpp-send-chat-state', (e, { accountId, to, state }) => {
  const c = connections[accountId];
  if (!c || !isValidJid(to) || !CHAT_STATES.includes(state)) return;
  c._xmpp.send(xml('message', { to, type: 'chat' }, xml(state, { xmlns: CHATSTATES }))).catch(() => {});
});

ipcMain.on('xmpp-send-presence', (e, { accountId, show, status }) => {
  const c = connections[accountId];
  if (!c) return;

  // Validate parameters
  const validShows = ['available', 'away', 'dnd', 'xa', 'chat'];
  if (show && !validShows.includes(show)) {
    console.error(`Invalid presence show value: ${show}`);
    return;
  }
  if (status && typeof status !== 'string') {
    console.error('Status must be a string');
    return;
  }

  const kids = [];
  if (show && show !== 'available') kids.push(xml('show', {}, show));
  if (status) kids.push(xml('status', {}, status));
  c._xmpp.send(xml('presence', {}, ...kids)).catch(() => {});
});


ipcMain.on('xmpp-add-contact', (e, { accountId, jid, name }) => {
  const c = connections[accountId];
  if (!c) return;

  // Validate parameters
  if (!isValidJid(jid)) {
    console.error(`Invalid JID in xmpp-add-contact: ${jid}`);
    return;
  }

  // Send subscription request
  c._xmpp.send(xml('presence', { to: jid, type: 'subscribe' })).catch(() => {});
});

ipcMain.on('xmpp-update-contact-groups', (e, { accountId, jid, name, groups }) => {
  const c = connections[accountId];
  if (!c) return;

  // Validate parameters
  if (!isValidJid(jid)) {
    console.error(`Invalid JID in xmpp-update-contact-groups: ${jid}`);
    return;
  }
  if (!Array.isArray(groups)) {
    console.error('Groups must be an array');
    return;
  }

  // Send roster update IQ with new groups
  const groupElements = groups.map(groupName => xml('group', {}, groupName));
  const item = xml('item', { jid, name: name || jid }, ...groupElements);
  const query = xml('query', { xmlns: 'jabber:iq:roster' }, item);
  const iq = xml('iq', { type: 'set', id: 'roster-' + Date.now() }, query);
  c._xmpp.send(iq).catch(() => {});
});

ipcMain.on('xmpp-remove-contact', (e, { accountId, jid }) => {
  const c = connections[accountId];
  if (!c) return;

  // Validate parameters
  if (!isValidJid(jid)) {
    console.error(`Invalid JID in xmpp-remove-contact: ${jid}`);
    return;
  }

  // Remove from roster with subscription='remove'
  const item = xml('item', { jid, subscription: 'remove' });
  const query = xml('query', { xmlns: 'jabber:iq:roster' }, item);
  const iq = xml('iq', { type: 'set', id: 'roster-' + Date.now() }, query);
  c._xmpp.send(iq).catch(() => {});
  // Send unsubscribe and unsubscribed
  c._xmpp.send(xml('presence', { to: jid, type: 'unsubscribe' })).catch(() => {});
  c._xmpp.send(xml('presence', { to: jid, type: 'unsubscribed' })).catch(() => {});
});


ipcMain.on('xmpp-join-room', (e, { accountId, roomJid, nick, since }) => {
  const c = connections[accountId];
  if (!c) return;

  // Validate parameters
  if (!isValidJid(roomJid)) {
    console.error(`Invalid room JID in xmpp-join-room: ${roomJid}`);
    return;
  }
  if (typeof nick !== 'string' || nick.trim().length === 0) {
    console.error('Invalid nick in xmpp-join-room');
    return;
  }

  // Join history is the only room history goonfleet.com offers (rooms have no
  // archive). Ask for everything since our last message, or the last day on a
  // first join; the server sends at most what it keeps, so the cap is generous.
  const history = typeof since === 'string' && !isNaN(Date.parse(since))
    ? { maxstanzas: '1000', since }
    : { maxstanzas: '1000', seconds: '86400' };
  c._xmpp.send(
    xml('presence', { to: `${roomJid}/${nick}` },
      xml('x', { xmlns: 'http://jabber.org/protocol/muc' },
        xml('history', history)
      )
    )
  ).catch(() => {});
});

ipcMain.on('xmpp-leave-room', (e, { accountId, roomJid, nick }) => {
  const c = connections[accountId];
  if (!c) return;

  // Validate parameters
  if (!isValidJid(roomJid)) {
    console.error(`Invalid room JID in xmpp-leave-room: ${roomJid}`);
    return;
  }
  if (typeof nick !== 'string' || nick.trim().length === 0) {
    console.error('Invalid nick in xmpp-leave-room');
    return;
  }

  c._xmpp.send(xml('presence', { to: `${roomJid}/${nick}`, type: 'unavailable' })).catch(() => {});
});

// Keep references so click handlers survive garbage collection until the notification closes
const activeNotifications = new Set();
ipcMain.on('show-notification', (e, { title, body, chatKey }) => {
  if (typeof title !== 'string' || typeof body !== 'string' || mainWindow.isFocused()) return;
  const n = new Notification({ title: title.slice(0, 100), body: body.slice(0, 120) });
  activeNotifications.add(n);
  n.on('click', () => {
    mainWindow.show();
    mainWindow.focus();
    if (typeof chatKey === 'string') send('open-chat', chatKey);
  });
  n.on('close', () => activeNotifications.delete(n));
  // Unsigned macOS builds can't show notifications (Electron 43+ uses UNNotification)
  n.on('failed', (e, error) => { activeNotifications.delete(n); console.warn('Notification failed:', error); });
  n.show();
});

ipcMain.on('save-accounts', (e, accounts) => {
  // Save passwords encrypted and accounts (without passwords) to store.
  // Kept synchronous so the password is stored before a following xmpp-connect is handled.
  if (!Array.isArray(accounts)) return;
  accounts = accounts.filter(a => a && typeof a.id === 'string' && typeof a.username === 'string');
  for (const account of accounts) {
    account.server = GSF_SERVER;
    account.port = GSF_PORT;
    if (account.password) {
      savePassword(account.id, account.password);
      // Don't store password in plaintext
      delete account.password;
    }
  }
  // Drop passwords of removed accounts
  const ids = new Set(accounts.map(a => a.id));
  for (const id of Object.keys(store.get('passwords', {}))) {
    if (!ids.has(id)) deletePassword(id);
  }
  store.set('accounts', accounts);
});

ipcMain.handle('load-accounts', async () => {
  let accounts = store.get('accounts', []);
  console.log(`Loaded ${accounts.length} accounts from store`);

  // Migrate plaintext passwords from old config to safeStorage
  for (const account of accounts) {
    if (account.password) {
      console.log(`Migrating password for account ${account.id} to safeStorage...`);
      savePassword(account.id, account.password);
      // Remove from plaintext storage
      delete account.password;
    }
  }

  // Drop data left over from the removed EVE features
  for (const account of accounts) delete account.eveCharacters;
  store.delete('eveTokens');
  store.delete('intelCaches');

  // Save the migrated accounts (without passwords)
  store.set('accounts', accounts);
  console.log('Account migration complete');

  // Return accounts without passwords (they stay in encrypted storage)
  return accounts.map(acc => ({ ...acc, password: '' }));
});
ipcMain.on('open-link', (e, url) => {
  // Only allow http and https URLs to prevent file:// and other protocol abuse
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    shell.openExternal(url);
  }
});

ipcMain.on('set-launch-on-startup', (e, { enabled }) => {
  try {
    // On Windows, clean up old "Electron" entry from registry if it exists
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      try {
        execSync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v Electron /f', { stdio: 'ignore' });
      } catch (err) {
        // Entry doesn't exist, that's fine
      }
    }

    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: app.getPath('exe'),
      args: ['--hidden']  // Windows: start in the tray
    });
    console.log(`[App] Launch on startup: ${enabled ? 'enabled' : 'disabled'}`);
  } catch (err) {
    console.error('[App] Error setting launch on startup:', err);
  }
});

ipcMain.handle('load-emoticons', async () => {
  const fs = require('fs');
  const basePath = path.join(__dirname, '../assets/emoticons');
  const emoticonsPerFolder = {};

  function loadEmoticonFolder(folderPath, folderName) {
    const emoticonsInFolder = [];
    const themeFile = path.join(folderPath, 'theme');

    if (fs.existsSync(themeFile)) {
      // Parse theme file
      try {
        const content = fs.readFileSync(themeFile, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          // Skip empty lines, comments, section headers
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
          // Skip hidden emoticons (starting with !)
          if (trimmed.startsWith('!')) continue;

          // Parse: filename    shortcut1   shortcut2   ...
          const parts = trimmed.split(/\s+/).filter(p => p);
          if (parts.length < 2) continue;

          const filename = parts[0];
          const filePath = path.join(folderPath, filename);

          if (!fs.existsSync(filePath)) continue;

          // Use all shortcuts as names
          for (let i = 1; i < parts.length; i++) {
            emoticonsInFolder.push({
              name: parts[i],
              file: filename,
              path: `file://${filePath.replace(/\\/g, '/')}`
            });
          }
        }
      } catch (err) {
        console.error(`Error parsing theme file for ${folderName}:`, err);
      }
    } else {
      // Fallback: use filenames for folders without theme file
      try {
        const files = fs.readdirSync(folderPath);
        for (const file of files) {
          if (/\.(gif|png|jpg|jpeg)$/i.test(file)) {
            const filePath = path.join(folderPath, file);
            emoticonsInFolder.push({
              name: file.replace(/\.[^.]+$/, ''),
              file: file,
              path: `file://${filePath.replace(/\\/g, '/')}`
            });
          }
        }
      } catch (err) {
        console.error(`Error loading emoticons from ${folderName}:`, err);
      }
    }

    if (emoticonsInFolder.length > 0) {
      emoticonsPerFolder[folderName] = emoticonsInFolder.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  function walkFolders(dir, prefix = '') {
    try {
      const items = fs.readdirSync(dir);

      for (const item of items) {
        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);

        if (!stat.isDirectory()) continue;

        // Build folder name with hierarchy
        const folderName = prefix ? `${prefix} > ${item}` : item;

        // Check if this folder has emoticons (theme file or image files)
        const themeFile = path.join(itemPath, 'theme');
        const hasImages = fs.readdirSync(itemPath).some(f => /\.(gif|png|jpg|jpeg)$/i.test(f));

        if (fs.existsSync(themeFile) || hasImages) {
          loadEmoticonFolder(itemPath, folderName);
        }

        // Recursively check subfolders
        walkFolders(itemPath, folderName);
      }
    } catch (err) {
      console.error(`Error walking folders at ${dir}:`, err);
    }
  }

  try {
    walkFolders(basePath);
    return emoticonsPerFolder;
  } catch (err) {
    console.error('Error loading emoticons:', err);
    return {};
  }
});

// Latest DM history from the server archive (XEP-0313 MAM), oldest first
ipcMain.handle('load-message-history', async (e, { accountId, with: withJid, count = 100 }) => {
  const conn = connections[accountId];
  if (!conn || !isValidJid(withJid) || !(await conn.mamSupported)) return [];

  const xmpp = conn._xmpp;
  const myBare = xmpp.jid ? xmpp.jid.bare().toString() : '';
  const queryId = `mam-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const messages = [];

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      xmpp.removeListener('stanza', listener);
      clearTimeout(timeoutHandle);
      resolve(messages);
    };

    function listener(stanza) {
      if (stanza.is('message')) {
        const result = stanza.getChild('result', 'urn:xmpp:mam:2');
        if (!result || result.attrs.queryid !== queryId) return;
        const forwarded = result.getChild('forwarded', 'urn:xmpp:forward:0');
        const msg = forwarded?.getChild('message');
        const body = msg?.getChildText('body');
        if (!body) return;
        const delay = forwarded.getChild('delay', 'urn:xmpp:delay');
        const from = msg.attrs.from || '';
        messages.push({
          text: body,
          ts: delay?.attrs.stamp ? new Date(delay.attrs.stamp).getTime() : Date.now(),
          me: from.split('/')[0] === myBare
        });
      } else if (stanza.is('iq') && stanza.attrs.id === queryId) {
        finish();  // <fin/> result or error: either way the query is over
      }
    }

    xmpp.on('stanza', listener);
    const timeoutHandle = setTimeout(finish, 8000);

    // <before/> with no id asks for the last page, returned in chronological order
    const mamQuery = xml('iq', { type: 'set', id: queryId },
      xml('query', { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
        xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
          xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'urn:xmpp:mam:2')),
          xml('field', { var: 'with' }, xml('value', {}, withJid))
        ),
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
          xml('max', {}, String(Math.min(Number(count) || 100, 500))),
          xml('before')
        )
      )
    );
    xmpp.send(mamQuery).catch(err => {
      console.error('MAM query error:', err);
      finish();
    });
  });
});

async function discoverRoomsOnServer(xmpp, server, timeout = 8000) {
  const rooms = [];
  let cleaned = false;

  return new Promise((resolve) => {
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeoutHandle);
      xmpp.removeListener('stanza', listener);
    }

    function listener(stanza) {
      if (stanza.name !== 'iq') return;
      if (stanza.attrs.type !== 'result') return;
      if (stanza.attrs.id !== queryId) return;

      const query = stanza.getChild('query', 'http://jabber.org/protocol/disco#items');
      if (query) {
        const items = query.getChildren('item');
        if (isDebugMode()) console.log(`Found ${items.length} rooms on ${server}`);

        items.forEach(item => {
          const jid = item.attrs.jid;
          const name = item.attrs.name || jid.split('@')[0];
          if (jid && name && isValidJid(jid)) {
            rooms.push({ jid, name, description: '' });
          }
        });
      }

      cleanup();
      resolve(rooms);
    }

    const queryId = `disco-${Date.now()}-${Math.random()}`;
    const discoQuery = xml(
      'iq',
      { type: 'get', to: server, id: queryId },
      xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' })
    );

    if (isDebugMode()) console.log(`Querying ${server} for available rooms (id: ${queryId})...`);

    const timeoutHandle = setTimeout(() => {
      cleanup();
      if (isDebugMode()) console.log(`Room discovery timeout on ${server}`);
      resolve([]);
    }, timeout);

    xmpp.on('stanza', listener);

    xmpp.send(discoQuery).catch(err => {
      console.error(`Room discovery send error on ${server}:`, err);
      cleanup();
      resolve([]);
    });
  });
}

ipcMain.handle('discover-rooms', async (e, { accountId }) => {
  const conn = connections[accountId];
  if (!conn) {
    if (isDebugMode()) console.log('No connection found for account', accountId);
    return [];
  }

  const xmpp = conn._xmpp;
  const account = conn.account;
  const domain = account.server || GSF_SERVER;

  // Try multiple MUC server variants (derive from account domain, with fallbacks)
  const mucServers = [
    `conference.${domain}`,
    `muc.${domain}`,
    `rooms.${domain}`,
    // Fallback to GSF servers
    'conference.goonfleet.com',
    'muc.goonfleet.com',
    'rooms.goonfleet.com'
  ];

  for (const server of mucServers) {
    if (isDebugMode()) console.log(`Attempting room discovery on ${server}...`);
    const rooms = await discoverRoomsOnServer(xmpp, server, 8000);

    if (rooms.length > 0) {
      if (isDebugMode()) console.log(`Successfully discovered ${rooms.length} rooms on ${server}`);
      return rooms.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  if (isDebugMode()) console.log('Room discovery failed on all servers');
  return [];
});


async function performUpdateCheck() {
  try {
    if (isDebugMode()) console.log('Starting update check...');
    const https = require('https');
    const currentVersion = require('../package.json').version;
    if (isDebugMode()) console.log('Current version:', currentVersion);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (isDebugMode()) console.log('Update check timed out');
        resolve({ status: 'error', error: 'Update check timed out' });
      }, 8000);

      const options = {
        hostname: 'api.github.com',
        path: '/repos/jayofelony/BeeTalk/tags?per_page=1',
        method: 'GET',
        headers: { 'User-Agent': 'BeeTalk' }
      };

      if (isDebugMode()) console.log('Fetching tags from GitHub...');
      https.request(options, (res) => {
        if (isDebugMode()) console.log('Got response, status:', res.statusCode);
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            const tags = JSON.parse(data);
            if (isDebugMode()) console.log('Parsed tags:', tags.length);

            if (!Array.isArray(tags) || tags.length === 0) {
              if (isDebugMode()) console.log('No tags found');
              resolve({ status: 'error', error: 'No tags found in repository' });
              return;
            }

            const latestTag = tags[0];
            if (isDebugMode()) console.log('Latest tag:', latestTag.name);
            const latestVersion = latestTag.name.replace(/^v/, '');
            const comparison = compareVersions(currentVersion, latestVersion);
            if (isDebugMode()) console.log('Version comparison:', currentVersion, 'vs', latestVersion, '=', comparison);

            if (comparison > 0) {
              if (isDebugMode()) console.log('Update available, fetching release info...');
              const releaseOptions = {
                hostname: 'api.github.com',
                path: `/repos/jayofelony/BeeTalk/releases/tags/${latestTag.name}`,
                method: 'GET',
                headers: { 'User-Agent': 'BeeTalk' }
              };

              https.request(releaseOptions, (releaseRes) => {
                if (isDebugMode()) console.log('Release response status:', releaseRes.statusCode);
                let releaseData = '';
                releaseRes.on('data', chunk => releaseData += chunk);
                releaseRes.on('end', () => {
                  try {
                    const release = JSON.parse(releaseData);
                    if (isDebugMode()) console.log('Parsed release');
                    resolve({
                      status: 'update-available',
                      version: latestVersion,
                      releaseNotes: release.body || 'No release notes available',
                      releaseUrl: release.html_url || `https://github.com/jayofelony/BeeTalk/releases/tag/${latestTag.name}`
                    });
                  } catch (err) {
                    console.error('Release parse error:', err.message);
                    resolve({
                      status: 'update-available',
                      version: latestVersion,
                      releaseNotes: 'New version available',
                      releaseUrl: `https://github.com/jayofelony/BeeTalk/releases/tag/${latestTag.name}`
                    });
                  }
                });
              }).on('error', (err) => {
                console.error('Release request error:', err.message);
                resolve({
                  status: 'update-available',
                  version: latestVersion,
                  releaseNotes: 'Update available',
                  releaseUrl: `https://github.com/jayofelony/BeeTalk/releases/tag/${latestTag.name}`
                });
              }).end();
            } else {
              if (isDebugMode()) console.log('Already up to date');
              resolve({ status: 'up-to-date', version: currentVersion });
            }
          } catch (err) {
            clearTimeout(timeout);
            console.error('Tag parse error:', err.message);
            resolve({ status: 'error', error: 'Failed to parse tag data: ' + err.message });
          }
        });
      }).on('error', (err) => {
        clearTimeout(timeout);
        console.error('Tag request error:', err.message);
        resolve({ status: 'error', error: err.message });
      }).end();
    });
  } catch (err) {
    console.error('Update check exception:', err.message);
    return { status: 'error', error: err.message };
  }
}


ipcMain.handle('check-update', performUpdateCheck);

ipcMain.handle('get-version', () => {
  return require('../package.json').version;
});


const WINDOWS_APP_ID = 'com.beetalk.app';

// Set Windows app identity globally before creating window.
if (process.platform === 'win32') {
  const { nativeImage } = require('electron');
  const iconPath = path.join(__dirname, '../assets/icon.ico');
  const icon = nativeImage.createFromPath(iconPath);

  // Use a distinct AppUserModelID in development so Windows doesn't bind
  // the packaged app to an old "Electron" shortcut created during `npm start`.
  const appUserModelId = app.isPackaged ? WINDOWS_APP_ID : `${WINDOWS_APP_ID}.dev`;
  app.setAppUserModelId(appUserModelId);
}

function cleanupLegacyElectronShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;

  try {
    const fs = require('fs');
    const electronShortcutPath = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Electron.lnk'
    );

    if (fs.existsSync(electronShortcutPath)) {
      fs.unlinkSync(electronShortcutPath);
      console.log('Removed legacy Electron Start Menu shortcut to avoid app identity conflicts.');
    }
  } catch (err) {
    console.warn('Failed to clean up legacy Electron shortcut:', err.message || err);
  }
}

// Ensure only one instance of the app is running
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  app.quit();
} else {
  // Handle the case where someone tried to run a second instance
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.show();
    }
  });
}

app.whenReady().then(async () => {
  cleanupLegacyElectronShortcut();
  createWindow();
  createTray();

  // Check for updates 10 seconds after app starts
  setTimeout(async () => {
    try {
      const result = await performUpdateCheck();
      if (result?.status === 'update-available') {
        console.log(`Update available: ${result.version}`);
        // Notify renderer about update
        send('update-available', result);
      }
    } catch (err) {
      console.error('Update check failed:', err);
    }
  }, 10000);
});

app.on('window-all-closed', () => { /* stay in tray */ });
app.on('activate', () => mainWindow.show());

app.on('before-quit', async (e) => {
  // Disconnect all XMPP connections
  for (const id in connections) {
    try {
      await destroyConnection(id);
    } catch (err) {
      console.error(`Error destroying connection ${id}:`, err);
    }
  }
});
