'use strict';
// Room discovery, joining, and rejoining with join history.
const { ACCOUNT, ROOM } = require('./fixtures');

module.exports = async t => {
  const rooms = Array.from({ length: 927 }, (_, i) => ({ jid: `room${i}@conference.goonfleet.com`, name: i === 5 ? 'recon_coord' : `room${i}`, description: '' }));
  let page = await t.open({ accounts: [ACCOUNT], rooms });
  page.send('xmpp-status', { id: 'acct_1', status: 'online', jid: 'tester@goonfleet.com/test' });
  await page.js("document.getElementById('btn-browse-rooms').click(); 0");
  await page.waitFor("document.querySelectorAll('#rooms-container .room-item').length > 0");
  t.equal(await page.js("document.querySelectorAll('#rooms-container .room-item').length"), 927, 'Browse Rooms lists all 927 rooms');
  await page.js("{ const s = document.getElementById('rooms-search'); s.value = 'recon'; s.dispatchEvent(new Event('input')); } 0");
  const shown = await page.js("[...document.querySelectorAll('#rooms-container .room-item')].filter(e => e.style.display !== 'none').map(e => e.dataset.name)");
  t.equal(shown, ['recon_coord'], 'room search filters the list');
  await page.js("[...document.querySelectorAll('#rooms-container .room-item')].find(e => e.style.display !== 'none').querySelector('[data-action=joinSingleRoom]').click(); 0");
  t.equal(t.sent('xmpp-join-room').map(j => j.roomJid), ['room5@conference.goonfleet.com'], 'Join button joins the room');
  page.close();

  // Discovery failure: join by name
  page = await t.open({ accounts: [ACCOUNT], rooms: [] });
  page.send('xmpp-status', { id: 'acct_1', status: 'online', jid: 'tester@goonfleet.com/test' });
  await page.js("document.getElementById('btn-browse-rooms').click(); 0");
  await page.waitFor("document.getElementById('modal-error').textContent.length > 0");
  t.ok(await page.js("document.getElementById('modal-error').textContent.includes('Join by name')"), 'discovery failure points to Join by name');
  await page.js(`document.querySelector('[data-action=showJoinRoomModal]').click();
                 document.getElementById('fi-room').value = 'Some-Room';
                 document.querySelector('[data-action=submitJoinRoom]').click();
                 showJoinRoomModal(); document.getElementById('fi-room').value = 'other@conference.goonfleet.com';
                 document.querySelector('[data-action=submitJoinRoom]').click(); 0`);
  t.equal(t.sent('xmpp-join-room').map(j => j.roomJid), ['some-room@conference.goonfleet.com', 'other@conference.goonfleet.com'],
    'join by name accepts a room name or a full JID');
  page.close();

  // Rejoin after restart asks for join history since the last stored message
  page = await t.open({ accounts: [ACCOUNT] });
  const lastTs = Date.now() - 10 * 60 * 1000;
  await page.js(`localStorage.setItem('rooms_acct_1', JSON.stringify([{ jid: '${ROOM}', nick: 'Tester', groups: [] }]));
                 localStorage.setItem('chat_messages_acct_1::${ROOM}', JSON.stringify([{ from: 'bob', text: 'earlier', ts: ${lastTs}, me: false }])); 0`);
  await page.reload();   // old localStorage history is migrated at startup
  t.fake.sent.length = 0;
  page.send('xmpp-status', { id: 'acct_1', status: 'online', jid: 'tester@goonfleet.com/test' });
  await t.wait(200);
  const join = t.sent('xmpp-join-room')[0] || {};
  t.ok(join.roomJid === ROOM && Date.parse(join.since) < lastTs && Date.parse(join.since) > lastTs - 5 * 60 * 1000,
    'rejoin asks for history since the last stored message', join);
  page.close();
};
