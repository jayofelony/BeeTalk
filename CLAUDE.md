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
   - The renderer's `ipcRenderer` shim in `src/js/core.js` maps channel names to camelCase: `send('xmpp-connect')` → `electronAPI.xmppConnect()`, `on('app-focus')` → `electronAPI.onAppFocus()`
   - **Every channel the renderer uses must be exposed here.** A missing one only logs a console warning ("IPC channel not exposed in preload")

3. **Renderer Process** (`src/index.html` + `src/js/*.js` + `src/styles.css`)
   - Plain scripts loaded in order by `index.html`; they share one global scope (no modules/bundler), so functions and top-level `const`s are visible across files. Add new code to the file that fits:
     - `core.js`: IPC shim, config, `state`, DOM refs, escaping/links, modals, the `data-action` dispatcher (`UI_ACTIONS`), idle detection
     - `events.js`: handlers for main-process events, typing notifications, sounds
     - `chats.js`: chat/room state, duplicates, join history, DM archive loading
     - `render.js`: left panel, `openChat`/`appendMessage`, sending
     - `dialogs.js`: account dialogs, context menus, groups, join room, settings, chat info, update check
     - `storage.js`: persistence, message history (IndexedDB), app settings
     - `content.js`: sanitizing, emoticons and the picker
     - `rooms.js`: Browse Rooms
     - `init.js`: DOM event listeners and boot (must stay last)
   - Top-level code runs at load in file order, so code that *runs* during load may only use things from earlier files; function calls at event time are fine

### Security Rules (renderer)

Chat content (messages, room subjects, nicknames, room names) is untrusted. The page's CSP is `script-src 'self'`, so inline script and inline event handlers are blocked.

- **Never use inline handlers** (`onclick="..."`). For clickable elements in generated HTML use `data-action="functionName"` plus `data-args="${esc(JSON.stringify([...]))}"`. One click listener dispatches these, and only to names in the `UI_ACTIONS` allow-list in `src/js/core.js`; add new actions there. `data-close="modal"` also closes the modal afterwards.
- **Escape all interpolated values** with `esc()` when building HTML strings.
- **Message HTML** goes through `sanitizeMessageHTML()`, which parses with `DOMParser` (inert) and keeps only allow-listed tags. Links (`linkifyUrls`, `escapeAndLinkify`) and emoticons (`applyEmoticons`) are built as DOM nodes; never pass message text through `innerHTML`.
- The main process doesn't trust renderer data: `xmpp-connect` connects using the stored account with the server pinned to `goonfleet.com`, and `open-link` only opens http(s) URLs.

### State Management

The renderer maintains a single `state` object (`src/js/core.js`):
- `accounts[]` — the account, with presence and display name. BeeTalk supports one account, but the data model is kept per account: account IDs are part of every storage key (`rooms_<id>`, history chat keys `<id>::<jid>`, the saved password), so changing it would need a data migration
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

The server is Openfire 5.0.2 (goonfleet.com): stream management (XEP-0198, resumable for 600 s), message carbons, ping, blocking, vCard/PEP, offline messages; no message archive (accounts or rooms), no file upload.

- `src/lib/connection.js` (`watchConnection`) owns the lifecycle; `connectXmpp()` in main.js only wires callbacks. @xmpp/client reconnects by itself; the watcher backs off its delay (2 s doubling to 5 min), reports a drop once, and stops after an authentication failure (a wrong password retried endlessly could lock the account).
- **Resumed sessions:** after a short drop the library resumes the XEP-0198 session and marks itself online *without emitting 'online'* (still so in @xmpp/client 0.14). The watcher listens for `xmpp.streamManagement`'s `resumed` event and reports `online` with `resumed: true`. A resumed session keeps presence, roster, room membership and carbons, so the renderer does not rejoin rooms. 0.14 also re-sends outgoing stanzas the server hadn't acknowledged.
- **Keepalive:** a ping every 30 s; no answer within 10 s (the timeout also covers *sending*, which can hang on a dead connection) means the connection is dead, so the socket is destroyed and the library reconnects/resumes.
- **Network changes:** the renderer forwards the browser's `offline`/`online` events (`network-status` IPC); main also listens to `powerMonitor` `resume` (wake from sleep). Network lost drops the connection at once; network back reconnects at once (or pings a connection that still looks online). Connection events are logged with a `[conn]` prefix (run `/opt/BeeTalk/beetalk` from a terminal to see them).
- **Login:** @xmpp/client 0.14 (an ES module; `require()` works in Node 22+/Electron). The credentials callback is called as `(authenticate, mechanisms, fast, entity)` and must pick the mechanism: `tlsOnlyCredentials` (`src/lib/xmpp-helpers.js`) refuses unless `xmpp.isSecure()` (after STARTTLS), then uses the first offered mechanism that isn't ANONYMOUS. goonfleet.com offers only SASL PLAIN (no SASL2/FAST).
- **Carbons** (XEP-0280) are enabled on each new session; `unwrapCarbon` (`src/lib/stanzas.js`) only trusts carbons from our own bare JID. "Sent" carbons reach the renderer as `xmpp-message` with `outgoing: true`.
- **Typing** (XEP-0085, DMs only): incoming states arrive as `xmpp-chat-state`; outgoing states are only sent to peers that have sent us one, and chat messages carry `<active/>`.
- Roster pushes are only accepted from our own account/server.

### Messages, History & Notifications

- Rooms have no archive on goonfleet.com; join history is all the server offers. Joins ask for up to 1000 messages `since` the last known message (first join: last day); the server sends at most what it keeps. Replayed messages that match an existing one (`isDuplicateMessage`) are skipped.
- DM history comes from the server archive (XEP-0313) when a DM is opened and is merged into the chat.
- Messages are rendered in batches (`RENDER_BATCH_SIZE = 50`); rooms show at most `MAX_DISPLAYED_MESSAGES_ROOM = 500` in the DOM.
- The renderer decides on notifications (`notifyIfNeeded`): DMs, Directorbot and mentions of your nick; never for history, your own messages or Do Not Disturb.

### Persistence

- **Account**: `electron-store` (`accounts`), without password
- **Password**: encrypted with `safeStorage` and stored as base64 in `electron-store` under `passwords[accountId]`
- **Message history**: IndexedDB `beetalk-history` (store `messages`, index `chat_ts` on `[chat key, ts]`), see `src/js/storage.js`. goonfleet.com has no server archive for accounts or rooms, so this is the only history. Messages are written as they arrive (one transaction per burst, no timers: hidden windows throttle them). Startup preloads the newest 300 per chat; "Load older messages" pages in more; in-chat search (Ctrl+Shift+F) covers everything stored. Rooms are pruned to 5000 messages, DMs and Directorbot are kept. Old `chat_messages_*` localStorage history is migrated once
- **Rooms, roster, groups, chat state, settings**: renderer `localStorage` (`rooms_*`, `roster_*`, `chat_*`, `appSettings`)
- **Server**: `goonfleet.com` (`GSF_SERVER` in `src/main.js`)

### Idle Detection & Auto-Away

- Idle timeout is 10 minutes (`IDLE_TIMEOUT_MS`)
- Keyboard/mouse activity resets the timer
- When idle threshold is reached, presence is set to 'away'
- When user becomes active again, presence returns to 'available'

## Common Patterns

### DOM Updates
Use `$()` shorthand to get DOM elements by ID (defined in `src/js/core.js`). Most UI updates call `render*()` functions that rebuild a section of the DOM, e.g. `renderLeftPanel()` rebuilds the contact and room lists.

### Error Handling
Connection errors are shown in the connection status bar at the top of the chat area. XMPP stanza errors are logged to console. If an operation fails (e.g., room discovery), the UI shows an error message but doesn't crash.

### Modal Dialogs
Call `showModal(html)` to display a modal and `hideModal()` to close it. The HTML must follow the security rules above (escaped values, `data-action` instead of inline handlers).

### Emoticons
Emoticon packs are in `assets/emoticons/` (`theme` files map image files to shortcuts). `parseEmoticons()` uses one regex over all names, longest first, and `applyEmoticons()` turns the placeholders into `<img>` nodes.

### Theming
Light/dark theme is a `data-theme` attribute on `<html>`, persisted in `localStorage` (`appSettings.theme`). CSS variables adapt colors for each theme.

## Testing & Debugging

```bash
npm test                          # everything (~15 s)
npm run test:node                 # main-process unit tests (node --test)
npm run test:electron             # renderer tests in hidden Electron windows
npm run test:electron -- history  # one suite
npm run test:main                 # starts the real app (main.js) and checks it boots
```

- **Main-process tests** (`test/node/`): helpers in `src/lib/xmpp-helpers.js` (JID validation, version comparison, archive check) and TLS enforcement against fake XMPP servers on localhost (needs `openssl`). Keep main-process logic that can be tested without Electron in `src/lib/`.
- **Renderer tests** (`test/electron/*.test.js`): `run.js` loads the real `index.html`/`src/js/*.js`/`preload.js` with the main process replaced by fakes (`t.fake`: accounts, emoticons, rooms, history; every `ipcRenderer.send` is recorded in `t.fake.sent`). Each suite gets fresh in-memory storage. Suites drive the app through the same IPC events the main process sends (`page.send('xmpp-message', ...)`). The boot sequence sets `document.body.dataset.ready` when done.
- Suites cover: security (script injection, CSP, inert sanitizing), accounts, rooms, messaging/notifications, history, emoticons.
- Hidden windows pause `requestAnimationFrame`, so tests shouldn't depend on more than a few batches of `openChat` rendering.
- **Boot smoke test** (`test/electron/main-smoke.js`): the renderer suites fake the main process, so this is what catches a broken `main.js`, e.g. a dependency upgrade that changes how a module loads (electron-store 9+ is ESM: `require('electron-store').default`).
- **Dependabot**: `@xmpp/*` is 0.x, where minor releases can break the API; it gets separate PRs. Before merging one, run `npm test` and check the connection tests (`test/node/connection.test.js` runs the real library against a fake server).
- CI runs the tests on every push to `main` and on pull requests (`.github/workflows/test.yml`); release builds only start if they pass.

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
