'use strict';
// src/lib/connection.js with the real @xmpp/client against a fake XMPP server that
// supports login, resource binding and stream management (XEP-0198) resumption.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { client } = require('@xmpp/client');
const { watchConnection } = require('../../src/lib/connection');

const HEADER = id => "<?xml version='1.0'?><stream:stream xmlns:stream='http://etherx.jabber.org/streams' " +
  `xmlns='jabber:client' from='localhost' id='${id}' version='1.0'>`;

// Minimal server. Options: answerPings (default true), authFail (default false).
function fakeServer({ answerPings = true, authFail = false } = {}) {
  const state = { sockets: [], resumes: 0, logins: 0, smId: 'sm-1' };
  const server = net.createServer(sock => {
    state.sockets.push(sock);
    let authed = false;
    sock.on('error', () => {});
    sock.on('data', d => {
      const s = d.toString();
      if (s.includes('<stream:stream')) {
        sock.write(HEADER('s' + state.sockets.length) + (authed
          ? "<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/><sm xmlns='urn:xmpp:sm:3'/></stream:features>"
          : "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>"));
      }
      if (s.includes('<auth')) {
        if (authFail) return sock.write("<failure xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><not-authorized/></failure>");
        authed = true;
        state.logins++;
        sock.write("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>");
      }
      const bind = s.match(/<iq[^>]*id=["']([^"']+)["'][^>]*>\s*<bind/);
      if (bind) sock.write(`<iq type='result' id='${bind[1]}'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>u@localhost/r</jid></bind></iq>`);
      if (s.includes('<enable')) sock.write(`<enabled xmlns='urn:xmpp:sm:3' id='${state.smId}' resume='true' max='600'/>`);
      if (s.includes('<resume')) { state.resumes++; sock.write("<resumed xmlns='urn:xmpp:sm:3' h='0' previd='sm-1'/>"); }
      const ping = s.match(/<iq[^>]*id=["']([^"']+)["'][^>]*>\s*<ping/);
      if (ping && answerPings) sock.write(`<iq type='result' id='${ping[1]}'/>`);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

function connect(port, options = {}) {
  // The fake server is plain TCP; @xmpp/client 0.14 won't use PLAIN there on its own,
  // so force it for this local test server only (src/main.js requires TLS).
  const xmpp = client({
    service: `xmpp://127.0.0.1:${port}`, domain: 'localhost',
    credentials: authenticate => authenticate({ username: 'u', password: 'p' }, 'PLAIN')
  });
  const events = [];
  const watcher = watchConnection(xmpp, {
    onOnline: ({ resumed }) => events.push(resumed ? 'online(resumed)' : 'online'),
    onOffline: () => events.push('offline'),
    onError: msg => events.push('error'),
    onAuthFail: msg => { events.push('authfail'); xmpp.reconnect.stop(); },
    minDelay: 50,
    ...options
  });
  xmpp.start().catch(watcher.handleError);
  return { xmpp, events, watcher };
}

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); }
  return false;
};

// The fake server never closes streams, so tear down sockets directly
function shutdown(xmpp, watcher, { server, state }) {
  watcher.stop();
  xmpp.reconnect.stop();
  xmpp.removeAllListeners();
  xmpp.on('error', () => {});
  state.sockets.forEach(s => s.destroy());
  server.close();
}

test('a resumed session after a drop is reported online (the library does not emit "online")', { timeout: 10000 }, async (t) => {
  const srv = await fakeServer(); const { state, port } = srv;
  const { xmpp, events, watcher } = connect(port);
  t.after(() => shutdown(xmpp, watcher, srv));
  assert.ok(await waitFor(() => events.includes('online')), 'initial login');
  assert.ok(xmpp.streamManagement.enabled && xmpp.streamManagement.id, 'stream management enabled');

  state.sockets.at(-1).destroy();  // network drop
  assert.ok(await waitFor(() => events.includes('online(resumed)')), `resumed session reported: ${events}`);
  assert.deepStrictEqual(events, ['online', 'offline', 'online(resumed)']);
  assert.strictEqual(state.resumes, 1);
  assert.strictEqual(xmpp.status, 'online');
});

test('a connection that stops answering pings is dropped and resumed', { timeout: 10000 }, async (t) => {
  const srv = await fakeServer({ answerPings: false }); const { state, port } = srv;
  const { xmpp, events, watcher } = connect(port, { pingInterval: 200, pingTimeout: 300 });
  t.after(() => shutdown(xmpp, watcher, srv));
  assert.ok(await waitFor(() => events.includes('online')));
  assert.ok(await waitFor(() => events.includes('online(resumed)'), 3000), `dead connection detected and resumed: ${events}`);
  assert.deepStrictEqual(events.slice(0, 3), ['online', 'offline', 'online(resumed)']);
});

test('answered pings keep the connection', { timeout: 10000 }, async (t) => {
  const srv = await fakeServer({ answerPings: true }); const { port } = srv;
  const { xmpp, events, watcher } = connect(port, { pingInterval: 100, pingTimeout: 300 });
  t.after(() => shutdown(xmpp, watcher, srv));
  assert.ok(await waitFor(() => events.includes('online')));
  await new Promise(r => setTimeout(r, 700));
  assert.deepStrictEqual(events, ['online']);
});

test('a wrong password is reported as authfail, once', { timeout: 10000 }, async (t) => {
  const srv = await fakeServer({ authFail: true }); const { state, port } = srv;
  const { xmpp, events, watcher } = connect(port);
  t.after(() => shutdown(xmpp, watcher, srv));
  assert.ok(await waitFor(() => events.includes('authfail')));
  await new Promise(r => setTimeout(r, 300));
  assert.deepStrictEqual(events.filter(e => e === 'authfail'), ['authfail']);
  assert.strictEqual(state.logins, 0);
});

test('a keepalive ping that never finishes sending still counts as dead', { timeout: 10000 }, async (t) => {
  const srv = await fakeServer(); const { port } = srv;
  const { xmpp, events, watcher } = connect(port, { pingInterval: 200, pingTimeout: 300, onKeepaliveFailed: () => events.push('keepalive failed') });
  t.after(() => shutdown(xmpp, watcher, srv));
  assert.ok(await waitFor(() => events.includes('online')));
  // Like a dead connection where the socket write never completes (the library's own
  // iq timeout only starts after the write)
  const write = xmpp.write.bind(xmpp);
  xmpp.write = str => (str.includes('urn:xmpp:ping') ? new Promise(() => {}) : write(str));
  assert.ok(await waitFor(() => events.includes('online(resumed)'), 3000), `detected and resumed: ${events}`);
  assert.deepStrictEqual(events.slice(0, 4), ['online', 'keepalive failed', 'offline', 'online(resumed)']);
});

test('network lost: dropped at once; network back: reconnects at once, not after the backoff', { timeout: 10000 }, async (t) => {
  const srv = await fakeServer(); const { state, port } = srv;
  // A long backoff, so only networkBack() can explain a quick reconnect
  const { xmpp, events, watcher } = connect(port, { minDelay: 20000 });
  t.after(() => shutdown(xmpp, watcher, srv));
  assert.ok(await waitFor(() => events.includes('online')));

  const lostAt = Date.now();
  watcher.networkLost();
  assert.ok(await waitFor(() => events.includes('offline'), 1000), 'offline right away');
  assert.ok(Date.now() - lostAt < 1000);

  await new Promise(r => setTimeout(r, 300));
  assert.ok(!events.includes('online(resumed)'), 'not reconnected by itself yet (backoff is 20 s)');
  watcher.networkBack();
  assert.ok(await waitFor(() => events.includes('online(resumed)'), 3000), `reconnected right away: ${events}`);
  assert.strictEqual(state.resumes, 1);
});

test('network back while still online: the connection is checked with a ping, not dropped', { timeout: 10000 }, async (t) => {
  const srv = await fakeServer({ answerPings: true }); const { state, port } = srv;
  const { xmpp, events, watcher } = connect(port);
  t.after(() => shutdown(xmpp, watcher, srv));
  assert.ok(await waitFor(() => events.includes('online')));
  watcher.networkBack();
  await new Promise(r => setTimeout(r, 500));
  assert.deepStrictEqual(events, ['online']);
  assert.strictEqual(state.sockets.length, 1);
});
