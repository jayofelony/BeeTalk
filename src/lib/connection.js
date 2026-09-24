'use strict';
// Connection lifecycle on top of @xmpp/client, kept free of Electron so it can be unit-tested.
//
// - Reports "online" and "offline" once each (not on every failed reconnect attempt)
// - The library reconnects by itself after a disconnect; we only back off its delay
// - After an authentication failure, callers should stop (a wrong password retried
//   endlessly could lock the account)
// - Stream management (XEP-0198): after a short drop the library may *resume* the
//   session. It then marks itself online without emitting 'online' (still true in
//   @xmpp/client 0.14), so we listen for streamManagement's 'resumed' event.
// - Keepalive: a ping that isn't answered in time means the connection is dead (e.g.
//   after sleep); destroying the socket lets the library reconnect and resume. 0.14 has
//   its own ack-based liveness check, but only while stream management is enabled, and
//   it ends the socket gracefully instead of destroying it.

const { xml } = require('@xmpp/client');
const { isStreamError } = require('./xmpp-helpers');

// Close a dead connection right away. xmpp.disconnect() only ends the socket and waits
// for it to close, which on a dead connection may never happen. After STARTTLS the
// socket is a wrapper; the real TLS socket is its .socket. The resulting 'close' makes
// the library emit 'disconnect' and reconnect.
function dropSocket(xmpp) {
  const s = xmpp.socket;
  const raw = typeof s?.destroy === 'function' ? s : s?.socket;
  if (typeof raw?.destroy === 'function') raw.destroy();
  else xmpp.disconnect().catch(() => {});
}

function watchConnection(xmpp, {
  onOnline,            // ({ resumed }) => void
  onOffline,           // () => void, once per outage
  onError,             // (message) => void, once per outage
  onAuthFail,          // (message) => void
  onKeepaliveFailed = () => {},  // () => void, before a dead connection is dropped
  isCurrent = () => true,
  minDelay = 2000,
  maxDelay = 5 * 60 * 1000,
  pingInterval = 30 * 1000,
  pingTimeout = 10 * 1000
}) {
  let down = false;
  let stopped = false;   // after an authentication failure or stop()
  let pingTimer = null;
  xmpp.reconnect.delay = minDelay;

  // Ping the server; resolves true if it answered (an error reply counts), false if
  // nothing came back in time. The timeout covers sending too: on a dead connection
  // the write itself may never complete, and the library only starts its own
  // timeout after the write.
  async function isAlive(timeout) {
    let timer;
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeout); });
    const ping = xmpp.iqCaller.request(
      xml('iq', { type: 'get', to: xmpp.options?.domain }, xml('ping', { xmlns: 'urn:xmpp:ping' })),
      timeout
    ).then(() => 'ok', err => (err.name === 'TimeoutError' ? 'timeout' : 'ok'));
    const result = await Promise.race([ping, expired]);
    clearTimeout(timer);
    return result === 'ok';
  }

  async function keepalive(timeout = pingTimeout) {
    if (xmpp.status !== 'online' || stopped) return;
    if (!(await isAlive(timeout)) && isCurrent() && xmpp.status === 'online') {
      onKeepaliveFailed();
      dropSocket(xmpp);
    }
  }

  function stopPing() {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  function startPing() {
    stopPing();
    pingTimer = setInterval(() => keepalive(), pingInterval);
  }

  function online(resumed) {
    if (!isCurrent() || stopped) return;
    down = false;
    xmpp.reconnect.delay = minDelay;
    startPing();
    onOnline({ resumed });
  }

  xmpp.on('online', () => online(false));
  // 'resumed' fires just before the library sets status 'online'; report once it has
  xmpp.streamManagement?.on('resumed', () => setImmediate(() => { if (xmpp.status === 'online') online(true); }));

  xmpp.on('disconnect', () => {
    if (!isCurrent()) return;
    stopPing();
    if (!down) onOffline();
    down = true;
    // The library has already scheduled this attempt; back off for the next one
    xmpp.reconnect.delay = Math.min(xmpp.reconnect.delay * 2, maxDelay);
  });

  // The library both emits 'error' and rejects start() with the same error object
  let lastError = null;
  function handleError(err) {
    if (!isCurrent() || isStreamError(err) || err === lastError) return;
    lastError = err;
    const message = err.message || String(err);
    const isAuth = err.name === 'SASLError' || /not-authorized|credentials/i.test(message);
    if (isAuth) {
      down = true;
      stopped = true;
      stopPing();
      onAuthFail(message);
      return;
    }
    if (down) return;  // still retrying; already reported
    down = true;
    onError(message);
  }
  xmpp.on('error', handleError);

  return {
    handleError,
    stop() { stopped = true; stopPing(); },
    // The OS reports no network: the connection can't work, drop it now instead of
    // waiting for the keepalive (the server keeps the session for a quick resume)
    networkLost() {
      if (stopped || !isCurrent()) return;
      if (['online', 'connecting', 'connect', 'opening', 'open'].includes(xmpp.status)) dropSocket(xmpp);
    },
    // Network is back or the computer woke up: reconnect now instead of waiting for
    // the backoff timer, or check that a connection that looks online still works
    networkBack() {
      if (stopped || !isCurrent()) return;
      if (xmpp.status === 'disconnect') {
        xmpp.reconnect.delay = 500;
        xmpp.reconnect.scheduleReconnect();
      } else if (xmpp.status === 'online') {
        keepalive(5000);
      }
    }
  };
}

module.exports = { watchConnection, dropSocket };
