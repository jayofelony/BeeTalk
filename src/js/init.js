'use strict';
// DOM event listeners, participants panel, boot.
// Part of the renderer: index.html loads src/js/*.js in order; they share one global scope.

// ─────────────────────────────────────────────
//  Event listeners
// ─────────────────────────────────────────────
$('btn-minimize').addEventListener('click', () => ipcRenderer.send('window-minimize'));
$('btn-maximize').addEventListener('click', () => ipcRenderer.send('window-maximize'));
$('btn-close').addEventListener('click', () => ipcRenderer.send('window-close'));
// Single-account mode: showAddAccountModal() is a no-op once an account exists
$('btn-add-account').addEventListener('click', showAddAccountModal);
$('btn-welcome-add').addEventListener('click', showAddAccountModal);

$('btn-browse-rooms').addEventListener('click', showBrowseRoomsModal);
$('btn-settings').addEventListener('click', showAccountSettingsModal);
btnReconnect.addEventListener('click', () => {
  const acct = getActiveAccount();
  if (acct) {
    ipcRenderer.send('xmpp-connect', acct);
  }
});
$('btn-emoticon').addEventListener('click', showEmoticonPicker);
$('btn-send').addEventListener('click', sendMessage);
$('btn-chat-info').addEventListener('click', showChatInfoModal);
$('btn-chat-search').addEventListener('click', showChatSearchModal);

msgInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
msgInput.addEventListener('input', () => { msgInput.style.height = 'auto'; msgInput.style.height = Math.min(msgInput.scrollHeight, 130) + 'px'; onComposeInput(); });

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  // Ctrl/Cmd + N: Add new account
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    showAddAccountModal();
  }

  // Ctrl/Cmd + Shift + F: search in the open chat
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f' && state.activeChatKey) {
    e.preventDefault();
    showChatSearchModal();
    return;
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
          <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
        `);
        return;
      }

      const acct = getActiveAccount();
      if (!acct) {
        showModal(`
          <div class="modal-title">Error</div>
          <p style="color:var(--text3);font-size:13px;margin-bottom:16px">No active account selected.</p>
          <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
        `);
        return;
      }

      // Append @goonfleet.com if not already present
      const jid = username.includes('@') ? username : username + '@goonfleet.com';
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
        <div class="modal-actions"><button class="btn-secondary" data-action="hideModal">OK</button></div>
      `);
    }
  });
}


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
  await initHistory();
  await loadAndConnect();
  document.body.dataset.ready = 'true';  // boot finished (used by the tests)
})();
