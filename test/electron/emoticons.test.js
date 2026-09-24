'use strict';
// Emoticon parsing and the picker.
const { ACCOUNT, EMOTICONS, onlineInRoom } = require('./fixtures');

module.exports = async t => {
  const page = await t.open({ accounts: [ACCOUNT], emoticons: EMOTICONS });
  const names = EMOTICONS.Default.map(e => e.name);
  const wrong = await page.js(`${JSON.stringify(names)}.filter(n => {
    const m = parseEmoticons(n).match(/^__EMOTICON_(\\d+)__$/);
    return !m || emoticonsList[+m[1]].name !== n; })`);
  t.equal(wrong, [], 'each emoticon name parses as itself (longest match first)');
  t.equal(await page.js("parseEmoticons('a :-)) b').replace(/__EMOTICON_(\\d+)__/g, (_, i) => '[' + emoticonsList[i].name + ']')"),
    'a [:-))] b', 'longer emoticon wins over its prefix');

  await onlineInRoom(page);
  await page.js("showEmoticonPicker(); document.querySelector('#emoticon-grid .emoticon-tile[data-name=\":dadjoke:\"]').click(); 0");
  t.equal(await page.js("document.getElementById('msg-input').value"), ':dadjoke:', 'clicking an emoticon inserts it');
  t.ok(await page.js("document.getElementById('modal-overlay').classList.contains('hidden')"), 'picker closes after inserting');

  await page.js("showEmoticonPicker(); document.querySelector('#emoticon-grid .emoticon-tile[data-name=\":d:\"] .emoticon-favorite-btn').click(); 0");
  t.equal(await page.js("getAppSettings().favoriteEmoticons"), [':d:'], 'star adds a favorite without inserting');
  t.equal(await page.js("document.getElementById('msg-input').value"), ':dadjoke:', 'favorite toggle does not insert');
  page.close();
};
