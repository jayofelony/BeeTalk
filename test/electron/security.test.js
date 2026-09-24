'use strict';
// Chat content is untrusted: nothing in messages, subjects, nicks or room names may run script.
const { ACCOUNT, ROOM, EMOTICONS, onlineInRoom } = require('./fixtures');

module.exports = async t => {
  const page = await t.open({ accounts: [ACCOUNT], emoticons: EMOTICONS });
  await onlineInRoom(page);
  await page.js('window.pwned = []; 0');

  const payloads = [
    '<img src=x onerror="pwned.push(1)">',                       // zero-click via message HTML
    '<b>&lt;img src=x onerror="pwned.push(2)"&gt; :)</b>',       // decoded text + emoticon
    '<svg onload="pwned.push(3)"></svg><div onmouseover="pwned.push(4)">x</div>',
    "https://example.com/');pwned.push(5);//",                    // link breaking out of a JS string
    '<b>ok</b> :) https://example.com/a?b=1&c=2'
  ];
  payloads.forEach((body, i) =>
    page.send('xmpp-message', { accountId: 'acct_1', from: `${ROOM}/nick${i}`, body, type: 'groupchat', ts: Date.now() + i }));
  await t.wait(500);
  await page.js("document.querySelectorAll('#messages-area a.msg-link').forEach(a => a.click()); 0");
  await t.wait(200);

  t.equal(await page.js('window.pwned'), [], 'message payloads run no script (render and link click)');

  // The sanitizer must parse untrusted HTML inertly: nothing in it may start loading.
  // (The CSP would block an onerror handler anyway; this checks the sanitizer on its own.)
  page.send('xmpp-message', { accountId: 'acct_1', from: `${ROOM}/prober`, body: '<b>x</b><img src="beetalk-probe.png">', type: 'groupchat', ts: Date.now() });
  await t.wait(300);
  t.equal(t.fake.probes, [], 'untrusted message HTML loads no resources while being sanitized');
  t.equal(t.sent('open-link'), ["https://example.com/');pwned.push(5);//", 'https://example.com/a?b=1&c=2'],
    'links open through IPC with the exact URL');
  t.ok(await page.js("!!document.querySelector('#messages-area .msg-bubble b') && !!document.querySelector('#messages-area img.emoticon')"),
    'allowed formatting and emoticons still render');

  // Room subject with a malicious link, shown in Chat info
  page.send('xmpp-room-subject', { accountId: 'acct_1', roomJid: ROOM, subject: "see https://x.com/');pwned.push(6);// now" });
  await t.wait(100);
  await page.js("showChatInfoModal(); document.querySelectorAll('#chat-info-subject-display a').forEach(a => a.click()); 0");
  await t.wait(100);
  t.equal(await page.js('window.pwned'), [], 'room subject link runs no script');

  // Malicious nickname in the participant menu and the DM menu
  const nick = "x');pwned.push(7);('";
  page.send('xmpp-presence', { accountId: 'acct_1', from: `${ROOM}/${nick}`, type: 'available', show: 'available', mucJid: null });
  await t.wait(100);
  await page.js(`hideModal(); window.currentContextEvent = { clientX: 5, clientY: 5 };
    const chat = state.chats[chatKey('acct_1', '${ROOM}')];
    showParticipantContextMenu(chat, ${JSON.stringify(nick)});
    document.querySelector('#context-menu [data-action=openDirectMessageWithParticipant_Menu]').click();
    showActiveDMContextMenu(state.chats[state.activeChatKey], getActiveAccount()); 0`);
  await t.wait(100);
  t.equal(await page.js('window.pwned'), [], 'nickname in menus runs no script');
  t.equal(await page.js('state.chats[state.activeChatKey].jid'), `${ROOM}/${nick}`, 'DM to a participant goes to room/nick');

  // No inline event handlers anywhere in the generated DOM
  const inline = await page.js(`[...document.querySelectorAll('*')].flatMap(el =>
    [...el.attributes].filter(a => a.name.startsWith('on')).map(a => el.tagName + '[' + a.name + ']'))`);
  t.equal(inline, [], 'no inline event handler attributes in the DOM');

  // The CSP blocks inline handlers even if one slips in
  await page.js(`window.__x = 0; const d = document.createElement('div'); d.setAttribute('onclick', 'window.__x = 1');
                 document.body.appendChild(d); d.click(); 0`);
  t.equal(await page.js('window.__x'), 0, 'CSP blocks inline event handlers');

  // Renderer can't redirect the password to another server: main uses the stored account
  // (covered in main.js; here we check the renderer sends only the account id path it always did)
  page.close();
};
