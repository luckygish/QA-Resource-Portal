const path = require('path');
const express = require('express');
const { spawn } = require('child_process');

// When packaged into a single .exe (pkg), __dirname points into an in-memory
// snapshot; resolve static to the real folder next to the executable.
const APP_DIR = typeof process !== 'undefined' && process.pkg ? path.dirname(process.execPath) : __dirname;
const DEFAULT_PORT = Number(process.env.MYSKILLS_PORT) || 3200;

const app = express();
app.use(express.static(path.join(APP_DIR, 'public')));

app.get('*', (req, res) => res.sendFile(path.join(APP_DIR, 'public', 'index.html')));

function openBrowser(url) {
  if (process.env.MYSKILLS_NO_OPEN) return;
  try {
    const stdio = 'ignore';
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio, detached: true, windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio, detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio, detached: true }).unref();
    }
  } catch (e) {
    console.error('Не удалось открыть браузер:', e.message);
  }
}

function listen(port) {
  return new Promise((resolve) => {
    const server = app.listen(port);
    server.once('error', () => resolve(null));
    server.once('listening', () => resolve(server));
  });
}

(async function start() {
  let server = null;
  let port = DEFAULT_PORT;
  for (let i = 0; i < 100; i += 1) {
    server = await listen(port);
    if (server) break;
    port += 1;
  }
  if (!server) {
    console.error('Не удалось занять порт для запуска сервера.');
    return;
  }
  const url = `http://localhost:${server.address().port}`;
  console.log(`MySkills listening on ${url}`);
  openBrowser(url);
})();