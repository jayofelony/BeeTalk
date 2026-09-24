'use strict';
// First run, single-account mode, adding contacts.
const { ACCOUNT } = require('./fixtures');

module.exports = async t => {
  // First run: no account
  let page = await t.open({ accounts: [] });
  const visible = id => page.js(`getComputedStyle(document.getElementById('${id}')).display !== 'none'`);
  t.ok(await visible('btn-add-account') && await visible('btn-welcome-add'), 'first run: add-account buttons visible');

  await page.js("document.getElementById('btn-welcome-add').click(); 0");
  t.ok(await page.js("!!document.getElementById('fi-user')"), 'welcome button opens the Add Account dialog');
  await page.js("document.querySelector('#modal-content a[data-action=openExternalLink]').click(); 0");
  t.equal(t.sent('open-link'), ['https://gice.goonfleet.com/Manage/ServicePassword'], '"Check username/password" opens the GSF service password page');

  await page.js(`document.getElementById('fi-display-name').value = 'Jay';
                 document.getElementById('fi-user').value = 'jay';
                 document.getElementById('fi-pass').value = 'pw';
                 document.querySelector('[data-action=submitAddAccount]').click(); 0`);
  const saved = t.sent('save-accounts').pop() || [];
  t.ok(saved.length === 1 && saved[0].username === 'jay' && saved[0].password === 'pw', 'account (with password) sent to main for saving', saved);
  t.equal(t.sent('xmpp-connect').map(a => a.username), ['jay'], 'connect requested after adding');
  t.ok(!(await visible('btn-add-account')) && !(await visible('btn-welcome-add')), 'add-account buttons hidden once an account exists');
  page.close();

  // Existing account
  page = await t.open({ accounts: [ACCOUNT] });
  t.ok(!(await page.js("['btn-add-account','btn-welcome-add'].some(id => getComputedStyle(document.getElementById(id)).display !== 'none')")),
    'with an account: add-account buttons hidden');
  await page.js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true })); 0");
  t.ok(await page.js("document.getElementById('modal-overlay').classList.contains('hidden')"), 'Ctrl+N does not open a second account dialog');
  t.equal(t.sent('xmpp-connect').map(a => a.id), ['acct_1'], 'saved account connects on start');

  page.send('xmpp-status', { id: 'acct_1', status: 'online', jid: 'tester@goonfleet.com/test' });
  await page.js(`{ const i = document.getElementById('new-contact-username'); i.value = 'dave';
                   i.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' })); } 0`);
  t.equal(t.sent('xmpp-add-contact').map(c => c.jid), ['dave@goonfleet.com'], 'adding a contact by username uses @goonfleet.com');
  page.close();
};
