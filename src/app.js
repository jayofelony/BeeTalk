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

// EVE location state: characterId -> { systemId, systemName, regionName, characterName, accountId }
const eveLocationState = {};
let eveTrackedCharacterId = null;  // which character the map is currently showing

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
}
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

ipcRenderer.on('eve-character-linked', (e, { accountId, characterId, characterName }) => {
  const acct = state.accounts.find(a => a.id === accountId);
  if (acct) {
    if (!acct.eveCharacters) acct.eveCharacters = [];
    if (!acct.eveCharacters.find(c => c.characterId === characterId)) {
      acct.eveCharacters.push({ characterId, characterName });
    }
  }
  updateEveMapPanelVisibility();
});

ipcRenderer.on('eve-location-update', (e, { accountId, characterId, characterName, systemId, systemName, regionName }) => {
  eveLocationState[characterId] = { accountId, characterId, characterName, systemId, systemName, regionName };
  eveTrackedCharacterId = characterId;  // Most recently updated character
  localStorage.setItem('lastEveSystem', systemId);
  renderEveMapPanel();
  if (eveMap.canvas) {
    eveMap.focusSystemId = systemId;
    // Preserve autopilot destination when reloading region
    const savedDest = fullscreenEveMap.autopilotDestination;
    const savedTimer = fullscreenEveMap.waypointClearTimer;
    eveMapLoadRegion(systemId);
    fullscreenEveMap.autopilotDestination = savedDest;
    fullscreenEveMap.waypointClearTimer = savedTimer;
  }
});

// ─────────────────────────────────────────────
//  EVE Map Canvas Renderer
// ─────────────────────────────────────────────
const eveMap = {
  canvas: null, ctx: null, data: null, systemIndex: {}, animFrame: null,
  transform: { scale: 1, offsetX: 0, offsetY: 0 }, fitScale: 1,
  dragging: false, dragOrigin: { x: 0, y: 0 }, hovered: null,
  focusSystemId: null, pulsePhase: 0, loadingRegionId: null,
  characterMarkers: {},  // systemId -> [{ characterId, characterName }, ...]
  showJumpBridges: true
};

function eveGetTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

// RIFT-compatible security status colors (11-tier scale)
function eveSecColor(sec) {
  const roundedSec = Math.round(sec * 10) / 10;  // Round to nearest 0.1
  if (roundedSec >= 1.0) return '#2E74DF';   // Deep blue (1.0+)
  if (roundedSec >= 0.9) return '#379CF6';   // Bright blue (0.9-0.99)
  if (roundedSec >= 0.8) return '#4ACFF3';   // Cyan (0.8-0.89)
  if (roundedSec >= 0.7) return '#5CDCA6';   // Teal (0.7-0.79)
  if (roundedSec >= 0.6) return '#70E552';   // Green (0.6-0.69)
  if (roundedSec >= 0.5) return '#EEFF83';   // Yellow-green (0.5-0.59)
  if (roundedSec >= 0.4) return '#DC6C08';   // Orange (0.4-0.49)
  if (roundedSec >= 0.3) return '#CE4611';   // Dark orange (0.3-0.39)
  if (roundedSec >= 0.2) return '#BC1113';   // Dark red (0.2-0.29)
  if (roundedSec >= 0.1) return '#6D231A';   // Deep maroon (0.1-0.19)
  return '#8F3068';                           // Purple (0.0-0.09, null sec)
}

function eveMapToCanvas(x, y) {
  return { cx: x * eveMap.transform.scale + eveMap.transform.offsetX, cy: -y * eveMap.transform.scale + eveMap.transform.offsetY };
}

function eveMapFitToCanvas() {
  if (!eveMap.data?.systems || !eveMap.canvas) return;
  const sys = eveMap.data.systems;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  sys.forEach(s => { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y); });
  const pad = 50, rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const scale = Math.min((eveMap.canvas.width - pad * 2) / rangeX, (eveMap.canvas.height - pad * 2) / rangeY);
  eveMap.fitScale = scale;
  eveMap.transform.scale = scale;
  eveMap.transform.offsetX = pad - minX * scale + ((eveMap.canvas.width - pad * 2) - rangeX * scale) / 2;
  eveMap.transform.offsetY = pad + maxY * scale + ((eveMap.canvas.height - pad * 2) - rangeY * scale) / 2;
}

function eveMapDraw() {
  const { canvas, ctx, data, transform } = eveMap;
  if (!canvas || !ctx) return;
  const w = canvas.width, h = canvas.height;
  const isDark = eveGetTheme() === 'dark';

  ctx.fillStyle = isDark ? '#080810' : '#f5f5f7';
  ctx.fillRect(0, 0, w, h);

  if (!data) return;

  eveMap.pulsePhase = (eveMap.pulsePhase + 0.04) % (Math.PI * 2);
  const dotR = 2;

  // Connections (stargates)
  ctx.strokeStyle = isDark ? 'rgba(60, 80, 140, 0.35)' : 'rgba(150, 150, 200, 0.25)';
  ctx.lineWidth = 0.6;
  data.connections.forEach(([a, b]) => {
    const sa = eveMap.systemIndex[a], sb = eveMap.systemIndex[b];
    if (!sa || !sb) return;
    const pa = eveMapToCanvas(sa.x, sa.y), pb = eveMapToCanvas(sb.x, sb.y);
    ctx.beginPath(); ctx.moveTo(pa.cx, pa.cy); ctx.lineTo(pb.cx, pb.cy); ctx.stroke();
  });

  // Jump bridges and cross-region endpoints
  const crossRegionEndpoints = new Map(); // systemId -> { system, regionName }
  if (eveMap.showJumpBridges && data.jumpBridges) {
    ctx.strokeStyle = isDark ? 'rgba(255, 100, 100, 0.4)' : 'rgba(200, 50, 50, 0.3)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 3]);
    data.jumpBridges.forEach(([a, b]) => {
      const sa = eveMap.systemIndex[a], sb = eveMap.systemIndex[b];
      if (!sa || !sb) return;
      const pa = eveMapToCanvas(sa.x, sa.y), pb = eveMapToCanvas(sb.x, sb.y);
      ctx.beginPath(); ctx.moveTo(pa.cx, pa.cy); ctx.lineTo(pb.cx, pb.cy); ctx.stroke();

      // Track cross-region endpoints (systems not in current region)
      const inCurrentRegion = data.systems.some(sys => sys.id === a);
      if (!inCurrentRegion && sa && sa.regionName) {
        crossRegionEndpoints.set(a, { system: sa, regionName: sa.regionName });
      }
      const inCurrentRegionB = data.systems.some(sys => sys.id === b);
      if (!inCurrentRegionB && sb && sb.regionName) {
        crossRegionEndpoints.set(b, { system: sb, regionName: sb.regionName });
      }
    });
    ctx.setLineDash([]);
  }

  // Systems with character markers
  eveMap.characterMarkers = {};
  for (const [charId, loc] of Object.entries(eveLocationState)) {
    const sys = eveMap.systemIndex[loc.systemId];
    if (sys) {
      if (!eveMap.characterMarkers[loc.systemId]) eveMap.characterMarkers[loc.systemId] = [];
      eveMap.characterMarkers[loc.systemId].push({ characterId: charId, characterName: loc.characterName });
    }
  }

  data.systems.forEach(sys => {
    const { cx, cy } = eveMapToCanvas(sys.x, sys.y);
    if (cx < -20 || cx > w + 20 || cy < -20 || cy > h + 20) return;
    const isFocus = sys.id === eveMap.focusSystemId;
    const isHovered = eveMap.hovered?.id === sys.id;
    const hasCharacters = eveMap.characterMarkers[sys.id];
    const color = eveSecColor(sys.security);

    if (isFocus || hasCharacters) {
      const glow = dotR * 5 + (isFocus ? Math.sin(eveMap.pulsePhase) * dotR * 2 : 0);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glow);
      grad.addColorStop(0, isFocus ? 'rgba(91,142,240,0.6)' : 'rgba(200,150,50,0.4)');
      grad.addColorStop(1, isFocus ? 'rgba(91,142,240,0)' : 'rgba(200,150,50,0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cx, cy, glow, 0, Math.PI * 2); ctx.fill();
    } else if (isHovered) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.arc(cx, cy, dotR * 3.5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = isFocus ? '#5b8ef0' : hasCharacters ? '#c89632' : color;
    ctx.beginPath(); ctx.arc(cx, cy, isFocus ? dotR * 2.5 : hasCharacters ? dotR * 1.8 : dotR, 0, Math.PI * 2); ctx.fill();
  });

  // Cross-region jump bridge endpoints
  const crossRegionLabels = [];
  crossRegionEndpoints.forEach(({ system: sys, regionName }) => {
    const { cx, cy } = eveMapToCanvas(sys.x, sys.y);
    if (cx < -30 || cx > w + 30 || cy < -30 || cy > h + 30) return;
    const color = eveSecColor(sys.security);
    const dimColor = isDark ? 'rgba(100,100,100,0.4)' : 'rgba(150,150,150,0.3)';

    ctx.fillStyle = dimColor;
    ctx.beginPath(); ctx.arc(cx, cy, dotR * 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, dotR * 0.5, 0, Math.PI * 2); ctx.fill();

    crossRegionLabels.push({ cx, cy, name: sys.name, regionName });
  });

  // Cross-region endpoint labels
  ctx.font = '10px -apple-system, Segoe UI, sans-serif';
  ctx.fillStyle = isDark ? 'rgba(200,200,200,0.5)' : 'rgba(80,80,80,0.5)';
  crossRegionLabels.forEach(({ cx, cy, name, regionName }) => {
    const label = `${name} (${regionName})`;
    const tw = ctx.measureText(label).width;
    const lx = Math.max(5, Math.min(cx - tw / 2, w - tw - 5));
    const ly = cy + 12;
    ctx.fillText(label, lx, ly);
  });

  // Hover tooltip
  if (eveMap.hovered) {
    const { cx, cy } = eveMapToCanvas(eveMap.hovered.x, eveMap.hovered.y);
    let label = `${eveMap.hovered.name}  ${eveMap.hovered.security.toFixed(1)}`;
    if (eveMap.characterMarkers[eveMap.hovered.id]) {
      label += `  [${eveMap.characterMarkers[eveMap.hovered.id].map(c => c.characterName).join(', ')}]`;
    }
    ctx.font = '11px -apple-system, Segoe UI, sans-serif';
    const tw = ctx.measureText(label).width;
    // Position tooltip 10px to the right and above the system, but keep it on screen
    let lx = cx + 10;
    let ly = cy - 10;
    if (lx + tw + 10 > w) lx = cx - tw - 10;  // Move to left if off right edge
    if (ly < 15) ly = cy + 15;  // Move below if off top edge
    ctx.fillStyle = isDark ? 'rgba(8, 8, 18, 0.85)' : 'rgba(255, 255, 255, 0.9)';
    ctx.fillRect(lx - 5, ly - 13, tw + 10, 18);
    ctx.fillStyle = eveSecColor(eveMap.hovered.security); ctx.fillText(label, lx, ly);
  }

  // Region name label
  ctx.fillStyle = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.15)';
  ctx.font = '11px -apple-system, Segoe UI, sans-serif';
  ctx.fillText(data.regionName || '', 10, 16);
}

function eveMapAnimate() {
  eveMapDraw();
  eveMap.animFrame = requestAnimationFrame(eveMapAnimate);
}

function initEveMapCanvas() {
  eveMap.canvas = document.getElementById('eve-map-canvas');
  if (!eveMap.canvas) return;
  eveMap.ctx = eveMap.canvas.getContext('2d');
  const wrap = eveMap.canvas.parentElement;
  new ResizeObserver(() => {
    eveMap.canvas.width = wrap.clientWidth;
    eveMap.canvas.height = wrap.clientHeight;
    if (eveMap.data) eveMapFitToCanvas();
  }).observe(wrap);
  eveMap.canvas.width = wrap.clientWidth;
  eveMap.canvas.height = wrap.clientHeight;

  eveMap.canvas.addEventListener('mousedown', e => {
    eveMap.dragging = true;
    eveMap.dragOrigin = { x: e.clientX - eveMap.transform.offsetX, y: e.clientY - eveMap.transform.offsetY };
  });
  window.addEventListener('mouseup', () => { eveMap.dragging = false; });
  eveMap.canvas.addEventListener('mousemove', e => {
    const rect = eveMap.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (eveMap.dragging) {
      eveMap.transform.offsetX = e.clientX - eveMap.dragOrigin.x;
      eveMap.transform.offsetY = e.clientY - eveMap.dragOrigin.y;
      return;
    }
    if (!eveMap.data) return;
    let best = null, bestD = 12;
    eveMap.data.systems.forEach(sys => {
      const { cx, cy } = eveMapToCanvas(sys.x, sys.y);
      const d = Math.hypot(cx - mx, cy - my);
      if (d < bestD) { best = sys; bestD = d; }
    });
    eveMap.hovered = best;
  });
  eveMap.canvas.addEventListener('mouseleave', () => { eveMap.hovered = null; eveMap.dragging = false; });
  eveMap.canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = eveMap.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const f = e.deltaY > 0 ? 0.85 : 1.18;
    eveMap.transform.offsetX = mx + (eveMap.transform.offsetX - mx) * f;
    eveMap.transform.offsetY = my + (eveMap.transform.offsetY - my) * f;
    eveMap.transform.scale *= f;
  }, { passive: false });

  if (eveMap.animFrame) cancelAnimationFrame(eveMap.animFrame);
  eveMapAnimate();
}

async function eveMapLoadRegion(systemId) {
  if (!systemId) return;
  // Only show loading on first load, not on updates
  const isFirstLoad = !eveMap.data;
  const loadingEl = document.getElementById('eve-map-loading');
  if (isFirstLoad) loadingEl?.classList.add('visible');

  const data = await ipcRenderer.invoke('eve-load-region-map', { systemId });
  if (isFirstLoad) loadingEl?.classList.remove('visible');
  if (!data) return;

  eveMap.data = data;
  // Preserve neighboring systems when resetting systemIndex
  const savedNeighbors = {};
  Object.keys(eveMap.systemIndex).forEach(id => {
    if (fullscreenEveMap.neighboringSystems?.[id]) {
      savedNeighbors[id] = eveMap.systemIndex[id];
    }
  });
  eveMap.systemIndex = {};
  data.systems.forEach(s => { eveMap.systemIndex[s.id] = s; });
  // Restore neighboring systems
  Object.assign(eveMap.systemIndex, savedNeighbors);

  // For cross-region jump bridges, we need to fetch the destination system data
  // Request additional system data for jump bridge endpoints from the main process
  if (data.jumpBridges && data.jumpBridges.length > 0) {
    const missingSystemIds = [];
    data.jumpBridges.forEach(([a, b]) => {
      if (!eveMap.systemIndex[a]) missingSystemIds.push(a);
      if (!eveMap.systemIndex[b]) missingSystemIds.push(b);
    });

    if (missingSystemIds.length > 0) {
      ipcRenderer.invoke('eve-get-systems', { systemIds: missingSystemIds }).then(systems => {
        if (systems && systems.length > 0) {
          systems.forEach(s => {
            eveMap.systemIndex[s.id] = s;
          });
        }
      }).catch(err => {
        // Fail silently
      });
    }
  }

  // Only fit to canvas on first load, not on updates
  if (isFirstLoad && eveMap.canvas) {
    eveMap.canvas.width = eveMap.canvas.parentElement.clientWidth;
    eveMap.canvas.height = eveMap.canvas.parentElement.clientHeight;
    eveMapFitToCanvas();
  }
}

function getAllEveCharacters() {
  return state.accounts.flatMap(a => (a.eveCharacters || []).map(c => ({ ...c, accountId: a.id })));
}

function renderEveMapPanel() {
  const selector = document.getElementById('eve-char-selector');
  const locationLabel = document.getElementById('eve-map-location');
  if (!selector || !locationLabel) return;

  const chars = getAllEveCharacters();
  selector.innerHTML = chars.length
    ? chars.map(c => `<option value="${c.characterId}" ${Number(c.characterId) === eveTrackedCharacterId ? 'selected' : ''}>${esc(c.characterName)}</option>`).join('')
    : '<option value="">No characters linked</option>';
  selector.style.display = chars.length ? 'block' : 'none';
  if (!eveTrackedCharacterId && chars.length) eveTrackedCharacterId = Number(chars[0].characterId);

  const loc = eveTrackedCharacterId ? eveLocationState[eveTrackedCharacterId] : null;
  if (loc) {
    locationLabel.textContent = `${loc.characterName}  ·  ${loc.systemName}  (${loc.regionName || '…'})`;
  } else if (chars.length) {
    locationLabel.textContent = 'Fetching location…';
  } else {
    locationLabel.textContent = 'No EVE character linked';
  }
}

// ─────────────────────────────────────────────
//  Fullscreen Map View
// ─────────────────────────────────────────────
const fullscreenEveMap = { canvas: null, ctx: null, transform: { offsetX: 0, offsetY: 0, scale: 1 } };

function showFullscreenMap() {
  const rightPanel = $('right-panel');
  const fsMapView = $('fullscreen-map-view');
  const fsWalletView = $('fullscreen-wallet-view');
  if (!rightPanel || !fsMapView) return;

  // Hide wallet if open
  if (fsWalletView) fsWalletView.style.display = 'none';

  rightPanel.style.display = 'none';
  fsMapView.style.display = 'flex';

  // Initialize canvas if not done
  if (!fullscreenEveMap.canvas) {
    fullscreenEveMap.canvas = document.getElementById('fullscreen-eve-map-canvas');
    fullscreenEveMap.ctx = fullscreenEveMap.canvas?.getContext('2d');
    const wrap = fullscreenEveMap.canvas?.parentElement;

    if (fullscreenEveMap.canvas && wrap) {
      fullscreenEveMap.canvas.width = wrap.clientWidth;
      fullscreenEveMap.canvas.height = wrap.clientHeight;
      new ResizeObserver(() => {
        fullscreenEveMap.canvas.width = wrap.clientWidth;
        fullscreenEveMap.canvas.height = wrap.clientHeight;
        fsEveMapFitToCanvas();
      }).observe(wrap);

      initFullscreenMapControls();
    }
  }

  // Use current region data
  if (eveMap.data) {
    // Load neighboring systems from connected regions
    loadNeighboringSystemsForFullscreenMap();
    fsEveMapFitToCanvas();
    animateFullscreenMap();
  }
}

function loadNeighboringSystemsForFullscreenMap() {
  if (!eveMap.data) return;

  const neighboringSystemIds = new Set();
  const currentSystemIds = new Set(eveMap.data.systems.map(s => s.id));
  const neighboringConnections = {}; // Track which local systems connect to each neighbor

  eveMap.data.connections.forEach(([a, b]) => {
    const aInRegion = currentSystemIds.has(a);
    const bInRegion = currentSystemIds.has(b);

    if (aInRegion && !bInRegion) {
      neighboringSystemIds.add(b);
      if (!neighboringConnections[b]) neighboringConnections[b] = [];
      neighboringConnections[b].push(a);
    } else if (bInRegion && !aInRegion) {
      neighboringSystemIds.add(a);
      if (!neighboringConnections[a]) neighboringConnections[a] = [];
      neighboringConnections[a].push(b);
    }
  });

  if (neighboringSystemIds.size > 0) {
    ipcRenderer.invoke('eve-get-systems', { systemIds: Array.from(neighboringSystemIds) }).then(systems => {
      fullscreenEveMap.neighboringSystems = {};
      const regionIds = new Set();
      if (systems && systems.length > 0) {
        systems.forEach(sys => {
          fullscreenEveMap.neighboringSystems[sys.id] = sys;
          eveMap.systemIndex[sys.id] = sys;  // Also add to systemIndex for pathfinding
          if (sys.region_id) regionIds.add(sys.region_id);
        });

        // Load neighboring region connections to build chains
        if (regionIds.size > 0) {
          ipcRenderer.invoke('eve-get-region-connections', { regionIds: Array.from(regionIds) }).then(connections => {
            fullscreenEveMap.neighboringRegionConnections = connections || [];

            // Position neighbors along lines connecting local systems
            positionNeighboringSystemsOnMap(neighboringConnections, connections);
          }).catch(err => {
            fullscreenEveMap.neighboringRegionConnections = [];
          });
        }
      }
    }).catch(err => {
      // Silent catch
    });
  }
}

function positionNeighboringSystemsOnMap(neighboringConnections, regionConnections) {
  const neighbors = fullscreenEveMap.neighboringSystems;
  if (!neighbors || Object.keys(neighbors).length === 0) return;

  // Build a graph of neighboring systems and their connections
  const graph = {};
  Object.keys(neighbors).forEach(id => {
    graph[id] = [];
  });

  regionConnections.forEach(([a, b]) => {
    if (graph[a] && graph[b]) {
      graph[a].push(b);
      graph[b].push(a);
    }
  });

  // Find chains of neighboring systems and their local endpoints
  const processed = new Set();
  Object.keys(neighbors).forEach(startId => {
    if (processed.has(startId)) return;

    // Find the chain starting from this system
    const chain = [startId];
    processed.add(startId);

    let current = startId;
    while (graph[current] && graph[current].length > 0) {
      const next = graph[current].find(id => !processed.has(id));
      if (!next) break;
      chain.push(next);
      processed.add(next);
      current = next;
    }

    // Find local system endpoints for this chain
    const chainEndpoints = [];
    chain.forEach(systemId => {
      const localConnections = neighboringConnections[systemId] || [];
      localConnections.forEach(localId => {
        if (!chainEndpoints.includes(localId)) {
          chainEndpoints.push(localId);
        }
      });
    });

    // If we have exactly 2 local endpoints, position chain along the line between them
    if (chainEndpoints.length === 2) {
      const sysA = eveMap.systemIndex[chainEndpoints[0]];
      const sysB = eveMap.systemIndex[chainEndpoints[1]];

      if (sysA && sysB) {
        // Position each system in the chain along the line from sysA to sysB
        chain.forEach((systemId, idx) => {
          const t = (idx + 1) / (chain.length + 1); // Distribute evenly, excluding endpoints
          const sys = neighbors[systemId];
          if (sys) {
            sys.x = sysA.x + (sysB.x - sysA.x) * t;
            sys.y = sysA.y + (sysB.y - sysA.y) * t;
          }
        });
      }
    }
  });
}

function startWaypointAutoClears() {
  // Clear any existing timer
  if (fullscreenEveMap.waypointClearTimer) {
    clearTimeout(fullscreenEveMap.waypointClearTimer);
  }
  // Auto-clear after 30 seconds
  fullscreenEveMap.waypointClearTimer = setTimeout(() => {
    fullscreenEveMap.autopilotDestination = null;
  }, 30000);
}

function hideFullscreenMap() {
  const rightPanel = $('right-panel');
  const fsMapView = $('fullscreen-map-view');
  if (!rightPanel || !fsMapView) return;

  // Clear waypoint timer when closing map
  if (fullscreenEveMap.waypointClearTimer) {
    clearTimeout(fullscreenEveMap.waypointClearTimer);
    fullscreenEveMap.waypointClearTimer = null;
  }
  fullscreenEveMap.autopilotDestination = null;

  fsMapView.style.display = 'none';
  rightPanel.style.display = 'flex';
}

async function showFullscreenWallet() {
  const rightPanel = $('right-panel');
  const fsWalletView = $('fullscreen-wallet-view');
  const fsMapView = $('fullscreen-map-view');
  if (!rightPanel || !fsWalletView) return;

  // Hide map if open
  if (fsMapView) fsMapView.style.display = 'none';

  rightPanel.style.display = 'none';
  fsWalletView.style.display = 'flex';

  // Fetch and display wallet data
  await loadWalletData();
}

function hideFullscreenWallet() {
  const rightPanel = $('right-panel');
  const fsWalletView = $('fullscreen-wallet-view');
  if (!rightPanel || !fsWalletView) return;

  fsWalletView.style.display = 'none';
  rightPanel.style.display = 'flex';
}

function showFullscreenMapContextMenu(system, clientX, clientY) {
  const menu = $('context-menu');
  if (!menu) return;

  menu.innerHTML = `
    <div style="background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 4px 12px rgba(0,0,0,0.3); min-width: 180px; z-index: 10000;">
      <div style="padding: 8px 0;">
        <div style="padding: 8px 16px; color: var(--text2); font-size: 11px; font-weight: 600; text-transform: uppercase; border-bottom: 1px solid var(--border);">
          ${system.name}
        </div>
        <div style="padding: 4px 0;">
          <button id="ctx-set-destination" style="width: 100%; padding: 8px 16px; text-align: left; background: none; border: none; color: var(--text1); cursor: pointer; font-size: 13px; transition: background 0.2s;" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background='none'">
            Set Destination
          </button>
          <button id="ctx-copy-name" style="width: 100%; padding: 8px 16px; text-align: left; background: none; border: none; color: var(--text1); cursor: pointer; font-size: 13px; transition: background 0.2s;" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background='none'">
            Copy System Name
          </button>
        </div>
      </div>
    </div>
  `;

  menu.classList.remove('hidden');
  menu.style.position = 'fixed';
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';

  $('ctx-set-destination')?.addEventListener('click', () => {
    setDestinationInGame(system);
    menu.classList.add('hidden');
  });

  $('ctx-copy-name')?.addEventListener('click', () => {
    navigator.clipboard.writeText(system.name).then(() => {
      // Show brief feedback
      const originalText = $('ctx-copy-name').textContent;
      $('ctx-copy-name').textContent = 'Copied!';
      setTimeout(() => {
        $('ctx-copy-name').textContent = originalText;
      }, 1500);
    });
    menu.classList.add('hidden');
  });

  // Hide menu when clicking elsewhere
  const hideMenu = () => {
    menu.classList.add('hidden');
    document.removeEventListener('click', hideMenu);
  };
  setTimeout(() => document.addEventListener('click', hideMenu), 100);
}

async function setDestinationInGame(system) {
  const eveChars = getAllEveCharacters();
  if (eveChars.length === 0) {
    alert('No EVE characters linked');
    return;
  }

  // Use the first character's account
  const char = eveChars[0];

  try {
    const result = await ipcRenderer.invoke('eve-set-autopilot', {
      characterId: char.characterId,
      destinationId: system.id,
      clearWaypoints: true
    });

    if (result.success) {
      // Store the destination for highlighting on the map
      fullscreenEveMap.autopilotDestination = system.id;
      startWaypointAutoClears();

      // Show success feedback
      const btn = $('ctx-set-destination');
      if (btn) {
        const originalText = btn.textContent;
        btn.textContent = '✓ Set!';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      }
    } else {
      alert(`Failed to set destination: ${result.error}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function loadWalletData() {
  const eveChars = getAllEveCharacters();
  if (eveChars.length === 0) {
    renderWalletEmpty();
    return;
  }

  try {
    const walletData = await ipcRenderer.invoke('eve-get-wallet', { characterIds: eveChars.map(c => c.characterId) });
    renderWalletData(walletData, eveChars);
  } catch (err) {
    $('wallet-balance-section').innerHTML = `<div style="color: var(--text2); padding: 12px;">Failed to load wallet data</div>`;
  }
}

function renderWalletEmpty() {
  const balanceSection = $('wallet-balance-section');
  balanceSection.innerHTML = '<div style="color: var(--text2); padding: 12px;">No EVE characters linked</div>';
}

function findRouteBetweenSystems(startId, endId, systems, connections, jumpBridges = []) {
  if (startId === endId) return [systems.find(s => s.id === startId)];

  // Build adjacency list from connections (stargates + jump bridges)
  const graph = {};
  const systemIds = new Set();
  systems.forEach(sys => {
    graph[sys.id] = [];
    systemIds.add(sys.id);
  });

  // Add stargate connections
  let sgCount = 0;
  connections.forEach(([a, b]) => {
    if (graph[a] && graph[b]) {
      graph[a].push(b);
      graph[b].push(a);
      sgCount += 2;
    }
  });

  // Add jump bridge connections
  let jbCount = 0;
  if (jumpBridges && jumpBridges.length > 0) {
    jumpBridges.forEach(([a, b]) => {
      if (graph[a] !== undefined) {
        graph[a].push(b);
        jbCount++;
      }
      if (graph[b] !== undefined) {
        graph[b].push(a);
        jbCount++;
      }
    });
  }


  // BFS to find shortest path
  const queue = [[startId, [startId]]];
  const visited = new Set([startId]);

  while (queue.length > 0) {
    const [current, path] = queue.shift();
    if (current === endId) {
      return path.map(id => systems.find(s => s.id === id)).filter(s => s);
    }

    const neighbors = graph[current] || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, [...path, neighbor]]);
      }
    }
  }

  return null; // No route found
}

function getTransactionTypeDescription(refType) {
  const typeMap = {
    'agent_mission_reward': 'Agent Mission Reward',
    'bounty_prize': 'Bounty Prize',
    'daily_goal_reward': 'Daily Goal Reward',
    'player_donation': 'Player Donation',
    'mission_reward': 'Mission Reward',
    'npc_bounty': 'NPC Bounty',
    'player_trading': 'Player Trading',
    'corp_war_rp': 'Crew Resource Point',
    'insurance': 'Insurance',
    'bounty_reimbursement': 'Bounty Reimbursement',
    'lp_store': 'LP Store',
    'market_escrow': 'Market Escrow',
    'isk_sink': 'ISK Sink',
    'structure_gate_jump': 'Structure Gate Jump',
    'manufacture': 'Manufacturing',
    'brokers_fee': 'Broker Fee',
  };
  return typeMap[refType] || refType || 'Transaction';
}

function renderWalletData(walletData, eveChars) {
  const isDark = eveGetTheme() === 'dark';
  const balanceSection = $('wallet-balance-section');
  const transactionsSection = $('wallet-transactions-section');

  // Render balance section
  let balanceHtml = '<div style="margin-bottom: 12px;"><h3 style="margin-bottom: 12px; color: var(--text1);">Character Balances</h3>';
  balanceHtml += '<div style="display: grid; gap: 8px;">';

  eveChars.forEach(char => {
    const balance = walletData.balances?.[char.characterId];
    const formattedBalance = balance ? parseFloat(balance).toFixed(2) : '0.00';
    balanceHtml += `
      <div style="padding: 8px 12px; background: var(--bg2); border-radius: var(--radius); border: 1px solid var(--border);">
        <div style="font-weight: 500; color: var(--text1);">${char.characterName}</div>
        <div style="font-size: 13px; color: var(--text2); margin-top: 4px;">
          <span style="color: var(--accent); font-weight: 600;">${parseFloat(formattedBalance).toLocaleString()}</span> ISK
        </div>
      </div>
    `;
  });

  balanceHtml += '</div></div>';
  balanceSection.innerHTML = balanceHtml;

  // Render transactions section
  let transHtml = '<div><h3 style="margin-bottom: 12px; color: var(--text1);">Recent Transactions</h3>';
  transHtml += '<div style="display: grid; gap: 8px;">';

  const allTransactions = [];
  if (walletData.transactions && typeof walletData.transactions === 'object') {
    Object.entries(walletData.transactions).forEach(([charId, transactions]) => {
      const char = eveChars.find(c => c.characterId === parseInt(charId));
      console.log(`Processing transactions for character ${charId}:`, transactions?.length || 0, 'transactions');
      if (transactions && Array.isArray(transactions)) {
        transactions.forEach((t, idx) => {
          if (!t || !t.date) return;
          // Accept both market transactions (quantity + unit_price) and journal entries (amount)
          if ((t.quantity !== undefined && t.unit_price !== undefined) || t.amount !== undefined) {
            allTransactions.push({ ...t, characterName: char?.characterName || 'Unknown' });
          }
        });
      }
    });
  }

  if (allTransactions.length > 0) {
    // Sort by date descending and limit to 100
    allTransactions.sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      return dateB - dateA;
    }).slice(0, 100).forEach(trans => {
      let amount, description, isIncome;

      // Handle market transactions (quantity + unit_price)
      if (trans.quantity !== undefined && trans.unit_price !== undefined) {
        amount = (trans.quantity * trans.unit_price).toFixed(2);
        isIncome = !trans.is_buy;
        const actionType = trans.is_buy ? 'Buy' : 'Sell';
        const quantity = trans.quantity.toLocaleString();
        description = `${actionType} ${quantity} items @ ${parseFloat(trans.unit_price).toFixed(2)} ISK`;
      }
      // Handle journal entries (amount + description)
      else if (trans.amount !== undefined) {
        amount = Math.abs(trans.amount).toFixed(2);
        isIncome = trans.amount > 0;
        description = trans.description || getTransactionTypeDescription(trans.ref_type);
      } else {
        return;
      }

      const color = isIncome ? 'rgba(100, 200, 100, 0.8)' : 'rgba(200, 100, 100, 0.8)';
      const transDate = new Date(trans.date).toLocaleDateString();

      transHtml += `
        <div style="padding: 8px 12px; background: var(--bg2); border-radius: var(--radius); border: 1px solid var(--border); font-size: 12px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: var(--text1);">${trans.characterName}</span>
            <span style="color: ${color}; font-weight: 600;">${isIncome ? '+' : '-'}${amount}</span>
          </div>
          <div style="color: var(--text3); font-size: 11px;">
            ${description} • ${transDate}
          </div>
        </div>
      `;
    });
  } else {
    transHtml += '<div style="color: var(--text2); padding: 12px;">No transactions available</div>';
  }

  transHtml += '</div></div>';
  transactionsSection.innerHTML = transHtml;
}

function fsEveMapFitToCanvas() {
  if (!fullscreenEveMap.canvas || !eveMap.data) return;
  const w = fullscreenEveMap.canvas.width;
  const h = fullscreenEveMap.canvas.height;
  const pad = 50;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  eveMap.data.systems.forEach(sys => {
    minX = Math.min(minX, sys.x);
    maxX = Math.max(maxX, sys.x);
    minY = Math.min(minY, sys.y);
    maxY = Math.max(maxY, sys.y);
  });

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scaleX = (w - pad * 2) / rangeX;
  const scaleY = (h - pad * 2) / rangeY;
  fullscreenEveMap.transform.scale = Math.min(scaleX, scaleY);
  fullscreenEveMap.transform.offsetX = w / 2 - ((minX + maxX) / 2) * fullscreenEveMap.transform.scale;
  fullscreenEveMap.transform.offsetY = h / 2 + ((minY + maxY) / 2) * fullscreenEveMap.transform.scale;
}

function fsMapToCanvas(x, y) {
  return {
    cx: x * fullscreenEveMap.transform.scale + fullscreenEveMap.transform.offsetX,
    cy: -y * fullscreenEveMap.transform.scale + fullscreenEveMap.transform.offsetY
  };
}

function drawFullscreenMap() {
  const { canvas, ctx, transform } = fullscreenEveMap;
  if (!canvas || !ctx || !eveMap.data) return;

  const w = canvas.width, h = canvas.height;
  const isDark = eveGetTheme() === 'dark';

  ctx.fillStyle = isDark ? '#080810' : '#f5f5f7';
  ctx.fillRect(0, 0, w, h);

  const data = eveMap.data;
  const dotR = 2;

  // Draw stargate connections (within region)
  ctx.strokeStyle = isDark ? 'rgba(60, 80, 140, 0.35)' : 'rgba(150, 150, 200, 0.25)';
  ctx.lineWidth = 0.6;
  data.connections.forEach(([a, b]) => {
    const sa = eveMap.systemIndex[a], sb = eveMap.systemIndex[b];
    if (!sa || !sb) return;
    const pa = fsMapToCanvas(sa.x, sa.y), pb = fsMapToCanvas(sb.x, sb.y);
    ctx.beginPath(); ctx.moveTo(pa.cx, pa.cy); ctx.lineTo(pb.cx, pb.cy); ctx.stroke();
  });

  // Draw jump bridge connections (green dashed)
  if (data.jumpBridges && data.jumpBridges.length > 0) {
    ctx.strokeStyle = isDark ? 'rgba(100, 180, 100, 0.4)' : 'rgba(100, 160, 100, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    data.jumpBridges.forEach(([a, b]) => {
      const sa = eveMap.systemIndex[a], sb = eveMap.systemIndex[b];
      if (!sa || !sb) return;
      const pa = fsMapToCanvas(sa.x, sa.y), pb = fsMapToCanvas(sb.x, sb.y);
      ctx.beginPath(); ctx.moveTo(pa.cx, pa.cy); ctx.lineTo(pb.cx, pb.cy); ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  // Draw dashed connections to neighboring regions (stargate connections)
  const neighboringSystems = fullscreenEveMap.neighboringSystems || {};
  const currentSystemIds = new Set(data.systems.map(s => s.id));

  ctx.strokeStyle = isDark ? 'rgba(60, 80, 140, 0.2)' : 'rgba(150, 150, 200, 0.15)';
  ctx.lineWidth = 0.6;
  ctx.setLineDash([3, 3]);

  data.connections.forEach(([a, b]) => {
    let localSysId = null, neighborSysId = null;

    // Check if one system is local and one is neighboring
    if (currentSystemIds.has(a) && neighboringSystems[b]) {
      localSysId = a;
      neighborSysId = b;
    } else if (currentSystemIds.has(b) && neighboringSystems[a]) {
      localSysId = b;
      neighborSysId = a;
    }

    if (localSysId && neighborSysId) {
      const localSys = eveMap.systemIndex[localSysId];
      const neighborSys = neighboringSystems[neighborSysId];
      if (localSys && neighborSys) {
        const pa = fsMapToCanvas(localSys.x, localSys.y);
        const pb = fsMapToCanvas(neighborSys.x, neighborSys.y);
        ctx.beginPath(); ctx.moveTo(pa.cx, pa.cy); ctx.lineTo(pb.cx, pb.cy); ctx.stroke();
      }
    }
  });

  // Draw connections between neighboring systems (only between systems that are on the map)
  const neighboringRegionConnections = fullscreenEveMap.neighboringRegionConnections || [];
  const neighboringSystemIds = new Set(Object.keys(neighboringSystems).map(id => Number(id)));
  if (neighboringRegionConnections.length > 0 && neighboringSystemIds.size > 0) {
    ctx.strokeStyle = isDark ? 'rgba(80, 100, 140, 0.3)' : 'rgba(150, 150, 180, 0.25)';
    ctx.lineWidth = 0.6;
    neighboringRegionConnections.forEach(([a, b]) => {
      // Only draw if both systems are neighboring systems on the map
      if (neighboringSystemIds.has(a) && neighboringSystemIds.has(b)) {
        const sysA = neighboringSystems[a];
        const sysB = neighboringSystems[b];
        if (sysA && sysB) {
          const pa = fsMapToCanvas(sysA.x, sysA.y);
          const pb = fsMapToCanvas(sysB.x, sysB.y);
          ctx.beginPath(); ctx.moveTo(pa.cx, pa.cy); ctx.lineTo(pb.cx, pb.cy); ctx.stroke();
        }
      }
    });
  }

  ctx.setLineDash([]);

  // Draw systems and labels
  const pulsePhase = (Date.now() / 50) % (Math.PI * 2);
  ctx.font = '10px -apple-system, Segoe UI, sans-serif';
  const bgColor = isDark ? '#080810' : '#f5f5f7';

  // Clear background under neighboring systems (so lines don't show through)
  Object.values(neighboringSystems).forEach(sys => {
    const { cx, cy } = fsMapToCanvas(sys.x, sys.y);
    if (cx < -20 || cx > w + 20 || cy < -20 || cy > h + 20) return;
    ctx.fillStyle = bgColor;
    ctx.beginPath(); ctx.arc(cx, cy, dotR * 1.5, 0, Math.PI * 2); ctx.fill();
  });

  // Draw neighboring systems (dimmer)
  Object.values(neighboringSystems).forEach(sys => {
    const { cx, cy } = fsMapToCanvas(sys.x, sys.y);
    if (cx < -20 || cx > w + 20 || cy < -20 || cy > h + 20) return;
    ctx.fillStyle = isDark ? 'rgba(100,100,120,0.5)' : 'rgba(150,150,150,0.4)';
    ctx.beginPath(); ctx.arc(cx, cy, dotR * 0.8, 0, Math.PI * 2); ctx.fill();

    // Draw system name and region name
    ctx.font = '10px -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = isDark ? 'rgba(150,150,170,0.6)' : 'rgba(120,120,120,0.5)';
    ctx.fillText(sys.name, cx + 5, cy - 4);
    ctx.font = '9px -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = isDark ? 'rgba(120,120,140,0.5)' : 'rgba(130,130,130,0.4)';
    ctx.fillText(sys.regionName || '?', cx + 5, cy + 6);
  });

  // Clear background under current region systems
  data.systems.forEach(sys => {
    const { cx, cy } = fsMapToCanvas(sys.x, sys.y);
    if (cx < -20 || cx > w + 20 || cy < -20 || cy > h + 20) return;
    ctx.fillStyle = bgColor;
    ctx.beginPath(); ctx.arc(cx, cy, dotR * 3.5, 0, Math.PI * 2); ctx.fill();
  });

  // Draw autopilot route if set
  if (fullscreenEveMap.autopilotDestination) {
    const currentLoc = Object.values(eveLocationState)[0];
    let destSys = data.systems.find(s => s.id === fullscreenEveMap.autopilotDestination);

    // Check if destination is a neighboring system
    if (!destSys) {
      destSys = neighboringSystems[fullscreenEveMap.autopilotDestination];
    }

    const currentSys = currentLoc ? data.systems.find(s => s.id === currentLoc.systemId) : null;

    if (currentSys && destSys) {
      // Find route through stargates and jump bridges
      // Use all indexed systems (including cross-region jump bridge endpoints) for pathfinding
      const allSystems = Object.values(eveMap.systemIndex);

      // Combine all connections: current region + neighboring region connections
      const allConnections = [...data.connections];
      const neighboringConnections = fullscreenEveMap.neighboringRegionConnections || [];
      neighboringConnections.forEach(conn => allConnections.push(conn));

      const route = findRouteBetweenSystems(currentSys.id, destSys.id, allSystems, allConnections, data.jumpBridges);

      if (route && route.length > 1) {
        ctx.strokeStyle = isDark ? 'rgba(255, 180, 0, 0.5)' : 'rgba(255, 150, 0, 0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();

        // Draw line through each system in the route
        for (let i = 0; i < route.length; i++) {
          const sys = route[i];
          const pos = fsMapToCanvas(sys.x, sys.y);
          if (i === 0) {
            ctx.moveTo(pos.cx, pos.cy);
          } else {
            ctx.lineTo(pos.cx, pos.cy);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // Draw current region systems
  data.systems.forEach(sys => {
    const { cx, cy } = fsMapToCanvas(sys.x, sys.y);
    if (cx < -20 || cx > w + 20 || cy < -20 || cy > h + 20) return;
    const isCurrentLocation = Object.values(eveLocationState).some(loc => loc.systemId === sys.id);
    const isDestination = fullscreenEveMap.autopilotDestination === sys.id;
    const color = eveSecColor(sys.security);

    if (isDestination) {
      const glow = dotR * 5 + Math.sin(pulsePhase) * dotR * 2;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glow);
      grad.addColorStop(0, 'rgba(255, 180, 0, 0.6)');
      grad.addColorStop(1, 'rgba(255, 180, 0, 0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cx, cy, glow, 0, Math.PI * 2); ctx.fill();
    }

    if (isCurrentLocation) {
      const glow = dotR * 5 + Math.sin(pulsePhase) * dotR * 2;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glow);
      grad.addColorStop(0, 'rgba(91,142,240,0.6)');
      grad.addColorStop(1, 'rgba(91,142,240,0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cx, cy, glow, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = isDestination ? '#ffa500' : (isCurrentLocation ? '#5b8ef0' : color);
    ctx.beginPath(); ctx.arc(cx, cy, isCurrentLocation || isDestination ? dotR * 2.5 : dotR, 0, Math.PI * 2); ctx.fill();

    // Draw system name
    ctx.fillStyle = isDark ? 'rgba(200,200,200,0.7)' : 'rgba(80,80,80,0.7)';
    ctx.fillText(sys.name, cx + 6, cy - 2);
  });
}

function animateFullscreenMap() {
  if (fullscreenEveMap.animFrame) {
    cancelAnimationFrame(fullscreenEveMap.animFrame);
  }
  function frame() {
    drawFullscreenMap();
    fullscreenEveMap.animFrame = requestAnimationFrame(frame);
  }
  fullscreenEveMap.animFrame = requestAnimationFrame(frame);
}

function initFullscreenMapControls() {
  const canvas = fullscreenEveMap.canvas;
  if (!canvas) return;

  let dragging = false;
  let dragOrigin = null;

  canvas.addEventListener('mousedown', e => {
    dragging = true;
    dragOrigin = { x: e.clientX - fullscreenEveMap.transform.offsetX, y: e.clientY - fullscreenEveMap.transform.offsetY };
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  canvas.addEventListener('mousemove', e => {
    if (dragging && dragOrigin) {
      fullscreenEveMap.transform.offsetX = e.clientX - dragOrigin.x;
      fullscreenEveMap.transform.offsetY = e.clientY - dragOrigin.y;
    }
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const f = e.deltaY > 0 ? 0.85 : 1.18;
    fullscreenEveMap.transform.offsetX = mx + (fullscreenEveMap.transform.offsetX - mx) * f;
    fullscreenEveMap.transform.offsetY = my + (fullscreenEveMap.transform.offsetY - my) * f;
    fullscreenEveMap.transform.scale *= f;
  }, { passive: false });

  // Right-click context menu
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // Find which system was clicked
    let clickedSystem = null;
    const hitRadius = 12;
    if (eveMap.data && eveMap.data.systems) {
      eveMap.data.systems.forEach(sys => {
        const { cx, cy } = fsMapToCanvas(sys.x, sys.y);
        const d = Math.hypot(cx - mx, cy - my);
        if (d < hitRadius && !clickedSystem) clickedSystem = sys;
      });

      // Also check neighboring systems
      if (!clickedSystem && fullscreenEveMap.neighboringSystems) {
        Object.values(fullscreenEveMap.neighboringSystems).forEach(sys => {
          const { cx, cy } = fsMapToCanvas(sys.x, sys.y);
          const d = Math.hypot(cx - mx, cy - my);
          if (d < hitRadius && !clickedSystem) clickedSystem = sys;
        });
      }
    }

    if (clickedSystem) {
      showFullscreenMapContextMenu(clickedSystem, e.clientX, e.clientY);
    }
  });
}

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

    // Refresh the contact list to show the new DM
    renderLeftPanel();

    // Persist active DM metadata for unknown contacts
    saveActiveDMs(accountId);
  }
});

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
  
  // Ensure message has a valid timestamp
  if (!msg.ts || msg.ts === 0) {
    msg.ts = Date.now();
  }
  
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

  // Show/hide neocom bar based on EVE characters
  const neocomBar = $('neocom-bar');
  if (neocomBar) {
    const hasEveChars = (acct.eveCharacters || []).length > 0;
    neocomBar.style.display = hasEveChars ? 'flex' : 'none';
  }
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
    
    // Check if message contains HTML tags
    if (/<[^>]/.test(msg.text)) {
      bubble.innerHTML = sanitizeMessageHTML(parseEmoticons(msg.text));
    } else {
      bubble.textContent = parseEmoticons(msg.text);
    }
    
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
  const eveChars = acct.eveCharacters || [];
  const eveListHtml = eveChars.length
    ? eveChars.map(c => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:13px;flex:1;color:var(--text1)">${esc(c.characterName)}</span>
          <span style="font-size:11px;color:var(--text3)">#${c.characterId}</span>
          <button class="btn-danger" style="padding:2px 8px;font-size:11px"
            onclick="unlinkEveCharacter('${esc(acct.id)}',${Number(c.characterId)})">Unlink</button>
        </div>`).join('')
    : '<div style="color:var(--text3);font-size:12px;padding:4px 0">No EVE characters linked yet.</div>';

  showModal(`
    <div class="modal-title">${esc(acct.displayName || acct.username + '@' + acct.server)}</div>
    <div style="margin:12px 0 0">
      <div style="font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">EVE Online Characters</div>
      <div id="eve-chars-list">${eveListHtml}</div>
      <button class="btn-secondary" id="btn-link-eve" style="margin-top:8px;width:100%"
        onclick="linkEveCharacter('${esc(acct.id)}')">+ Link EVE Character</button>
      <div id="eve-link-status" style="font-size:12px;margin-top:6px;min-height:18px;color:var(--text3)"></div>
    </div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary"   onclick="showEditAccountModal('${esc(acct.id)}')">Edit</button>
      <button class="btn-danger"    onclick="removeAccount('${esc(acct.id)}')">Remove</button>
    </div>
  `);
}

window.linkEveCharacter = async (accountId) => {
  const btn = document.getElementById('btn-link-eve');
  const statusEl = document.getElementById('eve-link-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening browser…'; }
  if (statusEl) statusEl.textContent = 'Complete the EVE login in your browser…';

  try {
    const result = await ipcRenderer.invoke('eve-link-character', { accountId });
    if (result.success) {
      const acct = state.accounts.find(a => a.id === accountId);
      if (acct) {
        if (!acct.eveCharacters) acct.eveCharacters = [];
        if (!acct.eveCharacters.find(c => c.characterId === result.characterId)) {
          acct.eveCharacters.push({ characterId: result.characterId, characterName: result.characterName });
        }
        saveAccounts();
        hideModal();
        showAccountContextMenu(acct);
      }
    } else {
      if (btn) { btn.disabled = false; btn.textContent = '+ Link EVE Character'; }
      if (statusEl) statusEl.textContent = '⚠ ' + (result.error || 'Unknown error');
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '+ Link EVE Character'; }
    if (statusEl) statusEl.textContent = '⚠ ' + err.message;
  }
};

window.unlinkEveCharacter = async (accountId, characterId) => {
  const id = Number(characterId);
  const acct = state.accounts.find(a => a.id === accountId);
  const char = acct?.eveCharacters?.find(c => Number(c.characterId) === id);
  if (!confirm(`Unlink EVE character "${char?.characterName || id}"?`)) return;

  await ipcRenderer.invoke('eve-unlink-character', { accountId, characterId: id });

  if (acct?.eveCharacters) {
    acct.eveCharacters = acct.eveCharacters.filter(c => Number(c.characterId) !== id);
    saveAccounts();
  }
  hideModal();
  if (acct) showAccountContextMenu(acct);
};

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

function showActiveDMContextMenu(chat, acct) {
  if (!acct) return;

  const allGroups = Object.keys(acct.groups || {});
  const chatGroups = chat.groups || [];

  let groupOptions = allGroups.map(groupName => {
    const isInGroup = chatGroups.includes(groupName);
    return `<button class="btn-group-option" style="${isInGroup ? 'opacity:0.5;' : ''}" onclick="moveDMToGroup('${esc(acct.id)}','${esc(chat.jid)}','${esc(groupName)}','${esc(chat.name)}')">${isInGroup ? '✓ ' : ''}${esc(groupName)}</button>`;
  }).join('');

  showModal(`
    <div class="modal-title">DM: ${esc(chat.name)}</div>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px">${esc(chat.jid)}</p>
    ${groupOptions ? `<div style="display:grid;gap:8px;margin-bottom:16px;">${groupOptions}</div>` : ''}
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-secondary" onclick="showCreateDMGroupModal('${esc(acct.id)}','${esc(chat.jid)}','${esc(chat.name)}')">+ New Group</button>
      <button class="btn-danger" onclick="submitDeleteActiveDM('${esc(chat.accountId)}','${esc(chat.jid)}','${esc(chat.name)}')">Delete</button>
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

function showGroupContextMenu(groupName, acct, groupType) {
  if (!acct) return;

  // Store group data globally for callbacks
  window._groupContextData = { groupName, acct, groupType };

  showModal(`
    <div class="modal-title">Group: ${esc(groupName)}</div>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px">${groupType === 'contact' ? 'Contact group' : 'Room group'}</p>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-secondary" onclick="renameGroupModal('${esc(groupName)}','${esc(acct.id)}','${groupType}')">✏️ Rename</button>
      <button class="btn-danger" onclick="deleteGroupConfirm('${esc(groupName)}','${esc(acct.id)}','${groupType}')">🗑️ Delete</button>
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
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="submitRenameGroup('${esc(groupName)}','${esc(accountId)}','${groupType}')">Rename</button>
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
    <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
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
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-danger" onclick="submitDeleteGroup('${esc(groupName)}','${esc(accountId)}','${groupType}')">Delete</button>
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
    <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
  `);
};



function showParticipantContextMenu(chat, nick) {
  const acct = state.accounts.find(a => a.id === chat.accountId);
  if (!acct) return;

  const partData = chat.participants[nick];
  const mucJid = (typeof partData === 'object') ? partData?.mucJid : null;
  const rawJid = mucJid || (nick.toLowerCase() + '@' + chat.jid.split('@')[1]);
  const displayJid = bareJid(rawJid);
  const displayName = nick;

  // Store data globally for context menu callbacks
  window._contextMenuData = { chat, nick, displayJid, displayName, acct };

  const contextMenu = document.getElementById('context-menu');
  contextMenu.innerHTML = `
    <div style="padding: 6px 10px; font-size: 12px; color: var(--text3); border-bottom: 1px solid var(--border); margin-bottom: 4px;">${esc(displayName)}</div>
    <div class="context-menu-item" onclick="openDirectMessageWithParticipant_Menu()">
      💬 Send DM
    </div>
    <div class="context-menu-item" onclick="addParticipantToContacts_Menu()">
      ➕ Add to Contacts
    </div>
  `;
  
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
  const { displayJid, displayName, acct } = data;
  
  ipcRenderer.send('xmpp-add-contact', { accountId: acct.id, jid: displayJid, name: displayName });
  if (!acct.roster) acct.roster = {};
  acct.roster[displayJid] = { jid: displayJid, name: displayName, presence: 'offline', groups: [] };
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
  
  // Try to get participant data for real JID
  const partData = chat.participants?.[nick];
  const mucJid = (typeof partData === 'object') ? partData?.mucJid : null;
  const rawJid = mucJid || (nick.toLowerCase() + '@' + chat.jid.split('@')[1]);
  const displayJid = bareJid(rawJid);
  const displayName = nick;

  // Store data globally for context menu callbacks
  window._contextMenuData = { chat, nick, displayJid, displayName, acct };

  const contextMenu = document.getElementById('context-menu');
  contextMenu.innerHTML = `
    <div style="padding: 6px 10px; font-size: 12px; color: var(--text3); border-bottom: 1px solid var(--border); margin-bottom: 4px;">${esc(displayName)}</div>
    <div class="context-menu-item" onclick="openDirectMessageWithParticipant_Menu()">
      💬 Send DM
    </div>
    <div class="context-menu-item" onclick="addParticipantToContacts_Menu()">
      ➕ Add to Contacts
    </div>
  `;
  
  showContextMenu(window.currentContextEvent);
}

window.showMessageSenderContextMenu = showMessageSenderContextMenu;

function showMessageContextMenu(msg) {
  // Store message data for context menu callbacks
  window._messageContextData = { msg };
  
  const contextMenu = document.getElementById('context-menu');
  contextMenu.innerHTML = `
    <div class="context-menu-item" onclick="quoteMessage_Menu()">
      💬 Quote
    </div>
    <div class="context-menu-item" onclick="copyMessage_Menu()">
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
    const partData = roomChat.participants[name];
    const presenceVal = (typeof partData === 'object') ? partData?.presence : partData;
    presence = presenceVal !== 'offline' ? 'available' : 'offline';
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

  // Try to use actual JID from MUC if available, otherwise construct from nick
  const partData = chat.participants[nick];
  const mucJid = (typeof partData === 'object') ? partData?.mucJid : null;
  const roomServer = chat.jid.split('@')[1];
  const participantJid = mucJid || (nick.toLowerCase() + '@' + roomServer);

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

  // Clear messages from localStorage
  localStorage.removeItem('chat_messages_' + key);

  // Update saved active DMs
  saveActiveDMs(accountId);

  // Re-render and show confirmation
  renderLeftPanel();
  showModal(`
    <div class="modal-title">✓ Deleted</div>
    <p style="color:var(--text3);font-size:13px;margin-bottom:16px">Conversation with ${esc(chatName)} has been deleted.</p>
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
    <div class="modal-actions"><button class="btn-secondary" onclick="hideModal()">OK</button></div>
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
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-primary" onclick="submitCreateDMGroup('${esc(accountId)}','${esc(dmJid)}','${esc(dmName)}')">Create & Add</button>
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
        <button class="btn-secondary" style="padding: 4px 8px; font-size: 11px; margin-left: auto;" onclick="playAlarmSound()">Test</button>
      </div>
      <div class="form-group" style="display: flex; align-items: center; gap: 10px;">
        <input type="checkbox" id="fi-dm-sound-enabled" ${dmSoundEnabled ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;" />
        <label for="fi-dm-sound-enabled" style="cursor: pointer; margin: 0;">Play sound for direct messages</label>
        <button class="btn-secondary" style="padding: 4px 8px; font-size: 11px; margin-left: auto;" onclick="playDMSound()">Test</button>
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

function showChatInfoModal() {
  const chat = state.chats[state.activeChatKey];
  if (!chat) return;

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
    </div>
    <div class="modal-actions">
      <button class="btn-primary" onclick="hideModal()">Close</button>
    </div>
  `);
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
  const safe = state.accounts.map(({ id, username, password, server, port, displayName, color, eveCharacters }) =>
    ({ id, username, password, server, port, displayName, color, eveCharacters: eveCharacters || [] })
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
  if (!saved?.length) return;
  saved.forEach(data => {
    const acct = { ...data, status: 'offline', roster: {}, presence: 'available', jid: data.username + '@' + data.server, groups: {}, roomGroups: {}, eveCharacters: data.eveCharacters || [] };

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
  renderEveMapPanel();
  initEveMapCanvas();
  updateEveMapPanelVisibility();

  // Load EVE region on startup
  const eveChars = state.accounts.flatMap(a => a.eveCharacters || []);
  if (eveChars.length > 0 && eveMap.canvas) {
    const lastSystemId = localStorage.getItem('lastEveSystem');
    const systemToLoad = lastSystemId ? Number(lastSystemId) : 30000142; // Jita as default
    eveMapLoadRegion(systemToLoad);

    // Trigger location fetch immediately if we have EVE characters
    setTimeout(() => {
      ipcRenderer.send('fetch-eve-locations');
    }, 500);
  }

  state.accounts.forEach(a => ipcRenderer.send('xmpp-connect', a));

  // Apply saved theme on load
  const settings = getAppSettings();
  if (settings.theme) {
    setTheme(settings.theme);
  }
}

function updateEveMapPanelVisibility() {
  const hasEveCharacters = state.accounts.some(a => a.eveCharacters?.length > 0);
  const panel = $('eve-map-panel');
  if (panel) {
    if (hasEveCharacters) {
      panel.classList.add('visible');
    } else {
      panel.classList.remove('visible');
    }
  }
}

document.getElementById('btn-jump-bridges')?.addEventListener('click', () => {
  eveMap.showJumpBridges = !eveMap.showJumpBridges;
  const btn = document.getElementById('btn-jump-bridges');
  btn.textContent = `Jump Bridges: ${eveMap.showJumpBridges ? 'ON' : 'OFF'}`;
});

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
//  Message Sanitization & Rendering
//  ─────────────────────────────────────────────
function sanitizeMessageHTML(html) {
  // Create a temporary container
  const temp = document.createElement('div');
  temp.innerHTML = html;

  // Allowed tags and their allowed attributes
  const allowed = {
    'b': [],
    'strong': [],
    'em': [],
    'i': [],
    'u': [],
    'br': [],
    'span': ['style', 'class'],
    'div': ['style', 'class']
  };

  function sanitizeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.cloneNode(true);
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      
      if (!allowed.hasOwnProperty(tag)) {
        // Not allowed - replace with text content
        const textNode = document.createTextNode(node.textContent);
        return textNode;
      }

      // Create sanitized element
      const safeEl = document.createElement(tag);

      // Copy allowed attributes
      if (allowed[tag].includes('style')) {
        // Only allow color and basic text styles
        const style = node.getAttribute('style') || '';
        const allowedStyles = ['color', 'background-color', 'text-decoration', 'font-weight', 'font-style'];
        const styleParts = style.split(';').map(s => s.trim()).filter(s => {
          const prop = s.split(':')[0].trim().toLowerCase();
          return allowedStyles.includes(prop);
        });
        if (styleParts.length > 0) {
          safeEl.setAttribute('style', styleParts.join('; '));
        }
      }

      if (allowed[tag].includes('class')) {
        const cls = node.getAttribute('class');
        if (cls) safeEl.setAttribute('class', cls);
      }

      // Recursively sanitize children
      for (let i = 0; i < node.childNodes.length; i++) {
        const sanitized = sanitizeNode(node.childNodes[i]);
        if (sanitized) safeEl.appendChild(sanitized);
      }

      return safeEl;
    }

    return null;
  }

  // Sanitize all child nodes
  const sanitized = document.createElement('div');
  for (let i = 0; i < temp.childNodes.length; i++) {
    const node = sanitizeNode(temp.childNodes[i]);
    if (node) sanitized.appendChild(node);
  }

  return sanitized.innerHTML;
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
$('btn-minimize').addEventListener('click', () => ipcRenderer.send('window-minimize'));
$('btn-maximize').addEventListener('click', () => ipcRenderer.send('window-maximize'));
$('btn-close').addEventListener('click', () => ipcRenderer.send('window-close'));
// Multi-account functionality removed
// $('btn-add-account').addEventListener('click', showAddAccountModal);
// $('btn-welcome-add').addEventListener('click', showAddAccountModal);

// Neocom map button
$('btn-neocom-map')?.addEventListener('click', showFullscreenMap);
$('btn-neocom-wallet')?.addEventListener('click', showFullscreenWallet);
$('btn-close-wallet')?.addEventListener('click', hideFullscreenWallet);
$('btn-close-fullmap')?.addEventListener('click', hideFullscreenMap);

// Debug: check system connections
window.debugSystemConnections = (systemName) => {
  if (!eveMap.data) return;
  const sys = eveMap.data.systems.find(s => s.name === systemName);
  if (!sys) { console.log(`System ${systemName} not found in current region`); return; }
  console.log(`System: ${sys.name} (${sys.id})`);
  const connections = eveMap.data.connections.filter(([a, b]) => a === sys.id || b === sys.id);
  console.log(`Found ${connections.length} connections:`);
  connections.forEach(([a, b]) => {
    const otherId = a === sys.id ? b : a;
    const otherSys = eveMap.systemIndex[otherId];
    console.log(`  -> ${otherSys?.name || otherId} (${otherId})`);
  });
};
$('eve-char-selector').addEventListener('change', (e) => {
  const id = Number(e.target.value);
  if (id) {
    eveTrackedCharacterId = id;
    renderEveMapPanel();
    const loc = eveLocationState[id];
    if (loc) {
      eveMap.focusSystemId = loc.systemId;
      eveMapLoadRegion(loc.systemId);
    }
  }
});
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

msgInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
msgInput.addEventListener('input', () => { msgInput.style.height = 'auto'; msgInput.style.height = Math.min(msgInput.scrollHeight, 130) + 'px'; });

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
