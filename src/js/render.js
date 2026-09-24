'use strict';
// Left panel (contacts, rooms), opening and rendering chats, sending messages.
// Part of the renderer: index.html loads src/js/*.js in order; they share one global scope.

// ─────────────────────────────────────────────
//  Render
// ─────────────────────────────────────────────
// Busy rooms deliver bursts of messages and presence changes; coalesce the
// resulting re-renders into one per frame.
let leftPanelFrame = null;
function scheduleLeftPanel() {
  if (leftPanelFrame) return;
  leftPanelFrame = requestAnimationFrame(() => { leftPanelFrame = null; renderLeftPanel(); });
}
let participantsFrame = null;
function scheduleParticipants() {
  if (participantsFrame) return;
  participantsFrame = requestAnimationFrame(() => {
    participantsFrame = null;
    const chat = state.chats[state.activeChatKey];
    if (chat?.type === 'room') renderParticipants(chat);
  });
}

function renderAccountBar() {
  accountListEl.innerHTML = '';
  // Single-account mode: only offer add-account buttons when no account exists
  // (both are display:none in styles.css, so they must be shown explicitly)
  const noAccount = state.accounts.length === 0;
  $('btn-add-account').style.display = noAccount ? 'flex' : 'none';
  $('btn-welcome-add').style.display = noAccount ? 'inline-block' : 'none';
  const acct = getActiveAccount();
  if (!acct) return;

  const btn = document.createElement('button');
  btn.className = 'acct-btn ' + acct.color;
  btn.title = acct.displayName || acct.username;
  btn.textContent = initials(acct.username);
  const pip = document.createElement('span');
  pip.className = 'acct-status-pip ' + (acct.status === 'online' ? 'dot-green' : acct.status === 'connecting' ? 'dot-amber' : 'dot-gray');
  btn.appendChild(pip);
  btn.addEventListener('click', () => showAccountContextMenu(acct));
  accountListEl.appendChild(btn);
  accountListEl.style.display = 'flex';

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
  let allEntries = Object.values(acct.roster || {}).filter(r =>
    !r.jid.startsWith('directorbot@') && (
      !state.search || r.name.toLowerCase().includes(state.search) || r.jid.toLowerCase().includes(state.search)
    )
  );

  // Add active DMs (unknown contacts) to the list
  const activeDMs = Object.entries(state.chats)
    .filter(([key, chat]) => 
      chat.accountId === acct.id && 
      chat.type === 'dm' && 
      !acct.roster?.[chat.jid] && // Not in roster
      (!state.search || chat.name.toLowerCase().includes(state.search) || chat.jid.toLowerCase().includes(state.search))
    )
    .map(([key, chat]) => ({
      jid: chat.jid,
      name: chat.name,
      presence: 'available', // Active DMs are treated as available for sorting
      groups: chat.groups || [] // Use chat groups if available
    }));

  allEntries = allEntries.concat(activeDMs).sort((a, b) => {
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

    // Add context menu for user groups (not for Ungrouped)
    if (groupName !== 'Ungrouped') {
      headerEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showGroupContextMenu(groupName, acct, 'contact');
      });
    }

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

        // Context menu for group management or deletion
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const isRosterContact = acct.roster && acct.roster[contact.jid];
          if (isRosterContact) {
            showContactContextMenu(contact, acct);
          } else {
            // Unknown contact DM
            const chat = state.chats[key];
            showActiveDMContextMenu(chat, acct);
          }
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

    // Add context menu for user room groups (not for Ungrouped)
    if (groupName !== 'Ungrouped') {
      headerEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showRoomGroupContextMenu(groupName, acct);
      });
    }

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
let openChatRenderId = 0;  // a newer openChat() render supersedes older batches

// scrollTo: 'bottom', or 'keep' to hold the view in place after older messages were prepended
function openChat(key, loadHistory = true, scrollTo = 'bottom') {
  const renderId = ++openChatRenderId;
  if (state.activeChatKey && state.activeChatKey !== key) endCompose(state.chats[state.activeChatKey], true);
  state.activeChatKey = key;
  const chat = state.chats[key];
  if (!chat) return;

  const isRoom = chat.type === 'room';
  const isDirectorbot = chat.jid && chat.jid.startsWith('directorbot@');

  chatHeaderAv.className     = 'avatar ' + avatarColor(chat.jid);
  chatHeaderAv.style.borderRadius = isRoom ? '6px' : '10px';
  chatHeaderAv.textContent   = isRoom ? '#' : initials(chat.name);
  chatHeaderName.textContent = isRoom ? chat.jid : chat.name;
  updateChatHeaderSub(chat);

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

  // Fetch archived DM history; it re-renders this chat when it arrives
  if (!isRoom && loadHistory) {
    loadMessageHistory(key);
  }

  // Load stored messages
  if (chat.messages.length === 0) {
    const savedMessages = loadChatMessages(key);
    if (savedMessages.length > 0) {
      chat.messages = savedMessages;
      console.log(`Loaded ${savedMessages.length} saved messages for ${chat.jid}`);
    }
  }

  // Reset unread since we're viewing the chat
  chat.unread = 0;

  const keepFromBottom = messagesArea.scrollHeight - messagesArea.scrollTop;
  // Messages after this were not seen yet: mark them with a "New messages" line
  const lastRead = scrollTo === 'bottom' ? (chat.lastReadTs || 0) : 0;
  let newDivider = null;
  messagesArea.innerHTML = '';

  // For rooms: limit displayed messages to avoid performance issues
  // (raised each time the user loads older messages)
  const displayLimit = isRoom ? Math.max(chat.displayLimit || 0, MAX_DISPLAYED_MESSAGES_ROOM) : Infinity;
  const messagesToRender = chat.messages.slice(-displayLimit);

  // More messages in memory or in the local history store: offer to load them
  if (chat.messages.length > messagesToRender.length || (history.db && !chat.historyExhausted)) {
    const older = document.createElement('button');
    older.className = 'load-older-btn';
    older.textContent = 'Load older messages';
    older.dataset.action = 'loadOlderMessages';
    older.dataset.args = JSON.stringify([key]);
    messagesArea.appendChild(older);
  }

  // Render messages incrementally to avoid UI blocking
  let lastDay = null;
  let renderIndex = 0;
  
  function renderNextBatch() {
    if (renderId !== openChatRenderId) return;  // another chat was opened meanwhile
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
      if (lastRead && !newDivider && !msg.me && msg.ts > lastRead) {
        newDivider = document.createElement('div');
        newDivider.className = 'new-divider';
        newDivider.textContent = 'New messages';
        messagesArea.appendChild(newDivider);
      }
      appendMessage(msg, chat);
    }
    
    renderIndex = endIdx;
    
    if (renderIndex < messagesToRender.length) {
      // Schedule next batch
      requestAnimationFrame(renderNextBatch);
    } else {
      // All messages rendered (appendMessage already added emoticons and links)
      requestAnimationFrame(() => {
        if (scrollTo === 'keep') messagesArea.scrollTop = messagesArea.scrollHeight - keepFromBottom;
        else if (newDivider) {
          // Start reading at the first new message
          messagesArea.scrollTop += newDivider.getBoundingClientRect().top - messagesArea.getBoundingClientRect().top - 8;
        } else scrollToBottom();
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
    
    // Check if message contains HTML tags
    if (/<[^>]/.test(msg.text)) {
      bubble.innerHTML = sanitizeMessageHTML(parseEmoticons(msg.text));
    } else {
      bubble.textContent = parseEmoticons(msg.text);
    }
    
    applyEmoticons(bubble);
    linkifyUrls(bubble);
    if (!msg.me && mentionsMe(chat, msg.text)) bubble.classList.add('mention');
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
    sn.className = 'msg-sender-name'; 
    sn.textContent = msg.from;
    sn.style.cursor = 'pointer';
    sn.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      window.currentContextEvent = e;
      showMessageSenderContextMenu(chat, msg);
    });
    body.appendChild(sn);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  
  // Check if message contains HTML tags
  if (/<[^>]/.test(msg.text)) {
    bubble.innerHTML = sanitizeMessageHTML(parseEmoticons(msg.text));
  } else {
    bubble.textContent = parseEmoticons(msg.text);
  }
  
  applyEmoticons(bubble);
  linkifyUrls(bubble);
  if (!msg.me && mentionsMe(chat, msg.text)) bubble.classList.add('mention');
  bubble.style.cursor = 'context-menu';
  bubble.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    window.currentContextEvent = e;
    showMessageContextMenu(msg);
  });
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
    const partData = chat.participants[nick];
    const presence = (typeof partData === 'string') ? partData : (partData?.presence || 'available');
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
  endCompose(chat, false);

  // Echo immediately for DMs (groupchat echo comes back from server)
  if (chat.type === 'dm') {
    pushMessage(state.activeChatKey, { from: acct.username, text, ts: Date.now(), me: true });
  }

  msgInput.value = '';
  msgInput.style.height = 'auto';
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
