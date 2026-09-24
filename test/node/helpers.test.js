'use strict';
// Unit tests for src/lib/xmpp-helpers.js. Run with: npm run test:node
const test = require('node:test');
const assert = require('node:assert');
const { xml, jid } = require('@xmpp/client');
const { isValidJid, isValidMessageType, compareVersions, checkMamSupport } = require('../../src/lib/xmpp-helpers');

test('isValidJid', () => {
  for (const ok of ['user@goonfleet.com', 'room@conference.goonfleet.com/Some Pilot', 'a@b/c']) {
    assert.ok(isValidJid(ok), ok);
  }
  for (const bad of ['', 'goonfleet.com', 'user@', '@goonfleet.com', 'a b@c', 'a@b c', 'a@b/', 'a@b/ x', null, 42]) {
    assert.ok(!isValidJid(bad), String(bad));
  }
});

test('isValidMessageType', () => {
  assert.ok(isValidMessageType('chat'));
  assert.ok(isValidMessageType('groupchat'));
  assert.ok(!isValidMessageType('script'));
});

test('compareVersions', () => {
  assert.strictEqual(compareVersions('1.0.9', '1.0.11'), 1);   // numeric, not lexicographic
  assert.strictEqual(compareVersions('1.0.14', '1.0.14'), 0);
  assert.strictEqual(compareVersions('1.1.0', '1.0.99'), -1);
  assert.strictEqual(compareVersions('1.0', '1.0.1'), 1);
});

function fakeXmpp(respond) {
  return {
    jid: jid('me@goonfleet.com/res'),
    iqCaller: { request: async (iq) => respond(iq) }
  };
}
const discoResult = (...features) =>
  xml('iq', { type: 'result' },
    xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' }, ...features.map(v => xml('feature', { var: v }))));

test('checkMamSupport: asks the account (bare JID) and detects urn:xmpp:mam:2', async () => {
  let askedTo;
  const xmpp = fakeXmpp(iq => { askedTo = iq.attrs.to; return discoResult('jabber:iq:roster', 'urn:xmpp:mam:2'); });
  assert.strictEqual(await checkMamSupport(xmpp), true);
  assert.strictEqual(askedTo, 'me@goonfleet.com');
});

test('checkMamSupport: false without the feature (goonfleet.com today)', async () => {
  assert.strictEqual(await checkMamSupport(fakeXmpp(() => discoResult('jabber:iq:roster', 'vcard-temp'))), false);
});

test('checkMamSupport: false when the server refuses the query', async () => {
  const xmpp = fakeXmpp(() => { const e = new Error('service-unavailable'); e.condition = 'service-unavailable'; throw e; });
  assert.strictEqual(await checkMamSupport(xmpp), false);
});
