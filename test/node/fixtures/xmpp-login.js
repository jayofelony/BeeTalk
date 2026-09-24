'use strict';
// Child process for tls.test.js: logs in to a fake server the way src/main.js does
// and prints the outcome as JSON. Usage: node xmpp-login.js <port>
const { client } = require('@xmpp/client');
const { tlsOnlyCredentials } = require('../../../src/lib/xmpp-helpers');

let refused = false;
const xmpp = client({
  service: `xmpp://localhost:${process.argv[2]}`,
  domain: 'localhost',
  credentials: tlsOnlyCredentials(() => xmpp, { username: 'u', password: 'secret' }, () => { refused = true; })
});
xmpp.reconnect.stop();
xmpp.on('error', () => {});
xmpp.start().then(
  () => finish({ online: true }),
  err => finish({ online: false, error: err.name, condition: err.condition || null, message: err.message })
);
function finish(result) {
  console.log(JSON.stringify({ ...result, refused }));
  xmpp.stop().catch(() => {}).finally(() => process.exit(0));
}
