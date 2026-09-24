# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BeeTalk is an Electron-based XMPP chat client for Windows for GSF Jabber (goonfleet.com). It supports one account, group chats (MUC), direct messages with server-side history, and system tray integration.

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
npm run build:win:docker  # Windows installer built on Linux via Docker (electronuserland/builder:wine)
npm run build:mac     # macOS DMG + zip → dist/
npm run build:linux   # Linux AppImage + deb → dist/
npm run build         # All platforms (runs build:win, build:mac, build:linux, build:linux)
```

### Icon Management
```bash
npm run icons     # Generate all icons (ico, icns, Linux PNG, tray) from assets/icon.png
```

`assets/icon.png` is the source artwork (high resolution, transparent; any aspect ratio, it is padded to square). Run `npm run icons` after changing it and commit the generated `icon.ico`, `icon.icns`, `icon-linux.png`, `tray.png` and `tray@2x.png`. The Linux icon must stay square at a standard size (512×512), or GNOME/KDE fall back to a generic icon.

## Architecture

### Three-Process Model

1. **Main Process** (`src/main.js`)
   - Electron app lifecycle, window creation (sandboxed, navigation blocked), system tray
   - XMPP connection (`connections[accountId]._xmpp`, one account)
   - Credential storage via Electron `safeStorage` (OS-level encryption)
   - IPC handlers that the renderer calls; OS notifications

2. **Preload Script** (`src/preload.js`)
   - Context isolation bridge exposing `window.electronAPI`
   - The renderer's `ipcRenderer` shim in `src/app.js` maps channel names to camelCase: `send('xmpp-connect')` → `electronAPI.xmppConnect()`, `on('app-focus')` → `electronAPI.onAppFocus()`
   - **Every channel the renderer uses must be exposed here.** A missing one only logs a console warning ("IPC channel not exposed in preload")

3. **Renderer Process** (`src/app.js` + `src/index.html` + `src/styles.css`)
   - UI, chat state, XMPP event handling, message rendering, modals

### Security Rules (renderer)

Chat content (messages, room subjects, nicknames, room names) is untrusted. The page's CSP is `script-src 'self'`, so inline script and inline event handlers are blocked.

- **Never use inline handlers** (`onclick="..."`). For clickable elements in generated HTML use `data-action="functionName"` plus `data-args="${esc(JSON.stringify([...]))}"`. One click listener dispatches these, and only to names in the `UI_ACTIONS` allow-list at the top of `src/app.js`; add new actions there. `data-close="modal"` also closes the modal afterwards.
- **Escape all interpolated values** with `esc()` when building HTML strings.
- **Message HTML** goes through `sanitizeMessageHTML()`, which parses with `DOMParser` (inert) and keeps only allow-listed tags. Links (`linkifyUrls`, `escapeAndLinkify`) and emoticons (`applyEmoticons`) are built as DOM nodes; never pass message text through `innerHTML`.
- The main process doesn't trust renderer data: `xmpp-connect` connects using the stored account with the server pinned to `goonfleet.com`, and `open-link` only opens http(s) URLs.

### State Management

The renderer maintains a single `state` object in `src/app.js`:
- `accounts[]` — the account (single-account mode; kept as an array), with presence and display name
- `chats{}` — rooms and DMs keyed by `accountId::jid`. Room private messages use the full `room@conference/nick` JID
- `activeAccountId`, `activeChatKey` — current selection in UI
- `appIsFocused`, idle state for auto-away

Changes flow: main process → renderer via IPC events → state mutations → DOM re-renders. Hot paths (messages, presence) use `scheduleLeftPanel()` / `scheduleParticipants()` to re-render at most once per animation frame.

### IPC Communication

**Renderer → Main**:
- `xmpp-connect`, `xmpp-disconnect`, `xmpp-send-presence`
- `xmpp-send-message`, `xmpp-join-room` (with optional `since` for history), `xmpp-leave-room`
- `xmpp-add-contact`, `xmpp-remove-contact`, `xmpp-update-contact-groups`
- `load-accounts`, `save-accounts`, `load-message-history` (MAM, DMs), `discover-rooms`, `load-emoticons`
- `show-notification`, `open-link`, `set-launch-on-startup`, `check-update`, `get-version`, window controls

**Main → Renderer**:
- `xmpp-status` (`connecting` / `online` / `offline` / `error` / `authfail`), `xmpp-message` (with `delayed` for history), `xmpp-presence`, `xmpp-roster`, `xmpp-room-subject`
- `app-focus`, `app-blur`, `tray-status`, `open-chat` (notification clicked), `update-available`

### Connection & Reconnect

- @xmpp/client reconnects by itself after every disconnect. `connectXmpp()` only tunes `xmpp.reconnect.delay` (2s, doubling to 5 min, reset when online) and reports a drop to the UI once.
- After an authentication failure the connection is destroyed; retrying a wrong password could lock the account.
- The password is only sent after STARTTLS succeeded (`credentials` callback + `isEncrypted()`); goonfleet.com offers only SASL PLAIN.

### Messages, History & Notifications

- Rooms have no archive on goonfleet.com; join history is all the server offers. Joins ask for up to 1000 messages `since` the last known message (first join: last day); the server sends at most what it keeps. Replayed messages that match an existing one (`isDuplicateMessage`) are skipped.
- DM history comes from the server archive (XEP-0313) when a DM is opened and is merged into the chat.
- Messages are rendered in batches (`RENDER_BATCH_SIZE = 50`); rooms show at most `MAX_DISPLAYED_MESSAGES_ROOM = 500` in the DOM.
- The renderer decides on notifications (`notifyIfNeeded`): DMs, Directorbot and mentions of your nick; never for history, your own messages or Do Not Disturb.

### Persistence

- **Account**: `electron-store` (`accounts`), without password
- **Password**: encrypted with `safeStorage` and stored as base64 in `electron-store` under `passwords[accountId]`
- **Message history**: IndexedDB `beetalk-history` (store `messages`, index `chat_ts` on `[chat key, ts]`), see "Message history" in `src/app.js`. goonfleet.com has no server archive for accounts or rooms, so this is the only history. Messages are written as they arrive (one transaction per burst, no timers: hidden windows throttle them). Startup preloads the newest 300 per chat; "Load older messages" pages in more; in-chat search (Ctrl+Shift+F) covers everything stored. Rooms are pruned to 5000 messages, DMs and Directorbot are kept. Old `chat_messages_*` localStorage history is migrated once
- **Rooms, roster, groups, chat state, settings**: renderer `localStorage` (`rooms_*`, `roster_*`, `chat_*`, `appSettings`)
- **Server**: `goonfleet.com` (`GSF_SERVER` in `src/main.js`)

### Idle Detection & Auto-Away

- Idle timeout is 10 minutes (`IDLE_TIMEOUT_MS`)
- Keyboard/mouse activity resets the timer
- When idle threshold is reached, presence is set to 'away'
- When user becomes active again, presence returns to 'available'

## Common Patterns

### DOM Updates
Use `$()` shorthand to get DOM elements by ID (defined at top of `src/app.js`). Most UI updates call `render*()` functions that rebuild a section of the DOM, e.g. `renderLeftPanel()` rebuilds the contact and room lists.

### Error Handling
Connection errors are shown in the connection status bar at the top of the chat area. XMPP stanza errors are logged to console. If an operation fails (e.g., room discovery), the UI shows an error message but doesn't crash.

### Modal Dialogs
Call `showModal(html)` to display a modal and `hideModal()` to close it. The HTML must follow the security rules above (escaped values, `data-action` instead of inline handlers).

### Emoticons
Emoticon packs are in `assets/emoticons/` (`theme` files map image files to shortcuts). `parseEmoticons()` uses one regex over all names, longest first, and `applyEmoticons()` turns the placeholders into `<img>` nodes.

### Theming
Light/dark theme is a `data-theme` attribute on `<html>`, persisted in `localStorage` (`appSettings.theme`). CSS variables adapt colors for each theme.

## Testing & Debugging

- **Linux dev**: if `npm start` aborts with "The SUID sandbox helper binary was found, but is not configured correctly", run `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox` (or use `npx electron --no-sandbox .` for local testing only)
- **Dev Tools**: `Ctrl+Shift+I`
- **Console**: DevTools for the renderer; the terminal for main-process logs. `DEBUG=true` enables extra main-process logging
- **State Issues**: Inspect the `state` object in the DevTools console

## Notes for Maintainers

- Electron 44. Electron supports only the latest three major versions; Dependabot (`.github/dependabot.yml`) opens PRs for Electron, npm packages and CI actions. Since Electron 43, `npm install` no longer downloads the Electron binary; the first `npm start` / `npx electron` does
- macOS builds are not code-signed, so OS notifications don't show on macOS (Electron 43+ requires signing; the `failed` event is handled)
- "Launch at startup" registers the app with `--hidden`, which starts it in the tray
- keytar is an optional dependency used only to migrate passwords saved by older versions into `safeStorage`; the app runs without it
- CI (`.github/workflows/build.yml`) builds all platforms on tag push `v*` and creates a prerelease; Node and action versions are pinned
