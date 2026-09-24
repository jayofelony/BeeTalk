'use strict';
// Reconnects (new vs. resumed session), message carbons and typing notifications.
const { ACCOUNT, ROOM } = require('./fixtures');

const CAROL = 'acct_1::carol@goonfleet.com';

module.exports = async t => {
  const page = await t.open({ accounts: [ACCOUNT] });
  await page.js(`localStorage.setItem('rooms_acct_1', JSON.stringify([{ jid: '${ROOM}', nick: 'Tester', groups: [] }])); 0`);
  const status = (s, extra = {}) => page.send('xmpp-status', { id: 'acct_1', status: s, jid: 'tester@goonfleet.com/test', ...extra });
  const sysMsgs = () => page.js(`state.chats[chatKey('acct_1', '${ROOM}')].messages.filter(m => m.system).map(m => m.text)`);

  // New session: rooms are joined
  status('online');
  await t.wait(100);
  t.equal(t.sent('xmpp-join-room').map(j => j.roomJid), [ROOM], 'new session joins saved rooms');

  // Short drop, session resumed by the server: no rejoin, back online, can send
  t.fake.sent.length = 0;
  status('offline');
  await t.wait(50);
  status('online', { resumed: true });
  await t.wait(100);
  t.equal(t.sent('xmpp-join-room'), [], 'resumed session does not rejoin rooms');
  t.equal(await page.js('getActiveAccount().status'), 'online', 'resumed session shows online');
  t.equal((await sysMsgs()).slice(-2), ['⚠ Disconnected — reconnecting…', '✓ Reconnected (nothing missed)'], 'user sees the drop and the resume');
  await page.js(`openChat(chatKey('acct_1', '${ROOM}')); document.getElementById('msg-input').value = 'still here'; sendMessage(); 0`);
  t.equal(t.sent('xmpp-send-message').map(m => m.body), ['still here'], 'sending works after a resume');

  // Longer outage, new session: rooms are rejoined
  t.fake.sent.length = 0;
  status('offline');
  await t.wait(50);
  status('online');
  await t.wait(100);
  t.equal(t.sent('xmpp-join-room').map(j => j.roomJid), [ROOM], 'new session after an outage rejoins rooms');

  // Carbons: a DM we sent from another device shows as ours, without notifying
  page.send('app-blur');
  page.send('xmpp-message', { accountId: 'acct_1', from: 'carol@goonfleet.com', body: 'sent from my phone', type: 'chat', ts: Date.now(), outgoing: true });
  page.send('xmpp-message', { accountId: 'acct_1', from: 'carol@goonfleet.com/pc', body: 'reply', type: 'chat', ts: Date.now() + 1 });
  await t.wait(100);
  t.equal(await page.js(`state.chats['${CAROL}'].messages.map(m => (m.me ? 'me' : m.from) + ':' + m.text)`),
    ['me:sent from my phone', 'carol:reply'], 'sent carbon appears as our own message in the right DM');
  t.equal(t.sent('show-notification').map(n => n.body), ['reply'], 'no notification for our own carbon');
  page.send('app-focus');

  // Incoming typing
  await page.js(`openChat('${CAROL}'); 0`);
  page.send('xmpp-chat-state', { accountId: 'acct_1', from: 'carol@goonfleet.com/pc', state: 'composing' });
  await t.wait(50);
  t.equal(await page.js("document.getElementById('chat-header-sub').textContent"), 'carol is typing…', 'header shows "is typing…"');
  page.send('xmpp-message', { accountId: 'acct_1', from: 'carol@goonfleet.com/pc', body: 'done typing', type: 'chat', ts: Date.now() + 2 });
  await t.wait(50);
  t.equal(await page.js("document.getElementById('chat-header-sub').textContent"), 'carol@goonfleet.com', 'a message clears "is typing…"');
  page.send('xmpp-chat-state', { accountId: 'acct_1', from: 'dave@goonfleet.com/x', state: 'composing' });
  await t.wait(50);
  t.ok(!(await page.js("!!state.chats['acct_1::dave@goonfleet.com']")), 'typing alone does not create a chat');

  // Outgoing typing: only to peers that send chat states (carol does now)
  t.fake.sent.length = 0;
  const type = text => page.js(`{ const i = document.getElementById('msg-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); } 0`);
  await type('h'); await type('he'); await type('hel');
  t.equal(t.sent('xmpp-send-chat-state').map(s => s.state), ['composing'], 'typing sends "composing" once');
  await type('');
  t.equal(t.sent('xmpp-send-chat-state').map(s => s.state), ['composing', 'active'], 'clearing the box sends "active"');
  await type('hello');
  await t.wait(5300);
  t.equal(t.sent('xmpp-send-chat-state').map(s => s.state), ['composing', 'active', 'composing', 'paused'], '"paused" after 5 s without typing');

  // A peer that never sent chat states gets none
  page.send('xmpp-message', { accountId: 'acct_1', from: 'erin@goonfleet.com/x', body: 'hi', type: 'chat', ts: Date.now() + 3 });
  await t.wait(50);
  await page.js("openChat('acct_1::erin@goonfleet.com'); 0");
  t.fake.sent.length = 0;
  await type('typing to erin');
  t.equal(t.sent('xmpp-send-chat-state'), [], 'no chat states to peers that never sent any');
  t.equal(page.consoleErrors, [], 'no errors in the page console');
  page.close();
};
