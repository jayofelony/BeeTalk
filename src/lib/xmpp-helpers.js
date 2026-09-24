'use strict';
// Main-process helpers without Electron dependencies, so they can be unit-tested with `node --test`.

const { randomUUID } = require('crypto');
// @xmpp/client 0.14 is an ES module; Node (and Electron) can require() it
const { xml } = require('@xmpp/client');

// local@domain[/resource]. The resource may contain spaces: for room private
// messages it is the participant's nick (room@conference.goonfleet.com/Some Pilot).
function isValidJid(jid) {
  return typeof jid === 'string' && /^[^\s@/]+@[^\s@/]+(?:\/\S.*)?$/.test(jid);
}

function isValidMessageType(type) {
  const validTypes = ['chat', 'groupchat', 'headline', 'normal'];
  return validTypes.includes(type);
}

// Silently suppress errors we expect during teardown
function isStreamError(err) {
  const msg = err.message || String(err);
  return msg.includes('write after end') ||
         msg.includes('ERR_STREAM') ||
         err.name === 'TimeoutError';
}

// The server message archive (XEP-0313) is optional; goonfleet.com has none.
// Checked once per login so DM history isn't requested from a server that refuses it.
async function checkMamSupport(xmpp) {
  try {
    const res = await xmpp.iqCaller.request(
      xml('iq', { type: 'get', to: xmpp.jid.bare().toString() },
        xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' })
      ), 10000);
    return res.getChild('query').getChildren('feature').some(f => f.attrs.var === 'urn:xmpp:mam:2');
  } catch {
    return false;
  }
}

// True once the connection runs over TLS (after STARTTLS)
function isEncrypted(xmpp) {
  return xmpp?.isSecure?.() === true;
}

// SASL credentials callback for @xmpp/client that only sends the password once
// STARTTLS succeeded, so a network attacker stripping STARTTLS can't read it.
// (0.14 also refuses PLAIN on insecure connections itself; this is a second guard
// that also covers every other mechanism.)
// getXmpp: returns the client (it doesn't exist yet when the options are built).
// Called by @xmpp/client 0.14 as (authenticate, mechanisms, fast, entity); we must pick
// the mechanism: the first offered one the library supports, in its priority order
// (SCRAM-SHA-1 before PLAIN), never ANONYMOUS.
function tlsOnlyCredentials(getXmpp, creds, onRefused) {
  const userAgent = xml('user-agent', { id: randomUUID() });  // only used by SASL2 servers
  return async (authenticate, mechanisms = []) => {
    if (!isEncrypted(getXmpp())) {
      if (onRefused) onRefused();
      throw new Error('TLS required');
    }
    const mechanism = mechanisms.find(m => m !== 'ANONYMOUS');
    if (!mechanism) throw new Error('No supported login mechanism offered by the server');
    return authenticate(creds, mechanism, userAgent);
  };
}

function compareVersions(current, latest) {
  const parsePart = (v) => {
    const parts = v.split('.');
    return parts.map(p => parseInt(p, 10) || 0);
  };
  const curr = parsePart(current);
  const ltest = parsePart(latest);

  for (let i = 0; i < Math.max(curr.length, ltest.length); i++) {
    const c = curr[i] || 0;
    const l = ltest[i] || 0;
    if (l > c) return 1;  // update available
    if (l < c) return -1; // current is newer
  }
  return 0; // same version
}

module.exports = { isValidJid, isValidMessageType, isStreamError, checkMamSupport, isEncrypted, tlsOnlyCredentials, compareVersions };
