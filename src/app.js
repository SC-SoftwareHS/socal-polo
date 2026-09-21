/* ============================================================
   SoCal Polo Brackets — app shell: routing, live loading, rendering.
   Data comes from window.POLO_MANIFEST + the adapter named by each
   entry's source.type. The UI only ever sees the normalized model.
   ============================================================ */
(function () {
  'use strict';
  const M = window.PoloModel, ADAPTERS = window.PoloAdapters || {}, MANIFEST = window.POLO_MANIFEST || [];
  const { esc, norm, fmtTime, fmtDate, fmtRange } = M;
  const REFRESH_MS = 60 * 1000, GAME_MINUTES = 45;
  const localISO = d => { d = d || new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const state = { data: {}, timers: {}, favorites: store.get('polo:favorites', {}), route: null, server: null, adding: null };

  /* ---------- server-managed tournaments (optional) ---------- */
  async function syncServer() {
    try {
      const res = await fetch('api/manifest', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const { tournaments } = await res.json();
      state.server = true;
      for (const t of tournaments) {
        const i = MANIFEST.findIndex(x => x.id === t.id);
        if (i >= 0) MANIFEST[i] = t; else MANIFEST.unshift(t);
      }
    } catch (e) { state.server = state.server || false; }
  }
  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  async function addTournament(form) {
    const body = { url: form.url.value.trim(), name: form.name.value.trim() || undefined, start: form.start.value || undefined };
    if (!body.url) return;
    state.adding = { since: Date.now(), error: null }; render();
    const tick = setInterval(() => { const el = document.getElementById('addProgress'); if (el) el.textContent = progressText(); }, 1000);
    try {
      const { entry, stats } = await api('POST', 'api/add', body);
      clearInterval(tick); state.adding = null;
      await syncServer();
      delete state.data[entry.id];
      location.hash = href(entry);
      if (stats.warnings && stats.warnings.length) console.warn('mapping warnings', stats.warnings);
    } catch (e) { clearInterval(tick); state.adding = { since: 0, error: e.message }; render(); }
  }
  function progressText() {
    const s = Math.round((Date.now() - state.adding.since) / 1000);
    const step = s < 8 ? 'Reading the sheet tabs…' : s < 240 ? 'Claude is working out the layout (this usually takes 2–5 minutes)…' : 'Still mapping — big sheets take a while…';
    return `${step} ${s}s`;
  }
  async function remapTournament(t) {
    if (!confirm('Re-read this sheet\'s layout with Claude? Takes a few minutes.')) return;
    state.adding = { since: Date.now(), error: null, remap: t.id }; render();
    const tick = setInterval(() => { const el = document.getElementById('addProgress'); if (el) el.textContent = progressText(); }, 1000);
    try { await api('POST', `api/remap/${t.id}`, {}); clearInterval(tick); state.adding = null; await syncServer(); delete state.data[t.id]; store.set('polo:cache:' + t.id, null); render(); }
    catch (e) { clearInterval(tick); state.adding = { since: 0, error: e.message }; render(); }
  }
  async function removeTournament(t) {
    if (!confirm(`Remove "${t.name}" from the board?`)) return;
    await api('DELETE', `api/tournament/${t.id}`);
    const i = MANIFEST.findIndex(x => x.id === t.id); if (i >= 0) MANIFEST.splice(i, 1);
    location.hash = '#/';
  }

  /* ---------- favorites ("My Team") ---------- */
  const favsOf = tid => state.favorites[tid] || [];
  const isFav = (tid, name) => !!name && favsOf(tid).some(f => norm(name).includes(norm(f)));
  function addFav(tid, name) { const n = M.clean(name); if (!n) return; const l = favsOf(tid); if (!l.some(f => norm(f) === norm(n))) l.push(n); state.favorites[tid] = l; store.set('polo:favorites', state.favorites); render(); }
  function removeFav(tid, name) { state.favorites[tid] = favsOf(tid).filter(f => f !== name); store.set('polo:favorites', state.favorites); render(); }
  function toggleFav(tid, name) { favsOf(tid).some(f => f === name) ? removeFav(tid, name) : addFav(tid, name); }

  /* ---------- loading ---------- */
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function fetchText(url, fallback) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sep = url.includes('?') ? '&' : '?';
        const res = await fetch(`${url}${sep}attempt=${attempt}-${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
        if (res.ok) {
          const t = await res.text();
          if (t && !/^\s*<!doctype html/i.test(t)) return t;
        }
        last = new Error(`HTTP ${res.status}`);
      } catch (e) { last = e; }
      if (attempt < 2) await wait(350 * (attempt + 1));
    }
    if (fallback) {
      const res = await fetch(fallback, { cache: 'no-store', credentials: 'omit' });
      if (res.ok) return res.text();
    }
    throw last || new Error('fetch failed');
  }
  async function fetchInBatches(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
      const batch = items.slice(i, i + size);
      out.push(...await Promise.all(batch.map(u => fetchText(u.url, u.fallback).then(text => [u.key, text]).catch(() => [u.key, null]))));
    }
    return out;
  }
  function entry(id) { return state.data[id] || (state.data[id] = { model: null, at: null, status: 'idle', error: null }); }
  function buildFrom(t, csv) {
    const adapter = ADAPTERS[t.source.type];
    return adapter.build(csv, Object.assign({}, t.source, { startDate: t.start }));
  }
  async function load(t, manual) {
    const e = entry(t.id);
    if (t.source.type === 'pending') { e.status = 'pending'; return; }
    if (t.source.type === 'static') { return loadStatic(t); }
    const adapter = ADAPTERS[t.source.type];
    if (!adapter) { e.status = 'error'; e.error = `No adapter for "${t.source.type}"`; render(); return; }
    e.status = 'loading'; renderSync(t);
    try {
      const activeDiv = state.route && state.route.t && state.route.t.id === t.id ? state.route.div : '';
      const urls = adapter.urls(t.source).sort((a, b) => (norm(b.key) === activeDiv) - (norm(a.key) === activeDiv));
      // Google intermittently throttles a burst of nine cross-origin CSV requests.
      // Fetch the active division first and keep concurrency deliberately low.
      const pairs = await fetchInBatches(urls, 3);
      if (pairs.every(p => p[1] == null)) throw new Error('unreachable');
      const csv = Object.fromEntries(pairs);
      const model = buildFrom(t, csv);
      if (!model.divisions.length) throw new Error('nothing parsed');
      e.model = model; e.at = Date.now(); e.status = 'ok'; e.error = null; e.fromCache = false;
      store.set('polo:cache:' + t.id, { at: e.at, csv });
    } catch (err) {
      e.status = 'error'; e.error = err.message;
      if (!e.model) restoreCache(t);
    }
    render();
  }
  function restoreCache(t) {
    const c = store.get('polo:cache:' + t.id, null);
    if (!c || !c.csv || !ADAPTERS[t.source.type]) return false;
    try { const e = entry(t.id); e.model = buildFrom(t, c.csv); e.at = c.at; e.fromCache = true; return true; } catch (err) { return false; }
  }
  function loadStatic(t) {
    const e = entry(t.id);
    if (window.POLO_STATIC && window.POLO_STATIC[t.id]) { e.model = window.POLO_STATIC[t.id]; e.status = 'ok'; e.at = Date.now(); render(); return; }
    e.status = 'loading';
    const s = document.createElement('script');
    s.src = `data/${t.id}.js`;
    s.onload = () => { e.model = (window.POLO_STATIC || {})[t.id] || null; e.status = e.model ? 'ok' : 'error'; e.error = e.model ? null : 'data file did not register'; e.at = Date.now(); render(); };
    s.onerror = () => { e.status = 'error'; e.error = `data/${t.id}.js not found`; render(); };
    document.head.appendChild(s);
  }
  function watch(t) {
    for (const id of Object.keys(state.timers)) if (id !== t.id) { clearInterval(state.timers[id]); delete state.timers[id]; }
    if (state.timers[t.id]) return;
    state.timers[t.id] = setInterval(() => { if (document.visibilityState === 'visible') load(t, false); }, REFRESH_MS);
  }

  /* ---------- derived ---------- */
  function tournamentPhase(t) {
    const today = localISO();
    if (t.status === 'pending') return 'pending';
    if (t.start && t.end && today >= t.start && today <= t.end) return 'live';
    if (t.start && today < t.start) return 'upcoming';
    if (t.end && today > t.end) return 'completed';
    return t.status || 'upcoming';
  }
  function gameStart(g) { return g.date && g.minutes != null ? new Date(g.date + 'T00:00:00').getTime() + g.minutes * 60000 : null; }
  function gameState(g) {
    const scored = g.score[0] != null && g.score[1] != null;
    if (scored) return 'final';
    const s = gameStart(g), now = Date.now();
    if (s != null && now >= s && now < s + GAME_MINUTES * 60000 && g.white.name && g.dark.name) return 'live';
    if (!g.white.name || !g.dark.name) return 'tbd';
    return 'upcoming';
  }
  function sortGames(a, b) { return (a.day - b.day) || ((a.minutes ?? 9e9) - (b.minutes ?? 9e9)) || (a.num - b.num); }
  // Teams as the sheet's pools spell them, plus any entered team that never made it into a pool.
  // Game rows are not used: organizers abbreviate there ("Laguna" for "Laguna Beach").
  function teamsOf(div) {
    const pool = new Set();
    div.pools.forEach(p => p.slots.forEach(sl => { if (sl.name && !sl.inferred) pool.add(sl.name); }));
    const initials = x => M.clean(x).split(' ').map(w => w[0] || '').join('').toLowerCase();
    const fuzzyHas = n => [...pool].some(x => norm(x) === norm(n) || norm(x).includes(norm(n)) || norm(n).includes(norm(x)) || initials(x) === norm(n) || initials(n) === norm(x));
    const extra = (div.entered || []).filter(n => !fuzzyHas(n));
    if (!pool.size && !extra.length) div.games.forEach(g => { if (g.white.name) pool.add(g.white.name); if (g.dark.name) pool.add(g.dark.name); });
    return [...pool].sort((a, b) => a.localeCompare(b)).concat(extra.sort((a, b) => a.localeCompare(b)));
  }
  function venueFor(t, text) {
    if (!text) return null;
    return (t.venues || []).find(v => new RegExp(v.match, 'i').test(text)) || null;
  }
  const mapsUrl = v => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.address || v.name);
  const isPlacement = g => /\b(\d{1,2}(st|nd|rd|th)|place|final|semi|champ|quarter|consol)/i.test(g.label || '');

  /* ---------- routing ---------- */
  function parseRoute() {
    let h = (location.hash || '#/').replace(/^#/, '');
    const q = h.indexOf('?');
    if (q >= 0) {
      const params = new URLSearchParams(h.slice(q + 1)); h = h.slice(0, q);
      const tid = (h.match(/^\/t\/([^/]+)/) || [])[1];
      const follow = (params.get('follow') || '').split(',').map(x => M.clean(x)).filter(Boolean);
      if (tid && follow.length) {
        const l = favsOf(tid); follow.forEach(n => { if (!l.some(f => norm(f) === norm(n))) l.push(n); });
        state.favorites[tid] = l; store.set('polo:favorites', state.favorites);
        history.replaceState(null, '', '#' + h);
      }
    }
    const parts = h.split('/').filter(Boolean);
    if (parts[0] !== 't' || !parts[1]) return { page: 'home' };
    const t = MANIFEST.find(x => x.id === parts[1]);
    if (!t) return { page: 'home' };
    const last = store.get('polo:last:' + t.id, {});
    let div = parts[2] || last.div || '', view = parts[3] || last.view || 'schedule';
    if (div === 'mine') { view = 'mine'; }
    return { page: 'tournament', t, div, view, day: parts[4] || null };
  }
  const href = (t, div, view, day) => `#/t/${t.id}` + (div ? `/${div}` : '') + (view ? `/${view}` : '') + (day ? `/${day}` : '');
  function go(t, div, view, day) { location.hash = href(t, div, view, day); }

  /* ---------- rendering ---------- */
  const app = document.getElementById('app'), foot = document.getElementById('foot'), topActions = document.getElementById('topActions');

  function render() {
    const r = state.route = parseRoute();
    if (r.page === 'home') renderHome(); else renderTournament(r);
  }

  function renderHome() {
    topActions.innerHTML = '';
    const groups = { live: [], upcoming: [], completed: [], pending: [] };
    MANIFEST.forEach(t => (groups[tournamentPhase(t)] || groups.upcoming).push(t));
    const card = t => {
      const e = entry(t.id), m = e.model, ph = tournamentPhase(t);
      const counts = m ? `${m.divisions.length} division${m.divisions.length === 1 ? '' : 's'} · ${m.divisions.reduce((n, d) => n + teamsOf(d).length, 0)} teams · ${m.divisions.reduce((n, d) => n + d.games.length, 0)} games` : (ph === 'pending' ? 'Schedule source not connected yet' : (t.source.type === 'pending' ? '' : 'Loading…'));
      const pill = { live: '<span class="pill live">Live</span>', upcoming: '<span class="pill soon">Upcoming</span>', completed: '<span class="pill done">Final</span>', pending: '<span class="pill need">Needs source</span>' }[ph];
      return `<a class="tcard ${ph === 'pending' ? 'pending' : ''}" href="${href(t)}"><div class="tcard-top"><h3>${esc(t.name)}</h3>${pill}</div>
        <div class="meta">${esc(fmtRange(t.start, t.end) || 'Dates TBA')} · ${esc(t.location || '')}${t.organizer ? ' · ' + esc(t.organizer) : ''}</div>
        <div class="counts">${esc(counts)}</div></a>`;
    };
    const section = (title, list) => list.length ? `<div class="section-title">${title}</div><div class="grid">${list.map(card).join('')}</div>` : '';
    const addBox = state.server ? `
      <div class="card add-card"><div class="card-h"><span class="card-t">Add a tournament</span><span class="card-s">Paste the organizer's Google Sheet link. Claude maps the layout once; scores then stream live.</span></div>
      ${state.adding && !state.adding.error ? `<div class="empty"><span class="spinner"></span> <span id="addProgress">${progressText()}</span></div>` : `
      <form class="add-form" id="addForm">
        <input name="url" type="url" required placeholder="https://docs.google.com/spreadsheets/d/…" aria-label="Google Sheet link">
        <input name="name" type="text" placeholder="Tournament name (optional)" aria-label="Tournament name">
        <input name="start" type="date" aria-label="Start date (optional)" title="Start date (optional)">
        <button class="btn primary" type="submit">Map it</button>
      </form>${state.adding && state.adding.error ? `<div class="note warn">${esc(state.adding.error)}</div>` : ''}
      <div class="card-s" style="padding:0 14px 12px">The sheet must be shared as “Anyone with the link can view”. Mapping takes a few minutes and costs well under a dollar.</div>`}</div>` : '';
    app.innerHTML = `
      <div class="hero"><h1>Southern California water polo, one bracket board.</h1>
      <p>Every tournament below is read live from its organizer's own schedule sheet, so scores, pool standings and next-round matchups update the moment the table workers type them in.</p></div>
      ${addBox}
      ${section('Happening now', groups.live)}${section('Coming up', groups.upcoming)}${section('Completed', groups.completed)}${section('Waiting on a schedule source', groups.pending)}`;
    foot.innerHTML = state.server ? `Tournaments added here are mapped by Claude and re-read from their sheets every minute.` : `Add a tournament by listing its schedule in <code>data/manifest.js</code>, or run the server (<code>node server/index.js</code>) to add sheets from this page.`;
    const f = document.getElementById('addForm'); if (f) f.onsubmit = ev => { ev.preventDefault(); addTournament(f); };
    // Warm the cards for live events.
    groups.live.concat(groups.upcoming).forEach(t => { const e = entry(t.id); if (e.status === 'idle' && t.source.type !== 'pending') { if (!restoreCache(t)) { /* nothing cached */ } load(t, false); } });
  }

  function renderSync(t) {
    const el = document.getElementById('sync'); if (!el) return;
    const e = entry(t.id);
    const at = e.at ? new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    let cls = 'ok', text = '';
    if (e.status === 'loading' && !e.model) { cls = 'loading'; text = 'Reading the schedule sheet…'; }
    else if (e.status === 'loading') { cls = 'loading'; text = `Checking for updates · last read ${at}`; }
    else if (e.status === 'error') { cls = 'error'; text = e.model ? `Can't reach the sheet right now · showing data from ${at}` : `Can't reach the sheet (${e.error || 'unknown error'})`; }
    else if (e.status === 'ok') { text = `Live from the sheet · updated ${at}`; }
    else if (e.status === 'pending') { cls = 'error'; text = 'No schedule source connected'; }
    el.className = 'sync ' + cls;
    el.querySelector('.sync-text').textContent = text;
  }

  function renderTournament(r) {
    const { t } = r, e = entry(t.id);
    if (e.status === 'idle') { if (!restoreCache(t)) { /* first visit */ } load(t, false); }
    if (t.source.type !== 'pending') watch(t);
    store.set('polo:last:' + t.id, { div: r.view === 'mine' ? '' : r.div, view: r.view });
    const m = e.model;
    const favCount = favsOf(t.id).length;
    topActions.innerHTML = `<a class="top-btn star" href="${href(t, 'mine')}">★ My Team${favCount ? ` (${favCount})` : ''}</a>`;

    const divs = m ? m.divisions : [];
    const teamCount = divs.reduce((n, d) => n + teamsOf(d).length, 0), gameCount = divs.reduce((n, d) => n + d.games.length, 0);
    const meta = [fmtRange(t.start, t.end) || 'Dates TBA', t.location, t.organizer ? `Hosted by ${t.organizer}` : ''].filter(Boolean).join(' · ');
    const head = `
      <div class="thead">
        <a class="crumb" href="#/">← All tournaments</a>
        <div class="eyebrow">Tournament central</div>
        <h1>${esc(t.name)}</h1>
        <div class="meta">${esc(meta)}</div>
        ${m ? `<div class="event-stats">
          <div class="event-stat"><strong>${divs.length}</strong><span>Divisions</span></div>
          <div class="event-stat"><strong>${teamCount}</strong><span>Teams</span></div>
          <div class="event-stat"><strong>${gameCount}</strong><span>Games</span></div>
        </div>` : ''}
        <div class="sync" id="sync"><span class="dot"></span><span class="sync-text"></span>
          ${t.source.type !== 'pending' ? '<button class="btn" id="refreshBtn" type="button">Refresh</button>' : ''}
          ${t.sheetUrl ? `<a class="btn" href="${esc(t.sheetUrl)}" target="_blank" rel="noopener">Open source sheet</a>` : ''}
          ${t.managed && state.server ? `<button class="btn" id="remapBtn" type="button" title="Mapped ${esc(t.mappedAt ? new Date(t.mappedAt).toLocaleString() : '')}">Re-map layout</button><button class="btn" id="removeBtn" type="button">Remove</button>` : ''}
        </div>
        ${state.adding && state.adding.remap === t.id && !state.adding.error ? `<div class="note"><span class="spinner"></span> <span id="addProgress">${progressText()}</span></div>` : ''}
        ${state.adding && state.adding.remap === t.id && state.adding.error ? `<div class="note warn">${esc(state.adding.error)}</div>` : ''}
        ${t.warnings && t.warnings.length ? `<div class="note warn"><strong>Mapping notes:</strong> ${esc(t.warnings.join(' · '))}</div>` : ''}
      </div>`;

    if (t.source.type === 'pending') {
      app.innerHTML = head + `<div class="note warn"><strong>This tournament is listed but has no schedule source yet.</strong><br>${esc(t.source.note || '')}</div>`;
      renderSync(t); foot.innerHTML = ''; return;
    }
    if (!m) {
      app.innerHTML = head + `<div class="empty">${e.status === 'error' ? 'The schedule sheet could not be reached. It will retry automatically.' : 'Reading the schedule sheet…'}</div>`;
      renderSync(t); wire(t); foot.innerHTML = ''; return;
    }

    let div = divs.find(d => d.id === r.div) || null;
    if (r.view !== 'mine' && !div) div = divs[0];
    const chips = `<nav class="chips" aria-label="Divisions">
      <a class="chip star ${r.view === 'mine' ? 'active' : ''}" href="${href(t, 'mine')}">★ Mine</a>
      ${divs.map(d => `<a class="chip ${div === d && r.view !== 'mine' ? 'active' : ''}" href="${href(t, d.id, r.view === 'mine' ? 'schedule' : r.view)}">${esc(d.name)}<small>${teamsOf(d).length}</small></a>`).join('')}
    </nav>`;

    let body = '';
    if (r.view === 'mine') body = renderMine(t, m);
    else {
      const views = [['schedule', 'Schedule'], ['standings', 'Standings'], ['playoffs', 'Playoffs'], ['teams', 'Teams'], ['venues', 'Venues']];
      const tabs = `<nav class="tabs">${views.map(([id, label]) => `<a class="tab ${r.view === id ? 'active' : ''}" href="${href(t, div.id, id)}">${label}</a>`).join('')}</nav>`;
      const panel = { schedule: renderSchedule, standings: renderStandings, playoffs: renderPlayoffs, teams: renderTeams, venues: renderVenues }[r.view] || renderSchedule;
      body = `<div class="nav-deck">${chips}${tabs}</div>` + panel(t, m, div, r);
    }
    app.innerHTML = head + (r.view === 'mine' ? `<div class="nav-deck">${chips}</div>` : '') + body;
    renderSync(t); wire(t);
    const notes = (m.notes || []).filter(Boolean);
    foot.innerHTML = `Read live from <a href="${esc(t.sheetUrl)}" target="_blank" rel="noopener">the organizer's sheet</a> and re-checked every minute. Names tagged <em>auto</em> were worked out from entered scores before the organizer filled them in. Cap colors: <span class="cap white" style="display:inline-block;vertical-align:middle"></span> white, <span class="cap dark" style="display:inline-block;vertical-align:middle"></span> dark.${notes.length ? `<br><span style="color:var(--live)">Parser notes: ${esc(notes.join(' · '))}</span>` : ''}`;
  }

  function wire(t) {
    const b = document.getElementById('refreshBtn'); if (b) b.onclick = () => load(t, true);
    const rm = document.getElementById('remapBtn'); if (rm) rm.onclick = () => remapTournament(t);
    const rv = document.getElementById('removeBtn'); if (rv) rv.onclick = () => removeTournament(t);
    app.querySelectorAll('[data-fav]').forEach(el => el.onclick = ev => { ev.preventDefault(); toggleFav(t.id, el.dataset.fav); });
    app.querySelectorAll('[data-unfav]').forEach(el => el.onclick = () => removeFav(t.id, el.dataset.unfav));
    const f = document.getElementById('favForm'); if (f) f.onsubmit = ev => { ev.preventDefault(); const i = f.querySelector('input'); addFav(t.id, i.value); i.value = ''; };
    app.querySelectorAll('[data-day]').forEach(el => el.onclick = () => { const r = state.route; go(t, r.div || (entry(t.id).model.divisions[0] || {}).id, 'schedule', el.dataset.day); });
  }

  /* ---------- panels ---------- */
  function teamHtml(t, side, won) {
    const fav = isFav(t.id, side.name);
    const cls = ['team', fav ? 'fav' : '', won ? 'won' : '', !side.name ? 'tbd' : '', side.inferred ? 'auto' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}"><span class="cap ${side.cap || ''}" title="${side.cap || ''} caps"></span><span class="name" title="${esc(side.raw || '')}">${esc(side.name || side.placeholder || 'TBD')}</span></div>`;
  }
  function gameHtml(t, g, opts) {
    opts = opts || {};
    const st = gameState(g), o = M.outcome(g);
    const wonW = o && o.winner === g.white.name && !o.tie, wonD = o && o.winner === g.dark.name && !o.tie;
    const fav = isFav(t.id, g.white.name) || isFav(t.id, g.dark.name);
    const v = venueFor(t, g.location);
    const loc = g.location && opts.showLoc ? `<div class="g-loc">${v ? `<a href="${mapsUrl(v)}" target="_blank" rel="noopener">📍 ${esc(g.location)}</a>` : esc(g.location)}</div>` : '';
    const score = st === 'final'
      ? `<span class="${wonW ? 'won' : ''}">${g.score[0]}</span><span class="${wonD ? 'won' : ''}">${g.score[1]}</span>`
      : `<span class="pending ${st === 'live' ? 'live' : (opts.next ? 'next' : '')}">${st === 'live' ? 'In progress' : (opts.next ? 'Next up' : (st === 'tbd' ? 'TBD' : 'Upcoming'))}</span>`;
    return `<div class="game ${fav ? 'fav' : ''} ${st === 'live' ? 'live' : ''}">
      <div class="g-when"><span class="g-time">${esc(fmtTime(g.minutes) || '—')}</span><span class="g-num">${opts.showDay ? esc(fmtDate(g.date) + ' · ') : ''}Game ${esc(g.num)}${g.block && opts.showLoc ? ' · ' + esc(g.block) : ''}</span>${g.label ? `<span class="g-label">${esc(g.label)}</span>` : ''}</div>
      <div class="g-teams">${teamHtml(t, g.white, wonW)}${teamHtml(t, g.dark, wonD)}${opts.showDiv ? `<div class="g-loc">${esc(opts.showDiv)}</div>` : ''}${loc}</div>
      <div class="g-score">${score}</div></div>`;
  }
  function dayList(div) {
    const map = new Map();
    div.games.forEach(g => { if (!map.has(g.day)) map.set(g.day, { day: g.day, date: g.date, label: g.dayLabel }); });
    return [...map.values()].sort((a, b) => a.day - b.day);
  }
  function nowStrip(t, div) {
    const games = div.games.slice().sort(sortGames);
    const live = games.filter(g => gameState(g) === 'live');
    const now = Date.now();
    const next = games.find(g => gameState(g) === 'upcoming' && (gameStart(g) == null || gameStart(g) > now - GAME_MINUTES * 60000));
    const card = (k, g, cls) => `<div class="now-card"><div class="k ${cls || ''}">${k}</div><div class="m">${esc(g.white.name || g.white.placeholder)} <span style="opacity:.7">v</span> ${esc(g.dark.name || g.dark.placeholder)}</div><div class="d">${esc(fmtDate(g.date))} · ${esc(fmtTime(g.minutes))} · Game ${esc(g.num)}${g.label ? ' · ' + esc(g.label) : ''}${g.location ? ' · ' + esc(g.location) : ''}</div></div>`;
    const parts = live.slice(0, 2).map(g => card('In the water now', g, 'live'));
    if (next && !live.includes(next)) parts.push(card('Next up', next));
    return parts.length ? `<div class="now">${parts.join('')}</div>` : '';
  }
  function renderSchedule(t, m, div, r) {
    const days = dayList(div);
    const today = localISO();
    let sel = r.day || null;
    if (!sel) { const d = days.find(x => x.date === today) || days.find(x => div.games.some(g => g.day === x.day && gameState(g) !== 'final')) || days[0]; sel = d ? String(d.day) : 'all'; }
    const sub = `<div class="subtabs">${days.map(d => `<button type="button" class="subtab ${sel === String(d.day) ? 'active' : ''}" data-day="${d.day}">Day ${d.day}<small>${esc(d.date ? fmtDate(d.date) : d.label)}</small></button>`).join('')}<button type="button" class="subtab ${sel === 'all' ? 'active' : ''}" data-day="all">All<small>${div.games.length} games</small></button></div>`;
    const list = div.games.filter(g => sel === 'all' || String(g.day) === sel).sort(sortGames);
    const now = Date.now();
    const next = list.find(g => gameState(g) === 'upcoming' && (gameStart(g) == null || gameStart(g) > now - GAME_MINUTES * 60000));
    // Group by location so a family can see one pool's whole day.
    const byLoc = new Map();
    list.forEach(g => { const k = g.location || 'Schedule'; if (!byLoc.has(k)) byLoc.set(k, []); byLoc.get(k).push(g); });
    const cards = [...byLoc.entries()].map(([loc, games]) => {
      const v = venueFor(t, loc);
      return `<div class="card"><div class="card-h"><div><span class="card-t">${esc(loc)}</span>${v ? `<div class="card-s">${esc(v.name)}</div>` : ''}</div>${v ? `<a href="${mapsUrl(v)}" target="_blank" rel="noopener">📍 Directions</a>` : ''}</div>${games.map(g => gameHtml(t, g, { next: g === next, showDay: sel === 'all' })).join('')}</div>`;
    }).join('');
    return nowStrip(t, div) + sub + (cards || '<div class="empty">No games listed yet.</div>');
  }
  function standingsTable(t, p) {
    const st = p.standings || M.standings(p.teams || [], []);
    const rows = st.rows.map(r => `<tr class="${isFav(t.id, r.team) ? 'fav' : ''} ${r.tied && r.gp > 0 ? 'tied' : ''}"><td class="rank">${r.rank}</td><td class="team">${esc(r.team)}</td><td class="n">${r.gp}</td><td class="n">${r.w}</td><td class="n">${r.l}</td><td class="n">${r.t}</td><td class="n">${r.gf}</td><td class="n">${r.ga}</td><td class="n">${r.gd > 0 ? '+' : ''}${r.gd}</td></tr>`).join('');
    const slots = p.slots.filter(s => !s.name).map(s => `<li><span>${esc(s.placeholder || 'TBD')}</span><span class="card-s">seed ${s.seed}</span></li>`).join('');
    const status = !st.scheduled ? (p.kind === 'bracket' ? 'Seeded bracket' : (p.kind === 'rebracket' ? 'Filled from pool results' : 'No round-robin games')) : (st.complete ? 'Final' : `${st.played} of ${st.scheduled} games played`);
    return `<div class="card"><div class="card-h"><span class="card-t">${esc(p.name)}</span><span class="card-s">${status}</span></div>
      ${rows ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Team</th><th class="n">GP</th><th class="n">W</th><th class="n">L</th><th class="n">T</th><th class="n">GF</th><th class="n">GA</th><th class="n">+/-</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      ${slots ? `<ul class="list">${slots}</ul>` : ''}</div>`;
  }
  function renderStandings(t, m, div) {
    const pools = div.pools.filter(p => p.kind !== 'bracket'), brackets = div.pools.filter(p => p.kind === 'bracket');
    const placements = div.games.filter(g => isPlacement(g) && gameState(g) === 'final').sort((a, b) => (parseInt(a.label) || 99) - (parseInt(b.label) || 99));
    const results = placements.length ? `<div class="card"><div class="card-h"><span class="card-t">Placement results</span></div>${placements.map(g => gameHtml(t, g, { showDay: true, showLoc: true })).join('')}</div>` : '';
    const seeds = brackets.map(p => `<div class="card"><div class="card-h"><span class="card-t">${esc(p.name)}</span><span class="card-s">Seeds</span></div><ul class="list">${p.slots.map(s => `<li><span class="${isFav(t.id, s.name) ? 'team fav' : ''}"><strong>${esc(s.name || s.placeholder)}</strong></span><span class="card-s">seed ${s.seed}</span></li>`).join('')}</ul></div>`).join('');
    return `<div class="legend"><span>Ties break on head-to-head, then goal difference, then goals for.</span><span>A <sup>T</sup> next to a rank means teams are still tied.</span></div>` + results + (pools.map(p => standingsTable(t, p)).join('') || '') + seeds + (!pools.length && !seeds ? '<div class="empty">No pools found for this division.</div>' : '');
  }
  function renderPlayoffs(t, m, div) {
    const games = div.games.filter(g => isPlacement(g) || (!g.poolId && (g.white.raw || '').match(/win|los|\d(st|nd|rd|th)/i)) || (!g.poolId && (g.dark.raw || '').match(/win|los|\d(st|nd|rd|th)/i))).sort(sortGames);
    if (!games.length) return '<div class="empty">No bracket or placement games in this division — it is a straight round robin. See Standings.</div>';
    const byDay = new Map();
    games.forEach(g => { const k = g.day; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(g); });
    return `<div class="legend"><span>Bracket and placement games, in order. Matchups fill in automatically as pool play and earlier rounds finish.</span></div>` +
      [...byDay.entries()].map(([day, list]) => `<div class="card"><div class="card-h"><span class="card-t">Day ${day} · ${esc(list[0].date ? fmtDate(list[0].date) : '')}</span><span class="card-s">${list.length} games</span></div>${list.map(g => gameHtml(t, g, { showLoc: true })).join('')}</div>`).join('');
  }
  function renderTeams(t, m, div) {
    const teams = teamsOf(div);
    const favs = favsOf(t.id);
    return `<div class="note">Star a team to highlight its games everywhere and collect them under <strong>★ Mine</strong>. Starring a club name (like “Shores”) matches every team containing it.</div>
      <div class="card"><div class="card-h"><span class="card-t">${esc(div.name)} · ${teams.length} teams</span></div>
      <ul class="list">${teams.map(n => `<li><span class="${isFav(t.id, n) ? 'team fav' : ''}"><span class="name">${esc(n)}</span></span><button type="button" class="star-btn ${favs.includes(n) ? 'on' : ''}" data-fav="${esc(n)}">${favs.includes(n) ? '★ Starred' : '☆ Star'}</button></li>`).join('')}</ul></div>`;
  }
  function renderVenues(t, m, div) {
    const locs = new Map();
    m.divisions.forEach(d => d.games.forEach(g => { if (!g.location) return; const k = g.location; if (!locs.has(k)) locs.set(k, { n: 0, divs: new Set() }); locs.get(k).n++; locs.get(k).divs.add(d.name); }));
    const groups = new Map();
    [...locs.entries()].forEach(([loc, info]) => { const v = venueFor(t, loc); const key = v ? v.name : loc; if (!groups.has(key)) groups.set(key, { v, locs: [] }); groups.get(key).locs.push({ loc, ...info }); });
    if (!groups.size) return '<div class="empty">No locations listed in the sheet yet.</div>';
    return [...groups.entries()].map(([name, g]) => `<div class="card"><div class="card-h"><div><span class="card-t">${esc(name)}</span>${g.v ? `<div class="card-s">${esc(g.v.address)}</div>` : ''}</div>${g.v ? `<a href="${mapsUrl(g.v)}" target="_blank" rel="noopener">📍 Directions</a>` : ''}</div>
      <ul class="list">${g.locs.map(l => `<li><span>${esc(l.loc)}</span><span class="card-s">${l.n} games · ${esc([...l.divs].join(', '))}</span></li>`).join('')}</ul></div>`).join('');
  }
  function renderMine(t, m) {
    const favs = favsOf(t.id);
    const editor = `<div class="note">Type a team or club name to follow it across every division. Starred names are saved on this device only.</div>
      <form class="fav-editor" id="favForm">${favs.map(f => `<span class="fav-chip">${esc(f)}<button type="button" data-unfav="${esc(f)}" aria-label="Remove">×</button></span>`).join('')}<input type="text" placeholder="Add a team or club, e.g. Shores" aria-label="Team name"><button class="btn primary" type="submit">Follow</button></form>`;
    if (!favs.length) return editor + '<div class="empty">No teams followed yet.</div>';
    const games = [];
    m.divisions.forEach(d => d.games.forEach(g => { if (isFav(t.id, g.white.name) || isFav(t.id, g.dark.name)) games.push({ g, d }); }));
    games.sort((a, b) => sortGames(a.g, b.g));
    if (!games.length) return editor + '<div class="empty">None of the followed names appear in this tournament yet.</div>';
    const now = Date.now();
    const next = (games.find(x => gameState(x.g) === 'upcoming' && (gameStart(x.g) == null || gameStart(x.g) > now - GAME_MINUTES * 60000)) || {}).g;
    const byDay = new Map();
    games.forEach(x => { const k = x.g.day; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(x); });
    const record = favs.map(f => {
      let w = 0, l = 0, tie = 0;
      games.forEach(({ g }) => { const o = M.outcome(g); if (!o) return; const mine = [g.white.name, g.dark.name].find(n => norm(n).includes(norm(f))); if (!mine) return; if (o.tie) tie++; else if (o.winner === mine) w++; else l++; });
      return `<span class="fav-chip" style="background:var(--card-2);color:var(--text);border:1px solid var(--line)">${esc(f)} · ${w}-${l}${tie ? '-' + tie : ''}</span>`;
    }).join(' ');
    return editor + `<div class="fav-editor">${record}</div>` + [...byDay.entries()].map(([day, list]) => `<div class="card"><div class="card-h"><span class="card-t">Day ${day} · ${esc(list[0].g.date ? fmtDate(list[0].g.date) : '')}</span><span class="card-s">${list.length} games</span></div>${list.map(({ g, d }) => gameHtml(t, g, { next: g === next, showDiv: d.name, showLoc: true })).join('')}</div>`).join('');
  }

  /* ---------- boot ---------- */
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.route && state.route.t) load(state.route.t, false); });
  setInterval(() => { if (state.route && state.route.page === 'tournament') render(); }, 30 * 1000);   // keep "In progress" honest between fetches
  render();
  syncServer().then(() => render());
})();
