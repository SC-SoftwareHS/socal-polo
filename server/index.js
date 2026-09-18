#!/usr/bin/env node
/* ============================================================
   SoCal Polo Brackets server: serves the static site and adds a small
   API so anyone can paste a Google Sheet link and get a live tournament.

     GET  /api/manifest          tournaments this server manages
     POST /api/add               { url, name?, start?, end?, location?, organizer? }
     POST /api/remap/:id         re-run the mapping (organizer changed the layout)
     DELETE /api/tournament/:id
     GET  /api/health

   State lives in server/data/tournaments.json. Run:  node server/index.js
   Env: PORT (default 8788), POLO_MAP_MODEL (default sonnet), ANTHROPIC_API_KEY (optional).
   ============================================================ */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { mapSheet, sheetIdFrom } = require('./mapper.js');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(__dirname, 'data'), FILE = path.join(DATA, 'tournaments.json');
const PORT = +(process.env.PORT || 8788);
fs.mkdirSync(DATA, { recursive: true });

function loadAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } }
function saveAll(list) { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 1)); fs.renameSync(tmp, FILE); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
function send(res, code, body, type) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': type || (isObj ? MIME['.json'] : 'text/plain; charset=utf-8'), 'cache-control': 'no-store' });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', d => { s += d; if (s.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || file.startsWith(path.join(ROOT, 'server')) || file.includes(`${path.sep}.git`)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const inflight = new Map();   // sheetId -> promise, so a double-click does not map twice
async function addOrRemap(body, existingId) {
  const url = body.url || (existingId && (loadAll().find(t => t.id === existingId) || {}).sheetUrl);
  const sheetId = sheetIdFrom(url);
  if (!sheetId) throw new Error('Please paste a Google Sheets link (docs.google.com/spreadsheets/d/...).');
  if (inflight.has(sheetId)) return inflight.get(sheetId);
  const job = (async () => {
    const list = loadAll();
    const prior = list.find(t => t.id === existingId) || list.find(t => t.source && t.source.sheetId === sheetId) || null;
    const hints = { id: prior ? prior.id : undefined, name: body.name || (prior && prior.name) || undefined, start: body.start || (prior && prior.start) || undefined, end: body.end || (prior && prior.end) || undefined, location: body.location || (prior && prior.location) || undefined, organizer: body.organizer || (prior && prior.organizer) || undefined, venues: prior ? prior.venues : undefined };
    const { entry, stats } = await mapSheet(url, hints);
    if (prior) { entry.id = prior.id; entry.status = prior.status || entry.status; }
    const fresh = loadAll().filter(t => t.id !== entry.id);
    fresh.unshift(entry); saveAll(fresh);
    return { entry: publicEntry(entry), stats };
  })();
  inflight.set(sheetId, job);
  try { return await job; } finally { inflight.delete(sheetId); }
}
const publicEntry = t => t;   // the map ships to the browser; it is what the live adapter reads

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  try {
    if (url === '/api/health') return send(res, 200, { ok: true, tournaments: loadAll().length });
    if (url.startsWith('/api/manifest')) return send(res, 200, { tournaments: loadAll().map(publicEntry) });
    if (req.method === 'POST' && url === '/api/add') { const body = await readBody(req); return send(res, 200, await addOrRemap(body, null)); }
    let m;
    if (req.method === 'POST' && (m = url.match(/^\/api\/remap\/([\w-]+)$/))) { const body = await readBody(req); return send(res, 200, await addOrRemap(body, m[1])); }
    if (req.method === 'DELETE' && (m = url.match(/^\/api\/tournament\/([\w-]+)$/))) { const list = loadAll(); const n = list.length; saveAll(list.filter(t => t.id !== m[1])); return send(res, 200, { removed: n - list.filter(t => t.id !== m[1]).length }); }
    if (req.method === 'PATCH' && (m = url.match(/^\/api\/tournament\/([\w-]+)$/))) {
      const body = await readBody(req); const list = loadAll(); const t = list.find(x => x.id === m[1]); if (!t) return send(res, 404, { error: 'not found' });
      ['name', 'start', 'end', 'location', 'organizer', 'status', 'venues'].forEach(k => { if (body[k] !== undefined) t[k] = body[k]; });
      saveAll(list); return send(res, 200, { entry: t });
    }
    if (url.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(new Date().toISOString(), req.method, url, e.message);
    return send(res, 500, { error: e.message });
  }
});
server.requestTimeout = 10 * 60 * 1000;   // mapping a big sheet can take a few minutes
server.listen(PORT, () => console.log(`SoCal Polo Brackets on http://localhost:${PORT}  (data: ${FILE})`));
