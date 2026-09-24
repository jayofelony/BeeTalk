'use strict';
// Renderer tests: loads the real src/index.html + app.js + preload.js in hidden
// windows, with the main process replaced by the fakes below. Each suite gets
// fresh in-memory storage (localStorage + IndexedDB).
// Run with: npm run test:electron  (or a single suite: npm run test:electron -- history)
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const SUITES = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();

// ── Fake main process ─────────────────────────────────────────────
// Suites set `fake.*` to control responses; every renderer -> main send is recorded.
const fake = {};
function resetFake() {
  Object.assign(fake, {
    accounts: [],             // load-accounts result
    emoticons: {},            // load-emoticons result
    history: () => [],        // load-message-history(query) -> messages
    rooms: [],                // discover-rooms result
    sent: [],                 // [{ channel, data }] for every ipcRenderer.send
    probes: []                // requested URLs containing "beetalk-probe" (see security suite)
  });
}
resetFake();
ipcMain.handle('load-accounts', () => fake.accounts);
ipcMain.handle('load-emoticons', () => fake.emoticons);
ipcMain.handle('get-version', () => 'test');
ipcMain.handle('load-message-history', (e, q) => fake.history(q));
ipcMain.handle('discover-rooms', () => fake.rooms);
ipcMain.handle('check-update', () => ({ status: 'up-to-date', version: 'test' }));
// Record every channel preload.js lets the renderer send (kept in sync automatically)
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
for (const [, ch] of preloadSrc.matchAll(/ipcRenderer\.send\('([a-z-]+)'/g)) {
  ipcMain.on(ch, (e, data) => fake.sent.push({ channel: ch, data }));
}

// ── Test context passed to each suite ─────────────────────────────
let failures = 0, passes = 0, partitionId = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));

function makeContext(suiteName) {
  const t = {
    fake,
    wait,
    ok(cond, name, detail) {
      if (cond) { passes++; console.log(`  ok - ${name}`); }
      else { failures++; console.log(`  not ok - ${name}${detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : ''}`); }
    },
    equal(actual, expected, name) {
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      t.ok(same, name, same ? undefined : { actual, expected });
    },
    sent: channel => fake.sent.filter(s => s.channel === channel).map(s => s.data),
    // Open the app in a fresh window. Options set the fake main process first.
    async open(options = {}) {
      resetFake();
      Object.assign(fake, options);
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true, contextIsolation: true, backgroundThrottling: false,
          partition: `suite-${suiteName}-${++partitionId}`,   // no "persist:" = in-memory
          preload: path.join(ROOT, 'src', 'preload.js')
        }
      });
      const page = {
        win,
        consoleErrors: [],
        js: code => win.webContents.executeJavaScript(code),
        send: (channel, data) => win.webContents.send(channel, data),
        // Wait until the renderer has finished booting (history store + accounts loaded)
        async ready() {
          for (let i = 0; i < 100; i++) {
            if (await page.js('document.body.dataset.ready === "true"')) break;
            await wait(50);
          }
        },
        async reload() {
          win.webContents.reload();
          await new Promise(r => win.webContents.once('did-finish-load', r));
          await page.ready();
        },
        async waitFor(expr, timeout = 3000) {
          const end = Date.now() + timeout;
          while (Date.now() < end) { if (await page.js(expr)) return true; await wait(50); }
          return false;
        },
        close: () => win.destroy()
      };
      // Record requests for probe resources: untrusted HTML must be parsed without loading anything
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.includes('beetalk-probe')) fake.probes.push(details.url);
        callback({});
      });
      win.webContents.on('console-message', e => {
        if (e.level === 'error' || /Uncaught/.test(e.message)) page.consoleErrors.push(e.message);
      });
      await win.loadFile(path.join(ROOT, 'src', 'index.html'));
      await page.ready();
      return page;
    }
  };
  return t;
}

// Suites close their windows between tests; don't let Electron quit when none are left
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  // Optional suite names after the script path, e.g. `-- history`
  const only = process.argv.slice(process.argv.findIndex(a => path.resolve(a) === __filename) + 1).filter(a => !a.startsWith('-'));
  let ran = 0;
  const watchdog = setTimeout(() => { console.log('Bail out! test run timed out'); app.exit(1); }, 5 * 60 * 1000);
  for (const file of SUITES) {
    const name = file.replace('.test.js', '');
    if (only.length && !only.includes(name)) continue;
    console.log(`# ${name}`);
    ran++;
    try {
      await require(path.join(__dirname, file))(makeContext(name));
    } catch (err) {
      failures++;
      console.log(`  not ok - suite crashed: ${err.stack || err}`);
    }
    BrowserWindow.getAllWindows().forEach(w => w.destroy());
  }
  clearTimeout(watchdog);
  if (!ran) { failures++; console.log(`not ok - no suites matched ${JSON.stringify(only)}`); }
  console.log(`\n# pass ${passes}\n# fail ${failures}`);
  app.exit(failures ? 1 : 0);
});
