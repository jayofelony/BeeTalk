# Code Review: BeeTalk

## Critical Issues

### 1. Potential XSS in Modal HTML Construction (app.js)
**Severity:** Medium  
**Location:** `src/app.js` - `showModal()` function and usage  
**Issue:** While most modals use `esc()` for HTML escaping, `showModal()` accepts raw HTML. If future modals are created without proper escaping, XSS is possible.

```javascript
// Line 117 - accepts raw HTML
function showModal(html) { 
  modalContent.innerHTML = html;  // Direct innerHTML assignment
  modalOverlay.classList.remove('hidden'); 
}
```

**Fix:** Either create a helper that only accepts escaped strings, or audit all `showModal()` calls to ensure `esc()` is applied.

---

### 2. Unvalidated IPC Parameters (main.js)
**Severity:** Medium  
**Location:** `src/main.js` - IPC handlers (lines 336-389)  
**Issue:** IPC handlers accept arbitrary data without validation. While XMPP library handles most cases, malformed input could cause errors or unexpected behavior.

```javascript
// Line 344 - no validation of 'to', 'body', 'type'
ipcMain.on('xmpp-send-message', (e, { accountId, to, body, type }) => {
  const c = connections[accountId];
  if (!c) return;
  c._xmpp.send(xml('message', { to, type: type || 'chat' }, xml('body', {}, body))).catch(() => {});
});
```

**Fix:** Add validation:
```javascript
// Check that 'to' is a valid JID format
// Check that 'body' is a string and not empty
// Check that 'type' is one of: 'chat', 'groupchat', 'headline', 'normal'
```

---

### 3. Race Condition in Message Archive Management (main.js, lines 559-667)
**Severity:** Low  
**Location:** `src/main.js` - `load-message-history` handler  
**Issue:** The stanza listener cleanup logic is fragile. The `resetTimeout()` function is called but the interval loop checking `complete` flag might resolve before cleanup happens.

```javascript
// Multiple ways the promise can resolve; cleanup timing unclear
const cleanupTimer = setInterval(() => {
  if (complete) {
    clearInterval(cleanupTimer);
    xmpp.off('stanza', listener);
    resolve(messages.reverse());
  }
}, 100);

setTimeout(() => {
  clearInterval(cleanupTimer);  // Forced cleanup after 6s
  xmpp.off('stanza', listener);
  resolve(messages.reverse());
}, 6000);
```

**Fix:** Use a single cleanup path with a flag to prevent duplicate resolves.

---

### 4. Silent Error Swallowing (main.js, line 45)
**Severity:** Low  
**Location:** `src/main.js` - `getPassword()` function  
**Issue:** Errors during old keytar cleanup are silently ignored without logging.

```javascript
try { await keytar.deletePassword(OLD_KEYTAR_SERVICE, accountId); } catch {}  // Line 45
```

**Fix:** Log the error:
```javascript
try { 
  await keytar.deletePassword(OLD_KEYTAR_SERVICE, accountId); 
} catch (err) { 
  console.warn(`Failed to clean up old keytar entry for ${accountId}:`, err);
}
```

---

### 5. Inefficient Event Listener Management (main.js, lines 673-731)
**Severity:** Low  
**Location:** `src/main.js` - `discoverRoomsOnServer()` function  
**Issue:** Using `xmpp.on()` adds a persistent listener that receives *all* stanzas. Should use `xmpp.once()` or manually remove after first match.

```javascript
// Line 724 - listener added but depends on manual removal
xmpp.on('stanza', listener);
```

**Fix:** Use `xmpp.once()` or explicitly remove:
```javascript
xmpp.once('stanza', listener);
// OR
const listener = (stanza) => { /* ... cleanup and remove */ };
xmpp.on('stanza', listener);
// Then: xmpp.removeListener('stanza', listener);
```

---

### 6. JID Format Validation Missing (multiple locations)
**Severity:** Low  
**Location:** `src/main.js` - `xmpp-send-message`, `xmpp-join-room`, `xmpp-add-contact`, etc.  
**Issue:** No validation that JIDs are properly formed (should match `user@domain` or `room@domain/resource`).

```javascript
// Line 392 - no validation that roomJid is valid
ipcMain.on('xmpp-join-room', (e, { accountId, roomJid, nick }) => {
  // ... directly used in stanza
```

**Fix:** Add simple JID validator:
```javascript
function isValidJid(jid) {
  return typeof jid === 'string' && /^[^\s@]+@[^\s@]+(?:\/[^\s]+)?$/.test(jid);
}
```

---

## Code Quality Issues

### 7. Hardcoded MUC Servers (main.js, lines 744-747)
**Location:** `src/main.js` - `discover-rooms` handler  
**Issue:** MUC servers are hardcoded for GSF Jabber, reducing flexibility for other XMPP servers.

```javascript
const mucServers = [
  'conference.goonfleet.com',
  'muc.goonfleet.com',
  'rooms.goonfleet.com'
];
```

**Suggestion:** Make this configurable per account or derive it from the server domain.

---

### 8. Promise Resolution Returned but Not Awaited (main.js, line 337)
**Location:** `src/main.js` - `xmpp-connect` handler  
**Issue:** `connectXmpp()` is async but the caller doesn't await it consistently.

```javascript
ipcMain.on('xmpp-connect', (e, account) => {
  connectXmpp(account).catch(err => {  // Catch exists but if connectXmpp is long-running...
    // ...
  });
});
```

This is acceptable for event handlers, but worth noting.

---

### 9. Missing Error Context in Update Check (main.js, lines 784-892)
**Location:** `src/main.js` - `performUpdateCheck()` function  
**Issue:** Extensive console logging of GitHub API responses could leak information in production builds. Should be conditional on debug mode.

```javascript
// Line 811 - logs raw API response
console.log('Raw response data:', data.slice(0, 200));
```

**Suggestion:** Gate debug logging behind a debug flag or environment variable.

---

## Summary

| Issue | Severity | Type |
|-------|----------|------|
| XSS in Modal HTML | Medium | Security |
| Unvalidated IPC Parameters | Medium | Security |
| MAM Race Condition | Low | Reliability |
| Silent Error Swallowing | Low | Debugging |
| Inefficient Listener Management | Low | Performance |
| Missing JID Validation | Low | Robustness |
| Hardcoded MUC Servers | Low | Flexibility |
| Extensive Debug Logging | Low | Privacy |

## Recommendations

1. **High Priority:** Add input validation to all IPC handlers, especially XMPP-related ones
2. **High Priority:** Audit all `showModal()` calls to ensure proper HTML escaping
3. **Medium Priority:** Improve event listener cleanup patterns
4. **Medium Priority:** Implement JID format validation utility
5. **Low Priority:** Make MUC server discovery more flexible
6. **Low Priority:** Reduce debug logging in production builds
