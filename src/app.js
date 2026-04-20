'use strict';

// Context isolation: use window.electronAPI instead of ipcRenderer
const ipcRenderer = {
  on: (channel, callback) => {
    // Convert channel name to camelCase function name
    // e.g., 'xmpp-status' -> 'onXmppStatus'
    const camelCase = 'on' + channel.split('-').map((word, i) =>
      i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)
    ).join('');
    const fn = window.electronAPI[camelCase];
    if (fn) fn(callback);
  },
  send: (channel, data) => {
    // Convert channel name to camelCase function name
    // e.g., 'xmpp-connect' -> 'xmppConnect'
    const camelCase = channel.split('-').map((word, i) =>
      i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
    ).join('');
    const fn = window.electronAPI[camelCase];
    if (fn) fn(data);
  },
  invoke: (channel, data) => {
    // e.g., 'load-accounts' -> 'loadAccounts'
    const camelCase = channel.split('-').map((word, i) =>
      i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
    ).join('');
    const fn = window.electronAPI[camelCase];
    if (fn) return fn(data);
    return Promise.resolve(null);
  }
};

// ─────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────
const MAX_DISPLAYED_MESSAGES_ROOM = 500;  // Max messages rendered in a room (keeps history, just limits display)
const RENDER_BATCH_SIZE = 50;  // Messages to render per animation frame
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;  // 10 minutes of inactivity before auto-away

// ─────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────
const state = {
  accounts: [],       // { id, username, password, server, port, displayName, color, status, jid, presence }
  activeAccountId: null,
  chats: {},          // chatKey -> { type, name, jid, accountId, messages[], unread, newMessagesWhileUnfocused, participants, myNick }
  activeChatKey: null,
  search: '',
  appIsFocused: true, // track whether app window is focused
  idleTimer: null,
  userIsIdle: false
};

// ─────────────────────────────────────────────
//  DOM refs
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const accountListEl  = $('account-list');
const contactListEl  = $('contact-list');
const roomListEl     = $('room-list');
const messagesArea   = $('messages-area');
const msgInput       = $('msg-input');
const chatArea       = $('chat-area');
const welcomeScreen  = $('welcome-screen');
const chatHeaderName = $('chat-header-name');
const chatHeaderSub  = $('chat-header-sub');
const chatHeaderAv   = $('chat-header-avatar');
const curJid         = $('cur-jid');
const curStatusText  = $('cur-status-text');
const curStatusDot   = $('cur-status-dot');
const curAvatar      = $('cur-avatar');
const modalOverlay   = $('modal-overlay');
const modalContent   = $('modal-content');
const searchInput    = $('search-input');
const connectionStatusBar = $('connection-status-bar');
const btnReconnect   = $('btn-reconnect');

// ─────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────
function avatarColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
  return 'av-' + (Math.abs(h) % 8);
}
function initials(name) {
  const clean = String(name).replace(/@.*/, '');
  const parts = clean.split(/[\s._-]/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : clean.slice(0, 2).toUpperCase();
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDateTime(ts) {
  const d = new Date(ts);
  const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${dateStr} ${timeStr}`;
}
function formatDay(ts) {
  const d = new Date(ts), today = new Date();
  const diff = (today - d) / 86400000;
  if (diff < 1) return 'Today';
  if (diff < 2) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function chatKey(accountId, jid) { return accountId + '::' + jid; }
function bareJid(jid) { return jid ? jid.split('/')[0] : ''; }
function showModal(html) { modalContent.innerHTML = html; modalOverlay.classList.remove('hidden'); }
function hideModal()     { modalOverlay.classList.add('hidden'); modalContent.innerHTML = ''; }
window.hideModal = hideModal;

// ─────────────────────────────────────────────
//  Idle Detection (Auto-away)
// ─────────────────────────────────────────────
function resetIdleTimer() {
  // Clear existing timer
  if (state.idleTimer) clearTimeout(state.idleTimer);

  // If user was idle, set them back to available
  if (state.userIsIdle) {
    state.userIsIdle = false;
    const acct = getActiveAccount();
    if (acct && acct.status === 'online' && acct.presence === 'away') {
      ipcRenderer.send('xmpp-send-presence', { accountId: acct.id, show: 'available', status: '' });
      acct.presence = 'available';
      renderLeftPanel();
    }
  }

  // Set new timer for idle detection
  state.idleTimer = setTimeout(() => {
    state.userIsIdle = true;
    const acct = getActiveAccount();
    if (acct && acct.status === 'online' && acct.presence !== 'away' && acct.presence !== 'dnd') {
      ipcRenderer.send('xmpp-send-presence', { accountId: acct.id, show: 'away', status: 'Away (idle)' });
      acct.presence = 'away';
      renderLeftPanel();
    }
  }, IDLE_TIMEOUT_MS);
}

function showUpdateAvailableModal(updateInfo) {
  showModal(`
    <div class="modal-title">Update Available</div>
    <div style="margin-bottom: 16px;">
      <p style="color: var(--text2); margin-bottom: 8px;">
        A new version is available: <strong style="color: var(--accent);">${esc(updateInfo.version)}</strong>
      </p>
      <div style="background: rgba(76, 175, 80, 0.1); border-left: 3px solid #4CAF50; padding: 8px; border-radius: 4px; margin-bottom: 12px;">
        <div style="font-size: 11px; color: var(--text2); line-height: 1.5; max-height: 150px; overflow-y: auto; font-family: monospace; white-space: pre-wrap; word-wrap: break-word;">
          ${esc(updateInfo.releaseNotes)}
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Later</button>
      <button class="btn-primary" onclick="openGithubRelease('${esc(updateInfo.releaseUrl)}')">Download Latest Version</button>
    </div>
  `);
}

window.openGithubRelease = (url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    openExternalLink(url);
  }
  hideModal();
};

// Open external links via IPC
function openExternalLink(url) {
  ipcRenderer.send('open-link', url);
}
window.openExternalLink = openExternalLink;

// ─────────────────────────────────────────────
//  IPC events from main process
// ─────────────────────────────────────────────
ipcRenderer.on('xmpp-status', (e, { id, status, jid, error }) => {
  const acct = state.accounts.find(a => a.id === id);
  if (!acct) return;
  acct.status = status;
  if (jid) acct.jid = jid;
  if (status === 'online') {
    // Re-join saved rooms now that we're connected
    const savedRooms = getSavedRooms(id);
    const roomAssignments = getSavedRoomAssignments(id);

    savedRooms.forEach(r => {
      const key = chatKey(id, r.jid);
      // Create/ensure chat before sending join
      ensureChat(key, { type: 'room', name: r.jid.split('@')[0], jid: r.jid, accountId: id, myNick: acct.displayName });
      // Restore group assignments before rendering
      if (state.chats[key]) {
        state.chats[key].groups = roomAssignments[r.jid] || [];
      }
      // Send join request
      state.chats[key].myNick = acct.displayName;
      ipcRenderer.send('xmpp-join-room', { accountId: id, roomJid: r.jid, nick: acct.displayName });
    });

    saveRooms(id);
    renderLeftPanel();
  }
  if (status === 'error' || status === 'authfail') {
    addSystemMsg(null, id, `⚠ ${status === 'authfail' ? 'Authentication failed' : ('Connection error: ' + error)}`);
  }
  if (status === 'offline' && acct._wasOnline) {
    addSystemMsg(null, id, '⚠ Disconnected — reconnecting…');
  }
  acct._wasOnline = (status === 'online');
  renderAccountBar();
  if (state.activeAccountId === id) renderLeftPanel();
});

ipcRenderer.on('xmpp-roster', (e, { accountId, contacts }) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  // Merge server roster with locally saved roster
  // Server roster takes precedence, but we keep local contacts that aren't on server yet
  const mergedRoster = { ...acct.roster };  // Start with existing local roster

  // Track which groups are from the server
  const serverGroups = new Set();

  // Update with server roster
  contacts.forEach(c => {
    mergedRoster[c.jid] = c;
    if (c.groups) c.groups.forEach(g => serverGroups.add(g));
  });

  acct.roster = mergedRoster;

  // Save roster to localStorage for persistence
  saveRoster(accountId, acct.roster);

  // Build groups from roster and merge with saved group metadata
  const allGroups = new Set();
  Object.values(acct.roster).forEach(c => {
    if (c.groups) c.groups.forEach(g => allGroups.add(g));
  });
  contacts.forEach(c => {
    if (c.groups) c.groups.forEach(g => allGroups.add(g));
  });

  // Load saved group metadata (collapse state, colors)
  let savedGroupMetadata = {};
  try {
    savedGroupMetadata = JSON.parse(localStorage.getItem('groups_' + accountId) || '{}');
  } catch { /* ignore */ }

  // Initialize groups object with all discovered groups
  if (!acct.groups) acct.groups = {};
  allGroups.forEach(groupName => {
    if (!acct.groups[groupName]) {
      acct.groups[groupName] = {
        name: groupName,
        color: 'default',
        collapsed: false,
        isServerGroup: serverGroups.has(groupName),
        ...savedGroupMetadata[groupName]
      };
    } else if (acct.groups[groupName].isServerGroup === undefined) {
      // Mark existing groups if not already marked
      acct.groups[groupName].isServerGroup = serverGroups.has(groupName);
    }
  });

  if (state.activeAccountId === accountId) renderLeftPanel();
});

ipcRenderer.on('app-focus', () => {
  state.appIsFocused = true;
  // Reset all new message counters
  Object.values(state.chats).forEach(chat => {
    chat.newMessagesWhileUnfocused = 0;
  });
  renderLeftPanel();
});

ipcRenderer.on('app-blur', () => {
  state.appIsFocused = false;
});

ipcRenderer.on('xmpp-message', (e, { accountId, from, body, type, ts }) => {
  const senderBareJid = bareJid(from);
  const senderName = senderBareJid.split('@')[0];

  // Route directorbot messages to a special chat
  if (senderName === 'directorbot') {
    const key = chatKey(accountId, 'directorbot@' + senderBareJid.split('@')[1]);
    ensureChat(key, { type: 'dm', name: 'Directorbot', jid: 'directorbot@' + senderBareJid.split('@')[1], accountId });
    pushMessage(key, { from: 'Directorbot', text: body, ts, me: false });

    // Auto-open Directorbot chat
    openChat(key);

    // Play alarm if enabled and not in Do Not Disturb mode
    const settings = getAppSettings();
    const acct = state.accounts.find(a => a.id === accountId);
    if (settings.alarmEnabled !== false && acct?.presence !== 'dnd') {
      playNotificationSound({ beepCount: 3, baseFrequency: 800, frequencyIncrement: 200, beepDuration: 0.2, gapDuration: 0.1, volume: 0.3 });
      ipcRenderer.send('window-focus');
    }
    return;
  }

  if (type === 'groupchat') {
    const roomJid = senderBareJid;
    const nick    = from.split('/')[1] || '?';
    const key     = chatKey(accountId, roomJid);
    if (!state.chats[key]) return;
    const isMe = nick === (state.chats[key].myNick || '');
    pushMessage(key, { from: nick, text: body, ts, me: isMe });
  } else {
    const key = chatKey(accountId, senderBareJid);
    const acct = state.accounts.find(a => a.id === accountId);
    const displayName = acct?.roster?.[senderBareJid]?.name || senderName;
    ensureChat(key, { type: 'dm', name: displayName, jid: senderBareJid, accountId });
    pushMessage(key, { from: displayName, text: body, ts, me: false });

    // Play sound for DM notifications if enabled and not in Do Not Disturb mode
    const settings = getAppSettings();
    if (settings.dmSoundEnabled !== false && acct?.presence !== 'dnd') {
      playNotificationSound({ beepCount: 2, baseFrequency: 600, frequencyIncrement: 0, beepDuration: 0.15, gapDuration: 0.08, volume: 0.25 });
    }
  }
});

ipcRenderer.on('xmpp-presence', (e, { accountId, from, type, show }) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct || !acct.roster) return;
  const jid = bareJid(from);
  if (acct.roster[jid]) {
    acct.roster[jid].presence = type === 'unavailable' ? 'offline' : (show || 'available');
  }
  // MUC participant tracking
  const roomJid = bareJid(from);
  const nick    = from.includes('/') ? from.split('/')[1] : null;
  if (nick) {
    const key  = chatKey(accountId, roomJid);
    const chat = state.chats[key];
    if (chat && chat.type === 'room') {
      chat.participants = chat.participants || {};
      if (type === 'unavailable') delete chat.participants[nick];
      else chat.participants[nick] = show || 'available';
      if (state.activeChatKey === key) renderParticipants(chat);
    }
  }
  if (state.activeAccountId === accountId) renderLeftPanel();
});

ipcRenderer.on('tray-status', (e, show) => {
  const acct = getActiveAccount();
  if (acct && acct.status === 'online') {
    ipcRenderer.send('xmpp-send-presence', { accountId: acct.id, show });
  }
});

ipcRenderer.on('update-available', (e, result) => {
  // Store update info and show modal
  window.pendingUpdate = result;
  console.log('Update available:', result.version);
  showUpdateAvailableModal(result);
});

// ─────────────────────────────────────────────
//  Chat helpers
// ─────────────────────────────────────────────
function ensureChat(key, defaults) {
  if (!state.chats[key]) {
    const savedState = loadChatState(key);
    state.chats[key] = { messages: [], unread: 0, newMessagesWhileUnfocused: 0, participants: {}, ...defaults, ...savedState };
  }
}

function pushMessage(key, msg) {
  const chat = state.chats[key];
  if (!chat) return;
  chat.messages.push(msg);
  
  // For rooms, enforce max message limit in memory (keep only recent messages)
  if (chat.type === 'room' && chat.messages.length > MAX_DISPLAYED_MESSAGES_ROOM * 2) {
    chat.messages = chat.messages.slice(-MAX_DISPLAYED_MESSAGES_ROOM);
  }
  
  chat.lastTs      = msg.ts;
  chat.lastPreview = (msg.me ? 'You: ' : '') + msg.text;

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

  renderLeftPanel();
  saveChatState(key);  // Persist chat state
  saveChatMessages(key);  // Persist messages to localStorage
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
  ipcRenderer.send('xmpp-join-room', { accountId: acct.id, roomJid, nick });
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

// ─────────────────────────────────────────────
//  Render
// ─────────────────────────────────────────────
function renderAccountBar() {
  accountListEl.innerHTML = '';
  state.accounts.forEach(acct => {
    const btn = document.createElement('button');
    btn.className = 'acct-btn ' + acct.color + (acct.id === state.activeAccountId ? ' active' : '');
    btn.title = acct.displayName || acct.username;
    btn.textContent = initials(acct.username);
    const pip = document.createElement('span');
    pip.className = 'acct-status-pip ' + (acct.status === 'online' ? 'dot-green' : acct.status === 'connecting' ? 'dot-amber' : 'dot-gray');
    btn.appendChild(pip);
    btn.addEventListener('click',       ()  => switchAccount(acct.id));
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); showAccountContextMenu(acct); });
    accountListEl.appendChild(btn);
  });
}

function renderLeftPanel() {
  const acct = getActiveAccount();
  if (acct) {
    curJid.textContent = acct.displayName || acct.username + '@' + acct.server;
    curAvatar.className   = 'avatar ' + acct.color;
    curAvatar.textContent = initials(acct.username);
    const s = acct.status;
    let statusText = s === 'connecting' ? 'Connecting…' : s === 'online' ? 'Online' : s === 'authfail' ? 'Auth failed' : s === 'error' ? 'Error' : 'Offline';

    // Show presence if set
    if (s === 'online' && acct.presence) {
      if (acct.presence === 'away') statusText = 'Away';
      else if (acct.presence === 'xa') statusText = 'Extended Away';
      else if (acct.presence === 'dnd') statusText = 'Do Not Disturb';
    }

    curStatusText.textContent = statusText;
    curStatusDot.className = 'status-dot ' + (s === 'online' ? 'dot-green' : s === 'connecting' ? 'dot-amber' : s === 'authfail' || s === 'error' ? 'dot-red' : 'dot-gray');

    // Show connection status bar if there's an error or auth failure
    connectionStatusBar.style.display = (s === 'error' || s === 'authfail') ? 'block' : 'none';
  } else {
    curJid.textContent = 'No account'; curAvatar.className = 'avatar av-0'; curAvatar.textContent = '?';
    curStatusText.textContent = 'Offline'; curStatusDot.className = 'status-dot dot-gray';
    connectionStatusBar.style.display = 'none';
  }
  renderContactList(acct);
  renderRoomList(acct);
}

function renderContactList(acct) {
  contactListEl.innerHTML = '';
  if (!acct) return;

  // Check for directorbot special chat
  const directorBotJid = Object.keys(state.chats).find(key => {
    const chat = state.chats[key];
    return chat.accountId === acct.id && chat.jid && chat.jid.startsWith('directorbot@');
  });

  if (directorBotJid) {
    const chat = state.chats[directorBotJid];
    const el = document.createElement('div');
    el.className = 'contact-item' + (state.activeChatKey === directorBotJid ? ' active' : '');
    el.style.borderBottom = '1px solid var(--border)';
    el.style.marginBottom = '8px';

    const av = document.createElement('div');
    av.className = 'avatar sm av-5';
    av.textContent = '🤖';
    av.style.fontSize = '16px';
    av.style.display = 'flex';
    av.style.alignItems = 'center';
    av.style.justifyContent = 'center';

    const info = document.createElement('div');
    info.className = 'item-info';
    info.innerHTML = `<div class="item-name">Directorbot</div>
      <div class="item-sub">${esc(chat?.lastPreview || 'System messages')}</div>`;

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    // Directorbot uses system message styling (orange badge)
    if (chat?.newMessagesWhileUnfocused > 0) {
      const div = document.createElement('div');
      div.innerHTML = `<div class="new-messages-badge" style="background: #FF9800; color: white; font-weight: bold; font-size: 11px; padding: 2px 6px; border-radius: 12px; min-width: 20px; text-align: center;">${chat.newMessagesWhileUnfocused}</div>`;
      meta.appendChild(div.firstElementChild);
    }
    if (chat?.unread > 0) meta.innerHTML += `<div class="unread-badge">${chat.unread}</div>`;

    el.append(av, info, meta);
    el.addEventListener('click', () => openChat(directorBotJid));
    contactListEl.appendChild(el);
  }

  // Filter and sort all entries
  const allEntries = Object.values(acct.roster || {}).filter(r =>
    !r.jid.startsWith('directorbot@') && (
      !state.search || r.name.toLowerCase().includes(state.search) || r.jid.toLowerCase().includes(state.search)
    )
  ).sort((a, b) => {
    const ao = a.presence !== 'offline' ? 0 : 1, bo = b.presence !== 'offline' ? 0 : 1;
    return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
  });

  if (!allEntries.length) {
    const el = document.createElement('div');
    el.style.cssText = 'color:var(--text3);font-size:12px;padding:16px 10px;text-align:center;';
    el.textContent = acct.status === 'online' ? 'No contacts yet.' : 'Connect to see contacts.';
    if (!directorBotJid) contactListEl.appendChild(el);
    return;
  }

  // Build grouped structure
  const grouped = {};
  const groupOrder = [];

  // Add entries to their groups
  allEntries.forEach(contact => {
    if (contact.groups && contact.groups.length > 0) {
      contact.groups.forEach(groupName => {
        if (!grouped[groupName]) {
          grouped[groupName] = [];
          groupOrder.push(groupName);
        }
        grouped[groupName].push(contact);
      });
    } else {
      // Ungrouped contacts
      if (!grouped['Ungrouped']) {
        grouped['Ungrouped'] = [];
        groupOrder.push('Ungrouped');
      }
      grouped['Ungrouped'].push(contact);
    }
  });

  // Sort groups: server groups first (by appearance), then user groups (alphabetically), then Ungrouped
  const serverGroups = [];
  const userGroups = [];

  groupOrder.forEach(groupName => {
    if (groupName === 'Ungrouped') {
      // Ungrouped goes last, don't add to either list
    } else if (acct.groups[groupName]?.isServerGroup) {
      serverGroups.push(groupName);
    } else {
      userGroups.push(groupName);
    }
  });

  // Sort user groups alphabetically
  userGroups.sort((a, b) => a.localeCompare(b));

  // Combine: server groups + user groups + ungrouped
  const sortedGroupOrder = [...serverGroups, ...userGroups];
  if (grouped['Ungrouped']) sortedGroupOrder.push('Ungrouped');
  groupOrder.length = 0;
  groupOrder.push(...sortedGroupOrder);

  // Render groups
  groupOrder.forEach(groupName => {
    const groupMetadata = acct.groups[groupName] || { name: groupName, collapsed: false };
    const contacts = grouped[groupName] || [];

    // Group header
    const headerEl = document.createElement('div');
    headerEl.className = 'group-header' + (groupMetadata.collapsed ? ' collapsed' : '');
    headerEl.style.cssText = 'display:flex;align-items:center;padding:8px 10px;cursor:pointer;user-select:none;color:var(--text2);font-size:12px;font-weight:600;text-transform:uppercase;gap:8px;';

    const arrow = document.createElement('span');
    arrow.className = 'group-arrow';
    arrow.textContent = groupMetadata.collapsed ? '▶' : '▼';
    arrow.style.cssText = 'display:inline-block;width:12px;text-align:center;transition:transform 0.2s;';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = groupName + ` (${contacts.length})`;

    headerEl.append(arrow, nameSpan);

    headerEl.addEventListener('click', () => {
      groupMetadata.collapsed = !groupMetadata.collapsed;
      acct.groups[groupName] = groupMetadata;
      // Save collapse state
      const saved = {};
      Object.keys(acct.groups).forEach(gn => {
        saved[gn] = { collapsed: acct.groups[gn].collapsed };
      });
      localStorage.setItem('groups_' + acct.id, JSON.stringify(saved));
      renderContactList(acct);
    });

    contactListEl.appendChild(headerEl);

    // Render contacts in this group
    if (!groupMetadata.collapsed) {
      contacts.forEach(contact => {
        const key  = chatKey(acct.id, contact.jid);
        const chat = state.chats[key];
        const el   = document.createElement('div');
        el.className = 'contact-item' + (state.activeChatKey === key ? ' active' : '');
        el.style.paddingLeft = '24px';

        const av = document.createElement('div');
        av.className   = 'avatar sm ' + avatarColor(contact.jid);
        av.textContent = initials(contact.name);
        av.style.position = 'relative';

        // Add status indicator
        const statusPip = document.createElement('span');
        statusPip.className = 'contact-status-pip ' + (contact.presence !== 'offline' ? 'dot-green' : 'dot-gray');
        statusPip.style.cssText = 'position:absolute;bottom:0;right:0;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--bg1);';
        av.appendChild(statusPip);

        const info = document.createElement('div');
        info.className = 'item-info';
        info.innerHTML = `<div class="item-name">${esc(contact.name)}</div>
          <div class="item-sub">${esc(chat?.lastPreview || contact.jid)}</div>`;

        const meta = document.createElement('div');
        meta.className = 'item-meta';
        if (chat?.lastTs)   meta.innerHTML += `<div class="item-time">${formatTime(chat.lastTs)}</div>`;
        if (chat?.newMessagesWhileUnfocused > 0) {
          const div = document.createElement('div');
          div.innerHTML = getBadgeStyle(chat);
          meta.appendChild(div.firstElementChild);
        }
        if (chat?.unread > 0) meta.innerHTML += `<div class="unread-badge">${chat.unread}</div>`;

        el.append(av, info, meta);
        el.addEventListener('click', () => {
          ensureChat(key, { type: 'dm', name: contact.name, jid: contact.jid, accountId: acct.id });
          openChat(key);
        });

        // Context menu for group management
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContactContextMenu(contact, acct);
        });

        contactListEl.appendChild(el);
      });
    }
  });
}

function renderRoomList(acct) {
  roomListEl.innerHTML = '';
  if (!acct) return;
  const rooms = Object.values(state.chats).filter(c =>
    c.accountId === acct.id && c.type === 'room' &&
    (!state.search || c.name.toLowerCase().includes(state.search) || c.jid.toLowerCase().includes(state.search))
  ).sort((a, b) => a.name.localeCompare(b.name));

  if (!rooms.length) {
    const el = document.createElement('div');
    el.style.cssText = 'color:var(--text3);font-size:12px;padding:16px 10px;text-align:center;';
    el.textContent = 'No rooms joined yet.';
    roomListEl.appendChild(el);
    return;
  }

  // Build grouped structure for rooms
  const grouped = {};
  const groupOrder = [];

  // Load saved room group metadata
  let roomGroupMetadata = {};
  try {
    roomGroupMetadata = JSON.parse(localStorage.getItem('roomGroups_' + acct.id) || '{}');
  } catch { /* ignore */ }

  // Initialize room groups if not done
  if (!acct.roomGroups) acct.roomGroups = {};
  Object.keys(roomGroupMetadata).forEach(groupName => {
    if (!acct.roomGroups[groupName]) {
      acct.roomGroups[groupName] = { name: groupName, collapsed: false, ...roomGroupMetadata[groupName] };
    }
  });

  // Add rooms to their groups
  rooms.forEach(room => {
    // Ensure room has groups array
    if (!room.groups) room.groups = [];

    if (room.groups.length > 0) {
      room.groups.forEach(groupName => {
        if (!grouped[groupName]) {
          grouped[groupName] = [];
          groupOrder.push(groupName);
        }
        grouped[groupName].push(room);
      });
    } else {
      // Ungrouped rooms
      if (!grouped['Ungrouped']) {
        grouped['Ungrouped'] = [];
        groupOrder.push('Ungrouped');
      }
      grouped['Ungrouped'].push(room);
    }
  });

  // Sort room groups: user groups alphabetically, then Ungrouped
  const userRoomGroups = groupOrder.filter(g => g !== 'Ungrouped');
  userRoomGroups.sort((a, b) => a.localeCompare(b));
  const sortedRoomGroupOrder = [...userRoomGroups];
  if (grouped['Ungrouped']) sortedRoomGroupOrder.push('Ungrouped');
  groupOrder.length = 0;
  groupOrder.push(...sortedRoomGroupOrder);

  // Render room groups
  groupOrder.forEach(groupName => {
    const groupMetadata = acct.roomGroups[groupName] || { name: groupName, collapsed: false };
    const groupRooms = grouped[groupName] || [];

    // Group header
    const headerEl = document.createElement('div');
    headerEl.className = 'group-header' + (groupMetadata.collapsed ? ' collapsed' : '');
    headerEl.style.cssText = 'display:flex;align-items:center;padding:8px 10px;cursor:pointer;user-select:none;color:var(--text2);font-size:12px;font-weight:600;text-transform:uppercase;gap:8px;';

    const arrow = document.createElement('span');
    arrow.className = 'group-arrow';
    arrow.textContent = groupMetadata.collapsed ? '▶' : '▼';
    arrow.style.cssText = 'display:inline-block;width:12px;text-align:center;transition:transform 0.2s;';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = groupName + ` (${groupRooms.length})`;

    headerEl.append(arrow, nameSpan);

    headerEl.addEventListener('click', () => {
      groupMetadata.collapsed = !groupMetadata.collapsed;
      acct.roomGroups[groupName] = groupMetadata;
      // Save collapse state
      const saved = {};
      Object.keys(acct.roomGroups).forEach(gn => {
        saved[gn] = { collapsed: acct.roomGroups[gn].collapsed };
      });
      localStorage.setItem('roomGroups_' + acct.id, JSON.stringify(saved));
      renderRoomList(acct);
    });

    roomListEl.appendChild(headerEl);

    // Render rooms in this group
    if (!groupMetadata.collapsed) {
      groupRooms.forEach(chat => {
        const key = chatKey(acct.id, chat.jid);
        const el  = document.createElement('div');
        el.className = 'room-item' + (state.activeChatKey === key ? ' active' : '');
        el.style.paddingLeft = '24px';

        const av = document.createElement('div');
        av.className   = 'avatar sm ' + avatarColor(chat.jid);
        av.style.borderRadius = '6px';
        av.textContent = '#';

        const info = document.createElement('div');
        info.className = 'item-info';
        info.innerHTML = `<div class="item-name">${esc(chat.name)}</div>
          <div class="item-sub">${esc(chat.lastPreview || chat.jid)}</div>`;

        const meta = document.createElement('div');
        meta.className = 'item-meta';
        if (chat.lastTs)  meta.innerHTML += `<div class="item-time">${formatTime(chat.lastTs)}</div>`;
        if (chat.newMessagesWhileUnfocused > 0) {
          const div = document.createElement('div');
          div.innerHTML = getBadgeStyle(chat);
          meta.appendChild(div.firstElementChild);
        }
        if (chat.unread > 0) meta.innerHTML += `<div class="unread-badge">${chat.unread}</div>`;

        el.append(av, info, meta);
        el.addEventListener('click', () => openChat(key));
        el.addEventListener('contextmenu', e => { e.preventDefault(); showRoomContextMenu(chat, acct); });
        roomListEl.appendChild(el);
      });
    }
  });
}

// ─────────────────────────────────────────────
//  Chat open / render
// ─────────────────────────────────────────────
function openChat(key) {
  state.activeChatKey = key;
  const chat = state.chats[key];
  if (!chat) return;

  const isRoom = chat.type === 'room';
  const isDirectorbot = chat.jid && chat.jid.startsWith('directorbot@');

  chatHeaderAv.className     = 'avatar ' + avatarColor(chat.jid);
  chatHeaderAv.style.borderRadius = isRoom ? '6px' : '10px';
  chatHeaderAv.textContent   = isRoom ? '#' : initials(chat.name);
  chatHeaderName.textContent = chat.name;
  chatHeaderSub.textContent  = chat.jid;

  const pp = document.getElementById('participants-panel');
  if (pp) { isRoom ? pp.classList.add('open') : pp.classList.remove('open'); }
  if (isRoom && pp) renderParticipants(chat);

  // Hide input row for Directorbot (read-only)
  const inputRow = document.getElementById('input-row');
  if (inputRow) {
    inputRow.style.display = isDirectorbot ? 'none' : 'flex';
  }

  // Switch to appropriate tab
  const contactsTab = document.querySelector('.ltab[data-tab="contacts"]');
  const roomsTab = document.querySelector('.ltab[data-tab="rooms"]');

  if (isRoom && roomsTab) {
    // Switch to rooms tab
    document.querySelectorAll('.ltab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    roomsTab.classList.add('active');
    document.getElementById('rooms-panel').classList.add('active');
  } else if (!isRoom && contactsTab) {
    // Switch to contacts tab for DMs and Directorbot
    document.querySelectorAll('.ltab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    contactsTab.classList.add('active');
    document.getElementById('contacts-panel').classList.add('active');
  }

  // Load MAM history for DMs (always reload to get archived messages)
  if (!isRoom) {
    loadMessageHistory(key);
  }

  // Load saved messages from localStorage
  if (chat.messages.length === 0) {
    const savedMessages = loadChatMessages(key);
    if (savedMessages.length > 0) {
      chat.messages = savedMessages;
      console.log(`Loaded ${savedMessages.length} saved messages for ${chat.jid}`);
    }
  }

  // Reset unread since we're viewing the chat
  chat.unread = 0;

  messagesArea.innerHTML = '';

  // For rooms: limit displayed messages to avoid performance issues
  let messagesToRender = chat.messages;
  let truncated = false;
  if (isRoom && chat.messages.length > MAX_DISPLAYED_MESSAGES_ROOM) {
    messagesToRender = chat.messages.slice(-MAX_DISPLAYED_MESSAGES_ROOM);
    truncated = true;
    // Add truncation notice
    const notice = document.createElement('div');
    notice.className = 'system-msg';
    notice.style.textAlign = 'center';
    notice.style.opacity = '0.6';
    notice.style.marginTop = '16px';
    notice.innerHTML = `⚠ Showing last ${MAX_DISPLAYED_MESSAGES_ROOM.toLocaleString()} messages (${(chat.messages.length - MAX_DISPLAYED_MESSAGES_ROOM).toLocaleString()} older hidden)`;
    messagesArea.appendChild(notice);
  }

  // Render messages incrementally to avoid UI blocking
  let lastDay = null;
  let renderIndex = 0;
  
  function renderNextBatch() {
    const endIdx = Math.min(renderIndex + RENDER_BATCH_SIZE, messagesToRender.length);
    
    for (let i = renderIndex; i < endIdx; i++) {
      const msg = messagesToRender[i];
      if (msg.system) {
        const el = document.createElement('div');
        el.className = 'system-msg'; el.textContent = msg.text;
        messagesArea.appendChild(el);
        continue;
      }
      const day = formatDay(msg.ts);
      if (day !== lastDay) {
        lastDay = day;
        const d = document.createElement('div');
        d.className = 'day-divider'; d.textContent = day;
        messagesArea.appendChild(d);
      }
      appendMessage(msg, chat);
    }
    
    renderIndex = endIdx;
    
    if (renderIndex < messagesToRender.length) {
      // Schedule next batch
      requestAnimationFrame(renderNextBatch);
    } else {
      // All messages rendered, apply emoticons
      const bubbles = messagesArea.querySelectorAll('.msg-bubble');
      bubbles.forEach(bubble => {
        applyEmoticons(bubble);
        linkifyUrls(bubble);
      });
      
      // Scroll after all done
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
  }
  
  renderNextBatch();

  markChatAsRead(key);  // Mark all messages as read
  welcomeScreen.style.display = 'none';
  chatArea.style.display = 'flex';
  msgInput.focus();
  renderLeftPanel();
}

function appendMessage(msg, chat) {
  if (msg.system) {
    const el = document.createElement('div');
    el.className = 'system-msg'; el.textContent = msg.text;
    messagesArea.appendChild(el);
    scrollToBottom();
    return;
  }

  // Merge into previous group if same sender
  const last = messagesArea.lastElementChild;
  if (last?.classList.contains('msg-group') && last.dataset.from === msg.from) {
    const body   = last.querySelector('.msg-group-body');
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = parseEmoticons(msg.text);
    applyEmoticons(bubble);
    linkifyUrls(bubble);
    body.insertBefore(bubble, body.querySelector('.msg-time'));
    scrollToBottom();
    return;
  }

  const group = document.createElement('div');
  group.className  = 'msg-group' + (msg.me ? ' me' : '');
  group.dataset.from = msg.from;

  const av = document.createElement('div');
  av.className   = 'avatar sm ' + avatarColor(msg.from);
  av.style.borderRadius = '8px';
  av.textContent = initials(msg.from);

  const body = document.createElement('div');
  body.className = 'msg-group-body';

  if (!msg.me && chat.type === 'room') {
    const sn = document.createElement('div');
    sn.className = 'msg-sender-name'; sn.textContent = msg.from;
    body.appendChild(sn);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = parseEmoticons(msg.text);
  applyEmoticons(bubble);
  linkifyUrls(bubble);
  body.appendChild(bubble);

  // Don't show timestamps for directorbot messages
  if (msg.from !== 'Directorbot') {
    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time'; timeEl.textContent = formatDateTime(msg.ts);
    body.appendChild(timeEl);
  }

  msg.me ? group.append(body, av) : group.append(av, body);
  messagesArea.appendChild(group);
  scrollToBottom();
}

function renderParticipants(chat) {
  const pp = document.getElementById('participants-panel');
  if (!pp) return;
  pp.innerHTML = `<div class="part-label">Participants (${Object.keys(chat.participants || {}).length})</div>`;
  Object.keys(chat.participants || {}).sort().forEach(nick => {
    const el = document.createElement('div');
    el.className = 'part-item';
    el.style.cursor = 'pointer';
    el.style.position = 'relative';
    const av = document.createElement('div');
    av.className = 'avatar sm ' + avatarColor(nick);
    av.style.position = 'relative';
    av.textContent = nick.slice(0, 2).toUpperCase();

    // Add status indicator
    const presence = chat.participants[nick] || 'available';
    const statusPip = document.createElement('span');
    const statusClass = presence !== 'offline' ? 'dot-green' : 'dot-gray';
    statusPip.className = 'contact-status-pip ' + statusClass;
    statusPip.style.cssText = 'position:absolute;bottom:0;right:0;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--bg2);';
    av.appendChild(statusPip);

    const span = document.createElement('span');
    span.textContent = nick;
    el.append(av, span);

    // Right-click context menu
    el.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      window.currentContextEvent = e;
      showParticipantContextMenu(chat, nick);
    });

    // Left-click to open DM
    el.addEventListener('click', () => {
      openDirectMessageWithParticipant(chat, nick);
    });

    pp.appendChild(el);
  });
}

function scrollToBottom() { messagesArea.scrollTop = messagesArea.scrollHeight; }
function showWelcome()     { welcomeScreen.style.display = 'flex'; chatArea.style.display = 'none'; }

// ─────────────────────────────────────────────
//  Send message
// ─────────────────────────────────────────────
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !state.activeChatKey) return;
  const chat = state.chats[state.activeChatKey];
  if (!chat) return;
  const acct = state.accounts.find(a => a.id === chat.accountId);
  if (!acct || acct.status !== 'online') return;

  ipcRenderer.send('xmpp-send-message', { accountId: acct.id, to: chat.jid, body: text, type: chat.type === 'room' ? 'groupchat' : 'chat' });

  // Echo immediately for DMs (groupchat echo comes back from server)
  if (chat.type === 'dm') {
    pushMessage(state.activeChatKey, { from: acct.username, text, ts: Date.now(), me: true });
  }

  msgInput.value = '';
  msgInput.style.height = 'auto';
}

// ─────────────────────────────────────────────
//  Account management
// ─────────────────────────────────────────────
function getActiveAccount() { return state.accounts.find(a => a.id === state.activeAccountId) || null; }

function switchAccount(id) {
  state.activeAccountId = id;
  renderAccountBar();
  renderLeftPanel();
}

function showAddAccountModal() {
  showModal(`
    <div class="modal-title">Add GSF Jabber Account</div>
    <div id="modal-error"></div>
    <div class="form-group">
      <label class="form-label">EVE Online Character Name</label>
      <input class="form-input" id="fi-display-name" placeholder="Your main character name" autocomplete="off" />
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group" style="margin:0">
        <label class="form-label">Username</label>
        <input class="form-input" id="fi-user" placeholder="alice" autocomplete="off" />
      </div>
      <div class="form-group" style="margin:0">
        <label class="form-label">Password</label>
        <input class="form-input" id="fi-pass" type="password" placeholder="••••••••" />
      </div>
    </div>
    <div style="color:var(--text3);font-size:12px;margin-top:12px;margin-bottom:12px">
      Connects to goonfleet.com — <a href="#" style="color:var(--accent);text-decoration:underline;cursor:pointer;" onclick="openExternalLink('https://goonfleet.com/esa/'); return false;">Check username/password</a>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="submitAddAccount()">Connect</button>
    </div>
  `);
  document.getElementById('fi-display-name').focus();
}
window.showAddAccountModal = showAddAccountModal;

window.submitAddAccount = () => {
  const displayNameInput = document.getElementById('fi-display-name').value.trim();
  const username = document.getElementById('fi-user').value.trim();
  const password = document.getElementById('fi-pass').value;
  const errEl    = document.getElementById('modal-error');

  if (!displayNameInput || !username || !password) {
    errEl.innerHTML = '<div class="strip error">EVE character name, username, and password are required.</div>';
    return;
  }

  const server = 'goonfleet.com';
  const port = 5222;
  const colors = ['av-0','av-1','av-2','av-3','av-4','av-5','av-6','av-7'];
  const account = {
    id: 'acct_' + Date.now(),
    username, password, server, port,
    displayName: displayNameInput,
    color: colors[state.accounts.length % colors.length],
    status: 'offline',
    roster: {},
    groups: {},
    roomGroups: {},
    jid: username + '@' + server
  };

  state.accounts.push(account);
  state.activeAccountId = account.id;
  saveAccounts();
  hideModal();
  ipcRenderer.send('xmpp-connect', account);
  renderAccountBar();
  renderLeftPanel();
};

function showAccountContextMenu(acct) {
  showModal(`
    <div class="modal-title">${esc(acct.displayName || acct.username + '@' + acct.server)}</div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary"   onclick="showEditAccountModal('${acct.id}')">Edit</button>
      <button class="btn-danger"    onclick="removeAccount('${acct.id}')">Remove</button>
    </div>
  `);
}

window.showEditAccountModal = (id) => {
  const acct = state.accounts.find(a => a.id === id);
  if (!acct) return;
  hideModal();
  showModal(`
    <div class="modal-title">Edit Account</div>
    <div style="color:var(--text3);font-size:13px;margin-bottom:12px">
      Account: ${esc(acct.username)}@goonfleet.com
    </div>
    <div class="form-group">
      <label class="form-label">New password (leave blank to keep)</label>
      <input class="form-input" id="fi-pass" type="password" placeholder="(unchanged)" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary"   onclick="submitEditAccount('${id}')">Save</button>
    </div>
  `);
};

window.submitEditAccount = (id) => {
  const acct   = state.accounts.find(a => a.id === id);
  if (!acct) return;
  const pass   = document.getElementById('fi-pass').value;
  if (pass) acct.password = pass;
  saveAccounts();
  ipcRenderer.send('xmpp-connect', acct);  // reconnect with new settings
  hideModal();
  renderAccountBar();
  renderLeftPanel();
};

window.removeAccount = (id) => {
  ipcRenderer.send('xmpp-disconnect', { id });
  Object.keys(state.chats).forEach(k => { if (state.chats[k].accountId === id) delete state.chats[k]; });
  state.accounts = state.accounts.filter(a => a.id !== id);
  if (state.activeAccountId === id) {
    state.activeAccountId = state.accounts[0]?.id || null;
    state.activeChatKey = null;
    showWelcome();
  }
  saveAccounts();
  hideModal();
  renderAccountBar();
  renderLeftPanel();
};

function showRoomContextMenu(chat, acct) {
  if (!acct) acct = state.accounts.find(a => a.id === chat.accountId);
  if (!acct) return;

  const roomGroups = acct.roomGroups || {};
  const allGroupNames = Object.keys(roomGroups);
  const roomChatGroups = chat.groups || [];

  let groupOptions = '';
  if (allGroupNames.length > 0) {
    groupOptions = allGroupNames.map(groupName => {
      const isInGroup = roomChatGroups.includes(groupName);
      return `<button class="btn-group-option" style="${isInGroup ? 'opacity:0.5;' : ''}" onclick="moveRoomToGroup('${esc(acct.id)}','${esc(chat.jid)}','${esc(groupName)}','${esc(chat.name)}')">${isInGroup ? '✓ ' : ''}${esc(groupName)}</button>`;
    }).join('');
  }

  showModal(`
    <div class="modal-title">Room: ${esc(chat.name)}</div>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px">${esc(chat.jid)}</p>
    ${groupOptions ? `<div style="display:grid;gap:8px;margin-bottom:16px;">${groupOptions}</div>` : ''}
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-secondary" onclick="showCreateRoomGroupModal('${esc(acct.id)}','${esc(chat.jid)}','${esc(chat.name)}')">+ Group</button>
      <button class="btn-danger"    onclick="leaveRoomConfirm('${acct.id}','${chat.jid}')">Leave room</button>
    </div>
  `);
}

function showContactContextMenu(contact, acct) {
  if (!acct) return;

  const allGroups = Object.keys(acct.groups || {});
  const contactGroups = contact.groups || [];

  let groupOptions = allGroups.map(groupName => {
    const isInGroup = contactGroups.includes(groupName);
    return `<button class="btn-group-option" style="${isInGroup ? 'opacity:0.5;' : ''}" onclick="moveContactToGroup('${esc(acct.id)}','${esc(contact.jid)}','${esc(groupName)}','${esc(contact.name)}')">${isInGroup ? '✓ ' : ''}${esc(groupName)}</button>`;
  }).join('');

  showModal(`
    <div class="modal-title">Groups for: ${esc(contact.name)}</div>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px">${esc(contact.jid)}</p>
    <div style="display:grid;gap:8px;margin-bottom:16px;">
      ${groupOptions}
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="showCreateGroupModal('${esc(acct.id)}','${esc(contact.jid)}','${esc(contact.name)}')">+ New Group</button>
      <button class="btn-danger" onclick="removeContactConfirm('${esc(acct.id)}','${esc(contact.jid)}','${esc(contact.name)}')">Remove</button>
    </div>
  `);
}



function showParticipantContextMenu(chat, nick) {
  // Participant context menu disabled for now
  hideContextMenu();
}

function showContextMenu(e) {
  const contextMenu = document.getElementById('context-menu');
  contextMenu.classList.remove('hidden');

  let x = e.clientX;
  let y = e.clientY;

  // Adjust position if menu goes off-screen
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';

  // Check if menu is off-screen horizontally
  const rect = contextMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    x = window.innerWidth - rect.width - 10;
    contextMenu.style.left = x + 'px';
  }

  // Check if menu is off-screen vertically
  if (rect.bottom > window.innerHeight) {
    y = window.innerHeight - rect.height - 10;
    contextMenu.style.top = y + 'px';
  }
}

function hideContextMenu() {
  const contextMenu = document.getElementById('context-menu');
  contextMenu.classList.add('hidden');
}

window.hideContextMenu = hideContextMenu;

function addParticipantToContacts(accountId, jid, name, roomChat) {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  // Add to roster (will subscribe)
  ipcRenderer.send('xmpp-add-contact', { accountId, jid, name });

  // Add to local roster
  if (!acct.roster) acct.roster = {};

  // Get participant's presence from room if available
  let presence = 'offline';
  if (roomChat && roomChat.participants && roomChat.participants[name]) {
    presence = roomChat.participants[name] !== 'offline' ? 'available' : 'offline';
  }

  acct.roster[jid] = { jid, name, presence, groups: [] };

  // Save to localStorage immediately for persistence
  saveRoster(accountId, acct.roster);

  addSystemMsg(null, accountId, `📋 Subscription request sent to ${name}`);
  hideModal();
  renderLeftPanel();
}

window.addParticipantToContacts = addParticipantToContacts;

function openDirectMessageWithParticipant(chat, nick) {
  const acct = state.accounts.find(a => a.id === chat.accountId);
  if (!acct) return;

  // For participants in rooms, create a DM with their nick@room server
  const roomServer = chat.jid.split('@')[1];
  const participantJid = nick.toLowerCase() + '@' + roomServer;

  // Create or find existing DM chat
  const key = chatKey(acct.id, participantJid);
  ensureChat(key, { type: 'dm', name: nick, jid: participantJid, accountId: acct.id });
  openChat(key);
  hideModal();
}

window.openDirectMessageWithParticipant = openDirectMessageWithParticipant;
window.showParticipantContextMenu = showParticipantContextMenu;

function escapeForJavaScript(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
window.leaveRoomConfirm = (accountId, roomJid) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (acct) leaveRoom(acct, roomJid);
  hideModal();
};

window.removeContactConfirm = (accountId, contactJid, contactName) => {
  showModal(`
    <div class="modal-title">Remove contact?</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">
      Remove ${esc(contactName)} from your contacts?
    </p>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-danger" onclick="submitRemoveContact('${esc(accountId)}','${esc(contactJid)}','${esc(contactName)}')">Remove</button>
    </div>
  `);
};

window.submitRemoveContact = (accountId, contactJid, contactName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  // Send removal to backend
  ipcRenderer.send('xmpp-remove-contact', { accountId, jid: contactJid });

  // Remove from local roster
  delete acct.roster[contactJid];

  // Save updated roster to localStorage
  saveRoster(accountId, acct.roster);

  // Close any open chat with this contact
  const key = chatKey(accountId, contactJid);
  if (state.activeChatKey === key) {
    state.activeChatKey = null;
    showWelcome();
  }
  delete state.chats[key];

  // Re-render and show confirmation
  renderLeftPanel();
  showModal(`
    <div class="modal-title">✓ Removed</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">${esc(contactName)} has been removed from your contacts.</p>
    <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
  `);
};

window.moveContactToGroup = (accountId, contactJid, groupName, contactName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  const contact = acct.roster[contactJid];
  if (!contact) return;

  // Initialize groups if needed
  if (!contact.groups) contact.groups = [];

  // Toggle group membership
  const idx = contact.groups.indexOf(groupName);
  if (idx >= 0) {
    contact.groups.splice(idx, 1);
  } else {
    contact.groups.push(groupName);
  }

  // Send update to backend
  ipcRenderer.send('xmpp-update-contact-groups', {
    accountId,
    jid: contactJid,
    name: contact.name,
    groups: contact.groups
  });

  // Save updated roster to localStorage
  saveRoster(accountId, acct.roster);

  // Re-render and show success
  renderContactList(acct);
  showModal(`
    <div class="modal-title">✓ Updated</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">${esc(contactName)} moved to group(s).</p>
    <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
  `);
};

window.showCreateGroupModal = (accountId, contactJid, contactName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  showModal(`
    <div class="modal-title">Create New Group</div>
    <div id="modal-error"></div>
    <div class="form-group">
      <label class="form-label">Group name</label>
      <input class="form-input" id="fi-group-name" placeholder="e.g. Friends, Work…" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="submitCreateGroup('${esc(accountId)}','${esc(contactJid)}','${esc(contactName)}')">Create & Add</button>
    </div>
  `);
  document.getElementById('fi-group-name').focus();
};

window.submitCreateGroup = (accountId, contactJid, contactName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  const input = document.getElementById('fi-group-name');
  const groupName = input.value.trim();

  if (!groupName) {
    document.getElementById('modal-error').innerHTML = '<div class="strip error">Group name is required.</div>';
    return;
  }

  // Create group metadata
  if (!acct.groups[groupName]) {
    acct.groups[groupName] = { name: groupName, collapsed: false };
    // Save to localStorage
    localStorage.setItem('groups_' + accountId, JSON.stringify(acct.groups));
  }

  // Add contact to group
  const contact = acct.roster[contactJid];
  if (contact) {
    if (!contact.groups) contact.groups = [];
    if (!contact.groups.includes(groupName)) {
      contact.groups.push(groupName);

      // Send update to backend
      ipcRenderer.send('xmpp-update-contact-groups', {
        accountId,
        jid: contactJid,
        name: contact.name,
        groups: contact.groups
      });
    }
  }

  // Re-render and close
  renderContactList(acct);
  hideModal();
};

window.moveRoomToGroup = (accountId, roomJid, groupName, roomName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  const chat = Object.values(state.chats).find(c => c.jid === roomJid && c.accountId === accountId);
  if (!chat) return;

  // Initialize groups if needed
  if (!chat.groups) chat.groups = [];

  // Toggle group membership
  const idx = chat.groups.indexOf(groupName);
  if (idx >= 0) {
    chat.groups.splice(idx, 1);
  } else {
    chat.groups.push(groupName);
  }

  // Save rooms to persist group assignments
  saveRooms(accountId);

  // Re-render
  renderRoomList(acct);
  showModal(`
    <div class="modal-title">✓ Updated</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">${esc(roomName)} room group updated.</p>
    <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
  `);
};

window.showCreateRoomGroupModal = (accountId, roomJid, roomName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  showModal(`
    <div class="modal-title">Create Room Group</div>
    <div id="modal-error"></div>
    <div class="form-group">
      <label class="form-label">Group name</label>
      <input class="form-input" id="fi-room-group-name" placeholder="e.g. Gaming, EVE, Social…" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="submitCreateRoomGroup('${esc(accountId)}','${esc(roomJid)}','${esc(roomName)}')">Create & Add</button>
    </div>
  `);
  document.getElementById('fi-room-group-name').focus();
};

window.submitCreateRoomGroup = (accountId, roomJid, roomName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  const input = document.getElementById('fi-room-group-name');
  const groupName = input.value.trim();

  if (!groupName) {
    document.getElementById('modal-error').innerHTML = '<div class="strip error">Group name is required.</div>';
    return;
  }

  // Create room group metadata
  if (!acct.roomGroups[groupName]) {
    acct.roomGroups[groupName] = { name: groupName, collapsed: false };
    // Save to localStorage
    localStorage.setItem('roomGroups_' + accountId, JSON.stringify(acct.roomGroups));
  }

  // Add room to group
  const chat = Object.values(state.chats).find(c => c.jid === roomJid && c.accountId === accountId);
  if (chat) {
    if (!chat.groups) chat.groups = [];
    if (!chat.groups.includes(groupName)) {
      chat.groups.push(groupName);
    }
    // Save rooms to persist group assignments
    saveRooms(accountId);
  }

  // Re-render and close
  renderRoomList(acct);
  hideModal();
};

function showJoinRoomModal() {
  const acct = getActiveAccount();
  if (!acct || acct.status !== 'online') {
    showModal(`
      <div class="modal-title">Not connected</div>
      <p style="color:var(--text3);font-size:13px;margin-bottom:16px">You need to be connected to join a room.</p>
      <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
    `);
    return;
  }
  showModal(`
    <div class="modal-title">Join a Room</div>
    <div id="modal-error"></div>
    <div class="form-group">
      <label class="form-label">Room name</label>
      <input class="form-input" id="fi-room" placeholder="general" />
    </div>
    <div style="color:var(--text3);font-size:12px;margin-bottom:12px">
      Joins: room@conference.goonfleet.com
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary"   onclick="submitJoinRoom()">Join</button>
    </div>
  `);
  document.getElementById('fi-room').focus();
}

window.submitJoinRoom = () => {
  const roomName = document.getElementById('fi-room').value.trim();
  if (!roomName) {
    document.getElementById('modal-error').innerHTML = '<div class="strip error">Room name is required.</div>';
    return;
  }
  const roomJid = roomName + '@conference.goonfleet.com';
  const acct = getActiveAccount();
  hideModal();
  sendJoinRoom(acct, roomJid);
  openChat(chatKey(acct.id, roomJid));
};

function showAccountSettingsModal() {
  const acct = getActiveAccount();
  if (!acct) return;
  const current = acct.presence || 'available';
  const settings = getAppSettings();
  const theme = settings.theme || 'dark';
  const alarmEnabled = settings.alarmEnabled !== false;  // Default to true
  const dmSoundEnabled = settings.dmSoundEnabled !== false;  // Default to true

  showModal(`
    <div class="modal-title">Account Settings</div>

    <div style="border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px;">
      <div style="font-weight: 500; margin-bottom: 8px; font-size: 12px; color: var(--text2); text-transform: uppercase;">Account</div>
      <div class="form-group">
        <label class="form-label">Display name</label>
        <input class="form-input" id="fi-display-name" value="${esc(acct.displayName || '')}" placeholder="Your display name" />
      </div>
      <div class="form-group">
        <label class="form-label">Presence</label>
        <select class="form-select" id="fi-presence">
          <option value="${current}" selected>${current === 'available' ? 'Available' : current === 'away' ? 'Away' : current === 'xa' ? 'Extended Away' : 'Do Not Disturb'}</option>
          ${current !== 'available' ? '<option value="available">Available</option>' : ''}
          ${current !== 'away' ? '<option value="away">Away</option>' : ''}
          ${current !== 'xa' ? '<option value="xa">Extended Away</option>' : ''}
          ${current !== 'dnd' ? '<option value="dnd">Do Not Disturb</option>' : ''}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Status message (optional)</label>
        <input class="form-input" id="fi-status-msg" placeholder="What are you up to?" />
      </div>
    </div>

    <div style="border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px;">
      <div style="font-weight: 500; margin-bottom: 12px; font-size: 12px; color: var(--text2); text-transform: uppercase;">Appearance</div>
      <div class="form-group">
        <label class="form-label">Theme</label>
        <select class="form-select" id="fi-theme">
          <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Dark</option>
          <option value="light" ${theme === 'light' ? 'selected' : ''}>Light</option>
        </select>
      </div>
    </div>

    <div style="padding-bottom: 12px; margin-bottom: 12px;">
      <div style="font-weight: 500; margin-bottom: 12px; font-size: 12px; color: var(--text2); text-transform: uppercase;">Notifications</div>
      <div class="form-group" style="display: flex; align-items: center; gap: 10px;">
        <input type="checkbox" id="fi-alarm-enabled" ${alarmEnabled ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;" />
        <label for="fi-alarm-enabled" style="cursor: pointer; margin: 0;">Play alarm for Directorbot messages</label>
      </div>
      <div class="form-group" style="display: flex; align-items: center; gap: 10px;">
        <input type="checkbox" id="fi-dm-sound-enabled" ${dmSoundEnabled ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;" />
        <label for="fi-dm-sound-enabled" style="cursor: pointer; margin: 0;">Play sound for direct messages</label>
      </div>
    </div>

    <div style="border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px;">
      <div style="font-weight: 500; margin-bottom: 12px; font-size: 12px; color: var(--text2); text-transform: uppercase;">Updates</div>
      ${appVersion ? `<div style="font-size: 11px; color: var(--text3); margin-bottom: 8px;">Current version: <strong style="color: var(--text1);">v${appVersion}</strong></div>` : ''}
      <div class="form-group" style="display: flex; gap: 8px; align-items: center;">
        <button class="btn-secondary" id="update-check-btn" onclick="checkForUpdate()">Check for Updates</button>
        <span id="update-status" style="font-size: 12px; color: var(--text2);"></span>
      </div>
      <div id="update-spinner" style="display: none; margin-top: 8px;">
        <div style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--text2); border-top: 2px solid var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
        <span style="margin-left: 8px; color: var(--text2); font-size: 12px;">Checking...</span>
      </div>
      <div id="update-message" style="display: none; margin-top: 8px; padding: 8px; border-radius: 4px; font-size: 12px;"></div>
    </div>

    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary"   onclick="submitAccountSettings()">Save</button>
    </div>
  `);
}
window.submitAccountSettings = () => {
  try {
    const displayName = document.getElementById('fi-display-name')?.value.trim() || '';
    const show   = document.getElementById('fi-presence')?.value || 'available';
    const status = document.getElementById('fi-status-msg')?.value.trim() || '';
    const theme = document.getElementById('fi-theme')?.value || 'dark';
    const alarmEnabled = document.getElementById('fi-alarm-enabled')?.checked ?? true;
    const dmSoundEnabled = document.getElementById('fi-dm-sound-enabled')?.checked ?? true;

    const acct = getActiveAccount();
    if (acct) {
      if (displayName) acct.displayName = displayName;
      if (acct.status === 'online' && (show !== acct.presence || status)) {
        acct.presence = show;
        ipcRenderer.send('xmpp-send-presence', { accountId: acct.id, show, status });
        addSystemMsg(null, acct.id, `📍 Status changed to ${show}${status ? ': ' + status : ''}`);
      }
      saveAccounts();
    }

    // Save app settings
    saveAppSettings({ theme, alarmEnabled, dmSoundEnabled });
    setTheme(theme);

    renderLeftPanel();
    hideModal();
  } catch (err) {
    console.error('Error saving settings:', err);
  }
};

window.checkForUpdate = async () => {
  const btn = document.getElementById('update-check-btn');
  const spinner = document.getElementById('update-spinner');
  const message = document.getElementById('update-message');
  const status = document.getElementById('update-status');

  if (!btn || !spinner || !message) return;

  // Disable button and show spinner
  btn.disabled = true;
  spinner.style.display = 'block';
  message.style.display = 'none';
  status.textContent = '';

  try {
    const result = await ipcRenderer.invoke('check-update', {});
    console.log('Update check result:', result);

    if (!result) {
      throw new Error('No response from update checker (null result)');
    }

    spinner.style.display = 'none';

    if (result.status === 'up-to-date') {
      message.style.display = 'block';
      message.textContent = `✓ You're on the latest version (${result.version})`;
      message.style.backgroundColor = 'rgba(76, 175, 80, 0.1)';
      message.style.color = '#4CAF50';
    } else if (result.status === 'update-available') {
      message.style.display = 'block';
      message.innerHTML = `
        <div style="margin-bottom: 8px;">
          ⬆ Update available: <strong>${result.version}</strong>
        </div>
        <div style="font-size: 11px; margin-bottom: 8px; color: var(--text2); max-height: 100px; overflow-y: auto;">
          ${result.releaseNotes.replace(/\n/g, '<br>')}
        </div>
        <button class="btn-primary" style="font-size: 11px; padding: 4px 8px;" onclick="openExternalLink('${esc(result.releaseUrl)}'); return false;">Download from GitHub</button>
      `;
      message.style.backgroundColor = 'rgba(33, 150, 243, 0.1)';
      message.style.color = '#2196F3';
    } else if (result.status === 'error') {
      message.style.display = 'block';
      message.textContent = `✗ Check failed: ${result.error}`;
      message.style.backgroundColor = 'rgba(244, 67, 54, 0.1)';
      message.style.color = '#F44336';
    }
  } catch (err) {
    console.error('Update check error:', err);
    spinner.style.display = 'none';
    message.style.display = 'block';
    message.textContent = `✗ Error: ${err.message}`;
    message.style.backgroundColor = 'rgba(244, 67, 54, 0.1)';
    message.style.color = '#F44336';
  } finally {
    btn.disabled = false;
  }
};

window.installUpdate = async (releaseUrl) => {
  if (typeof releaseUrl === 'string' && /^https?:\/\//.test(releaseUrl)) {
    openExternalLink(releaseUrl);
  }
};

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
    unread: 0  // Reset unread when saving
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

function saveChatMessages(key) {
  const chat = state.chats[key];
  if (!chat || !chat.messages) return;

  try {
    // Only save last 500 messages to avoid localStorage limits
    const messagesToSave = chat.messages.slice(-500);
    localStorage.setItem('chat_messages_' + key, JSON.stringify(messagesToSave));
  } catch (err) {
    console.error('Failed to save messages:', err);
  }
}

function loadChatMessages(key) {
  try {
    const messages = JSON.parse(localStorage.getItem('chat_messages_' + key) || '[]');
    return messages;
  } catch {
    return [];
  }
}

async function loadAndConnect() {
  const saved = await ipcRenderer.invoke('load-accounts');
  if (!saved?.length) return;
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

// ─────────────────────────────────────────────
//  Emoticons
// ─────────────────────────────────────────────
function parseEmoticons(text) {
  let result = text;
  if (!emoticonsList.length) return result;

  emoticonsList.forEach(e => {
    const regex = new RegExp(e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    result = result.replace(regex, `__EMOTICON_${emoticonsList.indexOf(e)}__`);
  });
  return result;
}

function applyEmoticons(element) {
  if (!emoticonsList.length) return;

  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  const nodesToReplace = [];
  let node;
  while (node = walker.nextNode()) {
    if (node.nodeValue.includes('__EMOTICON_')) {
      nodesToReplace.push(node);
    }
  }

  nodesToReplace.forEach(node => {
    const span = document.createElement('span');
    let html = node.nodeValue;
    emoticonsList.forEach((e, idx) => {
      const regex = new RegExp(`__EMOTICON_${idx}__`, 'g');
      html = html.replace(regex, `<img class="emoticon" src="${esc(e.path)}" alt="${esc(e.name)}" title="${esc(e.name)}" />`);
    });
    span.innerHTML = html;
    node.parentNode.replaceChild(span, node);
  });
}

function linkifyUrls(element) {
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`\[\]]*)/g;
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  const nodesToProcess = [];
  let node;
  while (node = walker.nextNode()) {
    if (urlRegex.test(node.nodeValue)) {
      nodesToProcess.push(node);
      urlRegex.lastIndex = 0; // Reset regex after test
    }
  }

  nodesToProcess.forEach(node => {
    const span = document.createElement('span');
    let html = esc(node.nodeValue);
    html = html.replace(/(https?:\/\/[^\s&<>"]*)/g, (url) => {
      return `<a onclick="event.preventDefault(); event.stopPropagation(); openExternalLink('${esc(url)}'); return false;" style="color: var(--accent); text-decoration: underline; cursor: pointer;">${esc(url)}</a>`;
    });
    span.innerHTML = html;
    node.parentNode.replaceChild(span, node);
  });
}

function insertEmoticon(name) {
  msgInput.value += name;
  msgInput.focus();
  addRecentEmoticon(name);
}

function toggleFavoriteEmoticon(name) {
  const settings = getAppSettings();
  let favorites = settings.favoriteEmoticons || [];
  if (favorites.includes(name)) {
    favorites = favorites.filter(e => e !== name);
  } else {
    favorites = [...favorites, name];
  }
  saveAppSettings({ favoriteEmoticons: favorites });
  // Refresh the emoticon picker
  showEmoticonPicker();
}

function showEmoticonPicker() {
  if (!Object.keys(emoticons).length) {
    showModal(`
      <div class="modal-title">Emoticons</div>
      <p style="color: var(--text3); text-align: center; padding: 20px;">Loading emoticons...</p>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="hideModal()">Close</button>
      </div>
    `);
    return;
  }

  const settings = getAppSettings();
  const recent = settings.recentEmoticons || [];
  const favorites = settings.favoriteEmoticons || [];
  const folders = Object.keys(emoticons);

  let html = `<div class="modal-title">Emoticons</div>`;

  // Recent tab
  if (recent.length > 0) {
    html += `<div style="margin-bottom: 12px;">
      <div style="font-size: 12px; color: var(--text2); margin-bottom: 8px; text-transform: uppercase;">Recent</div>
      <div style="display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px; margin-bottom: 16px; padding: 8px; background: var(--bg2); border-radius: var(--radius);">
        ${recent.map(name => {
          const emoticon = emoticonsList.find(e => e.name === name);
          const isFavorite = favorites.includes(name);
          return emoticon ? `
            <div style="position: relative; cursor: pointer; border-radius: 4px; padding: 4px; display: flex; align-items: center; justify-content: center; background: var(--bg3); transition: all 0.2s ease; user-select: none; overflow: visible;"
              onmouseenter="this.style.transform='scale(1.3)'; this.style.zIndex='10'; this.style.background='var(--accent)'; this.querySelector('.emoticon-favorite-btn').style.opacity='1'; this.querySelector('.emoticon-favorite-btn').style.color='#FFED4E';"
              onmouseleave="this.style.transform='scale(1)'; this.style.zIndex='auto'; this.style.background='var(--bg3)'; this.querySelector('.emoticon-favorite-btn').style.opacity='0'; this.querySelector('.emoticon-favorite-btn').style.color='#FFD700';"
              onclick="insertEmoticon('${esc(name)}'); hideModal();"
              title="${esc(name)}">
              <img src="${emoticon.path}" style="width: 24px; height: 24px; object-fit: contain; pointer-events: none;" loading="lazy" />
              <div style="position: absolute; top: 0; right: 0; cursor: pointer; font-size: 14px; opacity: 0; transition: opacity 0.2s; background: rgba(0,0,0,0.7); border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; line-height: 1; color: #FFD700;" class="emoticon-favorite-btn" onclick="event.stopPropagation(); toggleFavoriteEmoticon('${esc(name)}')" title="Toggle favorite">${isFavorite ? '★' : '☆'}</div>
            </div>
          ` : '';
        }).join('')}
      </div>
    </div>`;
  }

  // Favorites tab
  if (favorites.length > 0) {
    html += `<div style="margin-bottom: 12px;">
      <div style="font-size: 12px; color: var(--text2); margin-bottom: 8px; text-transform: uppercase;">Favorites</div>
      <div style="display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px; margin-bottom: 16px; padding: 8px; background: var(--bg2); border-radius: var(--radius);">
        ${favorites.map(name => {
          const emoticon = emoticonsList.find(e => e.name === name);
          return emoticon ? `
            <div style="position: relative; cursor: pointer; border-radius: 4px; padding: 4px; display: flex; align-items: center; justify-content: center; background: var(--bg3); transition: all 0.2s ease; user-select: none; overflow: visible;"
              onmouseenter="this.style.transform='scale(1.3)'; this.style.zIndex='10'; this.style.background='var(--accent)'; this.querySelector('.emoticon-favorite-btn').style.opacity='1'; this.querySelector('.emoticon-favorite-btn').style.color='#FFED4E';"
              onmouseleave="this.style.transform='scale(1)'; this.style.zIndex='auto'; this.style.background='var(--bg3)'; this.querySelector('.emoticon-favorite-btn').style.opacity='0'; this.querySelector('.emoticon-favorite-btn').style.color='#FFD700';"
              onclick="insertEmoticon('${esc(name)}'); hideModal();"
              title="${esc(name)}">
              <img src="${emoticon.path}" style="width: 24px; height: 24px; object-fit: contain; pointer-events: none;" loading="lazy" />
              <div style="position: absolute; top: 0; right: 0; cursor: pointer; font-size: 14px; opacity: 0; transition: opacity 0.2s; background: rgba(0,0,0,0.7); border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; line-height: 1; color: #FFD700;" class="emoticon-favorite-btn" onclick="event.stopPropagation(); toggleFavoriteEmoticon('${esc(name)}')" title="Toggle favorite">★</div>
            </div>
          ` : '';
        }).join('')}
      </div>
    </div>`;
  }

  // Search
  html += `<div style="margin-bottom: 12px;">
    <input class="form-input" id="emoticon-search" placeholder="Search emoticons..." style="margin-bottom: 8px; width: 100%; padding: 8px; font-size: 14px;" />
  </div>`;

  // Folder tabs
  html += `<div style="margin-bottom: 12px;">
    <div style="display: flex; gap: 8px; margin-bottom: 8px; border-bottom: 1px solid var(--border); padding-bottom: 8px; flex-wrap: wrap;">
      ${folders.map((folder, idx) => `
        <button style="padding: 6px 12px; border: none; background: ${idx === 0 ? 'var(--accent)' : 'var(--bg2)'}; color: var(--text1); border-radius: 4px; cursor: pointer; font-size: 12px; white-space: nowrap;"
          onclick="switchEmoticonFolder('${folder}', event)"
          data-folder="${folder}">${esc(folder)}</button>
      `).join('')}
    </div>
    <div id="emoticon-grid" style="display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px; padding: 8px; background: var(--bg2); border-radius: var(--radius); max-height: 400px; overflow-y: auto;">
      ${emoticons[folders[0]]?.map(e => {
        const favorites = (getAppSettings().favoriteEmoticons || []);
        const isFavorite = favorites.includes(e.name);
        return `
        <div style="position: relative; cursor: pointer; border-radius: 4px; padding: 4px; display: flex; align-items: center; justify-content: center; background: var(--bg3); transition: all 0.2s ease; user-select: none; overflow: visible;"
          onmouseenter="this.style.transform='scale(1.3)'; this.style.zIndex='10'; this.style.background='var(--accent)'; this.querySelector('.emoticon-favorite-btn').style.opacity='1'; this.querySelector('.emoticon-favorite-btn').style.color='#FFED4E';"
          onmouseleave="this.style.transform='scale(1)'; this.style.zIndex='auto'; this.style.background='var(--bg3)'; this.querySelector('.emoticon-favorite-btn').style.opacity='0'; this.querySelector('.emoticon-favorite-btn').style.color='#FFD700';"
          onclick="insertEmoticon('${esc(e.name)}'); hideModal();"
          data-name="${esc(e.name)}"
          title="${esc(e.name)}">
          <img src="${esc(e.path)}" style="width: 24px; height: 24px; object-fit: contain; pointer-events: none;" loading="lazy" />
          <div style="position: absolute; top: 0; right: 0; cursor: pointer; font-size: 14px; opacity: 0; transition: opacity 0.2s; background: rgba(0,0,0,0.7); border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; line-height: 1; color: #FFD700;" class="emoticon-favorite-btn" onclick="event.stopPropagation(); toggleFavoriteEmoticon('${esc(e.name)}')" title="Toggle favorite">${isFavorite ? '★' : '☆'}</div>
        </div>
      `;
      }).join('') || ''}
    </div>
  </div>`;

  html += `
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Close</button>
    </div>
  `;

  showModal(html);

  const searchInput = document.getElementById('emoticon-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const grid = document.getElementById('emoticon-grid');

      if (query === '') {
        const activeFolder = document.querySelector('[data-folder][style*="var(--accent)"]')?.dataset.folder || folders[0];
        grid.innerHTML = emoticons[activeFolder]?.map(e => {
          const favorites = (getAppSettings().favoriteEmoticons || []);
          const isFavorite = favorites.includes(e.name);
          return `
          <div style="position: relative; cursor: pointer; border-radius: 4px; padding: 4px; display: flex; align-items: center; justify-content: center; background: var(--bg3); transition: all 0.2s ease; user-select: none; overflow: visible;"
            onmouseenter="this.style.transform='scale(1.3)'; this.style.zIndex='10'; this.style.background='var(--accent)'; this.querySelector('.emoticon-favorite-btn').style.opacity='1'; this.querySelector('.emoticon-favorite-btn').style.color='#FFED4E';"
            onmouseleave="this.style.transform='scale(1)'; this.style.zIndex='auto'; this.style.background='var(--bg3)'; this.querySelector('.emoticon-favorite-btn').style.opacity='0'; this.querySelector('.emoticon-favorite-btn').style.color='#FFD700';"
            onclick="insertEmoticon('${esc(e.name)}'); hideModal();"
            data-name="${esc(e.name)}"
            title="${esc(e.name)}">
            <img src="${esc(e.path)}" style="width: 24px; height: 24px; object-fit: contain; pointer-events: none;" loading="lazy" />
            <div style="position: absolute; top: 0; right: 0; cursor: pointer; font-size: 14px; opacity: 0; transition: opacity 0.2s; background: rgba(0,0,0,0.7); border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; line-height: 1; color: #FFD700;" class="emoticon-favorite-btn" onclick="event.stopPropagation(); toggleFavoriteEmoticon('${esc(e.name)}')" title="Toggle favorite">${isFavorite ? '★' : '☆'}</div>
          </div>
        `;
        }).join('') || ''
      } else {
        const filtered = emoticonsList.filter(e => e.name.toLowerCase().includes(query));
        grid.innerHTML = filtered.map(e => {
          const favorites = (getAppSettings().favoriteEmoticons || []);
          const isFavorite = favorites.includes(e.name);
          return `
          <div style="position: relative; cursor: pointer; border-radius: 4px; padding: 4px; display: flex; align-items: center; justify-content: center; background: var(--bg3); transition: all 0.2s ease; user-select: none; overflow: visible;"
            onmouseenter="this.style.transform='scale(1.3)'; this.style.zIndex='10'; this.style.background='var(--accent)'; this.querySelector('.emoticon-favorite-btn').style.opacity='1'; this.querySelector('.emoticon-favorite-btn').style.color='#FFED4E';"
            onmouseleave="this.style.transform='scale(1)'; this.style.zIndex='auto'; this.style.background='var(--bg3)'; this.querySelector('.emoticon-favorite-btn').style.opacity='0'; this.querySelector('.emoticon-favorite-btn').style.color='#FFD700';"
            onclick="insertEmoticon('${esc(e.name)}'); hideModal();"
            data-name="${esc(e.name)}"
            title="${esc(e.name)}">
            <img src="${esc(e.path)}" style="width: 24px; height: 24px; object-fit: contain; pointer-events: none;" loading="lazy" />
          <div style="position: absolute; top: 0; right: 0; cursor: pointer; font-size: 14px; opacity: 0; transition: opacity 0.2s; background: rgba(0,0,0,0.7); border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; line-height: 1; color: #FFD700;" class="emoticon-favorite-btn" onclick="event.stopPropagation(); toggleFavoriteEmoticon('${esc(e.name)}')" title="Toggle favorite">${isFavorite ? '★' : '☆'}</div>
          </div>
        `;
        }).join('');
      }
    });
    searchInput.focus();
  }
}

function switchEmoticonFolder(folder, event) {
  const folders = Object.keys(emoticons);
  const grid = event.target.parentElement.nextElementSibling;

  event.target.parentElement.querySelectorAll('button').forEach(btn => {
    btn.style.background = btn.dataset.folder === folder ? 'var(--accent)' : 'var(--bg2)';
  });

  grid.innerHTML = emoticons[folder]?.map(e => {
    const favorites = (getAppSettings().favoriteEmoticons || []);
    const isFavorite = favorites.includes(e.name);
    return `
    <div style="position: relative; cursor: pointer; border-radius: 4px; padding: 4px; display: flex; align-items: center; justify-content: center; background: var(--bg3); transition: all 0.2s ease; user-select: none; overflow: visible;"
      onmouseenter="this.style.transform='scale(1.3)'; this.style.zIndex='10'; this.style.background='var(--accent)'; this.querySelector('.emoticon-favorite-btn').style.opacity='1'; this.querySelector('.emoticon-favorite-btn').style.color='#FFED4E';"
      onmouseleave="this.style.transform='scale(1)'; this.style.zIndex='auto'; this.style.background='var(--bg3)'; this.querySelector('.emoticon-favorite-btn').style.opacity='0'; this.querySelector('.emoticon-favorite-btn').style.color='#FFD700';"
      onclick="insertEmoticon('${esc(e.name)}'); hideModal();"
      data-name="${esc(e.name)}"
      title="${esc(e.name)}">
      <img src="${e.path}" style="width: 24px; height: 24px; object-fit: contain; pointer-events: none;" loading="lazy" />
      <div style="position: absolute; top: 0; right: 0; cursor: pointer; font-size: 14px; opacity: 0; transition: opacity 0.2s; background: rgba(0,0,0,0.7); border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; line-height: 1; color: #FFD700;" class="emoticon-favorite-btn" onclick="event.stopPropagation(); toggleFavoriteEmoticon('${esc(e.name)}')" title="Toggle favorite">${isFavorite ? '★' : '☆'}</div>
    </div>
  `;
  }).join('') || ''
}

function addRecentEmoticon(name) {
  const settings = getAppSettings();
  const recent = settings.recentEmoticons || [];
  const filtered = recent.filter(e => e !== name);
  const newRecent = [name, ...filtered].slice(0, 15);
  saveAppSettings({ recentEmoticons: newRecent });
}

function togglePinnedChat(chatKey) {
  const settings = getAppSettings();
  let pinnedChats = settings.pinnedChats || [];
  if (pinnedChats.includes(chatKey)) {
    pinnedChats = pinnedChats.filter(k => k !== chatKey);
  } else {
    pinnedChats = [chatKey, ...pinnedChats];
  }
  saveAppSettings({ pinnedChats });
  renderLeftPanel();
}

function getBadgeStyle(chat) {
  // Return different badge styles based on chat type and content
  if (chat.type === 'dm') {
    // DMs get a blue badge
    return `
      <div class="new-messages-badge" style="background: #2196F3; color: white; font-weight: bold; font-size: 11px; padding: 2px 6px; border-radius: 12px; min-width: 20px; text-align: center;">
        ${chat.newMessagesWhileUnfocused}
      </div>
    `;
  } else if (chat.type === 'room') {
    // Room messages get a green badge
    return `
      <div class="new-messages-badge" style="background: #4CAF50; color: white; font-weight: bold; font-size: 11px; padding: 2px 6px; border-radius: 12px; min-width: 20px; text-align: center;">
        ${chat.newMessagesWhileUnfocused}
      </div>
    `;
  }
  // Default badge
  return `<div class="new-messages-badge">${chat.newMessagesWhileUnfocused}</div>`;
}

window.insertEmoticon = insertEmoticon;
window.toggleFavoriteEmoticon = toggleFavoriteEmoticon;
window.switchEmoticonFolder = switchEmoticonFolder;

async function loadEmoticons() {
  try {
    emoticons = await ipcRenderer.invoke('load-emoticons');
    emoticonsList = [];
    Object.values(emoticons).forEach(folder => {
      emoticonsList.push(...folder);
    });
    console.log(`Loaded ${emoticonsList.length} emoticons from ${Object.keys(emoticons).length} folders`);
  } catch (err) {
    console.error('Failed to load emoticons:', err);
  }
}

async function loadMessageHistory(key) {
  const chat = state.chats[key];
  if (!chat || chat.type === 'room') return; // Only for DMs

  try {
    const account = state.accounts.find(a => a.id === chat.accountId);
    if (!account) return;

    const messages = await ipcRenderer.invoke('load-message-history', {
      accountId: account.id,
      'with': chat.jid,
      count: 100
    });

    if (messages && messages.length > 0) {
      // Merge with existing messages, avoiding duplicates
      const existingTs = new Set(chat.messages.map(m => m.ts));
      const newMessages = messages.filter(m => !existingTs.has(m.ts));
      chat.messages.unshift(...newMessages);
      console.log(`Loaded ${newMessages.length} historical messages for ${chat.jid}`);
    }
  } catch (err) {
    console.error('Failed to load message history:', err);
  }
}

function playNotificationSound(options = {}) {
  try {
    const {
      beepCount = 2,
      baseFrequency = 600,
      frequencyIncrement = 0,
      beepDuration = 0.15,
      gapDuration = 0.08,
      volume = 0.25
    } = options;

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;

    for (let i = 0; i < beepCount; i++) {
      const startTime = now + (i * (beepDuration + gapDuration));

      const osc = audioContext.createOscillator();
      osc.frequency.value = baseFrequency + (i * frequencyIncrement);
      osc.type = 'sine';

      const gain = audioContext.createGain();
      gain.gain.setValueAtTime(volume, startTime);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + beepDuration);

      osc.connect(gain);
      gain.connect(audioContext.destination);

      osc.start(startTime);
      osc.stop(startTime + beepDuration);
    }
  } catch (err) {
    console.error('Failed to play notification sound:', err);
  }
}

// Backwards compatibility aliases
function playAlarmSound() {
  playNotificationSound({ beepCount: 3, baseFrequency: 800, frequencyIncrement: 200, beepDuration: 0.2, gapDuration: 0.1, volume: 0.3 });
}

function playDMSound() {
  playNotificationSound({ beepCount: 2, baseFrequency: 600, frequencyIncrement: 0, beepDuration: 0.15, gapDuration: 0.08, volume: 0.25 });
}

function showBrowseRoomsModal() {
  showModal(`
    <div class="modal-title">Browse Rooms</div>
    <div id="modal-error"></div>
    <div id="rooms-loading" style="text-align: center; padding: 20px; color: var(--text3);">
      <div style="font-size: 14px; margin-bottom: 12px;">Loading available rooms...</div>
      <div style="display: inline-block; width: 30px; height: 30px; border: 3px solid var(--bg3); border-top: 3px solid var(--accent); border-radius: 50%; animation: spin 1s linear infinite;"></div>
    </div>
    <div id="rooms-list" style="display: none;"></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Close</button>
      <button class="btn-primary" id="btn-join-selected" onclick="joinMultipleRooms()" style="display: none;">Join Selected</button>
    </div>
  `);

  // Add loading animation CSS
  if (!document.getElementById('spin-animation')) {
    const style = document.createElement('style');
    style.id = 'spin-animation';
    style.innerHTML = '@keyframes spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }

  const account = state.accounts.find(a => a.id === state.activeAccountId);
  if (!account) {
    document.getElementById('modal-error').innerHTML = '<div class="strip error">No account selected</div>';
    document.getElementById('rooms-loading').style.display = 'none';
    return;
  }

  discoverRooms(account.id);
}

async function discoverRooms(accountId) {
  try {
    const rooms = await ipcRenderer.invoke('discover-rooms', { accountId });

    document.getElementById('rooms-loading').style.display = 'none';
    const roomsList = document.getElementById('rooms-list');
    const joinBtn = document.getElementById('btn-join-selected');

    if (!rooms || rooms.length === 0) {
      document.getElementById('modal-error').innerHTML = `
        <div class="strip error">
          <div style="font-weight: 500; margin-bottom: 6px;">Room discovery unavailable</div>
          <div style="font-size: 12px;">The server isn't responding to room discovery requests. You can still join rooms manually by using the "Join a room" option and entering the room name.</div>
        </div>
      `;
      return;
    }

    // Store rooms for filtering
    window.allRooms = rooms;

    // Add search box
    let searchHtml = `
      <input type="text" id="rooms-search" placeholder="Search rooms..."
        style="width: 100%; padding: 8px; margin-bottom: 12px; border: 1px solid var(--border);
               border-radius: var(--radius); background: var(--bg1); color: var(--text1);
               font-size: 14px;" />
    `;

    // Build rooms list
    searchHtml += '<div id="rooms-container" style="max-height: 400px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px;">';
    rooms.forEach((room, idx) => {
      searchHtml += `
        <div class="room-item" data-name="${room.name.toLowerCase()}" data-jid="${room.jid.toLowerCase()}" style="padding: 12px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: center;">
          <input type="checkbox" class="room-checkbox" data-jid="${esc(room.jid)}" data-name="${esc(room.name)}" style="width: 18px; height: 18px; cursor: pointer;" />
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 500; color: var(--text1);">#${esc(room.name)}</div>
            <div style="font-size: 12px; color: var(--text3);">${esc(room.jid)}</div>
          </div>
          <button class="btn-primary" style="padding: 6px 12px; font-size: 12px; white-space: nowrap;" onclick="joinSingleRoom('${esc(room.jid)}', '${esc(room.name)}')">Join</button>
        </div>
      `;
    });
    searchHtml += '</div>';

    roomsList.innerHTML = searchHtml;
    roomsList.style.display = 'block';
    if (joinBtn) joinBtn.style.display = 'block';

    // Add search event listener
    const searchInput = document.getElementById('rooms-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        const roomItems = document.querySelectorAll('.room-item');
        console.log(`Searching for: "${query}", found ${roomItems.length} room items`);

        if (query === '') {
          // Show all if search is empty
          roomItems.forEach(item => {
            item.style.display = 'flex';
          });
        } else {
          roomItems.forEach(item => {
            const name = item.dataset.name || '';
            const jid = item.dataset.jid || '';
            const matches = name.includes(query) || jid.includes(query);
            item.style.display = matches ? 'flex' : 'none';
          });
        }
      });

      // Focus search input
      searchInput.focus();
    } else {
      console.error('Search input not found');
    }
  } catch (err) {
    console.error('Room discovery failed:', err);
    document.getElementById('rooms-loading').style.display = 'none';
    document.getElementById('modal-error').innerHTML = '<div class="strip error">Failed to load rooms. Server may be offline or unreachable.</div>';
  }
}

function joinSingleRoom(jid, name) {
  const account = state.accounts.find(a => a.id === state.activeAccountId);
  if (!account) {
    alert('No account selected');
    return;
  }

  sendJoinRoom(account, jid);
  openChat(chatKey(account.id, jid));
  hideModal();
}

function joinMultipleRooms() {
  const checkboxes = document.querySelectorAll('.room-checkbox:checked');
  if (!checkboxes.length) {
    alert('Please select at least one room');
    return;
  }

  const account = state.accounts.find(a => a.id === state.activeAccountId);
  if (!account) {
    alert('No account selected');
    return;
  }

  let firstJid = null;
  checkboxes.forEach((cb, idx) => {
    const jid = cb.dataset.jid;
    if (idx === 0) firstJid = jid;
    sendJoinRoom(account, jid);
  });

  openChat(chatKey(account.id, firstJid));
  hideModal();
}

window.joinSingleRoom = joinSingleRoom;
window.joinMultipleRooms = joinMultipleRooms;
window.showBrowseRoomsModal = showBrowseRoomsModal;

// ─────────────────────────────────────────────
//  Event listeners
// ─────────────────────────────────────────────
$('btn-minimize').addEventListener('click',  () => ipcRenderer.send('window-minimize'));
$('btn-maximize').addEventListener('click',  () => ipcRenderer.send('window-maximize'));
$('btn-close').addEventListener('click',     () => ipcRenderer.send('window-close'));
$('btn-add-account').addEventListener('click',  showAddAccountModal);
$('btn-welcome-add').addEventListener('click',  showAddAccountModal);
$('btn-browse-rooms').addEventListener('click',  showBrowseRoomsModal);
$('btn-settings').addEventListener('click',     showAccountSettingsModal);
btnReconnect.addEventListener('click', () => {
  const acct = getActiveAccount();
  if (acct) {
    ipcRenderer.send('xmpp-connect', acct);
  }
});
$('btn-emoticon').addEventListener('click',     showEmoticonPicker);
$('btn-send').addEventListener('click', sendMessage);

msgInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
msgInput.addEventListener('input',   () => { msgInput.style.height = 'auto'; msgInput.style.height = Math.min(msgInput.scrollHeight, 130) + 'px'; });

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  // Ctrl/Cmd + N: Add new account
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    showAddAccountModal();
  }

  // Ctrl/Cmd + F: Focus search
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    searchInput.focus();
  }

  // Ctrl/Cmd + K: Focus message input
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    msgInput.focus();
  }

  // Ctrl/Cmd + ,: Open settings
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    showAccountSettingsModal();
  }

  // Ctrl/Cmd + 1-9: Switch to account by number
  if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    const accountNum = parseInt(e.key) - 1;
    if (state.accounts[accountNum]) {
      state.activeAccountId = state.accounts[accountNum].id;
      renderLeftPanel();
    }
  }

  // Reset idle timer on any key press
  resetIdleTimer();
});

// Track user activity for idle detection
document.addEventListener('mousemove', resetIdleTimer, true);
document.addEventListener('mousedown', resetIdleTimer, true);
document.addEventListener('keypress', resetIdleTimer, true);
document.addEventListener('touchstart', resetIdleTimer, true);

// Initialize idle timer
resetIdleTimer();

document.querySelectorAll('.ltab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ltab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.tab === 'contacts' ? 'contacts-panel' : 'rooms-panel').classList.add('active');
  });
});

searchInput.addEventListener('input', () => {
  state.search = searchInput.value.toLowerCase().trim();
  renderLeftPanel();
});

// Add contact from username input
const newContactInput = document.getElementById('new-contact-username');
if (newContactInput) {
  newContactInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const username = newContactInput.value.trim();
      if (!username) {
        showModal(`
          <div class="modal-title">Error</div>
          <p style="color:var(--text3);font-size:13px;margin-bottom:16px">Please enter a username.</p>
          <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
        `);
        return;
      }

      const acct = getActiveAccount();
      if (!acct) {
        showModal(`
          <div class="modal-title">Error</div>
          <p style="color:var(--text3);font-size:13px;margin-bottom:16px">No active account selected.</p>
          <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
        `);
        return;
      }

      // Append @goonfleet if not already present
      const jid = username.includes('@') ? username : username + '@goonfleet';
      const displayName = username.split('@')[0];

      // Add contact via XMPP
      ipcRenderer.send('xmpp-add-contact', { accountId: acct.id, jid, name: displayName });

      // Add to local roster
      if (!acct.roster) acct.roster = {};
      acct.roster[jid] = { jid, name: displayName, presence: 'offline', groups: [] };

      // Save to localStorage
      saveRoster(acct.id, acct.roster);

      addSystemMsg(null, acct.id, `📋 Subscription request sent to ${displayName}`);
      newContactInput.value = '';
      renderLeftPanel();
      showModal(`
        <div class="modal-title">✓ Added</div>
        <p style="color:var(--text3);font-size:13px;margin-bottom:16px">Subscription request sent to ${esc(displayName)}.</p>
        <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
      `);
    }
  });
}

// Close context menu when clicking elsewhere
document.addEventListener('click', (e) => {
  const contextMenu = document.getElementById('context-menu');
  if (contextMenu && !contextMenu.classList.contains('hidden') && !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

// ─────────────────────────────────────────────
//  Participants panel injection
// ─────────────────────────────────────────────
(function buildParticipantsPanel() {
  const pp = document.createElement('div');
  pp.id = 'participants-panel';
  const chatEl = $('chat-area');
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex:1;min-height:0;overflow:hidden;';
  const inner = document.createElement('div');
  inner.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0;';
  while (chatEl.children.length) inner.appendChild(chatEl.children[0]);
  wrapper.appendChild(inner);
  wrapper.appendChild(pp);
  chatEl.appendChild(wrapper);
  chatEl.style.flexDirection = 'column';
})();

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
(async () => {
  // Get and cache version
  try {
    appVersion = await window.electronAPI.getVersion?.();
    const versionEl = $('app-version');
    if (versionEl && appVersion) versionEl.textContent = `v${appVersion}`;
  } catch (err) {
    console.error('Failed to get version:', err);
  }

  await loadEmoticons();
  await loadAndConnect();
})();
