# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BeeTalk is an Electron-based XMPP chat client for Windows that supports multi-account connectivity, group chats (MUC), message history, and system tray integration. It connects to XMPP servers (primarily GSF Jabber). It also includes EVE Online integration with an interactive region map that tracks all linked EVE character locations.

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
- `eve-character-linked`: Character successfully linked to XMPP account
- `eve-location-update`: Character location changed (systemId, systemName, regionName)

### EVE Online Integration

The app can link EVE Online characters to XMPP accounts via OAuth2. When a character's location updates, it displays on an interactive regional map.

**EVE OAuth Flow** (`src/main.js`):
- User clicks "Link EVE Character"
- App generates PKCE code verifier/challenge
- Opens login.eveonline.com in browser
- Receives authorization code via callback (port 7777)
- Exchanges code for access/refresh tokens via `eve-link-character` IPC handler
- Stores tokens in `electron-store` under `eveTokens[characterId]`
- Stores character reference in account's `eveCharacters[]` array

**EVE Map Canvas** (`src/app.js`):
- 2D interactive map showing all systems in a region (from Static Data Export preload)
- Uses official `position2D` coordinates from CCP's SDE (matches Dotlan/in-game map orientation)
- Multi-character support: shows all linked characters' locations simultaneously
- Focus on most recently updated character: highlighted with blue pulsing glow, auto-centers
- Character selector dropdown to manually focus on a specific character
- Hover tooltips show system name, security status, and character names
- Pan with mouse drag, zoom with mouse wheel
- All characters shown with orange glow; region stargate connections drawn as lines

**EVE Map Functions**:
- `eveMapLoadRegion(systemId)` — Looks up cached region data from preloaded SDE, returns instantly
- `eveMapDraw()` — Renders canvas each frame: background, connections, systems, tooltips
- `eveMapAnimate()` — requestAnimationFrame loop
- `initEveMapCanvas()` — Canvas initialization, event handlers (drag, zoom, hover)
- `renderEveMapPanel()` — Updates character selector dropdown and location label
- `updateEveMapPanelVisibility()` — Shows/hides EVE map panel based on linked characters

**Character Location Polling** (`fetchEveLocations()` in `src/main.js`):
- Polls every 10 seconds for character location updates via ESI API
- Uses OAuth tokens stored in `electron-store` to authenticate requests
- Queries `https://esi.evetech.net/latest/characters/{id}/location/`
- Also fetches system and region data to provide location context
- Updates renderer via `eve-location-update` IPC event with `{ systemId, systemName, regionName }`
- **Note:** EVE cache parsing was explored but determined impractical (CCP uses proprietary binary format requiring reverse-engineering)

**EVE Data Flow**:
1. Main process polls character locations via ESI every 10 seconds
2. Sends `eve-location-update` when character location changes
3. Renderer receives event, updates `eveLocationState[characterId]`
4. Sets `eveTrackedCharacterId` to the most recently updated character
5. Calls `eveMapLoadRegion(systemId)` to look up cached region data from SDE
6. Canvas auto-centers on that system with blue pulsing indicator
7. All other linked characters shown with orange glow on the map

**Static Data Export (SDE) Integration**:
- Pre-loaded on app startup via `preloadEveUniverse()` from `assets/eve-sde/`
- Includes all regions, systems, stargates, and official position2D coordinates
- JSONL files: mapSolarSystems.jsonl, mapRegions.jsonl, mapStargates.jsonl (~8.5 MB total)
- Uses official CCP position2D instead of calculating from 3D coordinates
- `eve-load-region-map` handler returns cached region data instantly
- Returns: `{ regionName, regionId, currentSystemId, systems: [...], connections: [[sysA, sysB], ...] }`

### Message Rendering

Messages are rendered in batches (`RENDER_BATCH_SIZE = 50`) to avoid UI jank when loading large history. The room stores all messages in `state.chats[key].messages[]` but only displays the last `MAX_DISPLAYED_MESSAGES_ROOM = 500` in the DOM. This prevents memory bloat while keeping full history for search/scroll.

### Persistence

- **Accounts & Rooms**: Stored in `electron-store` (JSON file on disk), loaded on app start
- **Passwords**: Stored in system keychain via keytar, never written to disk as plaintext
- **EVE Tokens**: Stored in `electron-store` under `eveTokens[characterId]` (access/refresh tokens + expiry)
- **EVE Characters**: Stored in each account's `eveCharacters[]` array in the accounts store
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
- **EVE OAuth**: Requires `EVE_CLIENT_ID` set in `src/main.js` (get from https://developers.eveonline.com/applications). Callback URL must be registered as `http://localhost:7777/callback`
- **EVE Character Location**: Polled every 10 seconds via ESI API. Uses OAuth tokens for authentication. Official, reliable, no external dependencies.
- **EVE Map**: Fetches live data from ESI API (https://esi.evetech.net/). System coordinates and stargate connections pulled on demand. No local caching of map data.
- **EVE Token Storage**: Uses `electron-store` not keytar (keytar has size limits for large tokens). Tokens include expiry; refresh flow not yet implemented (tokens assumed valid for session duration).
- **EVE Map Neighboring Systems Positioning**: Both the small map and fullscreen map must call `positionNeighboringSystemsOnMap()` / `eveMapPositionNeighboringSystems()` to reposition neighboring systems along connection lines for visual clarity. Both maps use the same system objects from `eveMap.systemIndex` for consistent positioning. Both maps fetch neighboring region connections explicitly and store them in their respective map objects (`eveMap.neighboringRegionConnections` and `fullscreenEveMap.neighboringRegionConnections`). The fullscreen map also updates the small map's connections to ensure consistency across map switches.
- **EVE Intel Channel Parser**: Reads local EVE chat log files to extract intel reports. Auto-detects EVE log folder at standard locations (`%APPDATA%\CCP\EVE\`, `%LOCALAPPDATA%\CCP\EVE\`, or custom OneDrive paths). Parses messages like "PlayerName SystemName Ship" to extract threats and display on maps with color-coded age. Handles "+1"/"+N" increments, "clear" messages, and ship type detection. Intel markers appear on both small and fullscreen maps with 15-minute default timeout (configurable in settings).

## EVE Online API & ESI Reference

**ESI (EVE Swagger Interface)** is CCP's official RESTful API for EVE Online third-party development. 

**Official Resources**:
- API Explorer: https://developers.eveonline.com/api-explorer (interactive endpoint tester)
- ESI Docs: https://developers.eveonline.com/docs/services/esi/overview/ (full documentation)
- Base URL: `https://esi.evetech.net/latest/`
- Issues/Feature Requests: https://github.com/esi/esi-issues

### Authentication & Versioning

**SSO Authentication**: Many endpoints require OAuth2 tokens from EVE's SSO (Single Sign-On). Public endpoints don't require authentication.

**API Versioning**: Use `X-Compatibility-Date` header (ISO format: YYYY-MM-DD) to pin API behavior to a specific date. Changes roll out at 11:00 UTC daily.

**Breaking vs Non-Breaking**:
- **Requires new compat date**: New routes, required parameter changes, type changes, field removals
- **Same compat date**: New optional parameters, new response fields, new headers

Report issues at the esi-issues GitHub repository.

### Character Location & Navigation

- **GET `/characters/{id}/location/`** — Current system, station, and structure for a character (requires auth)
  - Returns: `solar_system_id`, `station_id`, `structure_id`
  - Used by: `fetchEveLocations()` in main.js (polled every 10 seconds)
  - Auth: Character OAuth token required
  - Rate limit: 1 request/second per character

- **GET `/universe/systems/{id}/`** — System metadata: name, security, coords, constellation
  - Returns: `name`, `security_status`, `sun_id`, `position: {x, y, z}`, `constellation_id`
  - Used for: Populating system names and security in map
  - Auth: Public (no token required)

- **GET `/universe/regions/{id}/`** — Region metadata: name, description
  - Returns: `name`, `region_id`, `constellations[]`
  - Used for: Displaying region names on map labels
  - Auth: Public

- **GET `/universe/stargates/{id}/`** — Stargate metadata: destination system/stargate
  - Returns: `name`, `position: {x, y, z}`, `destination: {stargate_id, system_id}`
  - Used for: Building stargate connection graph (embedded in SDE)
  - Auth: Public

### Static Data Export (SDE)

EVE's universe structure is pre-loaded from CCP's Static Data Export (JSONL files in `assets/eve-sde/`):
- `mapSolarSystems.jsonl` — All systems: id, name, position (x, y), region_id, security
- `mapRegions.jsonl` — All regions: id, name
- `mapStargates.jsonl` — All stargates: id, position, destination stargate/system

SDE data is authoritative for map rendering (no API calls needed). ESI is only called for:
- Character location polling
- System/region lookups when needed for context
- OAuth token exchange for character linking

### OAuth2 Flow (Character Linking)

EVE uses OAuth2 with PKCE (Proof Key for Code Exchange):
1. Generate `code_verifier` (43-128 chars) and `code_challenge` (SHA256 hash, base64url)
2. Redirect to `https://login.eveonline.com/v2/oauth/authorize/?client_id={EVE_CLIENT_ID}&redirect_uri={callback}&response_type=code&code_challenge={challenge}&scope={scopes}`
3. User logs in, grants permission
4. Browser redirects to `http://localhost:7777/callback?code={auth_code}`
5. Exchange code for tokens via `POST /oauth/token` with `code_verifier` in body
6. Receive: `access_token` (expires ~20 min), `refresh_token` (1 month), `expires_in`
7. Store in `electron-store` under `eveTokens[characterId]`

**Scopes used**: `esi-location.read.v1` (location), `esi-characters.read_standings.v1` (optional)

### Common Pitfalls

- **Token Expiry**: Access tokens expire after ~1200 seconds. Implement refresh flow to request new token with `refresh_token` (not yet implemented; currently tokens assumed valid for session duration)
- **Rate Limits**: ESI enforces per-endpoint rate limits (typically 1-100 req/s). Stagger requests, implement backoff
- **CORS**: Browser-side requests to ESI may fail due to CORS. Use main process (Node.js) for API calls instead
- **Caching**: Leverage SDE for static data; only query ESI for dynamic data (character location, orders, etc.)
- **Error Handling**: ESI returns 400/401/403/404/420/500/503. Implement exponential backoff for 503 (service unavailable)
