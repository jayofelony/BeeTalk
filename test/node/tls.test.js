'use strict';
// The password must only be sent after STARTTLS. Runs the real login code
// (fixtures/xmpp-login.js) against fake XMPP servers on localhost.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const HEADER = "<?xml version='1.0'?><stream:stream xmlns:stream='http://etherx.jabber.org/streams' " +
  "xmlns='jabber:client' from='localhost' id='1' version='1.0'>";
const PLAIN_ONLY = "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>";
const STARTTLS = "<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls></stream:features>";

let certDir;
function makeCert() {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beetalk-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
}

let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }

// Run the login fixture against a server; resolves with { result, sawAuth, authOverTls }
function runLogin(handleConnection) {
  return new Promise((resolve, reject) => {
    const seen = { sawAuth: false, authOverTls: false };
    const server = net.createServer(sock => handleConnection(sock, seen));
    server.listen(0, '127.0.0.1', () => {
      const fixture = path.join(__dirname, 'fixtures', 'xmpp-login.js');
      execFile(process.execPath, [fixture, String(server.address().port)], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(certDir, 'cert.pem') },
        timeout: 15000
      }, (err, stdout) => {
        server.close();
        if (err && !stdout) return reject(err);
        resolve({ result: JSON.parse(stdout.trim().split('\n').pop()), ...seen });
      });
    });
  });
}

test('TLS enforcement', { skip: !hasOpenssl && 'openssl not available' }, async (t) => {
  makeCert();
  t.after(() => fs.rmSync(certDir, { recursive: true, force: true }));

  await t.test('refuses to send the password when the server offers no STARTTLS', async () => {
    const { result, sawAuth } = await runLogin((sock, seen) => {
      sock.on('data', d => {
        const s = d.toString();
        if (s.includes('<stream:stream')) sock.write(HEADER + PLAIN_ONLY);
        if (s.includes('<auth')) seen.sawAuth = true;
      });
    });
    assert.strictEqual(sawAuth, false, 'password must not reach the server');
    assert.strictEqual(result.online, false);
    assert.strictEqual(result.refused, true);
  });

  await t.test('sends the password after STARTTLS; a wrong password is a SASLError', async () => {
    const { result, sawAuth, authOverTls } = await runLogin((raw, seen) => {
      raw.once('data', () => {
        raw.write(HEADER + STARTTLS);
        raw.once('data', d => {
          if (!d.toString().includes('<starttls')) return;
          raw.write("<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>");
          const sec = new tls.TLSSocket(raw, {
            isServer: true,
            key: fs.readFileSync(path.join(certDir, 'key.pem')),
            cert: fs.readFileSync(path.join(certDir, 'cert.pem'))
          });
          sec.on('data', d2 => {
            const s = d2.toString();
            if (s.includes('<stream:stream')) sec.write(HEADER + PLAIN_ONLY);
            if (s.includes('<auth')) {
              seen.sawAuth = true;
              seen.authOverTls = true;
              sec.write("<failure xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><not-authorized/></failure>");
            }
          });
        });
      });
    });
    assert.strictEqual(sawAuth && authOverTls, true, 'password sent over TLS');
    assert.strictEqual(result.refused, false);
    assert.strictEqual(result.error, 'SASLError');       // src/main.js stops retrying on this
    assert.strictEqual(result.condition, 'not-authorized');
  });
});
