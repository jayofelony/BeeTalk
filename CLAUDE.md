# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BeeTalk is an Electron-based XMPP chat client for Windows that supports multi-account connectivity, group chats (MUC), message history, and system tray integration. It connects to XMPP servers (primarily GSF Jabber).

## Development Commands

### Setup
```bash
npm install       # Install dependencies (Node.js 18+ required)
```

### Running
```bash
npm start         # Start development app (hot reload works for renderer process only)
npm run pack      # Create portable directory (no installer)
```

### Building Installers
```bash
npm run build:win     # Windows NSIS installer (x64) → dist/
npm run build:mac     # macOS DMG + zip → dist/
npm run build:linux   # Linux AppImage + deb → dist/
npm run build         # All platforms (runs build:win, build:mac, build:linux, build:linux)
```

### Icon Management
```bash
npm run icons     # Generate platform-specific icons from assets/icon.png
```

Place a 256×256 PNG at `assets/icon.png` and run `npm run icons` before building. The tray icon uses `assets/tray.png`.

## Architecture

### Three-Process Model

1. **Main Process** (`src/main.js`)
   - Electron app lifecycle, window creation, system tray
   - XMPP connection pool (one per account)
   - Credential storage via keytar (system keychain)
   - IPC handlers that the renderer calls

2. **Preload Script** (`src/preload.js`)
   - Context isolation bridge: converts IPC channels between kebab-case and camelCase
   - Example: `ipcRenderer.send('xmpp-connect')` → `window.electronAPI.xmppConnect()`
   - Ensures renderer cannot access Node.js APIs

3. **Renderer Process** (`src/app.js` + `src/index.html` + `src/styles.css`)
   - UI layout, styling, client-side routing between accounts/chats
   - Account and chat state management
   - XMPP event listeners and message rendering
   - Modal dialogs (settings, emoticons, room discovery, etc.)

### State Management

The renderer maintains a single `state` object in `src/app.js`:
- `accounts[]` — array of connected XMPP accounts with credentials, presence, display name
- `chats{}` — map of chat rooms/direct messages keyed by `accountId::jid`
- `activeAccountId`, `activeChatKey` — current selection in UI
- Idle/focus state for auto-away detection

Changes flow: main process → renderer via IPC events → state mutations → DOM re-renders

### Multi-Account Architecture

Each account has its own XMPP client (`connections[accountId]._xmpp`). Accounts are displayed as sidebar icons and can be switched. Each chat (room or direct message) is tied to an account. When an account disconnects, all its chats are marked offline.

### IPC Communication

**Renderer → Main** (via `ipcRenderer.send()` or `.invoke()`):
- `xmpp-connect`: Connect account with credentials
- `xmpp-send-message`: Send message to room/user
- `xmpp-disconnect`, `xmpp-send-presence`: Control connection
- `load-accounts`, `save-accounts`: Persist account list

**Main → Renderer** (via `event.reply()` or broadcast):
- `xmpp-status`: Account connected/disconnected/error
- `xmpp-message`: New message received
- `xmpp-room-users`: Participant list for a room
- `xmpp-room-discovery`: Available rooms from server

### Message Rendering

Messages are rendered in batches (`RENDER_BATCH_SIZE = 50`) to avoid UI jank when loading large history. The room stores all messages in `state.chats[key].messages[]` but only displays the last `MAX_DISPLAYED_MESSAGES_ROOM = 500` in the DOM. This prevents memory bloat while keeping full history for search/scroll.

### Persistence

- **Accounts & Rooms**: Stored in `electron-store` (JSON file on disk), loaded on app start
- **Passwords**: Stored in system keychain via keytar, never written to disk as plaintext
- **XMPP Server Connection**: GSF Jabber hardcoded in `src/app.js` line ~732; can be changed at startup

### Idle Detection & Auto-Away

- Idle timeout is 10 minutes (`IDLE_TIMEOUT_MS`)
- Keyboard/mouse activity resets the timer
- When idle threshold is reached, presence is set to 'away'
- When user becomes active again, presence returns to 'available'

## Key Implementation Details

### Account Connection Flow
1. Renderer calls `ipcRenderer.invoke('xmpp-connect', { username, password, displayName, ... })`
2. Main process creates XMPP client, sets up event listeners, saves account to electron-store
3. Main broadcasts `xmpp-status` with connection state
4. Renderer updates account status dot (green = connected, red = disconnected)
5. Main stores password in keytar; renderer never sees it

### Message Flow in Rooms
1. User types in message input, hits Enter
2. Renderer calls `ipcRenderer.send('xmpp-send-message', { chatKey, text })`
3. Main finds the account's XMPP client, sends message via stanza
4. Server sends message back to all participants via MUC
5. Main receives message event, broadcasts `xmpp-message`
6. Renderer updates `state.chats[chatKey].messages[]` and re-renders

### Search
Search filters both account names and chat names (rooms + contacts). The search input automatically focuses on account/room/contact matching as the user types.

### Emoticon System
Emoticon picker is a modal with search and favorites. Emoticons are simple text replacements (e.g., `:smile:` → corresponding symbol). Data structure is in renderer state; emoticon packs are in `assets/emoticons/`.

## Common Patterns

### DOM Updates
Use `$()` shorthand to get DOM elements by ID (defined at top of `src/app.js`). Most UI updates call `render*()` functions that rebuild a section of the DOM. Example: `renderLeftPanel()` re-renders all accounts and chat list.

### Error Handling
Connection errors are shown in the connection status bar at the top of the chat area. XMPP stanza errors are logged to console. Graceful degradation: if an operation fails (e.g., room discovery), the UI shows an error message but doesn't crash.

### Modal Dialogs
Call `showModal(html)` to display a modal; call `hideModal()` to close. Modals include settings, emoticon picker, room discovery, add-account form.

### Theming
Light/dark theme is controlled by a CSS class on `<body>`. The theme choice is persisted in electron-store. CSS variables (e.g., `--bg-primary`) adapt colors for each theme.

## Testing & Debugging

- **Dev Tools**: `Ctrl+Shift+I` in dev mode (if dev tools enabled in main.js)
- **Console**: Open DevTools or check terminal output for logs
- **Slow XMPP?**: Add `console.log()` in main.js connection handlers to trace stanza flow
- **IPC Debug**: Add logs in preload.js channel conversion to see what's being called
- **State Issues**: Inspect `state` object in DevTools console directly

## Notes for Maintainers

- Electron version is pinned to 41.2.0; check for security updates regularly
- keytar dependency is optional (graceful fallback if unavailable on some systems)
- Reconnection logic uses exponential backoff timers; timers are stored in `reconnectTimers` map
- MUC (Multi-User Chat) room join flow requires sending presence after joining; this is handled in main.js
- Message Archive Management (MAM) queries for history happen on room join; they're paginated to avoid overload
