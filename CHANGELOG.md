# Changelog

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
