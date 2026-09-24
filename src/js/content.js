'use strict';
// Message sanitizing, emoticons and the emoticon picker.
// Part of the renderer: index.html loads src/js/*.js in order; they share one global scope.

// ─────────────────────────────────────────────
//  Message Sanitization & Rendering
//  ─────────────────────────────────────────────
function sanitizeMessageHTML(html) {
  // Parse into an inert document: unlike a detached <div>, nothing in it loads
  // or runs (e.g. <img onerror>) before the allow-list below is applied.
  const temp = new DOMParser().parseFromString(html, 'text/html').body;

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
// One regex for all emoticon names (built when emoticons load), longest names first
let emoticonRegex = null;
const emoticonIndexByName = new Map();
function buildEmoticonRegex() {
  emoticonIndexByName.clear();
  emoticonsList.forEach((e, idx) => { if (!emoticonIndexByName.has(e.name)) emoticonIndexByName.set(e.name, idx); });
  const names = [...emoticonIndexByName.keys()].sort((a, b) => b.length - a.length);
  emoticonRegex = names.length
    ? new RegExp(names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null;
}

function parseEmoticons(text) {
  if (!emoticonRegex) return text;
  return text.replace(emoticonRegex, m => `__EMOTICON_${emoticonIndexByName.get(m)}__`);
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

  // Build nodes directly: the text node holds decoded message text, so it must
  // never be passed through innerHTML.
  nodesToReplace.forEach(node => {
    const frag = document.createDocumentFragment();
    node.nodeValue.split(/(__EMOTICON_\d+__)/).forEach(part => {
      const m = part.match(/^__EMOTICON_(\d+)__$/);
      const e = m && emoticonsList[Number(m[1])];
      if (e) {
        const img = document.createElement('img');
        img.className = 'emoticon';
        img.src = e.path;
        img.alt = img.title = e.name;
        frag.appendChild(img);
      } else if (part) {
        frag.appendChild(document.createTextNode(part));
      }
    });
    node.parentNode.replaceChild(frag, node);
  });
}

function linkifyUrls(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodesToProcess = [];
  let node;
  while (node = walker.nextNode()) {
    URL_REGEX.lastIndex = 0;
    if (!node.parentElement.closest('a') && URL_REGEX.test(node.nodeValue)) nodesToProcess.push(node);
  }
  URL_REGEX.lastIndex = 0;

  nodesToProcess.forEach(node => {
    const frag = document.createDocumentFragment();
    appendLinkified(frag, node.nodeValue);
    node.parentNode.replaceChild(frag, node);
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

// One emoticon tile in the picker; hover styling lives in styles.css (.emoticon-tile)
function emoticonTileHtml(e, isFavorite) {
  return `
    <div class="emoticon-tile" data-action="insertEmoticon" data-args="${esc(JSON.stringify([e.name]))}" data-close="modal"
      data-name="${esc(e.name)}" title="${esc(e.name)}">
      <img src="${esc(e.path)}" loading="lazy" />
      <div class="emoticon-favorite-btn" data-action="toggleFavoriteEmoticon" data-args="${esc(JSON.stringify([e.name]))}"
        title="Toggle favorite">${isFavorite ? '★' : '☆'}</div>
    </div>
  `;
}

function emoticonGridHtml(list) {
  const favorites = getAppSettings().favoriteEmoticons || [];
  return (list || []).map(e => emoticonTileHtml(e, favorites.includes(e.name))).join('');
}

function showEmoticonPicker() {
  if (!Object.keys(emoticons).length) {
    showModal(`
      <div class="modal-title">Emoticons</div>
      <p style="color: var(--text3); text-align: center; padding: 20px;">Loading emoticons...</p>
      <div class="modal-actions">
        <button class="btn-secondary" data-action="hideModal">Close</button>
      </div>
    `);
    return;
  }

  const settings = getAppSettings();
  const recent = settings.recentEmoticons || [];
  const favorites = settings.favoriteEmoticons || [];
  const folders = Object.keys(emoticons);
  const byName = name => emoticonsList.find(e => e.name === name);

  let html = `<div class="modal-title">Emoticons</div>`;

  const section = (title, list) => `<div style="margin-bottom: 12px;">
      <div style="font-size: 12px; color: var(--text2); margin-bottom: 8px; text-transform: uppercase;">${title}</div>
      <div class="emoticon-grid" style="margin-bottom: 16px;">${emoticonGridHtml(list)}</div>
    </div>`;

  if (recent.length > 0) html += section('Recent', recent.map(byName).filter(Boolean));
  if (favorites.length > 0) html += section('Favorites', favorites.map(byName).filter(Boolean));

  // Search
  html += `<div style="margin-bottom: 12px;">
    <input class="form-input" id="emoticon-search" placeholder="Search emoticons..." style="margin-bottom: 8px; width: 100%; padding: 8px; font-size: 14px;" />
  </div>`;

  // Folder tabs
  html += `<div style="margin-bottom: 12px;">
    <div style="display: flex; gap: 8px; margin-bottom: 8px; border-bottom: 1px solid var(--border); padding-bottom: 8px; flex-wrap: wrap;">
      ${folders.map((folder, idx) => `
        <button class="emoticon-folder-btn${idx === 0 ? ' active' : ''}"
          data-action="switchEmoticonFolder" data-args="${esc(JSON.stringify([folder]))}"
          data-folder="${esc(folder)}">${esc(folder)}</button>
      `).join('')}
    </div>
    <div id="emoticon-grid" class="emoticon-grid" style="max-height: 400px; overflow-y: auto;">
      ${emoticonGridHtml(emoticons[folders[0]])}
    </div>
  </div>`;

  html += `
    <div class="modal-actions">
      <button class="btn-secondary" data-action="hideModal">Close</button>
    </div>
  `;

  showModal(html);

  const searchInput = document.getElementById('emoticon-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const grid = document.getElementById('emoticon-grid');
      if (query === '') {
        const activeFolder = document.querySelector('.emoticon-folder-btn.active')?.dataset.folder || folders[0];
        grid.innerHTML = emoticonGridHtml(emoticons[activeFolder]);
      } else {
        grid.innerHTML = emoticonGridHtml(emoticonsList.filter(e => e.name.toLowerCase().includes(query)));
      }
    });
    searchInput.focus();
  }
}

function switchEmoticonFolder(folder) {
  document.querySelectorAll('.emoticon-folder-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.folder === folder);
  });
  const grid = document.getElementById('emoticon-grid');
  if (grid) grid.innerHTML = emoticonGridHtml(emoticons[folder]);
}

function addRecentEmoticon(name) {
  const settings = getAppSettings();
  const recent = settings.recentEmoticons || [];
  const filtered = recent.filter(e => e !== name);
  const newRecent = [name, ...filtered].slice(0, 15);
  saveAppSettings({ recentEmoticons: newRecent });
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
    buildEmoticonRegex();
    console.log(`Loaded ${emoticonsList.length} emoticons from ${Object.keys(emoticons).length} folders`);
  } catch (err) {
    console.error('Failed to load emoticons:', err);
  }
}
