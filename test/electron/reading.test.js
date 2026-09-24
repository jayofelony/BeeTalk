'use strict';
// Mention highlighting and the "New messages" divider.
const { ACCOUNT, ROOM, onlineInRoom } = require('./fixtures');

module.exports = async t => {
  const page = await t.open({ accounts: [ACCOUNT] });
  await onlineInRoom(page);   // our nick in the room is "Tester"
  const send = (nick, body, i) => page.send('xmpp-message', { accountId: 'acct_1', from: `${ROOM}/${nick}`, body, type: 'groupchat', ts: Date.now() + i });

  send('alice', 'hey Tester, x up', 0);
  send('bob', 'testers wanted', 1);        // substring, not a mention
  send('Tester', 'I am Tester', 2);        // our own message
  await t.wait(200);
  const marked = await page.js("[...document.querySelectorAll('#messages-area .msg-bubble')].map(b => b.classList.contains('mention'))");
  t.equal(marked, [true, false, false], 'only whole-word mentions by others are highlighted');

  // Messages seen live in the open, focused chat count as read
  await page.js(`openChat(chatKey('acct_1', '${ROOM}')); 0`);
  t.ok(!(await page.js("!!document.querySelector('.new-divider')")), 'no divider when everything was seen');

  // Leave the room chat, new messages arrive, come back
  page.send('xmpp-message', { accountId: 'acct_1', from: 'carol@goonfleet.com/r', body: 'dm', type: 'chat', ts: Date.now() + 3 });
  await t.wait(50);
  await page.js("openChat('acct_1::carol@goonfleet.com'); 0");
  send('alice', 'unread one', 10);
  send('bob', 'unread two', 11);
  await t.wait(100);
  await page.js(`openChat(chatKey('acct_1', '${ROOM}')); 0`);
  await t.wait(200);
  const order = await page.js(`[...document.querySelectorAll('#messages-area .new-divider, #messages-area .msg-bubble')]
    .map(el => el.classList.contains('new-divider') ? '--new--' : el.textContent)`);
  t.equal(order.slice(-3), ['--new--', 'unread one', 'unread two'], '"New messages" line before the first unread message');
  t.equal(await page.js("document.querySelectorAll('.new-divider').length"), 1, 'exactly one divider');

  // Reopening after reading: no divider
  await page.js("openChat('acct_1::carol@goonfleet.com'); 0");
  await page.js(`openChat(chatKey('acct_1', '${ROOM}')); 0`);
  t.ok(!(await page.js("!!document.querySelector('.new-divider')")), 'divider gone once read');

  // While the window is unfocused, messages in the open chat stay unread
  page.send('app-blur');
  await t.wait(50);
  send('alice', 'while away', 20);
  await t.wait(100);
  page.send('app-focus');
  await t.wait(50);
  t.ok(await page.js(`state.chats[chatKey('acct_1', '${ROOM}')].lastReadTs >= state.chats[chatKey('acct_1', '${ROOM}')].messages.at(-1).ts`),
    'focusing the window marks the open chat read');
  t.equal(page.consoleErrors, [], 'no errors in the page console');
  page.close();
};
