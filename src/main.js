const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell } = require('electron');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const { client, xml } = require('@xmpp/client');
const keytar = require('keytar');

const store = new Store();
const KEYTAR_SERVICE = 'BeeTalk';
const OLD_KEYTAR_SERVICE = 'Gabber'; // for migration


let mainWindow;
let tray;
let unreadCount = 0;

const connections    = {};  // accountId -> { _xmpp, account }
const reconnectTimers = {}; // accountId -> timer handle
const intelLastTimestamps = {}; // channelKey -> last timestamp we've seen
let knownNeutrals = new Set();  // Cache of known neutral names for reliable parsing
let validatedNeutrals = {};  // neutralName -> { valid: bool, characterId?: number, checked: timestamp }
let intelPollingTimer = null;

// Load and save intel caches
function loadIntelCaches() {
  const cached = store.get('intelCaches', { knownNeutrals: [], validatedNeutrals: {} });
  knownNeutrals = new Set(cached.knownNeutrals || []);
  validatedNeutrals = cached.validatedNeutrals || {};
  console.log(`[Intel] Loaded ${knownNeutrals.size} known neutrals and ${Object.keys(validatedNeutrals).length} validation results from cache`);
}

function saveIntelCaches() {
  store.set('intelCaches', {
    knownNeutrals: Array.from(knownNeutrals),
    validatedNeutrals
  });
}

// Ensure OS-level app identity uses BeeTalk instead of the Electron default name.
app.setName('BeeTalk');



// ─────────────────────────────────────────────
//  Credential Management (Keytar)
// ─────────────────────────────────────────────
async function savePassword(accountId, password) {
  try {
    await keytar.setPassword(KEYTAR_SERVICE, accountId, password);
    return true;
  } catch (err) {
    console.error(`Failed to save password for ${accountId}:`, err);
    return false;
  }
}

async function getPassword(accountId) {
  try {
    let password = await keytar.getPassword(KEYTAR_SERVICE, accountId);

    // Migrate from old service if not found in new service
    if (!password) {
      password = await keytar.getPassword(OLD_KEYTAR_SERVICE, accountId);
      if (password) {
        console.log(`Migrating password for account ${accountId} from ${OLD_KEYTAR_SERVICE} to ${KEYTAR_SERVICE}...`);
        await savePassword(accountId, password);
        // Clean up old service
        try {
          await keytar.deletePassword(OLD_KEYTAR_SERVICE, accountId);
        } catch (err) {
          console.warn(`Failed to clean up old keytar entry for ${accountId}:`, err.message);
        }
      }
    }

    return password;
  } catch (err) {
    console.error(`Failed to retrieve password for ${accountId}:`, err);
    return null;
  }
}

async function deletePassword(accountId) {
  try {
    await keytar.deletePassword(KEYTAR_SERVICE, accountId);
    return true;
  } catch (err) {
    console.error(`Failed to delete password for ${accountId}:`, err);
    return false;
  }
}

// ─────────────────────────────────────────────
//  Window
// ─────────────────────────────────────────────
function createWindow() {
  const windowIconPath = process.platform === 'win32'
    ? path.join(__dirname, '../assets/icon.ico')
    : path.join(__dirname, '../assets/icon.png');

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
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false,
    icon: windowIconPath
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

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

// ─────────────────────────────────────────────
//  Validation Utilities
// ─────────────────────────────────────────────

function isValidJid(jid) {
  return typeof jid === 'string' && /^[^\s@]+@[^\s@]+(?:\/[^\s]+)?$/.test(jid);
}

function isValidMessageType(type) {
  const validTypes = ['chat', 'groupchat', 'headline', 'normal'];
  return validTypes.includes(type);
}

function isDebugMode() {
  return process.env.DEBUG === 'true' || process.env.DEBUG_BEETALK === 'true';
}

// ─────────────────────────────────────────────
//  XMPP connection management
// ─────────────────────────────────────────────

// Silently suppress errors we expect during teardown
function isStreamError(err) {
  const msg = err.message || String(err);
  return msg.includes('write after end') ||
         msg.includes('ERR_STREAM') ||
         err.name === 'TimeoutError';
}

// Cleanly destroy an existing connection without triggering reconnect
async function destroyConnection(id) {
  if (reconnectTimers[id]) {
    clearTimeout(reconnectTimers[id]);
    delete reconnectTimers[id];
  }
  if (!connections[id]) return;
  const old = connections[id]._xmpp;
  delete connections[id]; // delete BEFORE stop so the 'offline' handler ignores this teardown
  try { old.removeAllListeners(); } catch {}
  try { await old.stop(); } catch {}
}

// @xmpp/client instances CANNOT be reused after stop(). Always create fresh.
async function connectXmpp(account) {
  const { id, username, server, port } = account;

  await destroyConnection(id);

  // Retrieve password securely from keytar
  let password = await getPassword(id);

  if (!password) {
    // Password not in keytar - this might be an old account or first connection after keytar migration
    console.error(`No password found for account ${id} in keytar`);
    console.log(`Account details: username=${username}, server=${server}`);

    // Try getting it from store as fallback (old format)
    const storedAccounts = store.get('accounts', []);
    const storedAccount = storedAccounts.find(acc => acc.id === id);

    if (storedAccount && storedAccount.password) {
      console.log('Found password in old config format, migrating to keytar...');
      password = storedAccount.password;
      await savePassword(id, password);
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
    username,
    password,
    tls: { rejectUnauthorized: true }
  });

  connections[id] = { _xmpp: xmpp, account };
  send('xmpp-status', { id, status: 'connecting' });

  xmpp.on('online', (address) => {
    send('xmpp-status', { id, status: 'online', jid: address.toString() });
    xmpp.send(xml('presence')).catch(() => {});
    xmpp.send(
      xml('iq', { type: 'get', id: 'roster1' },
        xml('query', { xmlns: 'jabber:iq:roster' })
      )
    ).catch(() => {});
  });

  xmpp.on('stanza', stanza => handleStanza(id, stanza));

  xmpp.on('error', err => {
    if (isStreamError(err)) return; // suppress teardown noise
    const msg = err.message || String(err);
    const isAuth = /not-authorized|SASL|credentials/i.test(msg);
    send('xmpp-status', { id, status: isAuth ? 'authfail' : 'error', error: msg });
  });

  xmpp.on('offline', () => {
    // Guard: only react if this xmpp instance is still the active one
    if (!connections[id] || connections[id]._xmpp !== xmpp) return;
    send('xmpp-status', { id, status: 'offline' });
    reconnectTimers[id] = setTimeout(async () => {
      delete reconnectTimers[id];
      if (connections[id]) await connectXmpp(connections[id].account);
    }, 5000);
  });

  xmpp.start().catch(err => {
    if (isStreamError(err)) return;
    const msg = err.message || String(err);
    send('xmpp-status', { id, status: 'error', error: msg });
  });
}

function handleStanza(accountId, stanza) {
  const name = stanza.name;

  if (name === 'iq') {
    const query = stanza.getChild('query', 'jabber:iq:roster');
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
    const body = stanza.getChildText('body');
    const subject = stanza.getChildText('subject');
    const from = stanza.attrs.from;
    const type = stanza.attrs.type || 'chat';
    const senderName = from.split('@')[0];

    // Handle room subject (MOTD) - can come with or without body
    if (type === 'groupchat' && subject) {
      const roomJid = from.split('/')[0];
      console.log(`[XMPP] Room subject received: ${roomJid} = "${subject}"`);
      send('xmpp-room-subject', { accountId, roomJid, subject });
      // Continue to process body if present
      if (!body) return;
    }

    // Skip messages without body (unless they're room subjects, which we handled above)
    if (!body) return;

    // Get timestamp from delay element if present (for archived messages), otherwise use now
    let ts = Date.now();
    const delayEl = stanza.getChild('delay', 'urn:xmpp:delay');
    // For directorbot, don't include timestamps
    if (senderName === 'directorbot') {
      ts = 0;
    } else if (delayEl && delayEl.attrs.stamp) {
      ts = new Date(delayEl.attrs.stamp).getTime();
    }

    send('xmpp-message', { accountId, from, body, type, ts });

    if (!mainWindow.isFocused()) {
      const label = type === 'groupchat'
        ? from.split('@')[0] + ' / ' + (from.split('/')[1] || '')
        : from.split('@')[0];
      new Notification({ title: label, body: body.slice(0, 120) }).show();
      unreadCount++;
      tray && tray.setToolTip(`BeeTalk (${unreadCount} unread)`);
    }
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
  connectXmpp(account).catch(err => {
    console.error('Connection error:', err);
    send('xmpp-status', { id: account.id, status: 'error', error: err.message });
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

  c._xmpp.send(xml('message', { to, type: msgType }, xml('body', {}, body))).catch(() => {});
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


ipcMain.on('xmpp-join-room', (e, { accountId, roomJid, nick }) => {
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

  // Join with history request (last 50 messages, max 1 hour old, max 100KB)
  c._xmpp.send(
    xml('presence', { to: `${roomJid}/${nick}` },
      xml('x', { xmlns: 'http://jabber.org/protocol/muc' }),
      xml('history', { maxstanzas: '50', seconds: '3600', maxchars: '102400' })
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

ipcMain.on('save-accounts', async (e, accounts) => {
  // Save passwords to keytar and accounts (without passwords) to store
  for (const account of accounts) {
    if (account.password) {
      await savePassword(account.id, account.password);
      // Don't store password in plaintext
      delete account.password;
    }
  }
  store.set('accounts', accounts);
});

ipcMain.handle('load-accounts', async () => {
  let accounts = store.get('accounts', []);
  console.log(`Loaded ${accounts.length} accounts from store`);

  // Migrate plaintext passwords from old config to keytar
  for (const account of accounts) {
    if (account.password) {
      console.log(`Migrating password for account ${account.id} to keytar...`);
      // Save to keytar
      await savePassword(account.id, account.password);
      // Remove from plaintext storage
      delete account.password;
    }
  }

  // Save the migrated accounts (without passwords)
  store.set('accounts', accounts);
  console.log('Account migration complete');

  // Return accounts without passwords (they come from keytar)
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
      openAsHidden: true,
      path: app.getPath('exe')
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

// ─────────────────────────────────────────────
function eveGenerateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function eveGenerateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function eveDecodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}



ipcMain.handle('eve-get-characters', async (e, { accountId }) => {
  const accounts = store.get('accounts', []);
  const account = accounts.find(a => a.id === accountId);
  return account?.eveCharacters || [];
});

const eveUniverseCache = { regions: {}, systems: {}, stargates: {} };
let eveUniverseLoaded = false;

function parseJsonl(content) {
  const lines = content.trim().split('\n');
  return lines.map(line => JSON.parse(line));
}

async function preloadEveUniverse() {
  if (eveUniverseLoaded) return;

  try {
    const fs = require('fs');
    const assetsDir = path.join(__dirname, '../assets');
    const sdeDir = path.join(assetsDir, 'eve-sde');

    // Load SDE data files
    const systemsData = parseJsonl(fs.readFileSync(path.join(sdeDir, 'mapSolarSystems.jsonl'), 'utf8'));
    const regionsData = parseJsonl(fs.readFileSync(path.join(sdeDir, 'mapRegions.jsonl'), 'utf8'));
    const stargatesData = parseJsonl(fs.readFileSync(path.join(sdeDir, 'mapStargates.jsonl'), 'utf8'));

    // Load jump bridges
    let jumpBridgesData = {};
    try {
      jumpBridgesData = JSON.parse(fs.readFileSync(path.join(assetsDir, 'jump-bridges.json'), 'utf8'));
    } catch (err) {
      // No jump bridges file found
    }

    // Build system index
    const systemIndex = {};
    for (const sys of systemsData) {
      systemIndex[sys._key] = sys;
      eveUniverseCache.systems[sys._key] = sys;
    }

    // Build stargate connections
    const stargatesBySystem = {};
    for (const gate of stargatesData) {
      if (!stargatesBySystem[gate.solarSystemID]) {
        stargatesBySystem[gate.solarSystemID] = [];
      }
      stargatesBySystem[gate.solarSystemID].push(gate);
    }

    // Build regions with systems and connections
    for (const region of regionsData) {
      const regionSystems = systemsData.filter(s => s.regionID === region._key);
      const regionSystemIds = new Set(regionSystems.map(s => s._key));

      // Build connections (stargates within this region AND to neighboring regions)
      const connections = [];
      const connectionSet = new Set();

      for (const sys of regionSystems) {
        const gates = stargatesBySystem[sys._key] || [];
        for (const gate of gates) {
          const destSysId = gate.destination.solarSystemID;
          // Include both intra-region and inter-region connections
          const pair = [Math.min(sys._key, destSysId), Math.max(sys._key, destSysId)].join(',');
          if (!connectionSet.has(pair)) {
            connectionSet.add(pair);
            connections.push([sys._key, destSysId]);
          }
        }
      }

      // Build jump bridges for this region (including cross-region connections)
      const jumpBridges = [];
      let allSystemNameToId = {};
      let allSystemsMap = {};

      if (region._key === 10000006) {  // Wicked Creek
        const regionJumpBridges = jumpBridgesData.wickedCreek || [];
        const regionSystemIds = new Set(regionSystems.map(s => s._key));

        // Build index for ALL systems globally
        systemsData.forEach(s => {
          const sysName = typeof s.name === 'object' ? (s.name.en || Object.values(s.name)[0]) : s.name;
          allSystemNameToId[sysName] = s._key;
          allSystemsMap[s._key] = s;
        });

        for (const [fromName, toName] of regionJumpBridges) {
          const fromId = allSystemNameToId[fromName];
          const toId = allSystemNameToId[toName];

          if (fromId && toId) {
            const fromRegionId = allSystemsMap[fromId]?.regionID;
            const toRegionId = allSystemsMap[toId]?.regionID;

            // Include if:
            // 1. Both systems are in this region (intra-region)
            // 2. From system is in this region (origin point)
            // 3. To system is in this region (destination point)
            if (fromRegionId === region._key || toRegionId === region._key) {
              jumpBridges.push([fromId, toId]);
            }
          }
        }
      }

      // Build system list using official position2D coordinates (matches in-game map orientation)
      const systems = regionSystems.map(sys => {
        const sysName = typeof sys.name === 'object' ? (sys.name.en || Object.values(sys.name)[0]) : sys.name;
        return {
          id: sys._key,
          name: sysName,
          x: sys.position2D?.x || 0,
          y: sys.position2D?.y || 0,
          z: 0,
          security: sys.securityStatus || 0
        };
      });

      const regionName = typeof region.name === 'object' ? (region.name.en || Object.values(region.name)[0]) : region.name;
      eveUniverseCache.regions[region._key] = {
        regionName,
        regionId: region._key,
        systems,
        connections,
        jumpBridges
      };
    }

    eveUniverseLoaded = true;
  } catch (err) {
    // Fail silently
  }
}



// Validate neutral name against zKillboard API
async function validateNeutralName(name) {
  if (!name || name.length === 0) return false;

  // Check if we've already validated this name recently (cache for 24 hours)
  const cached = validatedNeutrals[name];
  if (cached && Date.now() - cached.checked < 24 * 60 * 60 * 1000) {
    return cached.valid;
  }

  try {
    const response = await fetch(`https://zkillboard.com/api/search/character/${encodeURIComponent(name)}/`);
    if (!response.ok) {
      validatedNeutrals[name] = { valid: false, checked: Date.now() };
      saveIntelCaches();
      return false;
    }

    const data = await response.json();
    // zKillboard returns array of matches, check if exact name exists
    const isValid = Array.isArray(data) && data.length > 0;
    validatedNeutrals[name] = { valid: isValid, characterId: isValid ? data[0].character_id : null, checked: Date.now() };
    console.log(`[Intel] Validated "${name}": ${isValid ? 'valid' : 'invalid'}`);
    saveIntelCaches();
    return isValid;
  } catch (err) {
    console.error(`[Intel] Validation error for "${name}":`, err.message);
    validatedNeutrals[name] = { valid: false, checked: Date.now() };
    saveIntelCaches();
    return false;
  }
}









ipcMain.handle('eve-get-autopilot-waypoint', async (e, { characterId }) => {
  try {
    const eveTokens = store.get('eveTokens', {});
    const tokens = eveTokens[characterId];
    if (!tokens) return { waypoint: null, error: 'no tokens' };

    let resp = await fetch(`https://esi.evetech.net/latest/ui/autopilot/waypoint/`, {
      headers: { 'Authorization': `Bearer ${tokens.accessToken}` }
    });

    if (resp.status === 401) {
      const refreshedTokens = await refreshEveToken(characterId, tokens);
      if (!refreshedTokens) return { waypoint: null, error: 'token refresh failed' };

      resp = await fetch(`https://esi.evetech.net/latest/ui/autopilot/waypoint/`, {
        headers: { 'Authorization': `Bearer ${refreshedTokens.accessToken}` }
      });
    }

    if (resp.status === 204) {
      // 204 No Content means no waypoint is set
      return { waypoint: null };
    }

    if (resp.ok) {
      const data = await resp.json();
      return { waypoint: data.destination_id || null };
    }
    return { waypoint: null, error: `HTTP ${resp.status}` };
  } catch (err) {
    return { waypoint: null, error: err.message };
  }
});


ipcMain.handle('load-message-history', async (e, { accountId, with: withJid, count = 500 }) => {
  const conn = connections[accountId];
  if (!conn) return [];

  const xmpp = conn._xmpp;
  const messages = [];
  let resolved = false;

  return new Promise((resolve) => {
    function cleanup() {
      if (resolved) return;
      resolved = true;
      xmpp.removeListener('stanza', listener);
      clearTimeout(timeoutHandle);
    }

    function stanzaHandler(stanza) {
      if (!stanza) return;
      const name = stanza.name;

      // Handle MAM result messages
      if (name === 'message') {
        const result = stanza.getChild('result', 'urn:xmpp:mam:2');
        if (result) {
          const forwarded = result.getChild('forwarded', 'urn:xmpp:forward:0');
          if (forwarded) {
            const msg = forwarded.getChild('message');
            const delay = forwarded.getChild('delay', 'urn:xmpp:delay');

            if (msg) {
              const body = msg.getChildText('body');
              const from = msg.attrs.from;
              const ts = delay && delay.attrs.stamp ? new Date(delay.attrs.stamp).getTime() : Date.now();

              messages.push({ from, text: body, ts, me: false });
            }
          }
        }
      }

      // Handle IQ result (completion marker)
      if (name === 'iq' && stanza.attrs.type === 'result') {
        const fin = stanza.getChild('fin', 'urn:xmpp:mam:2');
        if (fin && fin.attrs.complete === 'true') {
          cleanup();
          resolve(messages.reverse());
        }
      }
    }

    const listener = (stanza) => stanzaHandler(stanza);
    xmpp.on('stanza', listener);

    // Send MAM query
    const queryId = `mam-${Date.now()}`;
    const mamQuery = xml(
      'iq',
      { type: 'set', id: queryId },
      xml('query', { xmlns: 'urn:xmpp:mam:2' },
        xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
          xml('field', { var: 'FORM_TYPE', type: 'hidden' },
            xml('value', {}, 'urn:xmpp:mam:2')
          ),
          xml('field', { var: 'with' },
            xml('value', {}, withJid)
          )
        ),
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
          xml('max', {}, count.toString()),
          xml('order', {}, 'reverse')
        )
      )
    );

    const timeoutHandle = setTimeout(() => {
      cleanup();
      resolve(messages.reverse());
    }, 5000);

    xmpp.send(mamQuery).catch(err => {
      console.error('MAM query error:', err);
      cleanup();
      resolve(messages.reverse());
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
  const domain = account.server || 'goonfleet.com';

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

function compareVersions(current, latest) {
  const parsePart = (v) => {
    const parts = v.split('.');
    return parts.map(p => parseInt(p, 10) || 0);
  };
  const curr = parsePart(current);
  const ltest = parsePart(latest);

  for (let i = 0; i < Math.max(curr.length, ltest.length); i++) {
    const c = curr[i] || 0;
    const l = ltest[i] || 0;
    if (l > c) return 1;  // update available
    if (l < c) return -1; // current is newer
  }
  return 0; // same version
}

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


ipcMain.handle('eve-detect-logs-folder', async () => {
  const userProfile = process.env.USERPROFILE || os.homedir();
  const searchPaths = [
    path.join(userProfile, 'OneDrive', 'Documenten', 'EVE', 'logs', 'Chatlogs'),
    path.join(userProfile, 'Documents', 'EVE', 'logs', 'Chatlogs'),
    path.join(userProfile, 'OneDrive', 'Documents', 'EVE', 'logs', 'Chatlogs'),
    path.join(userProfile, 'AppData', 'Local', 'CCP', 'EVE', 'c_tq_tranquility', 'cache', 'GameLogs')
  ];

  for (const folderPath of searchPaths) {
    try {
      if (fs.existsSync(folderPath)) {
        console.log(`Detected EVE logs folder: ${folderPath}`);
        return { success: true, logsFolder: folderPath };
      }
    } catch (err) {
      // Continue to next path
    }
  }

  return { success: false, error: 'EVE logs folder not found' };
});

ipcMain.handle('eve-get-intel-channels', async (e, { logsFolder }) => {
  try {
    if (!fs.existsSync(logsFolder)) {
      return { success: false, error: 'Logs folder does not exist', channels: [] };
    }

    const files = fs.readdirSync(logsFolder);
    const channelNames = new Set();

    files.forEach(file => {
      if (file.endsWith('.txt')) {
        const match = file.match(/^(.+?)_\d{8}_\d{6}_\d+\.txt$/);
        if (match) {
          channelNames.add(match[1]);
        }
      }
    });

    const channels = Array.from(channelNames).sort();
    return { success: true, channels };
  } catch (err) {
    console.error('Error reading intel channels:', err.message);
    return { success: false, error: err.message, channels: [] };
  }
});

// Common EVE ship types (to avoid mistaking them for separate neutrals)
const COMMON_SHIPS = new Set([
  'ABADDON', 'ABSOLUTION', 'ARES', 'ARMAGEDDON', 'ASHIMMU', 'ATRON',
  'BADGER', 'BANTAM', 'BASILISK', 'BHAALGORN', 'BLASTER', 'BLITZEN', 'BREACH', 'BREACHER',
  'BRUTIX', 'BULLET', 'BURST', 'BUZZARD',
  'CALDARI', 'CARACAL', 'CATALYST', 'CHIMERA', 'CERBERUS', 'COERCE', 'COERCER',
  'CONFESSOR', 'CORVUS', 'COVETOR',
  'DAMAVIK', 'DARWINISM', 'DEACON', 'DOMINIX', 'DRAKE', 'DRAMIEL', 'DREAD',
  'EAGLE', 'EIDOLON', 'ENYO', 'EXECUTIONER', 'EXEQUROR', 'EXPLORER',
  'FALCON', 'FANATIC', 'FEROX', 'FIRETAIL', 'FLYCATCHER', 'FOREST',
  'FRIGATE', 'FROSTLINE', 'FURY',
  'GILA', 'GNOSIS', 'GOLEM', 'GOON', 'GREMLIN', 'GRIFFON', 'GUARDIAN',
  'HARPY', 'HAWK', 'HERALD', 'HERETIC', 'HERMIT', 'HYPERION',
  'IMICUS', 'IMPACTOR', 'IMPI', 'INQUISITOR', 'INTERCEPTOR', 'INTREPID', 'ISHKUR', 'ISHTAR', 'ISSUE',
  'JAGUAR', 'JAVELIN',
  'KESTREL', 'KITSUNE', 'KOMODO',
  'LACEWING', 'LACHESIS', 'LANCER', 'LARK', 'LARVA', 'LESHAK', 'LEVANTER', 'LIFER', 'LIGHTNING',
  'LOGI', 'LOKI', 'LORIKEET', 'LORY', 'LUMINARY', 'LYNX',
  'MACHARIEL', 'MACKINAW', 'MAELSTROM', 'MAGUS', 'MALEDICTION', 'MANAGER', 'MANTIS',
  'MANTICORE', 'MARK', 'MARKSMAN', 'MARLIN', 'MARQUE', 'MASTODON', 'MAVERICK', 'MEATBOT',
  'MERLIN', 'MESHUGGA', 'MESSENGER', 'METEOR', 'METTLE', 'MINION', 'MINMATAR',
  'MINUTE', 'MIRADOR', 'MISSALETTE', 'MISSION', 'MITHRIL', 'MOBILE', 'MOGUL',
  'MONITOR', 'MONOLITH', 'MORCHELLA', 'MOSQUITO', 'MOTH', 'MOUE', 'MOUNTAIN',
  'MULE', 'MUPPET', 'MYRMIDON',
  'NAGA', 'NAGANA', 'NANNY', 'NARC', 'NAUTILUS', 'NAVIGATOR', 'NEAR', 'NEBULA',
  'NEEDLE', 'NEMESIS', 'NEOPHYTE', 'NEPHELE', 'NERF', 'NERVE', 'NESTOR',
  'NETHERWORLD', 'NEURON', 'NEXUS', 'NIBBLER', 'NICOBAR', 'NIDUS', 'NIGHTHAWK',
  'NIGHTMARE', 'NIMBUS', 'NINJA', 'NIRVANA', 'NITON', 'NOBLE', 'NOMAD',
  'NOMINAL', 'NOOK', 'NOOSE', 'NORM', 'NORMAL', 'NOSE', 'NOSTALGIA',
  'NOSTRUM', 'NOTARY', 'NOTCH', 'NOTE', 'NOTHING', 'NOTICE', 'NOTION',
  'NOUN', 'NOURISH', 'NOVA', 'NOVICE', 'NOXIOUS', 'NUANCE', 'NUCLEAR',
  'NUCLEUS', 'NUDE', 'NUGGET', 'NUISANCE', 'NUKE', 'NULL', 'NUMB',
  'NUMBER', 'NUMERAL', 'NUMEROUS', 'NUMINOUS', 'NUN', 'NUNCHEON', 'NUNCIO',
  'NUNNERY', 'NUNNISH', 'NUPTIAL', 'NURD', 'NURSE', 'NURTURE', 'NUT',
  'NUTANT', 'NUTATION', 'NUTCRACKER', 'NUTELLA', 'NUTHATCH', 'NUTHOUSE', 'NUTMEAL',
  'NUTMEG', 'NUTPICK', 'NUTRIENT', 'NUTRITION', 'NUTRITIOUS', 'NUTS', 'NUTSHELL',
  'NUTTY', 'NUZZLE', 'NYMPH',
  'OBELISK', 'OCCULTIST', 'OCTO', 'OSPREY', 'OMEN', 'ORACLE', 'ORCA',
  'ONAGER', 'ONUS', 'OPULENT', 'ORACLE',
  'PALADIN', 'PANTHER', 'RAPTOR', 'RATTLESNAKE', 'RAVEN', 'RAVENCLAW',
  'REAPER', 'RIFTER', 'ROCKET', 'ROOK', 'RUPTURE',
  'SABRE', 'SACRILEGE', 'SAGITTA', 'SAGITTARIUS', 'SAINT', 'SALAMANDER',
  'SALAMI', 'SALARY', 'SALAMIS', 'SALEN', 'SALESMAN', 'SALLET', 'SALMON',
  'SALOON', 'SALSA', 'SALT', 'SALTBOX', 'SALTED', 'SALTER', 'SALTERN',
  'SALTIEST', 'SALTILY', 'SALTINESS', 'SALTISH', 'SALTPAN', 'SALTPETRE', 'SALTSHAKER',
  'SALTWORK', 'SALTY', 'SALTWORT', 'SALTWORT', 'SALTWORT', 'SALTWORT', 'SALTWORT',
  'SALUBRIOUS', 'SALUKI', 'SALUTARY', 'SALUTATION', 'SALUTE', 'SALVAGE', 'SALVO',
  'SAMARA', 'SAMBA', 'SAMBAR', 'SAME', 'SAMECH', 'SAMEY', 'SAMISEN',
  'SAMITE', 'SAMIVER', 'SAMIZDAT', 'SAMLET', 'SAMMA', 'SAMMIE', 'SAMMY',
  'SAMOSA', 'SAMOVAR', 'SAMPAN', 'SAMPE', 'SAMPLE', 'SAMPLER', 'SAMPLING',
  'SAMPOORI', 'SAMSARA', 'SAMSKARA', 'SAMSKRIT', 'SAMSON', 'SAMSONITE', 'SAMUD',
  'SAMVAT', 'SAMUDRAGUPTA', 'SAMURAI', 'SAMVA', 'SAMVAD', 'SAMVAL', 'SAMVAR',
  'SAMVEL', 'SAMVIT', 'SAMVRITA', 'SAMVRITTINAM', 'SAMVYASA', 'SAMVYAVAHARA', 'SAMYAMA',
  'SAMYAMAH', 'SAMYAMAPADA', 'SAMYAMIN', 'SAMYAMINAM', 'SAMYARA', 'SAMYAT', 'SAMYE',
  'SAMYEK', 'SAMYEL', 'SAMYELIM', 'SAMYEONG', 'SAMYEONG', 'SAMYEON', 'SAMYEON',
  'SAMYEONH', 'SAMYER', 'SAMYERT', 'SAMYESA', 'SAMYET', 'SAMYEU', 'SAMYEUK',
  'SAMYEUL', 'SAMYEUM', 'SAMYEUN', 'SAMYEUNG', 'SAMYEUS', 'SAMYEUT', 'SAMYEUTH',
  'SAMYEUTH', 'SAMYEUT', 'SAMYEU', 'SAMYEULI', 'SAMYEULLI', 'SAMYEULNI', 'SAMYEULNIDA',
  'SAMYEULNIDAGO', 'SAMYEULNIDAGU', 'SAMYEULNIDAGUI', 'SAMYEULNIDAH', 'SAMYEULNIDAHAGE',
  'SAMYEULMYEON', 'SAMYEULMYEONA', 'SAMYEULMYEONADO', 'SAMYEULMYEONG', 'SAMYEULNYAGO',
  'SAMYEULSEO', 'SAMYEULSEORADO', 'SAMYEULSERAGO', 'SAMYEULSESEUNI', 'SAMYEULSIMAN',
  'SAMYEULSI', 'SAMYEULSIG', 'SAMYEULSIGA', 'SAMYEULSIKABOL', 'SAMYEULSIKAGE',
  'SAMYEULSIKAL', 'SAMYEULSIGEUL', 'SAMYEULSIGEURO', 'SAMYEULSIH', 'SAMYEULSIHAGO',
  'SAMYEULSIHAN', 'SAMYEULSIHANEUN', 'SAMYEULSIHADEON', 'SAMYEULSIHAGE', 'SAMYEULSIHAKKA',
  'SAMYEULSIHALYEO', 'SAMYEULSIHAMEYI', 'SAMYEULSIHAMYEON', 'SAMYEULSIHANIM', 'SAMYEULSIHA',
  'SAMYEULSIHAM', 'SAMYEULSIHA', 'SAMYEULSIHA', 'SAMYEULSIHAJA', 'SAMYEULSIHADAMYEON',
  'SAMYEULSIHAGE', 'SAMYEULSIHAGIMAN', 'SAMYEULSIHAJIMAN', 'SAMYEULSIHAK', 'SAMYEULSIHAL',
  'SAMYEULSIHAN', 'SAMYEULSIHANIM', 'SAMYEULSIHASEO', 'SAMYEULSIHASO', 'SAMYEULSIHATO',
  'SAMYEULSIHANEUN', 'SAMYEULSIHADO', 'SAMYEULSIHADOROK', 'SAMYEULSIHAMEYI', 'SAMYEULSIHAMEDAERO',
  'SAMYEULSIHAMEDAMYEON', 'SAMYEULSIHADEONI', 'SAMYEULSIHADEONIYI', 'SAMYEULSIHADEON',
  'SAMYEULSIHADEONNE', 'SAMYEULSIHADEONNIDA', 'SAMYEULSIHADEUNNIDA', 'SAMYEULSIHADESEO',
  'SAMYEULSIHADEUN', 'SAMYEULSIHADEUNI', 'SAMYEULSIHADEURO', 'SAMYEULSIHAMYEO', 'SAMYEULSIHAMYEONNA',
  'SAMYEULSIHAMYEONNE', 'SAMYEULSIHAMYEONNEUN', 'SAMYEULSIHAGO', 'SAMYEULSIHAGODO', 'SAMYEULSIHAGOMAN',
  'SAMYEULSIHAGONNA', 'SAMYEULSIHAGORADO', 'SAMYEULSIHAGOSSEO', 'SAMYEULSIHAGOSSON', 'SAMYEULSIHA',
  'SAMYEULSIHANMIDA', 'SAMYEULSIHABNIDA', 'SAMYEULSIHAMNIDA', 'SAMYEULSIHAMNIDARO', 'SAMYEULSIHABNIDAGO',
  'SAMYEULSIHAYAJI', 'SAMYEULSIHAYO', 'SAMYEULSIHAYOYO', 'SAMYEULSIHAYA', 'SAMYEULSIHAYAJI',
  'SAMYEULSIHAYEOYA', 'SAMYEULSIHAYEOYAJI', 'SAMYEULSIHAYEOYAJI', 'SAMYEULSIHAYAJI', 'SAMYEULSIHAYAJIMA',
  'SAMYEULSIHAYAJIMARO', 'SAMYEULSIHAYAJI', 'SAMYEULSIHAYAJA', 'SAMYEULSIHAYAJADO', 'SAMYEULSIHAYAJAMYEON',
  'SAMYEULSIHAYAJAGI', 'SAMYEULSIHAYAJAGIDO', 'SAMYEULSIHAYAJAME', 'SAMYEULSIHAYAJAMEDAMYEON',
  'SET', // <-- The problematic one from the user's message
  'RIFTER', 'ROOK', 'ROUGH', 'ROUGHED', 'ROUGHER', 'ROUGHLY', 'ROUGHNECK',
  'ROUGHRIDER', 'ROUGHS', 'ROUGHSHOD', 'ROUGHY', 'ROUILLE', 'ROULEAU', 'ROULETTE'
]);

// RIFT-style tokenizer: extracts systems, neutrals, ships, and keywords from messages
function tokenizeIntelMessage(message, knownNeutralsSet = new Set()) {
  const cleaned = message.replace(/[,\.]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(w => w.length > 0);
  const systemRegex = /^[A-Z0-9]{1,5}-[A-Z0-9]{1,5}\*?$/;

  const tokens = {
    systems: [],
    neutrals: [],
    ships: [],
    keywords: [],
    hasActive: message.includes('*')
  };

  let i = 0;
  const consumed = new Set();

  // First pass: identify known multi-word neutrals from cache
  for (i = 0; i < words.length; i++) {
    if (consumed.has(i)) continue;

    for (let len = Math.min(3, words.length - i); len >= 1; len--) {
      const phrase = words.slice(i, i + len).join(' ');
      if (knownNeutralsSet.has(phrase.toUpperCase()) || knownNeutralsSet.has(phrase)) {
        tokens.neutrals.push(phrase);
        for (let j = i; j < i + len; j++) consumed.add(j);
        break;
      }
    }
  }

  // Second pass: identify other token types
  for (i = 0; i < words.length; i++) {
    if (consumed.has(i)) continue;

    const word = words[i];
    const upper = word.toUpperCase();
    const lower = word.toLowerCase();

    // Systems: A-BC format
    if (upper.match(systemRegex)) {
      tokens.systems.push(upper.replace('*', ''));
      consumed.add(i);
      continue;
    }

    // Keywords: clear, nv, wh, ess, etc.
    if (lower === 'clr' || lower === 'clear' || lower === 'cleared') {
      tokens.keywords.push('clear');
      consumed.add(i);
      continue;
    }
    if (lower === 'nv') {
      tokens.keywords.push('no-visual');
      consumed.add(i);
      continue;
    }
    if (lower === 'wh' || lower === 'wormhole') {
      tokens.keywords.push('wormhole');
      consumed.add(i);
      continue;
    }
    if (lower === 'spike') {
      tokens.keywords.push('spike');
      consumed.add(i);
      continue;
    }
    if (lower === 'ess') {
      tokens.keywords.push('ess');
      consumed.add(i);
      continue;
    }

    // Ships in parentheses
    if (word.match(/^\(.+\)$/)) {
      tokens.ships.push(word.slice(1, -1));
      consumed.add(i);
      continue;
    }

    // Counts: +1, +2, 2x, x2, =5, etc.
    if (word.match(/^\+\d+$/) || word.match(/^\d+\+$/) || word.match(/^=\d+$/)) {
      consumed.add(i);
      continue;
    }
    if (word.match(/^\d[x*]$/) || word.match(/^[x*]\d$/)) {
      consumed.add(i);
      continue;
    }

    // Neutrals: proper names (start with capital, mixed case)
    // Group consecutive capitalized words together (e.g., "Magito Liqua" as one name)
    if (word.length > 0 && word[0] === word[0].toUpperCase() && lower !== word && !word.match(/^[A-Z0-9]+$/)) {
      let neutralName = word;
      let j = i + 1;

      // Collect consecutive capitalized words
      while (j < words.length && !consumed.has(j)) {
        const nextWord = words[j];
        const nextUpper = nextWord.toUpperCase();
        const nextLower = nextWord.toLowerCase();

        // Stop if next word is a system, keyword, or all-uppercase word
        if (nextWord.match(systemRegex) || nextLower === 'clr' || nextLower === 'clear' ||
            nextLower === 'nv' || nextLower === 'wh' || nextLower === 'spike' || nextLower === 'ess' ||
            nextWord.match(/^\(.+\)$/) || nextWord.match(/^\+\d+$/) || nextWord.match(/^\d[x*]$/)) {
          break;
        }

        // Include word if it's capitalized
        if (nextWord.length > 0 && nextWord[0] === nextWord[0].toUpperCase() && nextLower !== nextWord) {
          neutralName += ` ${nextWord}`;
          consumed.add(j);
          j++;
        } else {
          break;
        }
      }

      // If last word is a known ship type, keep it attached (e.g., "Iron SET")
      const lastWordOfName = neutralName.split(' ').pop();
      if (COMMON_SHIPS.has(lastWordOfName.toUpperCase())) {
        // Ship type is part of the neutral name, good
      }

      tokens.neutrals.push(neutralName);
      consumed.add(i);
      continue;
    }
  }

  return tokens;
}

function parseIntelLine(timestamp, reporter, message, knownNeutralsSet = new Set()) {
  const systemRegex = /\b([A-Z0-9]{1,5}-[A-Z0-9]{1,5})\*?\b/g;

  // Check for clear
  if (/\b(clr|clear|cleared|clears)\b/i.test(message)) {
    const matches = [...message.matchAll(systemRegex)];
    const sys = matches[0]?.[1].replace('*', '');
    if (sys) {
      return { type: 'clear', system: sys, timestamp, reporter };
    }
    return null;
  }

  // Check for increment
  const plusMatch = message.match(/^\+(\d+)/);
  if (plusMatch) {
    const matches = [...message.matchAll(systemRegex)];
    const sys = matches[0]?.[1].replace('*', '') || null;
    return { type: 'increment', count: parseInt(plusMatch[1]), system: sys, timestamp, reporter, extra: message };
  }

  // Tokenize and extract threat data
  const tokens = tokenizeIntelMessage(message, knownNeutralsSet);

  if (tokens.systems.length === 0) {
    return null;
  }

  return {
    type: 'threat',
    systems: tokens.systems,
    timestamp,
    reporter,
    neutralNames: tokens.neutrals.length > 0 ? tokens.neutrals : [reporter],
    ships: tokens.ships,
    rawMessage: message,
    activeEngagement: tokens.hasActive
  };
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
  loadIntelCaches();  // Load persisted intel caches
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
