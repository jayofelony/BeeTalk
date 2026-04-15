const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell } = require('electron');
const path = require('path');
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
    icon: path.join(__dirname, '../assets/icon.png')
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
  tray.setToolTip('Gabber');

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
        subscription: item.attrs.subscription
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

    // Get timestamp from delay element if present (for archived messages), otherwise use now
    let ts = Date.now();
    const delayEl = stanza.getChild('delay', 'urn:xmpp:delay');
    if (delayEl && delayEl.attrs.stamp) {
      ts = new Date(delayEl.attrs.stamp).getTime();
    }

    send('xmpp-message', { accountId, from, body, type, ts });

    if (!mainWindow.isFocused()) {
      const label = type === 'groupchat'
        ? from.split('@')[0] + ' / ' + (from.split('/')[1] || '')
        : from.split('@')[0];
      new Notification({ title: label, body: body.slice(0, 120) }).show();
      unreadCount++;
      tray && tray.setToolTip(`Gabber (${unreadCount} unread)`);
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
    console.log('Starting update check...');
    const https = require('https');
    const currentVersion = require('../package.json').version;
    console.log('Current version:', currentVersion);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('Update check timed out');
        resolve({ status: 'error', error: 'Update check timed out' });
      }, 8000);

      const options = {
        hostname: 'api.github.com',
        path: '/repos/jayofelony/BeeTalk/tags?per_page=1',
        method: 'GET',
        headers: { 'User-Agent': 'BeeTalk' }
      };

      console.log('Fetching tags from GitHub...');
      https.request(options, (res) => {
        console.log('Got response, status:', res.statusCode);
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timeout);
          console.log('Raw response data:', data.slice(0, 200));
          try {
            const tags = JSON.parse(data);
            console.log('Parsed tags:', tags.length);

            if (!Array.isArray(tags) || tags.length === 0) {
              console.log('No tags found');
              resolve({ status: 'error', error: 'No tags found in repository' });
              return;
            }

            const latestTag = tags[0];
            console.log('Latest tag:', latestTag.name);
            const latestVersion = latestTag.name.replace(/^v/, '');
            const comparison = compareVersions(currentVersion, latestVersion);
            console.log('Version comparison:', currentVersion, 'vs', latestVersion, '=', comparison);

            if (comparison > 0) {
              console.log('Update available, fetching release info...');
              // Get the release/pre-release info for this tag
              const releaseOptions = {
                hostname: 'api.github.com',
                path: `/repos/jayofelony/BeeTalk/releases/tags/${latestTag.name}`,
                method: 'GET',
                headers: { 'User-Agent': 'BeeTalk' }
              };

              https.request(releaseOptions, (releaseRes) => {
                console.log('Release response status:', releaseRes.statusCode);
                let releaseData = '';
                releaseRes.on('data', chunk => releaseData += chunk);
                releaseRes.on('end', () => {
                  try {
                    const release = JSON.parse(releaseData);
                    console.log('Parsed release');
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
                // If release endpoint fails, just report update available with release page URL
                resolve({
                  status: 'update-available',
                  version: latestVersion,
                  releaseNotes: 'Update available',
                  releaseUrl: `https://github.com/jayofelony/BeeTalk/releases/tag/${latestTag.name}`
                });
              }).end();
            } else {
              console.log('Already up to date');
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

if (process.platform === 'win32') {
  app.setAppUserModelId('com.beetalk.app');
}

app.whenReady().then(async () => {
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
