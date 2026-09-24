'use strict';
const path = require('path');

const ACCOUNT = { id: 'acct_1', username: 'tester', server: 'goonfleet.com', port: 5222, displayName: 'Tester', color: 'av-0', password: '' };
const ROOM = 'ops@conference.goonfleet.com';
const IMG = 'file://' + path.join(__dirname, '..', '..', 'assets', 'tray.png');
// Emoticon names chosen so shorter names are prefixes/substrings of longer ones
const EMOTICONS = {
  Default: [':)', ':-)', ':-))', '>:-(', ':(', ':d:', ':dadjoke:'].map(name => ({ name, file: 'x.png', path: IMG }))
};

// Bring the account online and create + open a joined room
async function onlineInRoom(page, room = ROOM) {
  page.send('xmpp-status', { id: ACCOUNT.id, status: 'online', jid: 'tester@goonfleet.com/test' });
  await page.js(`ensureChat(chatKey('acct_1', '${room}'), { type: 'room', name: '${room.split('@')[0]}', jid: '${room}', accountId: 'acct_1', myNick: 'Tester' });
                 openChat(chatKey('acct_1', '${room}')); 0`);
}

module.exports = { ACCOUNT, ROOM, EMOTICONS, onlineInRoom };
