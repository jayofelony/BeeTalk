'use strict';
// Parsing of incoming message stanzas, kept free of Electron so it can be unit-tested.

const CARBONS = 'urn:xmpp:carbons:2';
const FORWARD = 'urn:xmpp:forward:0';
const CHATSTATES = 'http://jabber.org/protocol/chatstates';
const CHAT_STATES = ['active', 'composing', 'paused', 'inactive', 'gone'];

// Message carbons (XEP-0280): copies of messages sent or received by our other devices.
// Returns undefined for a normal message, null for a carbon that must be ignored, or
// { direction: 'sent' | 'received', message } with the forwarded message.
// Carbons are only trusted from our own bare JID: otherwise anyone could forge
// "messages you sent" (a known class of client vulnerability).
function unwrapCarbon(stanza, myBareJid) {
  for (const direction of ['sent', 'received']) {
    const wrapper = stanza.getChild(direction, CARBONS);
    if (!wrapper) continue;
    if (!myBareJid || stanza.attrs.from !== myBareJid) return null;
    const message = wrapper.getChild('forwarded', FORWARD)?.getChild('message');
    return message ? { direction, message } : null;
  }
  return undefined;
}

// Chat state notification (XEP-0085) in a message, or null
function chatState(stanza) {
  const el = stanza.children.find(c => typeof c === 'object' && c.attrs?.xmlns === CHATSTATES && CHAT_STATES.includes(c.name));
  return el ? el.name : null;
}

module.exports = { unwrapCarbon, chatState, CARBONS, CHATSTATES, CHAT_STATES };
