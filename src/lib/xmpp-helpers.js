'use strict';
// Main-process helpers without Electron dependencies, so they can be unit-tested with `node --test`.

const tls = require('tls');
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

function isEncrypted(xmpp) {
  const s = xmpp.socket;
  return s instanceof tls.TLSSocket || s?.socket instanceof tls.TLSSocket;
}

// SASL credentials callback for @xmpp/client that only sends the password once
// STARTTLS succeeded, so a network attacker stripping STARTTLS can't read it.
// getXmpp: returns the client (it doesn't exist yet when the options are built).
function tlsOnlyCredentials(getXmpp, creds, onRefused) {
  return async (authenticate) => {
    if (!isEncrypted(getXmpp())) {
      if (onRefused) onRefused();
      throw new Error('TLS required');
    }
    return authenticate(creds);
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
