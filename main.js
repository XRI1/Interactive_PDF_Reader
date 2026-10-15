// Desktop app (Electron): starts the local server and shows the player fullscreen.
//   Ctrl+Shift+A  open the admin panel
//   Ctrl+Shift+O  open the data folder (PDF / Images / config.json)
//   F11           toggle fullscreen
//   Ctrl+Q        quit
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Data lives next to the .exe so PDFs/images can be changed on any PC.
// (PORTABLE_EXECUTABLE_DIR is set by the single-file portable .exe)
const DATA_DIR = app.isPackaged
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : __dirname;

// First run on a new PC: copy the bundled PDFs/images next to the .exe
function ensureData() {
  if (!app.isPackaged) return;
  const defaults = path.join(process.resourcesPath, 'defaults');
  for (const name of ['PDF', 'Images']) {
    const target = path.join(DATA_DIR, name);
    const source = path.join(defaults, name);
    if (!fs.existsSync(target) && fs.existsSync(source)) fs.cpSync(source, target, { recursive: true });
  }
  const cfg = path.join(DATA_DIR, 'config.json');
  const cfgSource = path.join(defaults, 'config.json');
  if (!fs.existsSync(cfg) && fs.existsSync(cfgSource)) fs.copyFileSync(cfgSource, cfg);
}

if (!app.requestSingleInstanceLock()) app.quit();

let player = null;
let admin = null;
let baseUrl = '';

// App shortcuts (only while one of our windows is focused)
function attachKeys(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (ctrl && input.shift && key === 'a') openAdmin();
    else if (ctrl && input.shift && key === 'o') shell.openPath(DATA_DIR);
    else if (ctrl && !input.shift && key === 'q') app.quit();
    else if (input.key === 'F11' && player) {
      const on = !player.isKiosk();
      player.setKiosk(on);
      player.setFullScreen(on);
    } else return;
    event.preventDefault();
  });
}

function createPlayer() {
  player = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    backgroundColor: '#0a1a8a',
    title: 'PDF Player',
    webPreferences: { plugins: true, backgroundThrottling: false },
  });
  attachKeys(player);
  player.loadURL(baseUrl + '/');
  player.on('closed', () => { player = null; app.quit(); });
}

function openAdmin() {
  if (admin) { admin.show(); admin.focus(); return; }
  admin = new BrowserWindow({
    width: 1200, height: 900,
    autoHideMenuBar: true,
    title: 'PDF Player Admin',
    alwaysOnTop: true,
    webPreferences: { plugins: true },
  });
  admin.setAlwaysOnTop(true, 'screen-saver'); // stay above the kiosk player
  attachKeys(admin);
  admin.loadURL(baseUrl + '/admin');
  admin.on('closed', () => { admin = null; if (player) player.focus(); });
}

app.whenReady().then(async () => {
  try {
    ensureData();
    process.env.DATA_DIR = DATA_DIR;
    const { start } = require('./server.js');
    const port = await start(3000);
    baseUrl = `http://localhost:${port}`;
  } catch (err) {
    dialog.showErrorBox('PDF Player', 'Could not start: ' + err.message);
    app.quit();
    return;
  }

  Menu.setApplicationMenu(null);
  createPlayer();
});

app.on('second-instance', () => { if (player) { player.show(); player.focus(); } });
app.on('window-all-closed', () => app.quit());
