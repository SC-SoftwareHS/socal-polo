/* ============================================================
   Shared model helpers — used by every adapter and by the UI.

   Normalized tournament model that every adapter must produce:

   {
     divisions: [{
       id, name,
       entered: [teamName, ...],                 // from the entry list (may be empty)
       pools:   [{ id, name, kind: 'pool'|'rebracket'|'bracket',
                   slots: [{ seed, name, placeholder, inferred }] }],
       games:   [{ id, num, dayIndex, date, time, minutes, location, label, poolId,
                   white: side, dark: side, score: [whiteGoals|null, darkGoals|null] }],
       venues:  [venueName, ...]
     }],
     notes: [string]                                // parser warnings for the UI footer
   }
   side = { name, placeholder, inferred, raw }
   ============================================================ */
(function (root) {
  'use strict';

  const clean = s => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const norm  = s => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const esc   = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : (n % 10 < 4 ? n % 10 : 0)]);

  function parseCSV(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // "2:40:00 PM", "4:10PM", "6:25", "11:20" -> minutes since midnight. Hours without AM/PM
  // are guessed the way a pool deck reads them: 1-6 is afternoon, 7-11 is morning, 12 is noon.
  function parseTime(text) {
    const m = clean(text).match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([AaPp])\.?[Mm]?\.?$|^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m) return null;
    let h, min, ap = null;
    if (m[1] != null) { h = +m[1]; min = +(m[2] || 0); ap = m[3].toUpperCase(); }
    else { h = +m[4]; min = +m[5]; }
    if (h > 23 || min > 59) return null;
    let explicit = !!ap;
    if (ap === 'P' && h < 12) h += 12;
    if (ap === 'A' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 6) h += 12;
    return { minutes: h * 60 + min, explicit };
  }
  function fmtTime(minutes) {
    if (minutes == null) return '';
    let h = Math.floor(minutes / 60), m = minutes % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')} ${ap}`;
  }

  // "12-5", "12 – 5", "12:5", "W 12-5" -> [12, 5]; anything else -> [null, null]
  function parseScore(text, text2) {
    const a = clean(text), b = clean(text2);
    let m = a.match(/(\d+)\s*[-–—:/]\s*(\d+)/);
    if (m) return [+m[1], +m[2]];
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return [+a, +b];
    return [null, null];
  }

  function outcome(g) {
    const [w, d] = g.score;
    if (w == null || d == null || !g.white.name || !g.dark.name) return null;
    if (w === d) return { tie: true, winner: null, loser: null };
    return w > d ? { winner: g.white.name, loser: g.dark.name } : { winner: g.dark.name, loser: g.white.name };
  }

  // Standings for one pool: `teams` in seed order, `games` the pool-play games (resolved sides).
  // Order: wins, head-to-head (two-way ties), goal difference, goals for, then seed.
  function standings(teams, games) {
    const rows = teams.filter(Boolean).map((t, i) => ({ team: t, seed: i + 1, gp: 0, w: 0, l: 0, t: 0, gf: 0, ga: 0, gd: 0 }));
    const by = Object.fromEntries(rows.map(r => [r.team, r]));
    const played = [];
    let scheduled = 0;
    for (const g of games) {
      const a = by[g.white.name], b = by[g.dark.name];
      if (!a || !b || a === b) continue;
      scheduled++;
      const [sa, sb] = g.score;
      if (sa == null || sb == null) continue;
      played.push(g);
      a.gp++; b.gp++; a.gf += sa; a.ga += sb; b.gf += sb; b.ga += sa;
      if (sa > sb) { a.w++; b.l++; } else if (sb > sa) { b.w++; a.l++; } else { a.t++; b.t++; }
    }
    rows.forEach(r => { r.gd = r.gf - r.ga; r.pts = r.w * 2 + r.t; });
    const h2h = (x, y) => {
      let dx = 0, dy = 0;
      for (const g of played) {
        const names = [g.white.name, g.dark.name];
        if (!names.includes(x.team) || !names.includes(y.team)) continue;
        const o = outcome(g); if (!o || o.tie) continue;
        if (o.winner === x.team) dx++; else dy++;
      }
      return dy - dx;
    };
    rows.sort((x, y) => y.pts - x.pts || h2h(x, y) || y.gd - x.gd || y.gf - x.gf || x.seed - y.seed);
    rows.forEach((r, i) => {
      r.rank = i + 1;
      const prev = rows[i - 1];
      r.tied = !!prev && prev.pts === r.pts && prev.gd === r.gd && prev.gf === r.gf && h2h(prev, r) === 0;
      if (r.tied) prev.tied = true;
    });
    const complete = scheduled > 0 && played.length === scheduled;
    return { rows, complete, scheduled, played: played.length };
  }

  function dateAdd(iso, days) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  function weekdayOf(iso) { return WEEKDAYS[new Date(iso + 'T12:00:00').getDay()]; }
  function fmtDate(iso, opts) {
    const d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, opts || { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtRange(a, b) {
    if (!a) return '';
    const da = new Date(a + 'T12:00:00'), db = new Date((b || a) + 'T12:00:00');
    const mo = d => d.toLocaleDateString(undefined, { month: 'short' });
    if (!b || a === b) return `${mo(da)} ${da.getDate()}, ${da.getFullYear()}`;
    if (da.getMonth() === db.getMonth()) return `${mo(da)} ${da.getDate()}–${db.getDate()}, ${da.getFullYear()}`;
    return `${mo(da)} ${da.getDate()} – ${mo(db)} ${db.getDate()}, ${db.getFullYear()}`;
  }

  const Model = { clean, norm, esc, ordinal, parseCSV, parseTime, fmtTime, parseScore, outcome, standings, dateAdd, weekdayOf, fmtDate, fmtRange, WEEKDAYS };
  root.PoloModel = Model;
  if (typeof module !== 'undefined' && module.exports) module.exports = Model;
})(typeof window !== 'undefined' ? window : globalThis);
