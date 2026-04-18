const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { client, xml } = require('@xmpp/client');
const { autoUpdater } = require('electron-updater');
const keytar = require('keytar');

const store = new Store();
const KEYTAR_SERVICE = 'BeeTalk';
const OLD_KEYTAR_SERVICE = 'Gabber'; // for migration

let mainWindow;
let tray;
let unreadCount = 0;

const connections    = {};  // accountId -> { _xmpp, account }
const reconnectTimers = {}; // accountId -> timer handle

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
        try { await keytar.deletePassword(OLD_KEYTAR_SERVICE, accountId); } catch {}
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
    send('xmpp-presence', {
      accountId,
      from: stanza.attrs.from,
      type: stanza.attrs.type || 'available',
      show: stanza.getChildText('show') || 'available'
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
  c._xmpp.send(xml('message', { to, type: type || 'chat' }, xml('body', {}, body))).catch(() => {});
});

ipcMain.on('xmpp-send-presence', (e, { accountId, show, status }) => {
  const c = connections[accountId];
  if (!c) return;
  const kids = [];
  if (show && show !== 'available') kids.push(xml('show', {}, show));
  if (status) kids.push(xml('status', {}, status));
  c._xmpp.send(xml('presence', {}, ...kids)).catch(() => {});
});


ipcMain.on('xmpp-add-contact', (e, { accountId, jid, name }) => {
  const c = connections[accountId];
  if (!c) return;
  // Send subscription request
  c._xmpp.send(xml('presence', { to: jid, type: 'subscribe' })).catch(() => {});
});

ipcMain.on('xmpp-update-contact-groups', (e, { accountId, jid, name, groups }) => {
  const c = connections[accountId];
  if (!c) return;
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
//  Message Archive Management (MAM)
// ─────────────────────────────────────────────
ipcMain.handle('load-message-history', async (e, { accountId, with: withJid, count = 50 }) => {
  const conn = connections[accountId];
  if (!conn) return [];

  const xmpp = conn._xmpp;
  const messages = [];
  let complete = false;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      stanzaHandler();
      resolve(messages);
    }, 5000);

    function stanzaHandler(stanza) {
      resetTimeout();
      if (!stanza) return;

      const name = stanza.name;

      // Handle MAM result
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

              messages.push({
                from,
                text: body,
                ts,
                me: false
              });
            }
          }
        }
      }

      // Handle IQ result (RSM - Result Set Management)
      if (name === 'iq' && stanza.attrs.type === 'result') {
        const fin = stanza.getChild('fin', 'urn:xmpp:mam:2');
        if (fin) {
          const set = fin.getChild('set', 'http://jabber.org/protocol/rsm');
          if (set) {
            const isComplete = fin.attrs.complete === 'true';
            if (isComplete) complete = true;
          }
          stanzaHandler();
        }
      }
    }

    function resetTimeout() {
      clearTimeout(timeout);
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

    xmpp.send(mamQuery).catch(err => {
      console.error('MAM query error:', err);
      xmpp.off('stanza', listener);
      resolve(messages);
    });

    // Cleanup after timeout or completion
    const originalTimeout = timeout;
    const cleanupTimer = setInterval(() => {
      if (complete) {
        clearInterval(cleanupTimer);
        xmpp.off('stanza', listener);
        resolve(messages.reverse()); // Reverse to get chronological order
      }
    }, 100);

    setTimeout(() => {
      clearInterval(cleanupTimer);
      xmpp.off('stanza', listener);
      resolve(messages.reverse());
    }, 6000);
  });
});

// ─────────────────────────────────────────────
//  Room Discovery (XEP-0030)
// ─────────────────────────────────────────────
async function discoverRoomsOnServer(xmpp, server, timeout = 8000) {
  const rooms = [];
  let foundResponse = false;

  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      cleanup();
      console.log(`Room discovery timeout on ${server}`);
      resolve([]);
    }, timeout);

    function cleanup() {
      clearTimeout(timeoutHandle);
      xmpp.removeListener('stanza', listener);
    }

    function listener(stanza) {
      if (stanza.name !== 'iq') return;
      if (stanza.attrs.type !== 'result') return;
      if (stanza.attrs.id !== queryId) return;

      foundResponse = true;
      clearTimeout(timeoutHandle);

      const query = stanza.getChild('query', 'http://jabber.org/protocol/disco#items');
      if (query) {
        const items = query.getChildren('item');
        console.log(`Found ${items.length} rooms on ${server}`);

        items.forEach(item => {
          const jid = item.attrs.jid;
          const name = item.attrs.name || jid.split('@')[0];
          if (jid && name) {
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

    console.log(`Querying ${server} for available rooms (id: ${queryId})...`);

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
    console.log('No connection found for account', accountId);
    return [];
  }

  const xmpp = conn._xmpp;

  // Try multiple MUC server variants
  const mucServers = [
    'conference.goonfleet.com',
    'muc.goonfleet.com',
    'rooms.goonfleet.com'
  ];

  for (const server of mucServers) {
    console.log(`Attempting room discovery on ${server}...`);
    const rooms = await discoverRoomsOnServer(xmpp, server, 8000);

    if (rooms.length > 0) {
      console.log(`Successfully discovered ${rooms.length} rooms on ${server}`);
      return rooms.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  console.log('Room discovery failed on all servers');
  return [];
});

// ─────────────────────────────────────────────
//  Update checker
// ─────────────────────────────────────────────
function setupAutoUpdater() {
  // Configure electron-updater to use GitHub releases
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'jayofelony',
    repo: 'BeeTalk'
  });

  // Auto-download updates when available, auto-install on quit
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    if (mainWindow) {
      send('update-available', {
        status: 'update-available',
        version: info.version,
        releaseNotes: info.releaseNotes || 'Update available',
        releaseUrl: `https://github.com/jayofelony/BeeTalk/releases/tag/v${info.version}`
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('Already up to date');
  });

  autoUpdater.on('error', (err) => {
    // Silently ignore "Unable to find latest version" - this is normal when only pre-releases exist
    if (err.message && err.message.includes('Unable to find latest version')) {
      console.log('No stable release found (only pre-releases available)');
      return;
    }
    console.error('Update error:', err.message);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    console.log(`Download progress: ${progressObj.percent}%`);
    if (mainWindow) {
      send('update-progress', { percent: progressObj.percent });
    }
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('Update downloaded, will install on quit');
    if (mainWindow) {
      send('update-downloaded', {});
    }
  });
}

function compareVersions(currentVersion, newVersion) {
  const current = currentVersion.split('.').map(Number);
  const newer = newVersion.split('.').map(Number);

  for (let i = 0; i < Math.max(current.length, newer.length); i++) {
    const curr = current[i] || 0;
    const next = newer[i] || 0;
    if (next > curr) return true;  // newer version is greater
    if (next < curr) return false; // current version is greater
  }
  return false; // versions are equal
}

let pendingUpdateInfo = null; // Store update info for download

async function checkForUpdates() {
  let result = null;

  // Try to check for stable releases first
  try {
    result = await autoUpdater.checkForUpdates();
  } catch (err) {
    // If we get a 406 or "Unable to find latest version" error, it means no stable releases exist
    if (err.message && (err.message.includes('Unable to find latest version') || err.statusCode === 406)) {
      console.log('No stable release found, checking tags...');
    } else {
      // Other errors should be reported
      console.error('Failed to check for stable releases:', err.message);
      return { status: 'error', error: err.message };
    }
  }

  // If no stable release found, try checking tags
  if (!result) {
    try {
      const https = require('https');
      const currentVersion = require('../package.json').version;
      console.log('Current version:', currentVersion);

      const tagInfo = await new Promise((resolve, reject) => {
        https.get('https://api.github.com/repos/jayofelony/BeeTalk/tags', {
          headers: { 'User-Agent': 'BeeTalk' }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const tags = JSON.parse(data);
              console.log('Fetched tags:', tags.map(t => t.name));
              // Find the first tag version newer than current
              for (const tag of tags) {
                const tagVersion = tag.name.replace(/^v/, '');
                console.log(`Comparing ${currentVersion} with ${tagVersion}:`, compareVersions(currentVersion, tagVersion));
                if (compareVersions(currentVersion, tagVersion)) {
                  console.log('Found newer version:', tagVersion);
                  resolve({
                    version: tagVersion,
                    releaseNotes: `New version available: ${tagVersion}`
                  });
                  return;
                }
              }
              console.log('No newer version found');
              resolve(null);
            } catch (e) {
              console.error('Tag parsing error:', e);
              reject(e);
            }
          });
        }).on('error', reject);
      });

      if (tagInfo) {
        result = tagInfo;
        console.log('Found newer tag:', result.version);
        // Store update info for download
        pendingUpdateInfo = {
          version: result.version,
          downloadUrl: `https://github.com/jayofelony/BeeTalk/releases/tag/v${result.version}`
        };
        // Emit update-available event for tag
        if (mainWindow) {
          send('update-available', {
            status: 'update-available',
            version: result.version,
            releaseNotes: result.releaseNotes,
            releaseUrl: `https://github.com/jayofelony/BeeTalk/releases/tag/v${result.version}`
          });
        }
      }
    } catch (err) {
      console.error('Tag check error:', err.message);
      console.error('Tag check error stack:', err);
      return { status: 'error', error: 'Failed to check for updates: ' + err.message };
    }
  }

  if (!result) {
    return { status: 'up-to-date' };
  }
  return { status: 'up-to-date' };
}

ipcMain.handle('check-update', checkForUpdates);
ipcMain.handle('download-update', async () => {
  try {
    // Try to download using autoUpdater first (for official releases)
    await autoUpdater.downloadUpdate();
    return { status: 'downloading' };
  } catch (err) {
    console.error('autoUpdater download failed:', err.message);

    // If we have pending update info (from tag-based check), fetch release assets and download
    if (pendingUpdateInfo) {
      try {
        const https = require('https');

        // Fetch release info for this tag
        const releaseInfo = await new Promise((resolve, reject) => {
          https.get(`https://api.github.com/repos/jayofelony/BeeTalk/releases/tags/v${pendingUpdateInfo.version}`, {
            headers: { 'User-Agent': 'BeeTalk' }
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(e);
              }
            });
          }).on('error', reject);
        });

        if (releaseInfo && releaseInfo.assets && releaseInfo.assets.length > 0) {
          console.log('Found release assets for', pendingUpdateInfo.version);
          // Let autoUpdater know about this release
          // Try setting feed URL to the specific release and re-check
          autoUpdater.setFeedURL({
            provider: 'github',
            owner: 'jayofelony',
            repo: 'BeeTalk',
            releaseType: 'all'  // Include all release types
          });

          // Trigger download with the release info
          await autoUpdater.downloadUpdate();
          return { status: 'downloading' };
        }
      } catch (assetErr) {
        console.log('Could not fetch release assets:', assetErr.message);
      }

      // Fallback: open the release page
      const { shell } = require('electron');
      shell.openExternal(pendingUpdateInfo.downloadUrl);
      return {
        status: 'error',
        error: 'Opening release page. Please download and install manually.'
      };
    }

    return { status: 'error', error: 'Update download not available' };
  }
});
ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

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

  // Setup auto-updater
  setupAutoUpdater();

  // Check for updates 10 seconds after app starts
  setTimeout(() => {
    checkForUpdates().catch(err => console.error('Update check failed:', err));
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
