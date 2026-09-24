'use strict';
// IPC bridge shim, config, state, DOM refs, utilities (escaping, links, modals, click dispatcher), idle detection.
// Part of the renderer: index.html loads src/js/*.js in order; they share one global scope.

// Context isolation: use window.electronAPI instead of ipcRenderer
const ipcRenderer = {
  on: (channel, callback) => {
    // Convert channel name to camelCase function name
    // e.g., 'xmpp-status' -> 'onXmppStatus'
    const camelCase = 'on' + channel.split('-').map((word, i) =>
      i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)
    ).join('');
    const fn = window.electronAPI[camelCase];
    if (fn) fn(callback); else console.warn(`IPC channel not exposed in preload: ${channel}`);
  },
  send: (channel, data) => {
    // Convert channel name to camelCase function name
    // e.g., 'xmpp-connect' -> 'xmppConnect'
    const camelCase = channel.split('-').map((word, i) =>
      i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
    ).join('');
    const fn = window.electronAPI[camelCase];
    if (fn) fn(data); else console.warn(`IPC channel not exposed in preload: ${channel}`);
  },
  invoke: (channel, data) => {
    // e.g., 'load-accounts' -> 'loadAccounts'
    const camelCase = channel.split('-').map((word, i) =>
      i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
    ).join('');
    const fn = window.electronAPI[camelCase];
    if (fn) return fn(data);
    console.warn(`IPC channel not exposed in preload: ${channel}`);
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
  userIsIdle: false,
  chatInfoModalOpen: false, // track if chat info modal is currently open
  chatInfoModalKey: null    // track which chat the modal is showing info for
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
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Links are built as DOM nodes and opened through the data-action dispatcher,
// never through inline handlers, so URL text can't break out into script.
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
function appendLinkified(parent, text) {
  let last = 0;
  for (const m of text.matchAll(URL_REGEX)) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'msg-link';
    a.textContent = m[0];
    a.dataset.action = 'openExternalLink';
    a.dataset.args = JSON.stringify([m[0]]);
    parent.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
function escapeAndLinkify(s) {
  const div = document.createElement('div');
  appendLinkified(div, String(s));
  return div.innerHTML;
}
function chatKey(accountId, jid) { return accountId + '::' + jid; }
function bareJid(jid) { return jid ? jid.split('/')[0] : ''; }
// Safe modal: expects pre-escaped HTML content from caller
function showModal(html) {
  if (typeof html !== 'string') {
    console.error('Modal HTML must be a string');
    return;
  }
  modalContent.innerHTML = html;
  modalOverlay.classList.remove('hidden');
}
function hideModal() {
  modalOverlay.classList.add('hidden');
  modalContent.innerHTML = '';
  state.chatInfoModalOpen = false;
  state.chatInfoModalKey = null;
}
window.hideModal = hideModal;

// Click dispatcher for generated HTML: elements use data-action="fnName" and
// data-args='[JSON]' instead of inline onclick, so the page can run with a CSP
// that forbids inline script. Only functions listed here can be triggered.
const UI_ACTIONS = new Set([
  'addParticipantToContacts_Menu', 'checkForUpdate', 'copyMessage_Menu', 'deleteGroupConfirm',
  'hideModal', 'insertEmoticon', 'joinMultipleRooms', 'joinSingleRoom', 'leaveRoomConfirm',
  'moveContactToGroup', 'moveDMToGroup', 'moveRoomToGroup', 'openDirectMessageWithParticipant_Menu',
  'openExternalLink', 'openGithubRelease', 'playAlarmSound', 'playDMSound', 'quoteMessage_Menu',
  'removeAccount', 'removeContactConfirm', 'renameGroupModal', 'showCreateDMGroupModal',
  'showCreateGroupModal', 'showCreateRoomGroupModal', 'showEditAccountModal', 'submitAccountSettings',
  'submitAddAccount', 'submitCreateDMGroup', 'submitCreateGroup', 'submitCreateRoomGroup',
  'submitDeleteActiveDM', 'submitDeleteGroup', 'submitEditAccount', 'submitJoinRoom',
  'submitRemoveContact', 'submitRenameGroup', 'switchEmoticonFolder', 'toggleFavoriteEmoticon',
  'showJoinRoomModal', 'loadOlderMessages'
]);
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const name = el.dataset.action;
  const fn = UI_ACTIONS.has(name) ? window[name] : null;
  if (typeof fn !== 'function') return;
  e.preventDefault();
  let args = [];
  try { args = el.dataset.args ? JSON.parse(el.dataset.args) : []; } catch { return; }
  fn(...args);
  if (el.dataset.close === 'modal') hideModal();
});

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
      <button class="btn-secondary" data-action="hideModal">Later</button>
      <button class="btn-primary" data-action="openGithubRelease" data-args="${esc(JSON.stringify([updateInfo.releaseUrl]))}">Download Latest Version</button>
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
