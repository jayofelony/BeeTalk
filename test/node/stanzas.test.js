'use strict';
// src/lib/stanzas.js: message carbons (XEP-0280) and chat states (XEP-0085).
const test = require('node:test');
const assert = require('node:assert');
const { xml } = require('@xmpp/client');
const { unwrapCarbon, chatState } = require('../../src/lib/stanzas');

const ME = 'me@goonfleet.com';
const carbon = (direction, outerFrom, inner) =>
  xml('message', { from: outerFrom, to: `${ME}/beetalk` },
    xml(direction, { xmlns: 'urn:xmpp:carbons:2' },
      xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, inner)));
const inner = (from, to, body) => xml('message', { from, to, type: 'chat' }, xml('body', {}, body));

test('normal message is not a carbon', () => {
  assert.strictEqual(unwrapCarbon(inner('carol@goonfleet.com/r', ME, 'hi'), ME), undefined);
});

test('"sent" carbon from our own account: a message we sent from another device', () => {
  const c = unwrapCarbon(carbon('sent', ME, inner(`${ME}/phone`, 'carol@goonfleet.com', 'from my phone')), ME);
  assert.strictEqual(c.direction, 'sent');
  assert.strictEqual(c.message.attrs.to, 'carol@goonfleet.com');
  assert.strictEqual(c.message.getChildText('body'), 'from my phone');
});

test('"received" carbon: a message delivered to another of our devices', () => {
  const c = unwrapCarbon(carbon('received', ME, inner('carol@goonfleet.com/r', `${ME}/phone`, 'hey')), ME);
  assert.strictEqual(c.direction, 'received');
  assert.strictEqual(c.message.attrs.from, 'carol@goonfleet.com/r');
});

test('forged carbon from someone else is ignored', () => {
  assert.strictEqual(unwrapCarbon(carbon('sent', 'mallory@goonfleet.com', inner(`${ME}/phone`, 'carol@goonfleet.com', 'fake')), ME), null);
  assert.strictEqual(unwrapCarbon(carbon('sent', `${ME}/other`, inner(`${ME}/phone`, 'carol@goonfleet.com', 'x')), ME), null, 'full JID is not the account');
});

test('carbon without a forwarded message is ignored', () => {
  const empty = xml('message', { from: ME }, xml('sent', { xmlns: 'urn:xmpp:carbons:2' }));
  assert.strictEqual(unwrapCarbon(empty, ME), null);
});

test('chatState', () => {
  const withState = state => xml('message', { type: 'chat' }, xml(state, { xmlns: 'http://jabber.org/protocol/chatstates' }));
  assert.strictEqual(chatState(withState('composing')), 'composing');
  assert.strictEqual(chatState(withState('paused')), 'paused');
  assert.strictEqual(chatState(xml('message', {}, xml('composing', { xmlns: 'wrong:ns' }))), null);
  assert.strictEqual(chatState(xml('message', {}, xml('body', {}, 'x'))), null);
});
