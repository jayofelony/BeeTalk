'use strict';
// Starts the real app (src/main.js) with a throwaway profile and checks it boots:
// the window loads, the renderer finishes booting, and nothing throws.
// The renderer suites replace main.js with fakes, so this is what catches a broken
// main process (e.g. a dependency upgrade that changes how a module loads).
// Run with: npm run test:main
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beetalk-smoke-'));
app.setPath('userData', profile);

const problems = [];
const finish = code => {
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(code === 0 ? 'ok - app boots with the real main process' : `not ok - app did not boot: ${problems.join(' | ')}`);
  app.exit(code);
};
process.on('uncaughtException', err => { problems.push(`main: ${err.message}`); finish(1); });
setTimeout(() => { problems.push('timed out'); finish(1); }, 60 * 1000);

try {
  require(path.join(__dirname, '..', '..', 'src', 'main.js'));
} catch (err) {
  problems.push(`main.js failed to load: ${err.message}`);
  finish(1);
}

app.on('browser-window-created', (e, win) => {
  win.webContents.on('console-message', ev => {
    if (ev.level === 'error' || /Uncaught/.test(ev.message)) problems.push(`renderer: ${ev.message}`);
  });
  win.webContents.on('did-finish-load', async () => {
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('document.body.dataset.ready === "true"').catch(() => false)) {
        return finish(problems.length ? 1 : 0);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    problems.push('renderer never finished booting');
    finish(1);
  });
});
