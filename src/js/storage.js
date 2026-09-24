'use strict';
// Persistence: accounts, chat state, message history (IndexedDB), app settings.
// Part of the renderer: index.html loads src/js/*.js in order; they share one global scope.

// ─────────────────────────────────────────────
//  Persistence
// ─────────────────────────────────────────────
function saveAccounts() {
  const safe = state.accounts.map(({ id, username, password, server, port, displayName, color }) =>
    ({ id, username, password, server, port, displayName, color })
  );
  ipcRenderer.send('save-accounts', safe);
}

function saveChatState(key) {
  const chat = state.chats[key];
  if (!chat) return;
  const data = {
    lastReadTs: chat.lastReadTs || 0,
    unread: 0,  // Reset unread when saving
    motd: chat.motd || ''
  };
  localStorage.setItem('chat_' + key, JSON.stringify(data));
}

function loadChatState(key) {
  try {
    const data = JSON.parse(localStorage.getItem('chat_' + key) || '{}');
    return data;
  } catch {
    return {};
  }
}

function markChatAsRead(key) {
  const chat = state.chats[key];
  if (!chat || !chat.messages.length) return;
  chat.lastReadTs = chat.messages[chat.messages.length - 1].ts;
  chat.unread = 0;
  saveChatState(key);
}

// ─────────────────────────────────────────────
//  Message history (IndexedDB)
// ─────────────────────────────────────────────
// goonfleet.com keeps no server-side archive, so this local store is the only
// history there is. One record per message, indexed by [chat key, timestamp].
const HISTORY_RECENT = 300;       // newest messages per chat loaded at startup
const HISTORY_PAGE = 300;         // messages per "Load older messages" click
const HISTORY_KEEP_ROOM = 5000;   // rooms are pruned to this; DMs and Directorbot are kept
const history = { db: null, recent: new Map(), queue: [], flushScheduled: false };

const idbRequest = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const idbDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});
const chatRange = (key, beforeTs = Infinity) =>
  IDBKeyRange.bound([key, -Infinity], [key, beforeTs], false, beforeTs !== Infinity);

function openHistoryDB() {
  const req = indexedDB.open('beetalk-history', 1);
  req.onupgradeneeded = () => {
    const store = req.result.createObjectStore('messages', { autoIncrement: true });
    store.createIndex('chat_ts', ['chat', 'ts']);
  };
  return idbRequest(req);
}

const toRecord = (key, msg, isRoom) =>
  ({ chat: key, ts: msg.ts || Date.now(), from: msg.from, text: msg.text, me: !!msg.me, room: !!isRoom });
const fromRecord = r => ({ from: r.from, text: r.text, ts: r.ts, me: r.me });

// Up to `limit` messages of a chat older than `beforeTs`, oldest first
async function loadHistoryPage(key, limit, beforeTs = Infinity) {
  if (!history.db) return [];
  const index = history.db.transaction('messages').objectStore('messages').index('chat_ts');
  const out = [];
  await new Promise((resolve, reject) => {
    const req = index.openCursor(chatRange(key, beforeTs), 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve();
      out.push(fromRecord(cursor.value));
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out.reverse();
}

// Every chat key that has stored messages
async function listHistoryChats() {
  const index = history.db.transaction('messages').objectStore('messages').index('chat_ts');
  const keys = [];
  await new Promise((resolve, reject) => {
    const req = index.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      keys.push(cursor.key[0]);
      cursor.continue([cursor.key[0], Infinity]);  // skip to the next chat
    };
    req.onerror = () => reject(req.error);
  });
  return keys;
}

// Keep only the newest HISTORY_KEEP_ROOM messages of a room
async function pruneRoomHistory(key) {
  const tx = history.db.transaction('messages', 'readwrite');
  const index = tx.objectStore('messages').index('chat_ts');
  const excess = (await idbRequest(index.count(chatRange(key)))) - HISTORY_KEEP_ROOM;
  if (excess <= 0) return;
  let deleted = 0;
  const req = index.openCursor(chatRange(key));
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor || deleted >= excess) return;
    cursor.delete();
    deleted++;
    cursor.continue();
  };
  await idbDone(tx);
}

// One-time move of the old localStorage history (chat_messages_*) into IndexedDB
async function migrateLocalStorageHistory() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('chat_messages_'));
  if (!keys.length) return;
  const tx = history.db.transaction('messages', 'readwrite');
  const store = tx.objectStore('messages');
  for (const lsKey of keys) {
    const key = lsKey.slice('chat_messages_'.length);
    const isRoom = /@conference\./.test(key.split('::')[1] || '');
    try {
      JSON.parse(localStorage.getItem(lsKey) || '[]')
        .filter(m => !m.system && m.text)
        .forEach(m => store.add(toRecord(key, m, isRoom)));
    } catch { /* unreadable entry: skip */ }
  }
  await idbDone(tx);
  keys.forEach(k => localStorage.removeItem(k));
  console.log(`Moved message history of ${keys.length} chats to IndexedDB`);
}

// Open the store and preload recent messages of every chat. Called before connecting.
async function initHistory() {
  try {
    history.db = await openHistoryDB();
    await migrateLocalStorageHistory();
    for (const key of await listHistoryChats()) {
      const recent = await loadHistoryPage(key, HISTORY_RECENT);
      if (/@conference\./.test(key.split('::')[1] || '') && !key.includes('/')) await pruneRoomHistory(key);
      history.recent.set(key, recent);
    }
  } catch (err) {
    console.error('Message history unavailable:', err);
    history.db = null;
  }
}

// Recent stored messages for a chat (used once, when the chat is created)
function loadChatMessages(key) {
  const msgs = history.recent.get(key) || [];
  history.recent.delete(key);
  return msgs;
}

// Store a message. Messages arriving in the same burst share one transaction.
// No timer: BeeTalk usually sits hidden in the tray, where Chromium throttles
// timers for up to a minute, and a quit in that window would lose messages.
function recordMessage(key, msg, isRoom) {
  if (msg.system || !msg.text) return;
  history.queue.push(toRecord(key, msg, isRoom));
  if (!history.flushScheduled) {
    history.flushScheduled = true;
    queueMicrotask(flushHistory);
  }
}

async function flushHistory() {
  history.flushScheduled = false;
  if (!history.db || !history.queue.length) return;
  const batch = history.queue.splice(0);
  try {
    const tx = history.db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    batch.forEach(r => store.add(r));
    await idbDone(tx);
  } catch (err) {
    console.error('Failed to save messages:', err);
  }
}
async function deleteChatHistory(key) {
  history.queue = history.queue.filter(r => r.chat !== key);
  if (!history.db) return;
  const tx = history.db.transaction('messages', 'readwrite');
  const req = tx.objectStore('messages').index('chat_ts').openCursor(chatRange(key));
  req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } };
  await idbDone(tx).catch(err => console.error('Failed to delete history:', err));
}

// Newest-first matches in a chat's full stored history (sender or text)
async function searchChatHistory(key, query, limit = 200) {
  await flushHistory();
  if (!history.db) return [];
  const q = query.toLowerCase();
  const index = history.db.transaction('messages').objectStore('messages').index('chat_ts');
  const out = [];
  await new Promise((resolve, reject) => {
    const req = index.openCursor(chatRange(key), 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve();
      const r = cursor.value;
      if (r.text.toLowerCase().includes(q) || (r.from || '').toLowerCase().includes(q)) out.push(fromRecord(r));
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out;
}

// "Load older messages": first reveal messages already in memory, then page in from the store
async function loadOlderMessages(key) {
  const chat = state.chats[key];
  if (!chat) return;
  const shown = chat.type === 'room' ? Math.max(chat.displayLimit || 0, MAX_DISPLAYED_MESSAGES_ROOM) : Infinity;
  if (chat.messages.length <= shown) {
    await flushHistory();
    const oldest = chat.messages.find(m => !m.system && m.ts);
    const older = await loadHistoryPage(key, HISTORY_PAGE, oldest ? oldest.ts : Infinity);
    if (older.length < HISTORY_PAGE) chat.historyExhausted = true;
    chat.messages.unshift(...older);
  }
  if (chat.type === 'room') chat.displayLimit = shown + HISTORY_PAGE;
  if (state.activeChatKey === key) openChat(key, false, 'keep');
}
window.loadOlderMessages = loadOlderMessages;

function showChatSearchModal() {
  const key = state.activeChatKey;
  const chat = state.chats[key];
  if (!chat) return;
  showModal(`
    <div class="modal-title">Search in ${esc(chat.name)}</div>
    <input class="form-input" id="chat-search-input" placeholder="Search messages or senders…" autocomplete="off" />
    <div id="chat-search-results" class="chat-search-results"></div>
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Close</button>
    </div>
  `);
  const input = $('chat-search-input');
  const results = $('chat-search-results');
  let timer = null, seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      const mySeq = ++seq;
      if (q.length < 2) { results.textContent = ''; return; }
      const found = await searchChatHistory(key, q);
      if (mySeq !== seq) return;  // a newer search is running
      results.textContent = '';
      if (!found.length) {
        results.textContent = 'No messages found.';
        return;
      }
      found.forEach(m => {
        const row = document.createElement('div');
        row.className = 'chat-search-row';
        const meta = document.createElement('div');
        meta.className = 'chat-search-meta';
        meta.textContent = `${m.from || ''} · ${formatDay(m.ts)} ${formatTime(m.ts)}`;
        const text = document.createElement('div');
        text.textContent = m.text;
        linkifyUrls(text);
        row.append(meta, text);
        results.appendChild(row);
      });
      if (found.length >= 200) {
        const more = document.createElement('div');
        more.className = 'chat-search-meta';
        more.textContent = 'Showing the 200 newest matches; refine the search to see older ones.';
        results.appendChild(more);
      }
    }, 250);
  });
  input.focus();
}

function saveActiveDMs(accountId) {
  // Save metadata of DM chats that aren't in the roster (for persistence across restarts)
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  const activeDMs = Object.entries(state.chats)
    .filter(([key, chat]) => 
      chat.accountId === accountId && 
      chat.type === 'dm' && 
      !acct.roster?.[chat.jid] // Not in roster
    )
    .map(([key, chat]) => ({
      jid: chat.jid,
      name: chat.name,
      type: 'dm',
      accountId: chat.accountId,
      groups: chat.groups || []  // Save group assignments
    }));

  if (activeDMs.length > 0) {
    localStorage.setItem('activeDMs_' + accountId, JSON.stringify(activeDMs));
  }
}

function loadActiveDMs(accountId) {
  // Load DM chats that aren't in the roster from a previous session
  try {
    const saved = JSON.parse(localStorage.getItem('activeDMs_' + accountId) || '[]');
    saved.forEach(dmData => {
      const key = chatKey(accountId, dmData.jid);
      ensureChat(key, { 
        type: 'dm', 
        name: dmData.name, 
        jid: dmData.jid, 
        accountId,
        groups: dmData.groups || []  // Restore group assignments
      });
    });
  } catch (err) {
    console.error('Failed to load active DMs:', err);
  }
}

async function loadAndConnect() {
  const saved = await ipcRenderer.invoke('load-accounts');
  if (!saved?.length) {
    renderAccountBar();  // first run: show the add-account buttons
    return;
  }
  saved.forEach(data => {
    const acct = { ...data, status: 'offline', roster: {}, presence: 'available', jid: data.username + '@' + data.server, groups: {}, roomGroups: {} };

    // Load saved roster from localStorage
    const savedRoster = getSavedRoster(acct.id);
    acct.roster = savedRoster;

    state.accounts.push(acct);

    // Create directorbot chat for this account
    const directorBotJid = 'directorbot@' + data.server;
    const key = chatKey(acct.id, directorBotJid);
    ensureChat(key, { type: 'dm', name: 'Directorbot', jid: directorBotJid, accountId: acct.id });

    // Load active DM chats from previous session
    loadActiveDMs(acct.id);
  });
  state.activeAccountId = state.accounts[0].id;
  renderAccountBar();
  renderLeftPanel();

  state.accounts.forEach(a => ipcRenderer.send('xmpp-connect', a));

  // Apply saved theme on load
  const settings = getAppSettings();
  if (settings.theme) {
    setTheme(settings.theme);
  }
}


// ─────────────────────────────────────────────
//  App Settings
// ─────────────────────────────────────────────
let emoticons = {};  // Loaded emoticons organized by folder
let emoticonsList = [];  // Flat list for parsing
let appVersion = '';  // Cached app version

function getAppSettings() {
  try {
    return JSON.parse(localStorage.getItem('appSettings') || '{}');
  } catch {
    return {};
  }
}

function saveAppSettings(settings) {
  const current = getAppSettings();
  const merged = { ...current, ...settings };
  localStorage.setItem('appSettings', JSON.stringify(merged));
}

function setTheme(themeName) {
  document.documentElement.setAttribute('data-theme', themeName);
  saveAppSettings({ theme: themeName });
}
