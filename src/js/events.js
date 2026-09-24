'use strict';
// Events from the main process (XMPP status, messages, presence, roster, subjects), typing notifications, sounds.
// Part of the renderer: index.html loads src/js/*.js in order; they share one global scope.

// ─────────────────────────────────────────────
//  IPC events from main process
// ─────────────────────────────────────────────
ipcRenderer.on('xmpp-status', (e, { id, status, jid, error, resumed }) => {
  const acct = state.accounts.find(a => a.id === id);
  if (!acct) return;
  const wasDown = acct._wentDown;
  acct.status = status;
  if (jid) acct.jid = jid;
  if (status === 'online' && wasDown) {
    addSystemMsg(null, id, resumed ? '✓ Reconnected (nothing missed)' : '✓ Reconnected');
  }
  if (status === 'online') acct._wentDown = false;
  // A resumed session (XEP-0198) is still in its rooms; only a new session rejoins
  if (status === 'online' && !resumed) {
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
      // Send join request, asking only for history we missed
      state.chats[key].myNick = acct.displayName;
      ipcRenderer.send('xmpp-join-room', { accountId: id, roomJid: r.jid, nick: acct.displayName, since: historySince(state.chats[key]) });
    });

    saveRooms(id);
    renderLeftPanel();
  }
  if (status === 'error' || status === 'authfail') {
    addSystemMsg(null, id, `⚠ ${status === 'authfail' ? 'Authentication failed' : ('Connection error: ' + error)}`);
  }
  if (status === 'offline' && acct._wasOnline) {
    addSystemMsg(null, id, '⚠ Disconnected — reconnecting…');
    acct._wentDown = true;
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

ipcRenderer.on('xmpp-room-subject', (e, { accountId, roomJid, subject }) => {
  const key = chatKey(accountId, roomJid);
  // Create chat if it doesn't exist yet (subject might arrive before room join)
  if (!state.chats[key]) {
    ensureChat(key, { type: 'room', name: roomJid.split('@')[0], jid: roomJid, accountId });
  }
  state.chats[key].motd = subject || '';
  console.log(`[Renderer] Room subject stored for ${roomJid}: "${subject}"`);
  saveChatState(key);  // Persist subject

  // Add system message in room when subject changes
  if (subject) {
    addSystemMsg(key, accountId, `📌 Topic: ${subject}`);
  } else {
    addSystemMsg(key, accountId, `📌 Topic cleared`);
  }

  // Update info modal if it's open for this room
  if (state.chatInfoModalOpen && state.chatInfoModalKey === key) {
    updateChatInfoModalSubject();
  }
});

ipcRenderer.on('app-focus', () => {
  state.appIsFocused = true;
  if (state.activeChatKey) markChatAsRead(state.activeChatKey);
  // Reset all new message counters
  Object.values(state.chats).forEach(chat => {
    chat.newMessagesWhileUnfocused = 0;
  });
  renderLeftPanel();
});

ipcRenderer.on('app-blur', () => {
  state.appIsFocused = false;
});

ipcRenderer.on('xmpp-message', (e, { accountId, from, body, type, ts, delayed, outgoing }) => {
  const senderBareJid = bareJid(from);
  const senderName = senderBareJid.split('@')[0];

  // Route directorbot messages to a special chat
  if (senderName === 'directorbot') {
    const key = chatKey(accountId, 'directorbot@' + senderBareJid.split('@')[1]);
    ensureChat(key, { type: 'dm', name: 'Directorbot', jid: 'directorbot@' + senderBareJid.split('@')[1], accountId });
    pushMessage(key, { from: 'Directorbot', text: body, ts, me: false });

    // Auto-open Directorbot chat
    openChat(key);
    notifyIfNeeded(key, 'Directorbot', body);

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
    const chat    = state.chats[key];
    if (!chat) return;
    const myNick = chat.myNick || '';
    const msg = { from: nick, text: body, ts, me: nick === myNick };
    if (delayed && isDuplicateMessage(chat, msg)) return;
    pushMessage(key, msg);
    // Rooms are busy: only notify when someone mentions our nick
    if (!delayed && !msg.me && mentionsMe(chat, body)) {
      notifyIfNeeded(key, `${chat.name} / ${nick}`, body);
    }
  } else {
    // A private message from a room participant comes from room@conference/nick
    const isRoomPM = state.chats[chatKey(accountId, senderBareJid)]?.type === 'room';
    const dmJid = isRoomPM ? from : senderBareJid;
    const key = chatKey(accountId, dmJid);
    const acct = state.accounts.find(a => a.id === accountId);
    const displayName = isRoomPM ? (from.split('/')[1] || '?') : (acct?.roster?.[senderBareJid]?.name || senderName);
    ensureChat(key, { type: 'dm', name: displayName, jid: dmJid, accountId });
    // outgoing: a message we sent from another device (message carbons); `from` is the peer
    const msg = outgoing
      ? { from: acct?.username || 'me', text: body, ts, me: true }
      : { from: displayName, text: body, ts, me: false };
    if (delayed && isDuplicateMessage(state.chats[key], msg)) return;
    if (!outgoing) setPeerTyping(key, false);  // a message ends "typing…"
    pushMessage(key, msg);
    if (outgoing) { saveActiveDMs(accountId); return; }
    if (!delayed) notifyIfNeeded(key, displayName, body);

    // Play sound for DM notifications if enabled and not in Do Not Disturb mode
    const settings = getAppSettings();
    if (!delayed && settings.dmSoundEnabled !== false && acct?.presence !== 'dnd') {
      playNotificationSound({ beepCount: 2, baseFrequency: 600, frequencyIncrement: 0, beepDuration: 0.15, gapDuration: 0.08, volume: 0.25 });
    }

    // Persist active DM metadata for unknown contacts
    saveActiveDMs(accountId);
  }
});

// ─────────────────────────────────────────────
//  Typing notifications (XEP-0085), DMs only
// ─────────────────────────────────────────────
// Incoming: show "typing…" in the chat header. Outgoing: only to peers whose client
// has sent us a chat state, as XEP-0085 asks; "paused" after 5 s without typing.
const TYPING_PAUSE_MS = 5000;
const TYPING_EXPIRE_MS = 30000;  // in case the peer never sends "paused"

function dmKeyFor(accountId, from) {
  const isRoomPM = state.chats[chatKey(accountId, bareJid(from))]?.type === 'room';
  return chatKey(accountId, isRoomPM ? from : bareJid(from));
}

function setPeerTyping(key, typing) {
  const chat = state.chats[key];
  if (!chat) return;
  clearTimeout(chat.typingTimer);
  chat.peerTyping = typing;
  if (typing) chat.typingTimer = setTimeout(() => setPeerTyping(key, false), TYPING_EXPIRE_MS);
  if (state.activeChatKey === key) updateChatHeaderSub(chat);
}

function updateChatHeaderSub(chat) {
  const typing = chat.type !== 'room' && chat.peerTyping;
  chatHeaderSub.textContent = chat.type === 'room' ? '' : (typing ? `${chat.name} is typing…` : chat.jid);
  chatHeaderSub.classList.toggle('typing', !!typing);
}

ipcRenderer.on('xmpp-chat-state', (e, { accountId, from, state: chatStateName }) => {
  const key = dmKeyFor(accountId, from);
  const chat = state.chats[key];
  if (!chat || chat.type === 'room') return;  // don't create chats for typing alone
  chat.peerSendsChatStates = true;
  setPeerTyping(key, chatStateName === 'composing');
});

function sendChatState(chat, chatStateName) {
  ipcRenderer.send('xmpp-send-chat-state', { accountId: chat.accountId, to: chat.jid, state: chatStateName });
}

// Called on every keystroke in the message box
function onComposeInput() {
  const chat = state.chats[state.activeChatKey];
  const acct = chat && state.accounts.find(a => a.id === chat.accountId);
  if (!chat || chat.type === 'room' || !chat.peerSendsChatStates || acct?.status !== 'online') return;
  clearTimeout(chat.composePauseTimer);
  if (!msgInput.value.trim()) {
    if (chat.composingSent) { chat.composingSent = false; sendChatState(chat, 'active'); }
    return;
  }
  if (!chat.composingSent) { chat.composingSent = true; sendChatState(chat, 'composing'); }
  chat.composePauseTimer = setTimeout(() => {
    if (chat.composingSent) { chat.composingSent = false; sendChatState(chat, 'paused'); }
  }, TYPING_PAUSE_MS);
}

// Leaving a chat or sending ends our "composing" state
function endCompose(chat, sendPaused) {
  if (!chat) return;
  clearTimeout(chat.composePauseTimer);
  if (chat.composingSent && sendPaused) sendChatState(chat, 'paused');
  chat.composingSent = false;
}

ipcRenderer.on('xmpp-presence', (e, { accountId, from, type, show, mucJid }) => {
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
      else chat.participants[nick] = { presence: show || 'available', mucJid: mucJid };
      if (state.activeChatKey === key) scheduleParticipants();
    }
  }
  if (state.activeAccountId === accountId) scheduleLeftPanel();
});

ipcRenderer.on('tray-status', (e, show) => {
  const acct = getActiveAccount();
  if (acct && acct.status === 'online') {
    ipcRenderer.send('xmpp-send-presence', { accountId: acct.id, show });
    acct.presence = show;
    renderLeftPanel();
  }
});

ipcRenderer.on('open-chat', (e, key) => {
  if (state.chats[key]) openChat(key);
});

ipcRenderer.on('update-available', (e, result) => {
  // Store update info and show modal
  window.pendingUpdate = result;
  console.log('Update available:', result.version);
  showUpdateAvailableModal(result);
});

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
