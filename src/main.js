const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell } = require('electron');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const { client, xml } = require('@xmpp/client');
const keytar = require('keytar');
const Pickler = require('pickler');

const store = new Store();
const KEYTAR_SERVICE = 'BeeTalk';
const OLD_KEYTAR_SERVICE = 'Gabber'; // for migration

// ─────────────────────────────────────────────
//  EVE Online ESI — set your Client ID from https://developers.eveonline.com/
//  Callback URL to register: http://localhost:7777/callback
// ─────────────────────────────────────────────
const EVE_CLIENT_ID = '9f17e8fe55774cc596a699ad0dcd44c5';  // <-- paste your EVE application Client ID here
const EVE_CALLBACK_PORT = 7777;
const EVE_CALLBACK_URL = `http://localhost:${EVE_CALLBACK_PORT}/callback`;
const EVE_AUTH_URL = 'https://login.eveonline.com/v2/oauth/authorize';
const EVE_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';

let mainWindow;
let tray;
let unreadCount = 0;

const connections    = {};  // accountId -> { _xmpp, account }
const reconnectTimers = {}; // accountId -> timer handle

// Ensure OS-level app identity uses BeeTalk instead of the Electron default name.
app.setName('BeeTalk');

// ─────────────────────────────────────────────
//  EVE Cache Reading
// ─────────────────────────────────────────────
function findEveCacheDir() {
  const appDataPath = path.join(os.homedir(), 'AppData', 'Local', 'CCP', 'EVE');

  // Try both Tranquility and Singularity servers
  const possibleDirs = [
    path.join(appDataPath, 'c_ccp_eve_tq_tranquility', 'cache'),
    path.join(appDataPath, 'c_ccp_eve_tq_tranquility', 'cache'),
    path.join(appDataPath, 'c_ccp_eve_sisi_singularity', 'cache'),
  ];

  for (const dir of possibleDirs) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }

  return null;
}

function getEveMachoNetPath(cacheDir) {
  const machoDir = path.join(cacheDir, 'MachoNet');
  if (!fs.existsSync(machoDir)) return null;

  // Find first server directory (IP address)
  const servers = fs.readdirSync(machoDir);
  if (servers.length === 0) return null;

  return path.join(machoDir, servers[0], '496', 'CachedObjects');
}

async function readEveLocationFromCache(characterId) {
  try {
    const cacheDir = findEveCacheDir();
    if (!cacheDir) return null;

    const objectsDir = getEveMachoNetPath(cacheDir);
    if (!objectsDir) return null;

    // Try to find and read cached location data
    // EVE stores location info in various cache objects
    // We'll look for character-related cache files
    const cacheFiles = fs.readdirSync(objectsDir).filter(f => f.endsWith('.cache'));

    for (const file of cacheFiles.slice(0, 50)) {
      try {
        const filePath = path.join(objectsDir, file);
        const fileData = fs.readFileSync(filePath);

        // Attempt to parse as pickle
        // Note: this is experimental and may not work for all EVE cache formats
        // If parsing fails, we fall back to ESI
        if (fileData.length > 0) {
          // Check for common pickle opcodes
          if (fileData[0] === 0x80 || fileData[0] === 0x63) {  // pickle protocol markers
            try {
              const unpickler = new Pickler.Unpickler(fileData);
              const data = unpickler.load();

              // If we find character-related data with location, return it
              if (data && typeof data === 'object') {
                // Look for character location in the data structure
                // This is fragile and depends on EVE's internal structure
                if (data.solarSystemID || data.systemId || data.solarsystemid) {
                  return {
                    systemId: data.solarSystemID || data.systemId || data.solarsystemid,
                    source: 'cache'
                  };
                }
              }
            } catch (err) {
              // Pickle parse error, try next file
              continue;
            }
          }
        }
      } catch (err) {
        // File read error, try next file
        continue;
      }
    }
  } catch (err) {
    console.error('Error reading EVE cache:', err.message);
  }

  return null;
}

// EVE character location polling
let eveLocationPollTimer = null;
async function fetchEveLocations() {
  const eveTokens = store.get('eveTokens', {});
  const accounts = store.get('accounts', []);

  for (const [characterId, tokens] of Object.entries(eveTokens)) {
    const account = accounts.find(a => a.eveCharacters?.some(c => c.characterId === Number(characterId)));
    if (!account) continue;

    const character = account.eveCharacters.find(c => c.characterId === Number(characterId));
    if (!character) continue;

    try {
      let systemId = null;

      // Try cache first (instant if EVE is running)
      const cacheResult = await readEveLocationFromCache(characterId);
      if (cacheResult) {
        systemId = cacheResult.systemId;
        console.log(`Character ${characterId} location from cache: ${systemId}`);
      } else {
        // Fall back to ESI API
        const locResp = await fetch(`https://esi.evetech.net/latest/characters/${characterId}/location/`, {
          headers: { 'Authorization': `Bearer ${tokens.accessToken}` }
        });
        if (locResp.ok) {
          const locData = await locResp.json();
          systemId = locData.solar_system_id;
          console.log(`Character ${characterId} location from ESI: ${systemId}`);
        }
      }

      if (systemId) {
        // Get system details
        const systemResp = await fetch(`https://esi.evetech.net/latest/universe/systems/${systemId}/`);
        if (systemResp.ok) {
          const systemData = await systemResp.json();
          const systemName = systemData.name;
          let regionName = '';
          try {
            const constResp = await fetch(`https://esi.evetech.net/latest/universe/constellations/${systemData.constellation_id}/`);
            if (constResp.ok) {
              const constData = await constResp.json();
              const regionResp = await fetch(`https://esi.evetech.net/latest/universe/regions/${constData.region_id}/`);
              if (regionResp.ok) {
                const regionData = await regionResp.json();
                regionName = regionData.name;
              }
            }
          } catch (err) {
            // ignore
          }
          send('eve-location-update', { accountId: account.id, characterId: Number(characterId), characterName: character.characterName, systemId, systemName, regionName });
        }
      }
    } catch (err) {
      // ignore polling errors
    }
  }
}
function startEveLocationPolling() {
  if (eveLocationPollTimer) return;
  fetchEveLocations();  // Fetch immediately
  eveLocationPollTimer = setInterval(fetchEveLocations, 5000);  // Poll every 5 seconds (cache reads are instant)
}
function stopEveLocationPolling() {
  if (eveLocationPollTimer) {
    clearInterval(eveLocationPollTimer);
    eveLocationPollTimer = null;
  }
}

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
    if (!body) return;

    const from = stanza.attrs.from;
    const type = stanza.attrs.type || 'chat';
    const senderName = from.split('@')[0];

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
//  EVE Online OAuth2 + PKCE helpers
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

ipcMain.handle('eve-link-character', async (e, { accountId }) => {
  if (!EVE_CLIENT_ID) {
    return { success: false, error: 'EVE_CLIENT_ID is not set. Edit src/main.js and paste your Client ID from https://developers.eveonline.com/' };
  }

  const codeVerifier = eveGenerateCodeVerifier();
  const codeChallenge = eveGenerateCodeChallenge(codeVerifier);
  const oauthState = crypto.randomBytes(8).toString('hex');

  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: EVE_CALLBACK_URL,
    client_id: EVE_CLIENT_ID,
    scope: [                                                  
      'publicData',                                           
      'esi-calendar.respond_calendar_events.v1',              
      'esi-calendar.read_calendar_events.v1',                 
      'esi-location.read_location.v1',                        
      'esi-location.read_ship_type.v1',                       
      'esi-mail.organize_mail.v1',                            
      'esi-mail.read_mail.v1',                                
      'esi-mail.send_mail.v1',                                
      'esi-skills.read_skills.v1',                            
      'esi-skills.read_skillqueue.v1',                        
      'esi-wallet.read_character_wallet.v1',                  
      'esi-wallet.read_corporation_wallet.v1',                
      'esi-search.search_structures.v1',                      
      'esi-clones.read_clones.v1',                            
      'esi-characters.read_contacts.v1',                      
      'esi-universe.read_structures.v1',                      
      'esi-killmails.read_killmails.v1',                      
      'esi-corporations.read_corporation_membership.v1',      
      'esi-assets.read_assets.v1',                            
      'esi-planets.manage_planets.v1',                        
      'esi-fleets.read_fleet.v1',                             
      'esi-fleets.write_fleet.v1',                            
      'esi-ui.open_window.v1',                                
      'esi-ui.write_waypoint.v1',                             
      'esi-characters.write_contacts.v1',                     
      'esi-fittings.read_fittings.v1',                        
      'esi-fittings.write_fittings.v1',                       
      'esi-markets.structure_markets.v1',                     
      'esi-corporations.read_structures.v1',                  
      'esi-characters.read_loyalty.v1',                       
      'esi-characters.read_chat_channels.v1',                 
      'esi-characters.read_medals.v1',                        
      'esi-characters.read_standings.v1',                     
      'esi-characters.read_agents_research.v1',               
      'esi-industry.read_character_jobs.v1',                  
      'esi-markets.read_character_orders.v1',                 
      'esi-characters.read_blueprints.v1',                    
      'esi-characters.read_corporation_roles.v1',             
      'esi-location.read_online.v1',                          
      'esi-contracts.read_character_contracts.v1',            
      'esi-clones.read_implants.v1',                          
      'esi-characters.read_fatigue.v1',                       
      'esi-killmails.read_corporation_killmails.v1',          
      'esi-corporations.track_members.v1',                    
      'esi-wallet.read_corporation_wallets.v1',               
      'esi-characters.read_notifications.v1',                 
      'esi-corporations.read_divisions.v1',                   
      'esi-corporations.read_contacts.v1',                    
      'esi-assets.read_corporation_assets.v1',                
      'esi-corporations.read_titles.v1',                      
      'esi-corporations.read_blueprints.v1',                  
      'esi-contracts.read_corporation_contracts.v1',          
      'esi-corporations.read_standings.v1',                   
      'esi-corporations.read_starbases.v1',                   
      'esi-industry.read_corporation_jobs.v1',                
      'esi-markets.read_corporation_orders.v1',               
      'esi-corporations.read_container_logs.v1',              
      'esi-industry.read_character_mining.v1',                
      'esi-industry.read_corporation_mining.v1',              
      'esi-planets.read_customs_offices.v1',                  
      'esi-corporations.read_facilities.v1',                  
      'esi-corporations.read_medals.v1',                      
      'esi-characters.read_titles.v1',                        
      'esi-alliances.read_contacts.v1',                       
      'esi-characters.read_fw_stats.v1',                      
      'esi-corporations.read_fw_stats.v1',                    
      'esi-corporations.read_projects.v1',                    
      'esi-corporations.read_freelance_jobs.v1',              
      'esi-characters.read_freelance_jobs.v1',                
      'esi-structures.read_corporation.v1',                   
      'esi-structures.read_character.v1',                     
      'esi-activities.read_character.v1',                     
      'esi-access.read_lists.v1',                             
    ].join(' '),                                              
  state: oauthState,
  code_challenge: codeChallenge,
  code_challenge_method: 'S256'
  });
  const authUrl = `${EVE_AUTH_URL}?${params}`;

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      let server;
      const timeout = setTimeout(() => {
        server?.close();
        reject(new Error('Timed out waiting for EVE login (5 min).'));
      }, 5 * 60 * 1000);

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${EVE_CALLBACK_PORT}`);
        if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

        const returnedCode = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>EVE login successful!</h2><p>You may close this tab and return to BeeTalk.</p></body></html>');
        server.close();
        clearTimeout(timeout);

        if (returnedState !== oauthState) { reject(new Error('State mismatch — retry the link.')); return; }
        if (!returnedCode) { reject(new Error('No authorisation code received.')); return; }
        resolve(returnedCode);
      });

      server.on('error', (err) => { clearTimeout(timeout); reject(err); });
      server.listen(EVE_CALLBACK_PORT, '127.0.0.1', () => shell.openExternal(authUrl));
    });
  } catch (err) {
    return { success: false, error: err.message };
  }

  let tokens;
  try {
    const tokenRes = await fetch(EVE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: EVE_CLIENT_ID,
        code_verifier: codeVerifier,
        redirect_uri: EVE_CALLBACK_URL
      })
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return { success: false, error: `Token exchange failed: ${text}` };
    }
    tokens = await tokenRes.json();
  } catch (err) {
    return { success: false, error: `Token request error: ${err.message}` };
  }

  const payload = eveDecodeJwtPayload(tokens.access_token);
  if (!payload) return { success: false, error: 'Could not decode EVE token.' };

  const characterId = parseInt(payload.sub?.split(':')[2], 10);
  const characterName = payload.name;
  if (!characterId || !characterName) return { success: false, error: 'Token missing character info.' };

  // Store EVE tokens (in store file, not keytar which has size limits)
  const eveTokens = store.get('eveTokens', {});
  eveTokens[characterId] = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in || 1200) * 1000
  };
  store.set('eveTokens', eveTokens);

  const accounts = store.get('accounts', []);
  const account = accounts.find(a => a.id === accountId);
  if (account) {
    if (!account.eveCharacters) account.eveCharacters = [];
    if (!account.eveCharacters.find(c => c.characterId === characterId)) {
      account.eveCharacters.push({ characterId, characterName });
    }
    store.set('accounts', accounts);
    // Notify renderer that EVE character was linked
    send('eve-character-linked', { accountId, characterId, characterName });

    // Fetch character location and send to renderer
    try {
      console.log(`Fetching location for character ${characterId} with token...`);
      const locResp = await fetch(`https://esi.evetech.net/latest/characters/${characterId}/location/`, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` }
      });
      console.log(`Location response status: ${locResp.status}`);
      if (locResp.ok) {
        const locData = await locResp.json();
        console.log(`Character location: system ${locData.solar_system_id}`);
        const systemId = locData.solar_system_id;
        const systemResp = await fetch(`https://esi.evetech.net/latest/universe/systems/${systemId}/`);
        if (systemResp.ok) {
          const systemData = await systemResp.json();
          const systemName = systemData.name;
          console.log(`System: ${systemName}, sending eve-location-update`);
          // Try to find region name
          let regionName = '';
          try {
            const constResp = await fetch(`https://esi.evetech.net/latest/universe/constellations/${systemData.constellation_id}/`);
            if (constResp.ok) {
              const constData = await constResp.json();
              const regionResp = await fetch(`https://esi.evetech.net/latest/universe/regions/${constData.region_id}/`);
              if (regionResp.ok) {
                const regionData = await regionResp.json();
                regionName = regionData.name;
              }
            }
          } catch (err) {
            console.warn('Failed to fetch region name:', err.message);
          }
          console.log(`Sending eve-location-update event with region: ${regionName}`);
          send('eve-location-update', { accountId, characterId, characterName, systemId, systemName, regionName });
        } else {
          console.error(`Failed to fetch system ${systemId}:`, systemResp.status);
        }
      } else {
        console.error('Failed to fetch character location:', locResp.status, locResp.statusText);
      }
    } catch (err) {
      console.error('Failed to fetch character location:', err);
    }
  }

  return { success: true, characterId, characterName };
});

ipcMain.handle('eve-unlink-character', async (e, { accountId, characterId }) => {
  const eveTokens = store.get('eveTokens', {});
  delete eveTokens[characterId];
  store.set('eveTokens', eveTokens);

  const accounts = store.get('accounts', []);
  const account = accounts.find(a => a.id === accountId);
  if (account?.eveCharacters) {
    account.eveCharacters = account.eveCharacters.filter(c => c.characterId !== characterId);
    store.set('accounts', accounts);
  }
  return { success: true };
});

ipcMain.handle('eve-get-characters', async (e, { accountId }) => {
  const accounts = store.get('accounts', []);
  const account = accounts.find(a => a.id === accountId);
  return account?.eveCharacters || [];
});


ipcMain.handle('eve-load-region-map', async (e, { systemId }) => {
  try {
    console.log(`eve-load-region-map: loading region for system ${systemId}`);

    const esi = 'https://esi.evetech.net/latest';

    // Get system info to find its region
    const systemResp = await fetch(`${esi}/universe/systems/${systemId}/`);
    console.log(`System response status: ${systemResp.status}`);
    if (!systemResp.ok) {
      console.error(`Failed to fetch system ${systemId}: ${systemResp.status}`);
      return null;
    }
    const system = await systemResp.json();
    const constellationId = system.constellation_id;
    console.log(`System ${systemId} is in constellation ${constellationId}`);

    // Get constellation to find region
    const constResp = await fetch(`${esi}/universe/constellations/${constellationId}/`);
    if (!constResp.ok) {
      console.error(`Failed to fetch constellation ${constellationId}: ${constResp.status}`);
      return null;
    }
    const constellation = await constResp.json();
    const regionId = constellation.region_id;
    console.log(`Constellation is in region ${regionId}`);

    // Get region info and all systems in this region
    const regionResp = await fetch(`${esi}/universe/regions/${regionId}/`);
    console.log(`Region response status: ${regionResp.status}`);
    if (!regionResp.ok) {
      console.error(`Failed to fetch region ${regionId}: ${regionResp.status}`);
      return null;
    }
    const apiRegionData = await regionResp.json();
    // Region contains constellations array, we need to get systems from each constellation
    const constellationIds = apiRegionData.constellations || [];
    console.log(`Region has ${constellationIds.length} constellations`);

    const systemIds = [];
    for (const constId of constellationIds) {
      try {
        const cResp = await fetch(`${esi}/universe/constellations/${constId}/`);
        if (cResp.ok) {
          const cData = await cResp.json();
          systemIds.push(...(cData.systems || []));
        }
      } catch (err) {
        console.warn(`Failed to fetch constellation ${constId}:`, err.message);
      }
    }
    console.log(`Region has ${systemIds.length} systems`);

    // Fetch all system details
    const systems = [];
    const systemDetails = {};

    for (const sysId of systemIds) {
      try {
        const resp = await fetch(`${esi}/universe/systems/${sysId}/`);
        if (!resp.ok) continue;
        const sys = await resp.json();
        systems.push({
          id: sysId,
          name: sys.name,
          x: sys.position?.x || 0,
          y: sys.position?.y || 0,
          z: sys.position?.z || 0,
          security: sys.security_status || 0
        });
        systemDetails[sysId] = sys;
      } catch (err) {
        console.error(`Failed to fetch system ${sysId}:`, err.message);
      }
    }

    // Build connections: systems connected by stargates
    const connections = [];
    const connectionSet = new Set();

    for (const sys of systems) {
      const sysData = systemDetails[sys.id];
      if (sysData?.stargates) {
        for (const gate of sysData.stargates) {
          try {
            const gateResp = await fetch(`${esi}/universe/stargates/${gate}/`);
            if (gateResp.ok) {
              const gateData = await gateResp.json();
              const destSystemId = gateData.destination?.system_id;
              if (destSystemId && systemIds.includes(destSystemId)) {
                const pair = [Math.min(sys.id, destSystemId), Math.max(sys.id, destSystemId)].join(',');
                if (!connectionSet.has(pair)) {
                  connectionSet.add(pair);
                  connections.push([sys.id, destSystemId]);
                }
              }
            }
          } catch (err) {
            // Ignore individual gate fetch errors
          }
        }
      }
    }

    return {
      regionName: apiRegionData.name,
      regionId,
      currentSystemId: systemId,
      systems,
      connections
    };
  } catch (err) {
    console.error('eve-load-region-map error:', err);
    return null;
  }
});

// ─────────────────────────────────────────────
//  Message Archive Management (MAM)
// ─────────────────────────────────────────────
ipcMain.handle('load-message-history', async (e, { accountId, with: withJid, count = 50 }) => {
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

// ─────────────────────────────────────────────
//  Room Discovery (XEP-0030)
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
//  Update checker
// ─────────────────────────────────────────────
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

ipcMain.handle('check-update', performUpdateCheck);

ipcMain.handle('get-version', () => {
  return require('../package.json').version;
});

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────

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
  startEveLocationPolling();  // Start polling EVE character locations

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
  stopEveLocationPolling();
  // Disconnect all XMPP connections
  for (const id in connections) {
    try {
      await destroyConnection(id);
    } catch (err) {
      console.error(`Error destroying connection ${id}:`, err);
    }
  }
});
