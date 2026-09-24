'use strict';
// Chat and room state helpers, duplicates, join history, DM archive loading.
// Part of the renderer: index.html loads src/js/*.js in order; they share one global scope.

// ─────────────────────────────────────────────
//  Chat helpers
// ─────────────────────────────────────────────
function ensureChat(key, defaults) {
  if (!state.chats[key]) {
    const savedState = loadChatState(key);
    // Load stored messages now (not lazily on open): incoming history is
    // de-duplicated against them.
    const messages = loadChatMessages(key);
    state.chats[key] = { unread: 0, newMessagesWhileUnfocused: 0, participants: {}, motd: '', ...defaults, ...savedState, messages,
      historyExhausted: messages.length < HISTORY_RECENT };
  }
}

// History replays (room rejoin, offline delivery) can repeat messages we already have.
// The live copy was stamped with our clock and the replay with the server's, so allow some skew.
function isDuplicateMessage(chat, msg) {
  const recent = chat.messages.slice(-300);
  return recent.some(m => !m.system && m.from === msg.from && m.text === msg.text && Math.abs(m.ts - msg.ts) < 2 * 60 * 1000);
}

// ISO timestamp for the MUC `since` history parameter: slightly before our last message,
// duplicates are filtered by isDuplicateMessage().
function historySince(chat) {
  const last = [...(chat?.messages || [])].reverse().find(m => !m.system && m.ts);
  return last ? new Date(last.ts - 60 * 1000).toISOString() : undefined;
}

// Does a room message mention our nick? Whole word, case-insensitive (so "Jay" doesn't match "jaywalk")
function mentionsMe(chat, text) {
  const nick = (chat?.myNick || '').trim();
  if (chat?.type !== 'room' || nick.length < 3) return false;
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'iu').test(text);
}

function notifyIfNeeded(key, title, body) {
  const acct = state.accounts.find(a => a.id === state.chats[key]?.accountId);
  if (state.appIsFocused || acct?.presence === 'dnd') return;
  ipcRenderer.send('show-notification', { title, body: String(body).slice(0, 120), chatKey: key });
}

function pushMessage(key, msg) {
  const chat = state.chats[key];
  if (!chat) return;
  
  // Ensure message has a valid timestamp
  if (!msg.ts || msg.ts === 0) {
    msg.ts = Date.now();
  }
  
  chat.messages.push(msg);
  
  // For rooms, enforce max message limit in memory (keep only recent messages)
  const roomLimit = Math.max(chat.displayLimit || 0, MAX_DISPLAYED_MESSAGES_ROOM);
  if (chat.type === 'room' && chat.messages.length > roomLimit * 2) {
    chat.messages = chat.messages.slice(-roomLimit);
  }
  
  chat.lastTs      = msg.ts;
  chat.lastPreview = (msg.me ? 'You: ' : '') + msg.text;

  // Seen live in the open chat (window focused): it's read
  if (state.activeChatKey === key && state.appIsFocused && msg.ts > (chat.lastReadTs || 0)) {
    chat.lastReadTs = msg.ts;
  }

  // Mark as unread only if not in active chat AND message is newer than last read
  if (state.activeChatKey !== key) {
    const lastReadTs = chat.lastReadTs || 0;
    if (msg.ts > lastReadTs) {
      chat.unread = (chat.unread || 0) + 1;
    }
  }

  // Increment new message counter if app is not focused
  if (!state.appIsFocused) {
    chat.newMessagesWhileUnfocused = (chat.newMessagesWhileUnfocused || 0) + 1;
  }

  if (state.activeChatKey === key) {
    appendMessage(msg, chat);
    scrollToBottom();
  }

  scheduleLeftPanel();
  saveChatState(key);  // Persist chat state
  recordMessage(key, msg, chat.type === 'room');
}

function addSystemMsg(key, accountId, text) {
  if (!key) {
    Object.keys(state.chats).forEach(k => {
      if (state.chats[k].accountId === accountId) addSystemMsg(k, accountId, text);
    });
    return;
  }
  const chat = state.chats[key];
  if (!chat) return;
  const msg = { system: true, text, ts: Date.now() };
  chat.messages.push(msg);
  if (state.activeChatKey === key) {
    const el = document.createElement('div');
    el.className = 'system-msg';
    el.textContent = text;
    messagesArea.appendChild(el);
    scrollToBottom();
  }
}

// ─────────────────────────────────────────────
//  Room handling
// ─────────────────────────────────────────────
function sendJoinRoom(acct, roomJid, nick) {
  nick = acct.displayName;
  const key = chatKey(acct.id, roomJid);
  ensureChat(key, { type: 'room', name: roomJid.split('@')[0], jid: roomJid, accountId: acct.id, myNick: nick });
  state.chats[key].myNick = nick;
  ipcRenderer.send('xmpp-join-room', { accountId: acct.id, roomJid, nick, since: historySince(state.chats[key]) });
  saveRooms(acct.id);
  renderLeftPanel();
}

function leaveRoom(acct, roomJid) {
  const key  = chatKey(acct.id, roomJid);
  const nick = state.chats[key]?.myNick || acct.username;
  ipcRenderer.send('xmpp-leave-room', { accountId: acct.id, roomJid, nick });
  delete state.chats[key];
  saveRooms(acct.id);
  renderLeftPanel();
  if (state.activeChatKey === key) { state.activeChatKey = null; showWelcome(); }
}

function getSavedRooms(accountId) {
  try { return JSON.parse(localStorage.getItem('rooms_' + accountId) || '[]'); } catch { return []; }
}
function saveRooms(accountId) {
  const rooms = Object.values(state.chats)
    .filter(c => c.accountId === accountId && c.type === 'room')
    .map(c => ({ jid: c.jid, nick: c.myNick, groups: c.groups || [] }));
  localStorage.setItem('rooms_' + accountId, JSON.stringify(rooms));
}

function getSavedRoomAssignments(accountId) {
  try {
    const rooms = JSON.parse(localStorage.getItem('rooms_' + accountId) || '[]');
    const assignments = {};
    rooms.forEach(r => {
      if (r.groups && r.groups.length > 0) {
        assignments[r.jid] = r.groups;
      }
    });
    return assignments;
  } catch { return {}; }
}

function getSavedRoster(accountId) {
  try { return JSON.parse(localStorage.getItem('roster_' + accountId) || '{}'); } catch { return {}; }
}
function saveRoster(accountId, roster) {
  const rosterToSave = {};
  Object.keys(roster).forEach(jid => {
    const contact = roster[jid];
    rosterToSave[jid] = {
      jid: contact.jid,
      name: contact.name,
      subscription: contact.subscription,
      groups: contact.groups || []
    };
  });
  localStorage.setItem('roster_' + accountId, JSON.stringify(rosterToSave));
}

async function loadMessageHistory(key) {
  const chat = state.chats[key];
  // Only real DMs: rooms get history on join, room PMs (room/nick) and Directorbot aren't archived
  if (!chat || chat.type === 'room' || chat.jid.includes('/') || chat.jid.startsWith('directorbot@')) return;
  const account = state.accounts.find(a => a.id === chat.accountId);
  if (!account || account.status !== 'online') return;

  try {
    const history = await ipcRenderer.invoke('load-message-history', { accountId: account.id, with: chat.jid, count: 100 });
    if (!history?.length || state.chats[key] !== chat) return;

    // Same sender naming as live messages, so duplicates can be recognised
    const added = history
      .map(m => ({ from: m.me ? account.username : chat.name, text: m.text, ts: m.ts, me: m.me }))
      .filter(m => !isDuplicateMessage(chat, m));
    if (!added.length) return;

    chat.messages.push(...added);
    chat.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    added.forEach(m => recordMessage(key, m, false));
    if (state.activeChatKey === key) openChat(key, false);
  } catch (err) {
    console.error('Failed to load message history:', err);
  }
}
