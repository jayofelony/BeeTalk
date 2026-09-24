'use strict';
// Account dialogs, context menus, contact/room groups, join room, settings, chat info, update check.
// Part of the renderer: index.html loads src/js/*.js in order; they share one global scope.

// ─────────────────────────────────────────────
//  Account management
// ─────────────────────────────────────────────
function getActiveAccount() { return state.accounts.find(a => a.id === state.activeAccountId) || null; }

function showAddAccountModal() {
  // Single-account mode: only allow adding when no account exists yet
  if (state.accounts.length > 0) return;
  showModal(`
    <div class="modal-title">Add GSF Jabber Account</div>
    <div id="modal-error"></div>
    <div class="form-group">
      <label class="form-label">Display Name</label>
      <input class="form-input" id="fi-display-name" placeholder="Your display name" autocomplete="off" />
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
      Connects to goonfleet.com — <a href="#" style="color:var(--accent);text-decoration:underline;cursor:pointer;" data-action="openExternalLink" data-args="${esc(JSON.stringify(['https://gice.goonfleet.com/Manage/ServicePassword']))}">Check username/password</a>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary" data-action="submitAddAccount">Connect</button>
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
    errEl.innerHTML = '<div class="strip error">Display name, username, and password are required.</div>';
    return;
  }

  const server = 'goonfleet.com';
  const port = 5222;
  const account = {
    id: 'acct_' + Date.now(),
    username, password, server, port,
    displayName: displayNameInput,
    color: 'av-0',  // single account
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
    <div class="modal-actions" style="margin-top:16px">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary"   data-action="showEditAccountModal" data-args="${esc(JSON.stringify([acct.id]))}">Edit</button>
      <button class="btn-danger"    data-action="removeAccount" data-args="${esc(JSON.stringify([acct.id]))}">Remove</button>
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
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary"   data-action="submitEditAccount" data-args="${esc(JSON.stringify([id]))}">Save</button>
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
      return `<button class="btn-group-option" style="${isInGroup ? 'opacity:0.5;' : ''}" data-action="moveRoomToGroup" data-args="${esc(JSON.stringify([acct.id, chat.jid, groupName, chat.name]))}">${isInGroup ? '✓ ' : ''}${esc(groupName)}</button>`;
    }).join('');
  }

  showModal(`
    <div class="modal-title">Room: ${esc(chat.name)}</div>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px">${esc(chat.jid)}</p>
    ${groupOptions ? `<div style="display:grid;gap:8px;margin-bottom:16px;">${groupOptions}</div>` : ''}
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-secondary" data-action="showCreateRoomGroupModal" data-args="${esc(JSON.stringify([acct.id, chat.jid, chat.name]))}">+ Group</button>
      <button class="btn-danger"    data-action="leaveRoomConfirm" data-args="${esc(JSON.stringify([acct.id, chat.jid]))}">Leave room</button>
    </div>
  `);
}

function showActiveDMContextMenu(chat, acct) {
  if (!acct) return;

  const allGroups = Object.keys(acct.groups || {});
  const chatGroups = chat.groups || [];

  let groupOptions = allGroups.map(groupName => {
    const isInGroup = chatGroups.includes(groupName);
    return `<button class="btn-group-option" style="${isInGroup ? 'opacity:0.5;' : ''}" data-action="moveDMToGroup" data-args="${esc(JSON.stringify([acct.id, chat.jid, groupName, chat.name]))}">${isInGroup ? '✓ ' : ''}${esc(groupName)}</button>`;
  }).join('');

  showModal(`
    <div class="modal-title">DM: ${esc(chat.name)}</div>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px">${esc(chat.jid)}</p>
    ${groupOptions ? `<div style="display:grid;gap:8px;margin-bottom:16px;">${groupOptions}</div>` : ''}
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-secondary" data-action="showCreateDMGroupModal" data-args="${esc(JSON.stringify([acct.id, chat.jid, chat.name]))}">+ New Group</button>
      <button class="btn-danger" data-action="submitDeleteActiveDM" data-args="${esc(JSON.stringify([chat.accountId, chat.jid, chat.name]))}">Delete</button>
    </div>
  `);
}

function showContactContextMenu(contact, acct) {
  if (!acct) return;

  const allGroups = Object.keys(acct.groups || {});
  const contactGroups = contact.groups || [];

  let groupOptions = allGroups.map(groupName => {
    const isInGroup = contactGroups.includes(groupName);
    return `<button class="btn-group-option" style="${isInGroup ? 'opacity:0.5;' : ''}" data-action="moveContactToGroup" data-args="${esc(JSON.stringify([acct.id, contact.jid, groupName, contact.name]))}">${isInGroup ? '✓ ' : ''}${esc(groupName)}</button>`;
  }).join('');

  showModal(`
    <div class="modal-title">Groups for: ${esc(contact.name)}</div>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px">${esc(contact.jid)}</p>
    <div style="display:grid;gap:8px;margin-bottom:16px;">
      ${groupOptions}
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary" data-action="showCreateGroupModal" data-args="${esc(JSON.stringify([acct.id, contact.jid, contact.name]))}">+ New Group</button>
      <button class="btn-danger" data-action="removeContactConfirm" data-args="${esc(JSON.stringify([acct.id, contact.jid, contact.name]))}">Remove</button>
    </div>
  `);
}

function showGroupContextMenu(groupName, acct, groupType) {
  if (!acct) return;

  // Store group data globally for callbacks
  window._groupContextData = { groupName, acct, groupType };

  showModal(`
    <div class="modal-title">Group: ${esc(groupName)}</div>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px">${groupType === 'contact' ? 'Contact group' : 'Room group'}</p>
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-secondary" data-action="renameGroupModal" data-args="${esc(JSON.stringify([groupName, acct.id, groupType]))}">✏️ Rename</button>
      <button class="btn-danger" data-action="deleteGroupConfirm" data-args="${esc(JSON.stringify([groupName, acct.id, groupType]))}">🗑️ Delete</button>
    </div>
  `);
}

function showRoomGroupContextMenu(groupName, acct) {
  showGroupContextMenu(groupName, acct, 'room');
}

window.renameGroupModal = (groupName, accountId, groupType) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  showModal(`
    <div class="modal-title">Rename Group</div>
    <div id="modal-error"></div>
    <div class="form-group">
      <label class="form-label">New group name</label>
      <input class="form-input" id="fi-rename-group" value="${esc(groupName)}" placeholder="Group name…" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary" data-action="submitRenameGroup" data-args="${esc(JSON.stringify([groupName, accountId, groupType]))}">Rename</button>
    </div>
  `);
  document.getElementById('fi-rename-group').focus();
  document.getElementById('fi-rename-group').select();
};

window.submitRenameGroup = (oldName, accountId, groupType) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  const input = document.getElementById('fi-rename-group');
  const newName = input.value.trim();

  if (!newName) {
    document.getElementById('modal-error').innerHTML = '<div class="strip error">Group name is required.</div>';
    return;
  }

  if (newName === oldName) {
    hideModal();
    return;
  }

  const groupsObj = groupType === 'room' ? acct.roomGroups : acct.groups;
  
  // Check if new name already exists
  if (groupsObj[newName]) {
    document.getElementById('modal-error').innerHTML = '<div class="strip error">Group name already exists.</div>';
    return;
  }

  // Move metadata from old name to new name
  const metadata = groupsObj[oldName];
  groupsObj[newName] = { ...metadata, name: newName };
  delete groupsObj[oldName];

  // Update all items in this group
  Object.values(state.chats).forEach(chat => {
    if (chat.accountId !== accountId) return;
    if (!chat.groups) chat.groups = [];
    
    const idx = chat.groups.indexOf(oldName);
    if (idx >= 0) {
      chat.groups[idx] = newName;
    }
  });

  // Update roster contacts if this is a contact group
  if (groupType !== 'room' && acct.roster) {
    Object.values(acct.roster).forEach(contact => {
      if (!contact.groups) contact.groups = [];
      const idx = contact.groups.indexOf(oldName);
      if (idx >= 0) {
        contact.groups[idx] = newName;
      }
    });
  }

  // Save changes
  if (groupType === 'room') {
    saveRooms(accountId);
    localStorage.setItem('roomGroups_' + accountId, JSON.stringify(acct.roomGroups));
    renderRoomList(acct);
  } else {
    saveActiveDMs(accountId);
    saveRoster(accountId, acct.roster);
    localStorage.setItem('groups_' + accountId, JSON.stringify(acct.groups));
    renderContactList(acct);
  }

  hideModal();
  showModal(`
    <div class="modal-title">✓ Renamed</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">Group renamed from "${esc(oldName)}" to "${esc(newName)}".</p>
    <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
  `);
};

window.deleteGroupConfirm = (groupName, accountId, groupType) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  const groupsObj = groupType === 'room' ? acct.roomGroups : acct.groups;
  let itemCount = 0;

  // Count items in this group
  Object.values(state.chats).forEach(chat => {
    if (chat.accountId === accountId && chat.groups && chat.groups.includes(groupName)) {
      itemCount++;
    }
  });

  if (groupType !== 'room' && acct.roster) {
    Object.values(acct.roster).forEach(contact => {
      if (contact.groups && contact.groups.includes(groupName)) {
        itemCount++;
      }
    });
  }

  const itemText = itemCount === 0 ? 'This group is empty.' : `This group has ${itemCount} item(s). They will be moved to Ungrouped.`;

  showModal(`
    <div class="modal-title">Delete Group?</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">
      Are you sure you want to delete the group "${esc(groupName)}"?<br><br>
      ${itemText}
    </p>
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-danger" data-action="submitDeleteGroup" data-args="${esc(JSON.stringify([groupName, accountId, groupType]))}">Delete</button>
    </div>
  `);
};

window.submitDeleteGroup = (groupName, accountId, groupType) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  const groupsObj = groupType === 'room' ? acct.roomGroups : acct.groups;

  // Move all items in this group to ungrouped
  Object.values(state.chats).forEach(chat => {
    if (chat.accountId === accountId && chat.groups) {
      const idx = chat.groups.indexOf(groupName);
      if (idx >= 0) {
        chat.groups.splice(idx, 1);
      }
    }
  });

  // Update roster contacts if this is a contact group
  if (groupType !== 'room' && acct.roster) {
    Object.values(acct.roster).forEach(contact => {
      if (contact.groups) {
        const idx = contact.groups.indexOf(groupName);
        if (idx >= 0) {
          contact.groups.splice(idx, 1);
        }
      }
    });
  }

  // Delete group metadata
  delete groupsObj[groupName];

  // Save changes
  if (groupType === 'room') {
    saveRooms(accountId);
    localStorage.setItem('roomGroups_' + accountId, JSON.stringify(acct.roomGroups));
    renderRoomList(acct);
  } else {
    saveActiveDMs(accountId);
    saveRoster(accountId, acct.roster);
    localStorage.setItem('groups_' + accountId, JSON.stringify(acct.groups));
    renderContactList(acct);
  }

  hideModal();
  showModal(`
    <div class="modal-title">✓ Deleted</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">Group "${esc(groupName)}" has been deleted.</p>
    <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
  `);
};



// Where to reach a room participant: their real JID if the room shares it,
// otherwise a MUC private message to room@conference/nick.
function participantJids(chat, nick) {
  const partData = chat.participants?.[nick];
  const realJid = (typeof partData === 'object' && partData?.mucJid) ? bareJid(partData.mucJid) : null;
  return { realJid, dmJid: realJid || `${chat.jid}/${nick}` };
}

function participantMenuHtml(displayName, realJid) {
  return `
    <div style="padding: 6px 10px; font-size: 12px; color: var(--text3); border-bottom: 1px solid var(--border); margin-bottom: 4px;">${esc(displayName)}</div>
    <div class="context-menu-item" data-action="openDirectMessageWithParticipant_Menu">
      💬 Send DM
    </div>
    ${realJid ? `<div class="context-menu-item" data-action="addParticipantToContacts_Menu">
      ➕ Add to Contacts
    </div>` : ''}
  `;
}

function showParticipantContextMenu(chat, nick) {
  const acct = state.accounts.find(a => a.id === chat.accountId);
  if (!acct) return;

  const { realJid, dmJid: displayJid } = participantJids(chat, nick);
  const displayName = nick;

  // Store data globally for context menu callbacks
  window._contextMenuData = { chat, nick, displayJid, realJid, displayName, acct };

  const contextMenu = document.getElementById('context-menu');
  contextMenu.innerHTML = participantMenuHtml(displayName, realJid);
  
  showContextMenu(window.currentContextEvent);
}

window.openDirectMessageWithParticipant_Menu = () => {
  const data = window._contextMenuData;
  if (!data) return;
  const { nick, displayJid, acct, chat } = data;
  
  const key = chatKey(acct.id, displayJid);
  ensureChat(key, { type: 'dm', name: nick, jid: displayJid, accountId: acct.id });
  openChat(key);
  hideContextMenu();
};

window.addParticipantToContacts_Menu = () => {
  const data = window._contextMenuData;
  if (!data) return;
  const { realJid, displayName, acct } = data;
  if (!realJid) return;  // room hides real JIDs; the menu doesn't offer this then

  ipcRenderer.send('xmpp-add-contact', { accountId: acct.id, jid: realJid, name: displayName });
  if (!acct.roster) acct.roster = {};
  acct.roster[realJid] = { jid: realJid, name: displayName, presence: 'offline', groups: [] };
  saveRoster(acct.id, acct.roster);
  addSystemMsg(null, acct.id, `📋 Subscription request sent to ${displayName}`);
  renderLeftPanel();
  hideContextMenu();
};

function showMessageSenderContextMenu(chat, msg) {
  const acct = state.accounts.find(a => a.id === chat.accountId);
  if (!acct) return;

  // Extract nick from msg.from (e.g., "username@server/nickname" -> "nickname" or "nickname" for direct msgs)
  const nick = msg.from.includes('/') ? msg.from.split('/')[1] : msg.from;
  
  const { realJid, dmJid: displayJid } = participantJids(chat, nick);
  const displayName = nick;

  // Store data globally for context menu callbacks
  window._contextMenuData = { chat, nick, displayJid, realJid, displayName, acct };

  const contextMenu = document.getElementById('context-menu');
  contextMenu.innerHTML = participantMenuHtml(displayName, realJid);
  
  showContextMenu(window.currentContextEvent);
}

window.showMessageSenderContextMenu = showMessageSenderContextMenu;

function showMessageContextMenu(msg) {
  // Store message data for context menu callbacks
  window._messageContextData = { msg };
  
  const contextMenu = document.getElementById('context-menu');
  contextMenu.innerHTML = `
    <div class="context-menu-item" data-action="quoteMessage_Menu">
      💬 Quote
    </div>
    <div class="context-menu-item" data-action="copyMessage_Menu">
      📋 Copy
    </div>
  `;
  
  showContextMenu(window.currentContextEvent);
}

window.showMessageContextMenu = showMessageContextMenu;

window.quoteMessage_Menu = () => {
  const data = window._messageContextData;
  if (!data) return;
  const { msg } = data;
  const quotedText = msg.text.split('\n').map(line => '> ' + line).join('\n');
  const fullQuote = `${msg.from} wrote:\n${quotedText}\n\n`;
  msgInput.value = fullQuote;
  msgInput.focus();
  hideContextMenu();
};

window.copyMessage_Menu = () => {
  const data = window._messageContextData;
  if (!data) return;
  const { msg } = data;
  navigator.clipboard.writeText(msg.text).then(() => {
    addSystemMsg(null, state.activeAccountId, '📋 Copied to clipboard');
    hideContextMenu();
  }).catch(() => {
    addSystemMsg(null, state.activeAccountId, '❌ Failed to copy');
    hideContextMenu();
  });
};

function showContextMenu(e) {
  const contextMenu = document.getElementById('context-menu');
  if (!contextMenu) {
    console.error('Context menu element not found!');
    return;
  }
  
  contextMenu.classList.remove('hidden');
  contextMenu.style.zIndex = '10001';

  let x = e.clientX || 0;
  let y = e.clientY || 0;

  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';

  // Adjust if off-screen
  setTimeout(() => {
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      contextMenu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      contextMenu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    }
  }, 0);
}

function hideContextMenu() {
  const contextMenu = document.getElementById('context-menu');
  contextMenu.classList.add('hidden');
}

window.hideContextMenu = hideContextMenu;

// Close context menu when clicking elsewhere (but not on the menu itself)
document.addEventListener('click', (e) => {
  const contextMenu = document.getElementById('context-menu');
  if (!contextMenu.classList.contains('hidden') && !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});


function openDirectMessageWithParticipant(chat, nick) {
  const acct = state.accounts.find(a => a.id === chat.accountId);
  if (!acct) return;

  const participantJid = participantJids(chat, nick).dmJid;

  // Create or find existing DM chat
  const key = chatKey(acct.id, participantJid);
  ensureChat(key, { type: 'dm', name: nick, jid: participantJid, accountId: acct.id });
  openChat(key);
  hideModal();
}

window.openDirectMessageWithParticipant = openDirectMessageWithParticipant;
window.showParticipantContextMenu = showParticipantContextMenu;

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
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-danger" data-action="submitRemoveContact" data-args="${esc(JSON.stringify([accountId, contactJid, contactName]))}">Remove</button>
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
    <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
  `);
};

window.submitDeleteActiveDM = (accountId, chatJid, chatName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  // Close any open chat
  const key = chatKey(accountId, chatJid);
  if (state.activeChatKey === key) {
    state.activeChatKey = null;
    showWelcome();
  }
  delete state.chats[key];

  // Delete its stored history
  deleteChatHistory(key);

  // Update saved active DMs
  saveActiveDMs(accountId);

  // Re-render and show confirmation
  renderLeftPanel();
  showModal(`
    <div class="modal-title">✓ Deleted</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">Conversation with ${esc(chatName)} has been deleted.</p>
    <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
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
    <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
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
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary" data-action="submitCreateGroup" data-args="${esc(JSON.stringify([accountId, contactJid, contactName]))}">Create & Add</button>
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

window.moveDMToGroup = (accountId, dmJid, groupName, dmName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  const chat = Object.values(state.chats).find(c => c.jid === dmJid && c.accountId === accountId);
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

  // Save chats to persist group assignments
  saveActiveDMs(accountId);

  // Re-render
  renderLeftPanel();
  showModal(`
    <div class="modal-title">✓ Updated</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">DM with ${esc(dmName)} group updated.</p>
    <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
  `);
};

window.showCreateDMGroupModal = (accountId, dmJid, dmName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (!acct) return;

  showModal(`
    <div class="modal-title">Create New Group</div>
    <div id="modal-error"></div>
    <div class="form-group">
      <label class="form-label">Group name</label>
      <input class="form-input" id="fi-dm-group-name" placeholder="e.g. Friends, Work…" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary" data-action="submitCreateDMGroup" data-args="${esc(JSON.stringify([accountId, dmJid, dmName]))}">Create & Add</button>
    </div>
  `);
  document.getElementById('fi-dm-group-name').focus();
};

window.submitCreateDMGroup = (accountId, dmJid, dmName) => {
  const acct = state.accounts.find(a => a.id === accountId);
  const input = document.getElementById('fi-dm-group-name');
  const groupName = input.value.trim();

  if (!groupName) {
    document.getElementById('modal-error').innerHTML = '<div class="strip error">Group name is required.</div>';
    return;
  }

  // Create group metadata if it doesn't exist
  if (!acct.groups[groupName]) {
    acct.groups[groupName] = { name: groupName, collapsed: false };
    // Save to localStorage
    localStorage.setItem('groups_' + accountId, JSON.stringify(acct.groups));
  }

  // Add DM to group
  const chat = Object.values(state.chats).find(c => c.jid === dmJid && c.accountId === accountId);
  if (chat) {
    if (!chat.groups) chat.groups = [];
    if (!chat.groups.includes(groupName)) {
      chat.groups.push(groupName);
    }
    // Save chats to persist group assignments
    saveActiveDMs(accountId);
  }

  // Re-render and close
  renderLeftPanel();
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
    <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
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
      <input class="form-input" id="fi-room-group-name" placeholder="e.g. Gaming, Work, Social…" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary" data-action="submitCreateRoomGroup" data-args="${esc(JSON.stringify([accountId, roomJid, roomName]))}">Create & Add</button>
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
      <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
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
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary"   data-action="submitJoinRoom">Join</button>
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
  // Accept either a room name or a full room JID
  const roomJid = (roomName.includes('@') ? roomName : roomName + '@conference.goonfleet.com').toLowerCase();
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
  const launchOnStartup = settings.launchOnStartup === true;  // Default to false

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

    <div style="border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px;">
      <div style="font-weight: 500; margin-bottom: 12px; font-size: 12px; color: var(--text2); text-transform: uppercase;">Application</div>
      <div class="form-group" style="display: flex; align-items: center; gap: 10px;">
        <input type="checkbox" id="fi-launch-on-startup" ${launchOnStartup ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;" />
        <label for="fi-launch-on-startup" style="cursor: pointer; margin: 0;">Launch BeeTalk when Windows starts</label>
      </div>
    </div>

    <div style="padding-bottom: 12px; margin-bottom: 12px;">
      <div style="font-weight: 500; margin-bottom: 12px; font-size: 12px; color: var(--text2); text-transform: uppercase;">Notifications</div>
      <div class="form-group" style="display: flex; align-items: center; gap: 10px;">
        <input type="checkbox" id="fi-alarm-enabled" ${alarmEnabled ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;" />
        <label for="fi-alarm-enabled" style="cursor: pointer; margin: 0;">Play alarm for Directorbot messages</label>
        <button class="btn-secondary" style="padding: 4px 8px; font-size: 11px; margin-left: auto;" data-action="playAlarmSound">Test</button>
      </div>
      <div class="form-group" style="display: flex; align-items: center; gap: 10px;">
        <input type="checkbox" id="fi-dm-sound-enabled" ${dmSoundEnabled ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;" />
        <label for="fi-dm-sound-enabled" style="cursor: pointer; margin: 0;">Play sound for direct messages</label>
        <button class="btn-secondary" style="padding: 4px 8px; font-size: 11px; margin-left: auto;" data-action="playDMSound">Test</button>
      </div>
    </div>

    <div style="border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px;">
      <div style="font-weight: 500; margin-bottom: 12px; font-size: 12px; color: var(--text2); text-transform: uppercase;">Updates</div>
      ${appVersion ? `<div style="font-size: 11px; color: var(--text3); margin-bottom: 8px;">Current version: <strong style="color: var(--text1);">v${appVersion}</strong></div>` : ''}
      <div class="form-group" style="display: flex; gap: 8px; align-items: center;">
        <button class="btn-secondary" id="update-check-btn" data-action="checkForUpdate">Check for Updates</button>
        <span id="update-status" style="font-size: 12px; color: var(--text2);"></span>
      </div>
      <div id="update-spinner" style="display: none; margin-top: 8px;">
        <div style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--text2); border-top: 2px solid var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
        <span style="margin-left: 8px; color: var(--text2); font-size: 12px;">Checking...</span>
      </div>
      <div id="update-message" style="display: none; margin-top: 8px; padding: 8px; border-radius: 4px; font-size: 12px;"></div>
    </div>

    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Cancel</button>
      <button class="btn-primary"   data-action="submitAccountSettings">Save</button>
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
    const launchOnStartup = document.getElementById('fi-launch-on-startup')?.checked ?? false;

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
    saveAppSettings({ theme, alarmEnabled, dmSoundEnabled, launchOnStartup });
    setTheme(theme);

    // Update Windows startup registration
    ipcRenderer.send('set-launch-on-startup', { enabled: launchOnStartup });

    renderLeftPanel();
    hideModal();
  } catch (err) {
    console.error('Error saving settings:', err);
  }
};

function showChatInfoModal() {
  const chat = state.chats[state.activeChatKey];
  if (!chat) return;

  console.log(`[showChatInfoModal] Chat key: ${state.activeChatKey}, motd: "${chat.motd}"`);

  const type = chat.type === 'room' ? 'Group Chat' : 'Direct Message';
  const participants = chat.participants ? Object.keys(chat.participants).length : 0;

  showModal(`
    <div class="modal-title">Chat Info</div>
    <div style="padding: 12px 0;">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
        <div class="avatar" style="font-size: 24px; width: 60px; height: 60px; display: flex; align-items: center; justify-content: center;">${esc(initials(chat.name))}</div>
        <div>
          <div style="font-weight: 500; font-size: 14px;">${esc(chat.name)}</div>
          <div style="font-size: 12px; color: var(--text2);">${type}</div>
        </div>
      </div>
      <div style="border-top: 1px solid var(--border); padding-top: 12px;">
        <div style="font-size: 12px; color: var(--text2); margin-bottom: 4px; text-transform: uppercase;">Details</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
          <div>
            <div style="color: var(--text2); margin-bottom: 2px;">JID</div>
            <div style="word-break: break-all; font-family: monospace; font-size: 11px;">${esc(chat.jid || '—')}</div>
          </div>
          ${chat.type === 'room' ? `
            <div>
              <div style="color: var(--text2); margin-bottom: 2px;">Participants</div>
              <div>${participants}</div>
            </div>
          ` : ''}
        </div>
      </div>
      ${chat.type === 'room' ? `
        <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px;">
          <div style="font-size: 12px; color: var(--text2); margin-bottom: 4px; text-transform: uppercase;">Subject</div>
          <div id="chat-info-subject-display" style="padding: 10px 12px; background: var(--bg2); border-radius: var(--radius); border-left: 3px solid var(--accent); font-size: 13px; color: var(--text1); line-height: 1.6; word-wrap: break-word; overflow-wrap: break-word; white-space: pre-wrap;">
            ${chat.motd ? escapeAndLinkify(chat.motd) : '—'}
          </div>
        </div>
      ` : ''}
    </div>
    <div class="modal-actions">
      <button class="btn-primary" data-action="hideModal">Close</button>
    </div>
  `);

  state.chatInfoModalOpen = true;
  state.chatInfoModalKey = state.activeChatKey;
}

function updateChatInfoModalSubject() {
  if (!state.chatInfoModalOpen || !state.chatInfoModalKey) return;

  const chat = state.chats[state.chatInfoModalKey];
  if (!chat || chat.type !== 'room') return;

  const subjectEl = document.getElementById('chat-info-subject-display');
  if (subjectEl) {
    subjectEl.innerHTML = chat.motd ? escapeAndLinkify(chat.motd) : '—';
  }
}

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
          ⬆ Update available: <strong>${esc(result.version)}</strong>
        </div>
        <div style="font-size: 11px; margin-bottom: 8px; color: var(--text2); max-height: 100px; overflow-y: auto;">
          ${esc(result.releaseNotes).replace(/\n/g, '<br>')}
        </div>
        <button class="btn-primary" style="font-size: 11px; padding: 4px 8px;" data-action="openExternalLink" data-args="${esc(JSON.stringify([result.releaseUrl]))}">Download from GitHub</button>
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
