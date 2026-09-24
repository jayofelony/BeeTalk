'use strict';
// Browse Rooms: room discovery and joining.
// Part of the renderer: index.html loads src/js/*.js in order; they share one global scope.

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
      <button class="btn-secondary" data-action="hideModal">Close</button>
      <button class="btn-secondary" data-action="showJoinRoomModal">Join by name…</button>
      <button class="btn-primary" id="btn-join-selected" data-action="joinMultipleRooms" style="display: none;">Join Selected</button>
    </div>
  `);

  // Add loading animation CSS
  if (!document.getElementById('spin-animation')) {
    const style = document.createElement('style');
    style.id = 'spin-animation';
    style.innerHTML = '@keyframes spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }

  const account = getActiveAccount();
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
          <div style="font-size: 12px;">The server isn't responding to room discovery requests. You can still join a room with "Join by name…" below.</div>
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
        <div class="room-item" data-name="${esc(room.name.toLowerCase())}" data-jid="${esc(room.jid.toLowerCase())}" style="padding: 12px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: center;">
          <input type="checkbox" class="room-checkbox" data-jid="${esc(room.jid)}" data-name="${esc(room.name)}" style="width: 18px; height: 18px; cursor: pointer;" />
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 500; color: var(--text1);">#${esc(room.name)}</div>
            <div style="font-size: 12px; color: var(--text3);">${esc(room.jid)}</div>
          </div>
          <button class="btn-primary" style="padding: 6px 12px; font-size: 12px; white-space: nowrap;" data-action="joinSingleRoom" data-args="${esc(JSON.stringify([room.jid, room.name]))}">Join</button>
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
  const account = getActiveAccount();
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

  const account = getActiveAccount();
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
