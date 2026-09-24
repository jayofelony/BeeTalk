'use strict';
// Message routing, duplicates, notifications, presence, room private messages, busy rooms.
const { ACCOUNT, ROOM, onlineInRoom } = require('./fixtures');

module.exports = async t => {
  let page = await t.open({ accounts: [ACCOUNT] });
  await onlineInRoom(page);
  const roomMsgs = () => page.js(`state.chats[chatKey('acct_1', '${ROOM}')].messages.map(m => m.from + ':' + m.text)`);

  // Join history replays a message we already have (server clock differs); a live repeat is kept
  const now = Date.now();
  page.send('xmpp-message', { accountId: 'acct_1', from: `${ROOM}/alice`, body: 'hello all', type: 'groupchat', ts: now });
  page.send('xmpp-message', { accountId: 'acct_1', from: `${ROOM}/alice`, body: 'hello all', type: 'groupchat', ts: now - 20000, delayed: true });
  page.send('xmpp-message', { accountId: 'acct_1', from: `${ROOM}/alice`, body: 'hello all', type: 'groupchat', ts: now + 5000 });
  await t.wait(200);
  t.equal(await roomMsgs(), ['alice:hello all', 'alice:hello all'], 'replayed history duplicate dropped, live repeat kept');

  // Notifications while unfocused: mentions and live DMs only
  page.send('app-blur');
  await t.wait(50);
  for (const [from, body, type, extra] of [
    [`${ROOM}/alice`, 'no mention here', 'groupchat'],
    [`${ROOM}/alice`, 'hey tester, ping', 'groupchat'],
    [`${ROOM}/Tester`, 'my own msg tester', 'groupchat'],
    ['carol@goonfleet.com/r', 'dm!', 'chat'],
    ['carol@goonfleet.com/r', 'old dm', 'chat', { delayed: true, ts: now - 999999 }]
  ]) page.send('xmpp-message', { accountId: 'acct_1', from, body, type, ts: Date.now(), ...extra });
  await t.wait(200);
  t.equal(t.sent('show-notification').map(n => n.title), ['ops / alice', 'carol'], 'notify for nick mentions and live DMs only');

  // Tray: Do Not Disturb updates presence and silences notifications
  page.send('tray-status', 'dnd');
  await t.wait(50);
  t.ok(await page.js("getActiveAccount().presence") === 'dnd' && t.sent('xmpp-send-presence').some(p => p.show === 'dnd'), 'tray DND sets presence');
  t.fake.sent.length = 0;
  page.send('xmpp-message', { accountId: 'acct_1', from: 'carol@goonfleet.com/r', body: 'dm while dnd', type: 'chat', ts: Date.now() });
  await t.wait(100);
  t.equal(t.sent('show-notification'), [], 'no notification in Do Not Disturb');

  // Clicking a notification opens the chat
  page.send('open-chat', 'acct_1::carol@goonfleet.com');
  await t.wait(50);
  t.equal(await page.js('state.activeChatKey'), 'acct_1::carol@goonfleet.com', 'notification click opens the chat');

  // Room private messages: participant without a shared real JID
  page.send('xmpp-presence', { accountId: 'acct_1', from: `${ROOM}/Some Pilot`, type: 'available', show: 'available', mucJid: null });
  page.send('xmpp-presence', { accountId: 'acct_1', from: `${ROOM}/Known`, type: 'available', show: 'available', mucJid: 'known@goonfleet.com/res' });
  await t.wait(100);
  t.equal(await page.js(`participantJids(state.chats[chatKey('acct_1','${ROOM}')], 'Some Pilot').dmJid`), `${ROOM}/Some Pilot`, 'hidden participant: DM goes to room/nick');
  t.equal(await page.js(`participantJids(state.chats[chatKey('acct_1','${ROOM}')], 'Known').dmJid`), 'known@goonfleet.com', 'shared real JID is used when known');
  page.send('xmpp-message', { accountId: 'acct_1', from: `${ROOM}/Some Pilot`, body: 'psst', type: 'chat', ts: Date.now() });
  await t.wait(100);
  t.ok(await page.js(`!!state.chats[chatKey('acct_1','${ROOM}/Some Pilot')] && !state.chats[chatKey('acct_1','${ROOM}')].messages.some(m => m.text === 'psst')`),
    'incoming room PM gets its own chat');
  await page.js(`openChat(chatKey('acct_1','${ROOM}/Some Pilot')); document.getElementById('msg-input').value = 'hi'; sendMessage(); 0`);
  t.equal(t.sent('xmpp-send-message').map(m => m.to), [`${ROOM}/Some Pilot`], 'reply is sent to room/nick');
  page.close();

  // Server archive (when a server has one): merged, sorted, own messages marked, duplicates dropped
  const T0 = Date.now();
  page = await t.open({ accounts: [ACCOUNT], history: () => [
    { text: 'from last week', ts: T0 - 7 * 86400000, me: false },
    { text: 'my old reply', ts: T0 - 7 * 86400000 + 1000, me: true },
    { text: 'live one', ts: T0 - 30000, me: false }
  ] });
  page.send('xmpp-status', { id: 'acct_1', status: 'online', jid: 'tester@goonfleet.com/test' });
  page.send('xmpp-message', { accountId: 'acct_1', from: 'carol@goonfleet.com/r', body: 'live one', type: 'chat', ts: T0 });
  await t.wait(100);
  await page.js("openChat('acct_1::carol@goonfleet.com'); 0");
  await page.waitFor("state.chats['acct_1::carol@goonfleet.com'].messages.length === 3");
  t.equal(await page.js("state.chats['acct_1::carol@goonfleet.com'].messages.map(m => m.from + ':' + m.text)"),
    ['carol:from last week', 'tester:my old reply', 'carol:live one'], 'archived DM history merged in order without duplicates');

  // Busy room: 1000 presences + 300 messages must not rebuild the left panel per event
  // (counted, not timed: CI machines vary too much for a time limit)
  await onlineInRoom(page, 'big@conference.goonfleet.com');
  await page.js(`window.__renders = 0; { const orig = renderLeftPanel;
    window.renderLeftPanel = function (...args) { window.__renders++; return orig.apply(this, args); }; } 0`);
  const start = Date.now();
  for (let i = 0; i < 1000; i++) page.send('xmpp-presence', { accountId: 'acct_1', from: `big@conference.goonfleet.com/pilot${i}`, type: 'available', show: 'available' });
  for (let i = 0; i < 300; i++) page.send('xmpp-message', { accountId: 'acct_1', from: `big@conference.goonfleet.com/pilot${i % 50}`, body: `msg ${i}`, type: 'groupchat', ts: Date.now() + i });
  await page.waitFor("state.chats[chatKey('acct_1','big@conference.goonfleet.com')].messages.length >= 300", 10000);
  await page.js('new Promise(r => requestAnimationFrame(() => r()))');
  const ms = Date.now() - start;
  const renders = await page.js('window.__renders');
  t.ok(renders < 100, `1300 events caused ${renders} left-panel renders (limit 100; was one per event), ${ms} ms`);
  t.equal(await page.js("document.querySelectorAll('#participants-panel .part-item').length"), 1000, 'all 1000 participants listed');
  t.equal(page.consoleErrors, [], 'no errors in the page console');
  page.close();
};
