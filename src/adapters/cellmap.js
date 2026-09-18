/* ============================================================
   Adapter: "cellmap" — the universal adapter.

   A one-time mapping step (server/mapper.js, done by Claude) turns any
   organizer's sheet into a MAP: which cells hold each game's teams,
   score, time and place, and which cells seed each pool. This adapter
   then re-reads those cells from the live CSV on every refresh, so the
   layout is understood once and scores flow through deterministically.

   Map shape (produced by the mapper, stored in the manifest entry):
   {
     divisions: [{
       id, name, tab,                       // tab = exact sheet tab name
       entered: [teamName],
       pools: [{ id, name, kind, slots: [{ seed, cell? , text? }] }],
       games: [{
         num, block?, day, date?, timeCell? | time?,
         whiteCell?, darkCell?  |  matchupCell? + firstIs ('dark'|'white'),
         scoreCell? + scoreOrder ('white-dark'|'dark-white'|'first-second')  |  whiteScoreCell? + darkScoreCell?,
         locationCell? | location?, labelCell? | label?
       }]
     }]
   }
   ============================================================ */
(function (root) {
  'use strict';
  const M = root.PoloModel || (typeof require !== 'undefined' ? require('../model.js') : null);
  const { clean, norm, parseTime, parseScore, standings, outcome, ordinal, dateAdd, weekdayOf, WEEKDAYS } = M;

  // "B9" -> [row 8, col 1]
  function cellRef(ref) {
    const m = String(ref || '').trim().toUpperCase().match(/^([A-Z]{1,3})(\d{1,5})$/);
    if (!m) return null;
    let col = 0; for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return [+m[2] - 1, col - 1];
  }
  function readCell(rows, ref) {
    const rc = cellRef(ref); if (!rc) return '';
    return clean((rows[rc[0]] || [])[rc[1]]);
  }

  // Side text in every dialect we have met so far.
  function parseSide(text) {
    const raw = clean(text);
    const side = { raw, name: '', ref: null };
    let s = raw, m;
    if (!s || /^(tbd|tba|bye)$/i.test(s)) { side.placeholder = s.toUpperCase() || 'TBD'; return side; }
    // "(WG1) Mira Costa", "(LG9 Foothill)", "(W#3)": a game reference, optionally followed by the name once known
    if ((m = s.match(/^\(\s*([WL])\s*G?\s*#?\s*(\d+)\s*([^)]*)\)\s*(.*)$/i))) {
      const rest = clean(m[4]).replace(/^[-–:]\s*/, '');
      if (rest && !/^\d+$/.test(rest)) { side.name = rest.replace(/^\d{1,2}\s+/, ''); return side; }
      side.ref = { kind: 'game', which: m[1].toUpperCase() === 'W' ? 'win' : 'lose', game: +m[2], hint: clean(m[3]) }; return side;
    }
    if ((m = s.match(/^(\d{1,2})\s+(.+)$/)) && !/^\d{1,2}\s+\d/.test(s)) s = m[2];             // "4 Mira Costa" -> seed stripped
    if ((m = s.match(/^([A-Z]{1,3})\s*(\d{1,2})$/i)))                       { side.ref = { kind: 'slot', pool: m[1].toUpperCase(), n: +m[2] }; return side; }
    if ((m = s.match(/^(\d{1,2})$/)))                                       { side.ref = { kind: 'slot', pool: '_', n: +m[1] }; return side; }
    if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)\s+(?:place\s+)?(?:pool\s+|group\s+)?([A-Z]{1,3})\b\s*(.*)$/i))) { side.ref = { kind: 'rank', pool: m[2].toUpperCase(), rank: +m[1], hint: clean(m[3]) }; return side; }
    if ((m = s.match(/^(win(?:ner)?|los(?:er|s))\s*(?:of)?\s*(?:game|gm|g)?\s*#?\s*(\d{1,3})\s*(.*)$/i))) { side.ref = { kind: 'game', which: /^w/i.test(m[1]) ? 'win' : 'lose', game: +m[2], hint: clean(m[3]).replace(/^[()]|[()]$/g, '') }; return side; }
    if ((m = s.match(/^(win(?:ner)?|los(?:er|s))\s*(?:of)?\s*(.+)$/i)))    { side.ref = { kind: 'label', which: /^w/i.test(m[1]) ? 'win' : 'lose', label: norm(m[2]) }; return side; }
    side.name = s;
    return side;
  }
  // "3:00 PM", "1. 2:40 PM", "11.11:20", "1 8:00", "4.4:20" -> parsed time or null
  function parseTimeCell(text) {
    const s = clean(text);
    const tries = [s, s.replace(/^\d{1,3}\s*[.)]\s*/, ''), s.replace(/^\d{1,3}\s+/, ''), s.replace(/^(?:game|gm|g)?\s*#?\d{1,3}\s*[.):-]?\s*/i, '')];
    for (const cand of tries) { const t = parseTime(cand); if (t) return t; }
    return null;
  }
  function splitMatchup(text) { return clean(text).split(/\s+vs?\.?\s+/i); }

  function readDivision(rows, dm, cfg) {
    const div = { id: dm.id || norm(dm.name || dm.tab), name: dm.name || dm.tab, tab: dm.tab, entered: (dm.entered || []).slice(), aliases: dm.aliases || {}, pools: [], games: [], venues: [] };
    for (const pm of dm.pools || []) {
      const pool = { id: String(pm.id || '').toUpperCase() || '_', name: pm.name || `Pool ${pm.id}`, kind: pm.kind || 'pool', slots: [] };
      (pm.slots || []).forEach((sm, i) => {
        const text = sm.cell ? readCell(rows, sm.cell) : clean(sm.text);
        const side = parseSide(text);
        pool.slots[i] = { seed: sm.seed || i + 1, side, name: side.name, placeholder: side.name ? '' : (side.raw || `${pool.id}${sm.seed || i + 1}`) };
      });
      div.pools.push(pool);
    }
    let auto = 0;
    for (const gm of dm.games || []) {
      let whiteText, darkText;
      if (gm.matchupCell) {
        const parts = splitMatchup(readCell(rows, gm.matchupCell));
        const first = parts[0] || '', second = parts[1] || '';
        if ((gm.firstIs || 'dark') === 'dark') { darkText = first; whiteText = second; } else { whiteText = first; darkText = second; }
      } else { whiteText = gm.whiteCell ? readCell(rows, gm.whiteCell) : clean(gm.white); darkText = gm.darkCell ? readCell(rows, gm.darkCell) : clean(gm.dark); }
      let score = [null, null];
      if (gm.whiteScoreCell || gm.darkScoreCell) {
        const w = readCell(rows, gm.whiteScoreCell), d = readCell(rows, gm.darkScoreCell);
        score = [/^\d+$/.test(w) ? +w : null, /^\d+$/.test(d) ? +d : null];
        if (score[0] == null && score[1] == null) { const p = parseScore(w || d); score = p; }
      } else if (gm.scoreCell) {
        const p = parseScore(readCell(rows, gm.scoreCell));
        const order = gm.scoreOrder || 'white-dark';
        if (order === 'dark-white' || (order === 'first-second' && (gm.firstIs || 'dark') === 'dark')) score = [p[1], p[0]]; else score = p;
      }
      const timeText = gm.timeCell ? readCell(rows, gm.timeCell) : clean(gm.time);
      const t = parseTimeCell(timeText);
      const num = gm.num != null ? gm.num : ++auto;
      div.games.push({
        id: `${div.id}-${gm.block ? norm(gm.block) + '-' : ''}${num}`, num, block: gm.block || '', day: gm.day || 1, date: gm.date || null,
        minutes: t ? t.minutes : null, explicit: t ? t.explicit : false,
        location: gm.locationCell ? readCell(rows, gm.locationCell) : clean(gm.location), label: gm.labelCell ? readCell(rows, gm.labelCell) : clean(gm.label),
        white: parseSide(whiteText), dark: parseSide(darkText), score,
      });
    }
    // Dates: honour the map's dates, else day N = start + N-1.
    const days = [...new Set(div.games.map(g => g.day))].sort((a, b) => a - b);
    div.games.forEach(g => { if (!g.date && cfg.startDate) g.date = dateAdd(cfg.startDate, days.indexOf(g.day)); });
    // AM/PM sanity within a block+day: times must not run backwards.
    const seq = {};
    div.games.forEach(g => { const k = g.block + '|' + g.day; const last = seq[k]; if (g.minutes != null && !g.explicit && last != null && g.minutes < last && g.minutes < 720) g.minutes += 720; if (g.minutes != null) seq[k] = Math.max(last || 0, g.minutes); });
    return div;
  }

  // ---- reference resolution (block-aware version of sheet-tabs') ----
  function resolveDivision(div) {
    const pool = id => div.pools.find(p => p.id === id) || (id === '_' && div.pools.length === 1 && div.pools[0]) || null;
    // "1st A" means a round-robin standing: if pool A is a seeded bracket, look for the group that ranks its losers (e.g. "bottomA", "GA").
    const rankPool = id => { const p = pool(id); if (p && p.kind !== 'bracket') return p; const alt = div.pools.find(x => x.kind !== 'bracket' && x.id !== id && x.id.toUpperCase().endsWith(id.toUpperCase())); return alt || p; };
    const cache = new Map(), inProgress = new Set();
    // Abbreviations the sheet uses for sites ("FH", "Beck", "NH") are learnt from the games inside each block.
    const aliases = {};
    Object.entries(div.aliases || {}).forEach(([k, v]) => { aliases[norm(k)] = v; });
    div.games.forEach(g => [g.white, g.dark].forEach(sd => { const h = sd.ref && sd.ref.hint && norm(sd.ref.hint); if (h && g.block && !aliases[h]) aliases[h] = g.block; }));
    // Last resort for abbreviations nobody declared ("FH", "NH"): the one block whose name starts with the same letter.
    const blocks = [...new Set(div.games.map(g => g.block).filter(Boolean))];
    const guessBlock = h => { const c = blocks.filter(b => norm(b)[0] === h[0]); return c.length === 1 ? c[0] : null; };
    const blockMatches = (g, hint) => {
      if (!hint) return true; const h = norm(hint);
      if (norm(g.block).includes(h) || h.includes(norm(g.block)) || norm(g.location).includes(h)) return true;
      if (aliases[h]) return norm(aliases[h]) === norm(g.block);
      return guessBlock(h) === g.block;
    };
    function findGame(ref, ctx) {
      const byNum = div.games.filter(g => g.num === ref.game);
      if (!byNum.length) return null;
      if (ref.hint) { const h = byNum.find(g => blockMatches(g, ref.hint)); if (h) return h; }
      const same = byNum.find(g => g.block === ctx.block); if (same) return same;
      return byNum.length === 1 ? byNum[0] : null;
    }
    function resolve(side, ctx, depth) {
      if (!side) return { name: '', placeholder: 'TBD' };
      if (side.name) return { name: side.name, inferred: false };
      const ref = side.ref;
      if (!ref) return { name: '', placeholder: side.placeholder || side.raw || 'TBD' };
      if (depth > 25) return { name: '', placeholder: side.raw };
      if (ref.kind === 'slot') {
        const p = pool(ref.pool), slot = p && p.slots[ref.n - 1];
        if (!slot) return { name: '', placeholder: side.raw };
        if (slot.name) return { name: slot.name, inferred: false };
        const inner = resolve(slot.side, ctx, depth + 1);
        return inner.name ? { name: inner.name, inferred: true } : { name: '', placeholder: inner.placeholder || `${p.name} #${ref.n}` };
      }
      if (ref.kind === 'rank') {
        const p = rankPool(ref.pool);
        if (!p) return { name: '', placeholder: side.raw };
        const st = poolStandings(p, depth + 1), row = st.rows[ref.rank - 1];
        if (st.complete && row && !row.tied) return { name: row.team, inferred: true };
        return { name: '', placeholder: `${ordinal(ref.rank)} ${p.name}` };
      }
      let g = null, what = '';
      if (ref.kind === 'game') { g = findGame(ref, ctx); what = `Game ${ref.game}${ref.hint ? ' (' + ref.hint + ')' : (g && g.block ? ' (' + g.block + ')' : '')}`; }
      else { g = div.games.find(x => norm(x.label) === ref.label || (ref.label && norm(x.label).replace(/place|game/g, '') === ref.label.replace(/place|game/g, ''))); what = clean(side.raw).replace(/^(win(?:ner)?|los(?:er|s))\s*(of)?\s*/i, ''); }
      const label = `${ref.which === 'win' ? 'Winner' : 'Loser'} of ${what}`;
      if (!g) return { name: '', placeholder: label };
      const o = outcome(resolvedGame(g, depth + 1));
      if (o && !o.tie) return { name: ref.which === 'win' ? o.winner : o.loser, inferred: true };
      return { name: '', placeholder: label };
    }
    function resolvedGame(g, depth) {
      if (cache.has(g.id)) return cache.get(g.id);
      if (inProgress.has(g.id)) return { score: g.score, white: { name: '', placeholder: g.white.raw }, dark: { name: '', placeholder: g.dark.raw } };
      inProgress.add(g.id);
      const rg = { score: g.score, white: resolve(g.white, g, depth), dark: resolve(g.dark, g, depth) };
      inProgress.delete(g.id); cache.set(g.id, rg);
      return rg;
    }
    div.games.forEach(g => { const a = g.white.ref, b = g.dark.ref; g.poolId = a && b && a.kind === 'slot' && b.kind === 'slot' && pool(a.pool) && pool(a.pool) === pool(b.pool) ? pool(a.pool).id : null; });
    const poolTeams = (p, depth) => p.slots.map(s => s ? (s.name || resolve(s.side, { block: '' }, depth).name) : '');
    function poolGames(p, depth) {
      const teams = poolTeams(p, depth);
      const direct = s => !s.ref || s.ref.kind === 'slot' || s.ref.kind === 'game';
      return div.games.filter(g => {
        if (g.poolId === p.id) return true;
        if (g.poolId || !direct(g.white) || !direct(g.dark)) return false;
        const rg = resolvedGame(g, depth + 1);
        return rg.white.name && rg.dark.name && teams.includes(rg.white.name) && teams.includes(rg.dark.name);
      });
    }
    function poolStandings(p, depth) { return standings(poolTeams(p, depth), poolGames(p, depth).map(g => resolvedGame(g, depth))); }

    const resolved = div.games.map(g => resolvedGame(g, 0));
    const info = div.pools.map(p => ({ p, teams: poolTeams(p, 0), games: poolGames(p, 0).map(g => resolvedGame(g, 0)) }));
    div.games.forEach((g, i) => { g.white = { raw: g.white.raw, ...resolved[i].white, cap: 'white' }; g.dark = { raw: g.dark.raw, ...resolved[i].dark, cap: 'dark' }; delete g.explicit; });
    info.forEach(({ p, teams, games }) => {
      p.standings = standings(teams, games);
      p.slots = p.slots.map((s, i) => { if (!s) return { seed: i + 1, name: '', placeholder: `${p.id}${i + 1}`, inferred: false }; const rs = s.name ? { name: s.name, inferred: false } : resolve(s.side, { block: '' }, 0); return { seed: s.seed, name: rs.name || '', placeholder: rs.name ? '' : (rs.placeholder || s.placeholder), inferred: !!rs.inferred, raw: s.side ? s.side.raw : '' }; });
      p.teams = p.slots.map(s => s.name);
    });
    div.venues = [...new Set(div.games.map(g => g.location).filter(Boolean))];
    return div;
  }

  function build(csvByTab, cfg) {
    const map = cfg.map || {};
    const notes = [], divisions = [];
    for (const dm of map.divisions || []) {
      const text = csvByTab[dm.tab];
      if (text == null) { notes.push(`Tab "${dm.tab}" could not be loaded.`); continue; }
      try { divisions.push(resolveDivision(readDivision(M.parseCSV(text), dm, cfg))); }
      catch (e) { notes.push(`Tab "${dm.tab}": ${e.message}`); }
    }
    return { divisions, notes };
  }

  const A = { id: 'cellmap', build, readDivision, resolveDivision, parseSide, parseTimeCell, cellRef,
    urls(cfg) {
      // Raw export by gid keeps blank rows, so the mapper's row numbers stay valid.
      return (cfg.tabs || []).map(t => ({ key: t.name, url: `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/export?format=csv&gid=${t.gid}&_=${Date.now()}`,
        fallback: `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(t.name)}&_=${Date.now()}` }));
    },
  };
  root.PoloAdapters = root.PoloAdapters || {};
  root.PoloAdapters.cellmap = A;
  if (typeof module !== 'undefined' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
