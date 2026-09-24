# Changelog

## [1.0.16] - 2026-09-24

### Changed
- electron-store 11 (settings storage); existing settings load unchanged
- png-to-ico 3.0.2 (icon generation at build time)
- New automated check that the app actually starts, so a broken dependency upgrade can't pass CI

## [1.0.15] - 2026-09-24

### Fixed
- After a short connection drop, BeeTalk stayed "Disconnected — reconnecting…" and couldn't send messages even though the server had resumed the session (since 1.0.12)
- A dead connection (e.g. after sleep) is detected within about a minute and reconnected
- Replies to room private messages from nicks with spaces were dropped
- A wrong password was reported twice
- Roster updates are only accepted from your own server

### Added
- Message history is kept much longer (IndexedDB): all DMs and Directorbot pings, 5000 messages per room. goonfleet.com keeps no server archive, so this is the only history
- "Load older messages" and search within a chat (🔍 or Ctrl+Shift+F)
- Messages sent or received on your other devices appear in BeeTalk (message carbons)
- Typing indicators in DMs
- Mentions of your nick are highlighted in rooms; a "New messages" line marks where you left off
- Rooms ask the server for all missed join history (up to 1000 messages) instead of 50

### Changed
- Electron 44 (41 is no longer supported and had known security issues); all npm audit findings fixed
- "Launch at startup" starts BeeTalk in the tray
- Automated tests run on every push; releases only build when they pass
- macOS: OS notifications need a code-signed build since Electron 43; the macOS build is unsigned

## [1.0.14] - 2026-09-24

### Changed
- DM history is only requested from servers that keep a message archive. goonfleet.com doesn't, so older DMs (including Directorbot) can't be fetched from the server; BeeTalk keeps its own local history from first use

## [1.0.13] - 2026-09-24

### Changed
- New high-resolution app icon (the army-helmet bee) on Windows, macOS, Linux and in the system tray
- "Check username/password" in the Add Account dialog opens the GSF service password page

### Fixed
- Linux: the dock showed a generic icon instead of the BeeTalk icon
- Releases contained every installer twice

## [1.0.12] - 2026-09-24

### Security
- Fixed script injection from chat content: messages containing HTML (for example `<img onerror>`), links in messages and room subjects, and nicknames or room names shown in menus could run code in BeeTalk. That code could have sent the stored password to another server
- The password is only sent over an encrypted (STARTTLS) connection
- Passwords are stored with Electron `safeStorage` instead of keytar (existing passwords are migrated)

### Fixed
- Adding an account on first start (the add buttons were hidden)
- Adding, removing and regrouping contacts, the tray status menu and unread badges while the window is unfocused did nothing
- Adding a contact by username used `@goonfleet` instead of `@goonfleet.com`
- Room messages were duplicated after every reconnect, and saved room history could be overwritten
- A wrong password is no longer retried endlessly; reconnects back off up to 5 minutes
- DM history loaded the oldest messages and showed your own archived messages as the other person's
- DMs to room participants went to an invalid address; they are now sent as room private messages
- Emoticons such as `>:-(` or `:dadjoke:` were split into other emoticons
- "Join by name…" in Browse Rooms, for when room discovery fails

### Changed
- Notifications only for DMs, Directorbot and mentions of your nick; not for history, your own messages or Do Not Disturb. Clicking a notification opens the chat
- Busy rooms render much faster; chat history is saved less often (200 messages per room, 500 per DM)
- Removed the unused EVE Online features and data (~9.5 MB smaller installer)

## [1.0.6] - 2026-04-20

### Added
- **Notification Enhancements**:
  - Separate audio alert for direct messages (configurable in settings)
  - Do Not Disturb mode suppresses notification sounds when presence is set to "Do Not Disturb"
  - Color-coded message indicators (Blue = DMs, Green = Room Messages, Orange = System Messages)
  - Connection feedback with visual status bar showing connection errors and one-click reconnect button
- **Keyboard Shortcuts** for quick navigation:
  - `Ctrl+N` - New chat
  - `Ctrl+F` - Search
  - `Ctrl+K` - Account switcher
  - `Ctrl+,` - Settings
  - `Ctrl+1-9` - Quick account switch
- **Emoticon Favorites**:
  - Star button on each emoticon (appears on hover)
  - Gold color (#FFD700) highlighting for favorited emoticons
  - Favorited emoticons appear at top of picker
  - Recent emoticons tracked automatically
- **Context Menus for User Interactions**:
  - Right-click on participant name to Send DM or Add to Contacts
  - Right-click on message sender name to Send DM or Add to Contacts
  - Right-click on message bubble to Quote or Copy
  - Real JID extraction from non-anonymous rooms for accurate contact management
- **Contact Management Improvements**:
  - Quick Add Contact input at bottom of contacts panel
  - Automatically appends `@goonfleet` to usernames
  - Press Enter to send subscription request
  - Direct contact addition without modal navigation

### Improved
- **UI/UX Enhancements**:
  - Themed focus state on input fields (accent color on focus)
  - Better visual distinction between UI elements
  - Smoother transitions and hover states
  - Context menus appear near cursor for intuitive interaction
- **Auto-Away Feature**: Automatically sets status to "Away" after 10 minutes of inactivity
- **MUC JID Handling**: Extract and store participant JIDs from presence stanzas for improved contact tracking in multi-user chat rooms

## [1.0.5] - 2026-04-18

### Added
- **Contact Grouping System**: Display and organize contacts by server-provided groups (from XMPP roster `<group>` elements)
- **Custom Contact Groups**: Users can now create their own contact groups and assign contacts to multiple groups
- **Room Grouping System**: Frontend-only grouping for chat rooms with persistent assignments across app restarts
- **Delete Contacts**: Users can now remove self-added contacts from their roster with one click
- **Group Sorting**: 
  - Contacts: Server-provided groups appear first, followed by user-created groups (alphabetical), then ungrouped
  - Rooms: User-created groups sorted alphabetically, then ungrouped
  - Directorbot always appears at the top
- **Presence Status for New Contacts**: When adding a participant from a room to contacts, their current online status is captured and displayed immediately
- **Persistent Group State**: All group assignments are saved to localStorage and restored on app restart
- **Collapsible Groups**: Group headers can be collapsed/expanded with state persistence

### Improved
- Contact list now merges server roster with locally saved contacts, preventing loss of user-added contacts on reconnection
- Presence updates are properly reflected for all contacts including newly added ones
- Better visibility of contact online/offline status with status indicators on avatars

### Fixed
- Added contacts now persist through app restarts
- Ungrouped server contacts no longer disappear when app reconnects
- Room group assignments persist correctly across app restarts
- Presence updates now display correctly for newly added contacts

## [1.0.4] - Previous Release
- Previous version features and improvements
