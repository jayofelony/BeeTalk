# Changelog

## [1.0.6] - 2026-04-18

### Added
- **Automatic Delta Updates**: Implemented electron-updater with blockmap support for efficient differential updates
  - Download only changed blocks instead of full installer (~10-20% of installer size)
  - Automatic progress tracking during downloads
  - Seamless install with app restart

### Improved
- **Update UI**: Enhanced update modal with download progress bar and automatic installation flow
- **Code Quality**: Removed 7 unused functions, CSS classes, and API exports
  - Removed unused `escapeForJavaScript()` function
  - Removed unused `onXmppParticipants` listener
  - Removed unused `.section-label` CSS class
  - Removed unused `.avatar.round` CSS modifier
  - Removed unused update API exports from preload.js
- **Update Check**: Fixed settings page "Check for Updates" button to work with electron-updater

### Fixed
- Update check function now properly returns status and works with async event handlers
- Cleaned up dead code to improve maintainability

### Technical Details
- Replaced manual GitHub API calls with electron-updater
- Blockmap files are automatically generated during build (electron-builder)
- Just upload `.exe` and `.exe.blockmap` to GitHub releases for automatic delta updates

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

