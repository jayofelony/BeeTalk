'use strict';
// Local message history (IndexedDB): migration, restart, load older, search, pruning, deletion.
const { ACCOUNT, ROOM, onlineInRoom } = require('./fixtures');

const DM = 'acct_1::carol@goonfleet.com';
const RKEY = `acct_1::${ROOM}`;
const openDM = page => page.js(`ensureChat('${DM}', { type: 'dm', name: 'carol', jid: 'carol@goonfleet.com', accountId: 'acct_1' }); openChat('${DM}'); 0`);
const count = (page, key) => page.js(`idbRequest(history.db.transaction('messages').objectStore('messages').index('chat_ts').count(chatRange('${key}')))`);

module.exports = async t => {
  const page = await t.open({ accounts: [ACCOUNT] });

  // History saved by 1.0.14 and older (localStorage) is migrated at startup
  await page.js(`{ const t0 = Date.now() - 86400000;
    localStorage.setItem('chat_messages_${DM}', JSON.stringify(Array.from({ length: 500 }, (_, i) =>
      ({ from: i % 2 ? 'tester' : 'carol', text: 'dm ' + i, ts: t0 + i * 1000, me: !!(i % 2) }))));
    localStorage.setItem('chat_messages_${RKEY}', JSON.stringify([{ from: 'bob', text: 'room old', ts: t0, me: false }, { system: true, text: 'sys', ts: t0 + 1 }])); } 0`);
  await page.reload();
  t.equal(await page.js("Object.keys(localStorage).filter(k => k.startsWith('chat_messages_'))"), [], 'localStorage history migrated and removed');

  await openDM(page);
  let msgs = await page.js(`state.chats['${DM}'].messages.map(m => m.text)`);
  t.ok(msgs.length === 300 && msgs[0] === 'dm 200' && msgs[299] === 'dm 499', 'opening a chat shows the newest 300 in order', [msgs.length, msgs[0], msgs[msgs.length - 1]]);
  t.ok(await page.js("!!document.querySelector('.load-older-btn')"), '"Load older messages" is offered');
  await page.js("document.querySelector('.load-older-btn').click(); 0");
  await page.waitFor(`state.chats['${DM}'].messages.length === 500`);
  msgs = await page.js(`state.chats['${DM}'].messages.map(m => m.text)`);
  t.ok(msgs.length === 500 && msgs[0] === 'dm 0' && msgs[499] === 'dm 499', 'load older adds the rest in order');
  t.ok(await page.waitFor("!document.querySelector('.load-older-btn')"), 'button disappears when nothing older is left');

  // Messages are stored as they arrive and survive a restart immediately after
  await onlineInRoom(page);
  page.send('xmpp-message', { accountId: 'acct_1', from: `${ROOM}/alice`, body: 'live room msg', type: 'groupchat', ts: Date.now() });
  page.send('xmpp-message', { accountId: 'acct_1', from: 'carol@goonfleet.com/r', body: '<img src=x onerror="window.pwned=1"> needle', type: 'chat', ts: Date.now() });
  await t.wait(100);
  await page.reload();
  await page.js(`ensureChat('${RKEY}', { type: 'room', name: 'ops', jid: '${ROOM}', accountId: 'acct_1' }); 0`);
  t.equal(await page.js(`state.chats['${RKEY}'].messages.map(m => m.text)`), ['room old', 'live room msg'], 'history survives a restart; system lines are not stored');

  // Search covers the whole stored history and renders results as text
  await openDM(page);
  await page.js("showChatSearchModal(); { const i = document.getElementById('chat-search-input'); i.value = 'dm 3'; i.dispatchEvent(new Event('input')); } 0");
  await page.waitFor("document.querySelectorAll('.chat-search-row').length > 0");
  t.equal(await page.js("document.querySelectorAll('.chat-search-row').length"), 111, 'search finds messages outside the loaded window (dm 3, 30-39, 300-399)');
  await page.js("{ const i = document.getElementById('chat-search-input'); i.value = 'needle'; i.dispatchEvent(new Event('input')); } 0");
  await page.waitFor("document.querySelectorAll('.chat-search-row').length === 1");
  t.ok(await page.js("!window.pwned && document.querySelector('.chat-search-row')?.textContent.includes('<img')"), 'search results are shown as text, no script');

  // Rooms are pruned to the newest 5000 at startup
  await page.js(`(async () => {
    const tx = history.db.transaction('messages', 'readwrite'); const st = tx.objectStore('messages');
    for (let i = 0; i < 5100; i++) st.add({ chat: 'acct_1::big@conference.goonfleet.com', ts: 1e12 + i, from: 'x', text: 'm' + i, me: false, room: true });
    await idbDone(tx); })()`);
  await page.reload();
  t.equal(await count(page, 'acct_1::big@conference.goonfleet.com'), 5000, 'room history pruned to 5000');

  // Deleting a DM deletes its history
  await page.js(`ensureChat('${DM}', { type: 'dm', name: 'carol', jid: 'carol@goonfleet.com', accountId: 'acct_1' });
                 submitDeleteActiveDM('acct_1', 'carol@goonfleet.com', 'carol'); 0`);
  await t.wait(300);
  t.equal(await count(page, DM), 0, 'deleting a DM deletes its stored history');
  t.equal(page.consoleErrors, [], 'no errors in the page console');
  page.close();
};
