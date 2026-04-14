# BeeTalk

A modern XMPP chat client for Windows built with Electron. Connect to GSF Jabber or any XMPP server.

## Features

- **Multi-account** — Connect multiple XMPP accounts simultaneously, each shown as a sidebar icon
- **Group chat (MUC)** — Join rooms; they stay open as tabs in the main window (no popup hell)
- **Room discovery** — Browse and join available rooms, or join manually by name
- **Message history** — Automatically loads archived messages from the server (MAM)
- **System tray** — Minimises to tray, badge shows unread count, right-click for status/quit
- **Participant list** — Slides open when viewing a group chat
- **Persistent accounts** — Credentials and joined rooms are saved and reconnected on launch
- **Emoticons** — Built-in emoticon picker with search and favorites
- **Light/dark theme** — Toggle between light and dark UI
- **Directorbot integration** — Special chat for system messages with optional alarm sound

## Requirements

- [Node.js](https://nodejs.org/) 18+ (LTS recommended)
- Windows 10/11 (also works on macOS/Linux for development)

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Run in development
npm start

# 3. Build a Windows installer (.exe)
npm run build:win
```

The installer will be in the `dist/` folder.

## Connecting

Default connection is to **GSF Jabber** (goonfleet.com). When adding an account, enter your EVE character name, username, and password.

To connect to a different XMPP server, modify the hardcoded server details in `src/app.js` (around line 732).

| Server    | WebSocket URL (if needed)                        |
|-----------|--------------------------------------------------|
| GSF Jabber | `goonfleet.com:5222`                            |
| Prosody   | `wss://yourdomain.com:5281/xmpp-websocket`       |
| ejabberd  | `wss://yourdomain.com:5443/ws`                   |
| Openfire  | `wss://yourdomain.com:7443/ws`                   |

## Joining rooms

1. Make sure your account is connected (green dot)
2. Click the **Rooms** tab in the left panel
3. Either:
   - Click **Browse rooms** to see available rooms and join with one click
   - Click **Join a room** to manually enter a room name (e.g. `general`)

Joined rooms are saved and automatically rejoined on startup. Rooms remember the last 50 messages from the server.

## Settings

Click the settings icon (⚙) to:
- Change your display name
- Set your presence status (Available, Away, Extended Away, Do Not Disturb)
- Add a status message
- Toggle light/dark theme
- Enable/disable alarm sound for Directorbot messages

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Send message |
| `Shift+Enter` | New line in message |

## System tray

- **Left-click** — Toggle window visibility
- **Double-click** — Show and focus window
- **Right-click** — Quick access to status, quit button
- The tray icon badge shows unread message count

## Building a distributable

```bash
npm run build:win
```

Produces an NSIS installer in `dist/`. For a portable directory instead:

```bash
npm run pack
```

To build for macOS or Linux, use `npm run build:mac` or `npm run build:linux`. To build all platforms at once, use `npm run build`.

## Replacing the icon

Put a 256×256 PNG at `assets/icon.png` and a 16×16 ICO at `assets/icon.ico`
before building. The tray icon uses `assets/tray.png` (16×16 or 32×32 PNG).

## Project structure

```
BeeTalk/
├── src/
│   ├── main.js         # Electron main process (window, tray, XMPP, IPC)
│   ├── preload.js      # Context isolation bridge
│   ├── index.html      # UI shell
│   ├── app.js          # Renderer — UI, XMPP events, multi-account, rooms
│   └── styles.css      # Light/dark theme
├── assets/
│   ├── icon.png        # Window/taskbar icon
│   ├── icon.ico        # Windows icon
│   ├── tray.png        # System tray icon
│   └── emoticons/      # Emoticon packs
├── package.json
└── README.md
```
