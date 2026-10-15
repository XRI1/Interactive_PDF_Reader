// Interactive PDF Reader - local server
//   world map player + admin panel + ESP32 switches over USB serial + QR downloads
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;                          // app files (inside the .exe when packaged)
const DATA = process.env.DATA_DIR || __dirname;  // PDF/, Images/, config.json (next to the .exe when packaged)
const PDF_DIR = path.join(DATA, 'PDF');
const IMG_DIR = path.join(DATA, 'Images');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MODULES = path.join(ROOT, 'node_modules');
const CONFIG_FILE = path.join(DATA, 'config.json');

const SWITCH_COUNT = 10;

const DEFAULT_SETTINGS = {
  abstractDuration: 120,  // seconds the abstract + QR stay on screen
  zoomDuration: 3,        // seconds for the fly-in to the country
  countryHold: 1.2,       // seconds to stay on the zoomed country before the transition
  revealDuration: 1.2,    // seconds for the map -> abstract transition
  abstractStyle: 'auto',  // 'auto' = text on tall screens / PDF image on wide screens, 'text', 'image'
  showHint: true,
  hintText: 'Press a button to explore the research',
  logo: 'Nemonic.png',
  showLogo: true,
  publicBaseUrl: '',      // base for QR download links; '' = this PC's network address
  serialPort: 'auto',     // 'auto' or a fixed port like 'COM5'
  baudRate: 115200,
};

// Preset places for the 10 switches (match the PDF names 1_USA ... 10_faridpur)
const DEFAULT_SWITCHES = [
  { place: 'USA',      country: 'United States of America', lat: 39.5,  lon: -98.35, zoom: 3.2 },
  { place: 'Italy',    country: 'Italy',      lat: 42.6,  lon: 12.6,  zoom: 6.5 },
  { place: 'Sweden',   country: 'Sweden',     lat: 62.5,  lon: 16.0,  zoom: 4.8 },
  { place: 'Dinajpur', country: 'Bangladesh', lat: 25.63, lon: 88.64, zoom: 18 },
  { place: 'Sylhet',   country: 'Bangladesh', lat: 24.90, lon: 91.87, zoom: 18 },
  { place: 'Sylhet',   country: 'Bangladesh', lat: 24.90, lon: 91.87, zoom: 18 },
  { place: 'Dhaka',    country: 'Bangladesh', lat: 23.81, lon: 90.41, zoom: 18 },
  { place: 'Dhaka',    country: 'Bangladesh', lat: 23.81, lon: 90.41, zoom: 18 },
  { place: 'Dhaka',    country: 'Bangladesh', lat: 23.81, lon: 90.41, zoom: 18 },
  { place: 'Faridpur', country: 'Bangladesh', lat: 23.61, lon: 89.84, zoom: 18 },
];
const EMPTY_SWITCH = { pdf: '', title: '', place: '', country: '', lat: 0, lon: 0, zoom: 3, abstractPage: 'auto', link: '' };

function listPdfs() {
  fs.mkdirSync(PDF_DIR, { recursive: true });
  return fs.readdirSync(PDF_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function listImages() {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  return fs.readdirSync(IMG_DIR).filter(f => /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const settings = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (cfg.settings && cfg.settings[k] !== undefined) settings[k] = cfg.settings[k];

  const existing = new Set(listPdfs());
  const oldButtons = cfg.buttons || []; // from the previous version
  const switches = Array.from({ length: SWITCH_COUNT }, (_, i) => {
    const s = { ...EMPTY_SWITCH, ...DEFAULT_SWITCHES[i], ...((cfg.switches || [])[i] || {}) };
    if (!s.pdf && oldButtons[i]) s.pdf = oldButtons[i];
    if (s.pdf && !existing.has(s.pdf)) s.pdf = '';
    return s;
  });
  return { settings, switches };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ settings: cfg.settings, switches: cfg.switches }, null, 2));
}

// Which PDF a switch shows: the admin choice, else the file named "<n>_..." / "<n>.pdf" / "pdf<n>.pdf"
function resolvePdf(cfg, n) {
  const s = cfg.switches[n - 1];
  if (!s) return null;
  if (s.pdf) return s.pdf;
  const re = new RegExp(`^(pdf)?0*${n}(?![0-9])`, 'i');
  return listPdfs().find(f => re.test(f)) || null;
}

// ---------------- Network address for QR download links ----------------
function lanAddress() {
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) all.push({ name, address: a.address });
    }
  }
  // Prefer Wi-Fi / Ethernet over virtual adapters (VirtualBox, Hyper-V, VPN...)
  const score = x => (/virtual|vbox|vmware|hyper-v|vethernet|loopback|tailscale|zerotier|vpn/i.test(x.name) ? 10 : 0)
    + (/^192\.168\./.test(x.address) ? 0 : /^10\./.test(x.address) ? 1 : 2);
  all.sort((a, b) => score(a) - score(b));
  return all.length ? all[0].address : 'localhost';
}

function downloadUrl(cfg, n) {
  const s = cfg.switches[n - 1];
  if (s && s.link) return s.link;
  const file = resolvePdf(cfg, n);
  if (!file) return null;
  const base = (cfg.settings.publicBaseUrl || `http://${lanAddress()}:${PORT}`).replace(/\/+$/, '');
  return `${base}/download/${encodeURIComponent(file)}`;
}

let QRCode = null;
try { QRCode = require('qrcode'); } catch { console.warn('  qrcode module missing - run "npm install".'); }

// ---------------- Live events to the player (Server-Sent Events) ----------------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function pressButton(n, source) {
  const cfg = loadConfig();
  const file = resolvePdf(cfg, n);
  serialStatus.lastButton = { n, file, source, at: Date.now() };
  console.log(`  Switch ${n} (${source}) -> ${file || 'no PDF assigned'}`);
  if (n >= 1 && n <= SWITCH_COUNT) broadcast('play', { button: n, file });
  return file;
}

// ---------------- ESP32 serial ----------------
let SerialPort = null, ReadlineParser = null;
try {
  ({ SerialPort } = require('serialport'));
  ({ ReadlineParser } = require('@serialport/parser-readline'));
} catch {
  console.warn('  serialport module not installed - run "npm install" to use the ESP32 switches.');
}

const serialStatus = { connected: false, port: null, error: null, lastLine: null, lastButton: null };
let serial = null;

// USB-serial chips used by ESP32 boards: Silicon Labs CP210x, WCH CH340/CH9102, FTDI, Espressif native USB
const ESP_VENDORS = ['10c4', '1a86', '0403', '303a'];

async function findPort(wanted) {
  const ports = await SerialPort.list();
  if (wanted && wanted !== 'auto') return ports.find(p => p.path.toLowerCase() === wanted.toLowerCase()) ? wanted : null;
  const esp = ports.find(p => ESP_VENDORS.includes(String(p.vendorId || '').toLowerCase()))
    || ports.find(p => /silicon labs|wch|ftdi|espressif|ch340|cp210|usb/i.test(`${p.manufacturer} ${p.friendlyName}`));
  return esp ? esp.path : null;
}

async function connectSerial() {
  if (!SerialPort || serial) return;
  const { settings } = loadConfig();
  let portPath;
  try { portPath = await findPort(settings.serialPort); } catch (e) { serialStatus.error = e.message; return; }
  if (!portPath) {
    serialStatus.error = settings.serialPort === 'auto' ? 'ESP32 not found - is it plugged in?' : `${settings.serialPort} not found`;
    return;
  }

  const port = new SerialPort({ path: portPath, baudRate: Number(settings.baudRate) || 115200 }, err => {
    if (err) { serialStatus.error = err.message; serial = null; }
  });
  serial = port;
  port.on('open', () => {
    Object.assign(serialStatus, { connected: true, port: portPath, error: null });
    console.log(`  ESP32 connected on ${portPath}`);
  });
  port.on('close', () => {
    if (serialStatus.connected) console.log(`  ESP32 disconnected (${portPath})`);
    Object.assign(serialStatus, { connected: false, port: null });
    serial = null;
  });
  port.on('error', e => { serialStatus.error = e.message; });
  port.pipe(new ReadlineParser({ delimiter: '\n' })).on('data', line => {
    line = String(line).trim();
    if (!line) return;
    serialStatus.lastLine = line;
    const m = line.match(/^PDF:(\d+)/i);
    if (m) pressButton(Number(m[1]), 'switch');
  });
}

function reconnectSerial() {
  if (serial) { serial.removeAllListeners('close'); serial.close(() => {}); serial = null; }
  Object.assign(serialStatus, { connected: false, port: null });
  connectSerial();
}

setInterval(connectSerial, 3000); // keeps retrying, so the ESP32 can be plugged in any time

// ---------------- HTTP helpers ----------------
// Only allow plain file names (no folders / path tricks)
function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

function sendFile(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      ...extraHeaders,
    });
    fs.createReadStream(file).pipe(res);
  });
}

function send(res, code, body) {
  const isJson = typeof body !== 'string';
  res.writeHead(code, { 'Content-Type': isJson ? MIME['.json'] : 'text/plain; charset=utf-8' });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit = 500 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('File too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveFrom(dir, rel, res, extraHeaders) {
  const file = path.join(dir, rel);
  if (!file.startsWith(dir + path.sep)) return send(res, 403, 'Forbidden');
  sendFile(res, file, extraHeaders);
}

// Browser libraries, served from node_modules so everything works offline
const VENDOR = {
  'pdf.min.mjs': 'pdfjs-dist/build/pdf.min.mjs',
  'pdf.worker.min.mjs': 'pdfjs-dist/build/pdf.worker.min.mjs',
  'd3.min.js': 'd3/dist/d3.min.js',
  'topojson-client.min.js': 'topojson-client/dist/topojson-client.min.js',
  'countries-50m.json': 'world-atlas/countries-50m.json',
  'countries-10m.json': 'world-atlas/countries-10m.json',
};

// ---------------- Routes ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  const isLocal = /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '');

  try {
    // Public: phones scanning the QR code only get the download route
    if (p.startsWith('/download/')) {
      const name = safeName(p.slice('/download/'.length));
      if (!name || !listPdfs().includes(name)) return send(res, 404, 'Not found');
      return serveFrom(PDF_DIR, name, res, {
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
    }
    // Everything else (player, admin, API) only from this PC
    if (!isLocal) return send(res, 403, 'Only downloads are available from other devices.');

    // ---------- API ----------
    if (p === '/api/config' && req.method === 'GET') {
      const cfg = loadConfig();
      return send(res, 200, {
        ...cfg,
        files: listPdfs(),
        images: listImages(),
        resolved: cfg.switches.map((_, i) => resolvePdf(cfg, i + 1)),
        downloadUrls: cfg.switches.map((_, i) => downloadUrl(cfg, i + 1)),
        lanAddress: `http://${lanAddress()}:${PORT}`,
      });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const incoming = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const old = loadConfig();
      const existing = new Set(listPdfs());
      const settings = { ...old.settings };
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (incoming.settings && incoming.settings[k] !== undefined) settings[k] = incoming.settings[k];
      const switches = old.switches.map((s, i) => {
        const inc = (incoming.switches || [])[i] || {};
        const out = { ...s };
        for (const k of Object.keys(EMPTY_SWITCH)) if (inc[k] !== undefined) out[k] = inc[k];
        out.lat = Number(out.lat) || 0; out.lon = Number(out.lon) || 0; out.zoom = Math.max(1, Number(out.zoom) || 1);
        if (out.pdf && !existing.has(out.pdf)) out.pdf = '';
        return out;
      });
      saveConfig({ settings, switches });
      if (old.settings.serialPort !== settings.serialPort || old.settings.baudRate !== settings.baudRate) reconnectSerial();
      return send(res, 200, { ok: true });
    }

    // QR code (SVG) for a switch's download link
    if (p === '/api/qr' && req.method === 'GET') {
      const cfg = loadConfig();
      const link = downloadUrl(cfg, Number(url.searchParams.get('n')));
      if (!link || !QRCode) return send(res, 404, 'No link');
      const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#04263b', light: '#ffffff' } });
      res.writeHead(200, { 'Content-Type': MIME['.svg'], 'Cache-Control': 'no-cache', 'X-Link': encodeURI(link) });
      return res.end(svg);
    }

    // Live events for the player
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // Switch status, for the admin page
    if (p === '/api/serial' && req.method === 'GET') {
      const ports = SerialPort ? await SerialPort.list().catch(() => []) : [];
      return send(res, 200, {
        ...serialStatus,
        available: !!SerialPort,
        ports: ports.map(p => ({ path: p.path, name: p.friendlyName || p.manufacturer || '' })),
      });
    }

    // Simulate a switch press (admin "Test" button), e.g. POST /api/press?n=3
    if (p === '/api/press' && req.method === 'POST') {
      const n = Number(url.searchParams.get('n'));
      if (!(n >= 1 && n <= SWITCH_COUNT)) return send(res, 400, { error: 'Bad switch number' });
      return send(res, 200, { ok: true, file: pressButton(n, 'test') });
    }

    // Back to the world map
    if (p === '/api/home' && req.method === 'POST') {
      broadcast('home', {});
      return send(res, 200, { ok: true });
    }

    // Upload: raw file body, file name in ?name=..., optional ?switch=<n> to assign it
    if (p === '/api/upload' && req.method === 'POST') {
      const kind = url.searchParams.get('type') === 'image' ? 'image' : 'pdf';
      const name = safeName(url.searchParams.get('name'));
      if (!name) return send(res, 400, { error: 'Missing file name' });
      if (kind === 'pdf' && !name.toLowerCase().endsWith('.pdf')) return send(res, 400, { error: 'Only .pdf files allowed' });
      if (kind === 'image' && !/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return send(res, 400, { error: 'Only image files allowed' });

      const data = await readBody(req);
      fs.writeFileSync(path.join(kind === 'pdf' ? PDF_DIR : IMG_DIR, name), data);

      const n = Number(url.searchParams.get('switch'));
      if (kind === 'pdf' && n >= 1 && n <= SWITCH_COUNT) {
        const cfg = loadConfig();
        cfg.switches[n - 1].pdf = name;
        saveConfig(cfg);
      }
      return send(res, 200, { ok: true, name });
    }

    if (p.startsWith('/api/pdf/') && req.method === 'DELETE') {
      const name = safeName(p.slice('/api/pdf/'.length));
      const file = name && path.join(PDF_DIR, name);
      if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
      fs.unlinkSync(file);
      saveConfig(loadConfig()); // drops the deleted file from the switches
      return send(res, 200, { ok: true });
    }

    // ---------- Static ----------
    if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (p === '/admin' || p === '/admin.html') return sendFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    if (p.startsWith('/pdf/')) return serveFrom(PDF_DIR, p.slice(5), res);
    if (p.startsWith('/images/')) return serveFrom(IMG_DIR, p.slice(8), res);
    // PDF.js decoders, fonts and character maps (needed for scanned images / some fonts)
    const asset = p.match(/^\/pdfjs\/(wasm|cmaps|standard_fonts|iccs)\/(.+)$/);
    if (asset) return serveFrom(path.join(MODULES, 'pdfjs-dist', asset[1]), asset[2], res);
    if (p.startsWith('/vendor/')) {
      const rel = VENDOR[p.slice(8)];
      return rel ? sendFile(res, path.join(MODULES, rel)) : send(res, 404, 'Not found');
    }
    return serveFrom(PUBLIC_DIR, p.slice(1), res);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

// Start listening; if the port is taken, try the next one. Resolves with the port used.
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      if (err.code === 'EADDRINUSE' && port < PORT + 20) resolve(start(port + 1));
      else reject(err);
    };
    server.once('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      PORT = port;
      onListening();
      resolve(port);
    });
  });
}
module.exports = { start };
if (require.main === module) start().catch(err => { console.error(err.message); process.exit(1); });

function onListening() {
  saveConfig(loadConfig()); // writes the new config format on first run
  console.log('');
  console.log('  Interactive PDF Reader is running');
  console.log(`  Player : http://localhost:${PORT}/`);
  console.log(`  Admin  : http://localhost:${PORT}/admin`);
  console.log(`  QR downloads use: http://${lanAddress()}:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  connectSerial();
}

// Keep the event stream alive
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);
