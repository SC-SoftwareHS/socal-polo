/* ============================================================
   Adapter: the Newport Harbor "South Coast Tournament" sheet layout
   (single "Schedule" tab). Ported from the Bishops tracker parser.

     ,(A) Foothill,(B) Beckman,(C) CDM,(D) Newport,,Bottom 12 Group,...
     1,Cathedral Catholic,JSerra,...            <- seeds per site bracket
     9/17/2026,Foothill,,Score,Beckman,,,Score  <- pool-play day: sites side by side
     3:00 PM,Game #1,4 Mira Costa v 5 San Marcos,14 - 7,...
     9/19/2026,(Places 1-8),Newport Harbor HS   <- placement block
     Time,,Dark,Score,White,Score
     8:30 AM,Game #11, (LG9 Foothill),, (LG9 Newport),,Semi
   ============================================================ */
(function (root) {
  'use strict';
  const M = root.PoloModel || (typeof require !== 'undefined' ? require('../model.js') : null);
  const { clean, parseTime, ordinal, standings } = M;

  const dateOf  = s => { const m = clean(s).match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/); if (!m) return null; let y = m[3] ? +m[3] : new Date().getFullYear(); if (y < 100) y += 2000; return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`; };
  const isDate  = s => !!dateOf(s) && !/^\d{1,2}:\d{2}/.test(clean(s));
  const isTime  = s => !!parseTime(s);
  const gameNum = s => { const m = clean(s).match(/^(?:game|g)\s*#?\s*(\d+)$/i); return m ? +m[1] : null; };
  const isScoreHdr = s => /^score$/i.test(clean(s));

  function parseScorePair(a, b) {
    const one = clean(a).match(/^(\d+)\s*[-–—:]\s*(\d+)$/);
    if (one) return [+one[1], +one[2]];
    const na = clean(a), nb = clean(b);
    if (/^\d+$/.test(na) && /^\d+$/.test(nb)) return [+na, +nb];
    return [null, null];
  }

  function parseSide(text) {
    let s = clean(text);
    const side = { raw: s, seed: null, ref: null, name: '' };
    let m;
    if ((m = s.match(/^(\d{1,2})\s+(.*)$/))) { side.seed = +m[1]; s = m[2]; }
    if ((m = s.match(/^\(\s*([WL])\s*G?\s*(\d+)\s*([^)]*)\)\s*(.*)$/i))) {
      side.ref = { kind: m[1].toUpperCase() === 'W' ? 'win' : 'lose', game: +m[2], poolHint: clean(m[3]) };
      s = m[4];
    } else if ((m = s.match(/^(winner|loser)\s*(?:of)?\s*#?\s*(?:game)?\s*#?\s*(\d+)\s*([A-Za-z.]*)\s*(.*)$/i))) {
      side.ref = { kind: /^w/i.test(m[1]) ? 'win' : 'lose', game: +m[2], poolHint: '' };
      s = clean(m[3] + ' ' + m[4]);
    } else if ((m = s.match(/^(\d)(?:st|nd|rd|th)\s+(?:pool\s+)?([A-Z])\b\s*(.*)$/i))) {
      side.ref = { kind: 'rank', rank: +m[1], pool: m[2].toUpperCase() };
      s = m[3];
    }
    if ((m = s.match(/^(\d{1,2})\s+(.*)$/))) { side.seed = +m[1]; s = m[2]; }
    side.name = clean(s.replace(/^[-–:]\s*/, ''));
    if (/^(tbd|tba|bye)$/i.test(side.name)) { side.placeholderText = side.name.toUpperCase(); side.name = ''; }
    return side;
  }
  function parseMatchup(text) {
    const parts = clean(text).split(/\s+vs?\.?\s+/i);
    return [parseSide(parts[0] || ''), parseSide(parts[1] || '')];
  }

  function findPool(model, text, aliases) {
    const t = clean(text).toLowerCase();
    if (!t) return null;
    let p = model.pools.find(p => p.letter.toLowerCase() === t);
    if (p) return p;
    p = model.pools.find(p => t.startsWith(p.name.toLowerCase()) || p.name.toLowerCase().startsWith(t));
    if (p) return p;
    for (const [alias, rx] of Object.entries(aliases || {})) {
      if (t === alias) { p = model.pools.find(p => rx.test(p.name)); if (p) return p; }
    }
    return model.pools.find(p => t.includes(p.name.toLowerCase())) || null;
  }

  function parseSheet(rows, aliases) {
    const model = { pools: [], standings: {}, days: [] };
    const cell = (r, i) => clean((rows[r] || [])[i]);
    const rowHasGame = (r, cols) => cols.some(i => isTime(cell(r, i)) || gameNum(cell(r, i)) != null);
    let r = 0;
    while (r < rows.length) {
      const row = rows[r] || [];
      const hdr = row.map((c, i) => { const m = clean(c).match(/^\(([A-Z])\)\s*(.+)$/); return m ? { i, letter: m[1], name: clean(m[2]) } : null; }).filter(Boolean);
      if (hdr.length >= 2 && !model.pools.length) {
        const stIdx = row.findIndex(c => /bottom|standing/i.test(c || ''));
        hdr.forEach(h => model.pools.push({ letter: h.letter, name: h.name, teams: [], games: {} }));
        r++;
        let rank = 1;
        while (r < rows.length && hdr.some(h => cell(r, h.i)) && !isDate(cell(r, 0))) {
          hdr.forEach(h => { const t = cell(r, h.i); if (t && !/^(bye|tbd)$/i.test(t)) model.pools.find(p => p.letter === h.letter).teams.push(t); });
          if (stIdx >= 0) {
            model.pools.forEach((p, k) => {
              const v = cell(r, stIdx + k);
              if (v && !/^[A-Z]\s*\d+$/i.test(v) && !/^\d+(st|nd|rd|th)\s+[A-Z]$/i.test(v)) model.standings[p.letter + rank] = v;
            });
          }
          rank++; r++;
        }
        continue;
      }

      if (isDate(cell(r, 0))) {
        const date = dateOf(cell(r, 0));
        let day = model.days.find(d => d.date === date);
        if (!day) { day = { date, blocks: [] }; model.days.push(day); }

        if (row.some(isScoreHdr)) {
          const cols = [];
          let prevScore = 0;
          row.forEach((c, i) => {
            if (i === 0 || !clean(c) || isScoreHdr(c)) return;
            const p = findPool(model, c, aliases);
            if (!p) return;
            let sc = -1; for (let j = i + 1; j < row.length; j++) if (isScoreHdr(row[j])) { sc = j; break; }
            if (sc < 0) return;
            const span = []; for (let j = prevScore; j < sc; j++) span.push(j);
            let time = -1, game = -1;
            for (let rr = r + 1; rr < Math.min(rows.length, r + 12) && (time < 0 || game < 0); rr++) {
              if (time < 0) time = span.find(j => isTime(cell(rr, j))) ?? -1;
              if (game < 0) game = span.find(j => gameNum(cell(rr, j)) != null) ?? -1;
            }
            if (game < 0) game = i;
            if (time < 0) time = Math.max(prevScore, game - 1);
            cols.push({ pool: p, time, game, matchup: sc - 1, score: sc });
            prevScore = sc + 1;
          });
          if (cols.length) {
            const blocks = cols.map(c => ({ kind: 'pool', pool: c.pool, label: `${c.pool.name} Bracket`, site: c.pool.name, games: [] }));
            r++;
            const watch = cols.flatMap(c => [c.time, c.game]);
            while (r < rows.length && !isDate(cell(r, 0)) && rowHasGame(r, watch)) {
              cols.forEach((c, k) => {
                const num = gameNum(cell(r, c.game));
                if (num == null) return;
                const g = { num, time: cell(r, c.time), sides: parseMatchup(cell(r, c.matchup)),
                            score: parseScorePair(cell(r, c.score), ''), place: '', ctx: { type: 'pool', pool: c.pool }, day, block: blocks[k] };
                blocks[k].games.push(g);
                c.pool.games[num] = g;
              });
              r++;
            }
            blocks.forEach(b => day.blocks.push(b));
            continue;
          }
        }

        const block = { kind: 'group', label: cell(r, 1).replace(/^\((.*)\)$/, '$1') || 'Placement', site: cell(r, 2), games: [], byNum: {} };
        let col = { time: 0, game: 1, dark: 2, darkScore: 3, white: 4, whiteScore: 5, place: 6 };
        r++;
        const h = rows[r] || [];
        const hi = rx => h.findIndex(c => rx.test(clean(c)));
        if (hi(/^time$/i) >= 0 || hi(/^dark$/i) >= 0 || hi(/^white$/i) >= 0) {
          const t = hi(/^time$/i), d = hi(/^dark$/i), w = hi(/^white$/i);
          if (t >= 0) col.time = t;
          if (d >= 0) { col.dark = d; col.darkScore = d + 1; col.game = d - 1; }
          if (w >= 0) { col.white = w; col.whiteScore = w + 1; col.place = w + 2; }
          r++;
        }
        while (r < rows.length && !isDate(cell(r, 0)) && rowHasGame(r, [col.time, col.game])) {
          const num = gameNum(cell(r, col.game));
          if (num != null) {
            let score = parseScorePair(cell(r, col.darkScore), cell(r, col.whiteScore));
            if (score[0] == null) score = parseScorePair(cell(r, col.darkScore), '');
            const g = { num, time: cell(r, col.time), sides: [parseSide(cell(r, col.dark)), parseSide(cell(r, col.white))],
                        score, place: cell(r, col.place), ctx: { type: 'group', block }, day, block };
            block.games.push(g);
            block.byNum[num] = g;
          }
          r++;
        }
        day.blocks.push(block);
        continue;
      }
      r++;
    }
    model.days.sort((a, b) => a.date.localeCompare(b.date));
    model.days.forEach((d, i) => d.index = i + 1);
    return model;
  }

  // ---- resolution (unchanged logic from the tracker) ----
  function gameOutcome(model, g, aliases, depth = 0) {
    const [sa, sb] = g.score;
    if (sa == null || sb == null || sa === sb || depth > 30) return null;
    const a = resolveSide(model, g.sides[0], g.ctx, aliases, depth + 1);
    const b = resolveSide(model, g.sides[1], g.ctx, aliases, depth + 1);
    if (!a.name || !b.name) return null;
    return sa > sb ? { winner: a.name, loser: b.name } : { winner: b.name, loser: a.name };
  }
  function groupOf(model, pool, aliases, depth) {
    // First-round losers of a site bracket, and their round-robin games among themselves.
    const games = Object.values(pool.games);
    const firstRound = games.filter(g => !g.sides[0].ref && !g.sides[1].ref);
    const members = [], rr = [];
    for (const g of firstRound) { const o = gameOutcome(model, g, aliases, depth + 1); members.push(o ? o.loser : ''); }
    for (const g of games) {
      if (firstRound.includes(g)) continue;
      const [x, y] = g.sides;
      if (x.ref && y.ref && x.ref.kind === 'lose' && y.ref.kind === 'lose' && firstRound.some(f => f.num === x.ref.game) && firstRound.some(f => f.num === y.ref.game)) rr.push(g);
    }
    return { members, rr, firstRound };
  }
  function computeRank(model, pool, rank, aliases, depth) {
    const { members, rr } = groupOf(model, pool, aliases, depth);
    if (!members.length || members.some(m => !m)) return null;
    const games = rr.map(g => ({ score: g.score, white: resolveSide(model, g.sides[1], g.ctx, aliases, depth + 1), dark: resolveSide(model, g.sides[0], g.ctx, aliases, depth + 1) }));
    const st = standings(members, games);
    const row = st.rows[rank - 1];
    return st.complete && row && !row.tied ? row.team : null;
  }
  function resolveSide(model, side, ctx, aliases, depth = 0) {
    if (side.name) return { name: side.name, inferred: false };
    const ref = side.ref;
    if (!ref) return { name: '', placeholder: side.placeholderText || side.raw || 'TBD' };
    if (depth > 30) return { name: '', placeholder: side.raw };
    if (ref.kind === 'rank') {
      const pool = model.pools.find(p => p.letter === ref.pool);
      const fromSheet = model.standings[ref.pool + ref.rank];
      if (fromSheet) return { name: fromSheet, inferred: false };
      const computed = pool ? computeRank(model, pool, ref.rank, aliases, depth) : null;
      if (computed) return { name: computed, inferred: true };
      return { name: '', placeholder: `${ordinal(ref.rank)} Group ${ref.pool}${pool ? ' (' + pool.name + ')' : ''}` };
    }
    let game = null, where = '';
    if (ctx.type === 'pool') { game = ctx.pool.games[ref.game]; where = ctx.pool.name; }
    else {
      const hinted = ref.poolHint ? findPool(model, ref.poolHint, aliases) : null;
      if (hinted) { game = hinted.games[ref.game]; where = hinted.name; }
      else game = ctx.block.byNum[ref.game];
    }
    const label = `${ref.kind === 'win' ? 'Winner' : 'Loser'} of Game ${ref.game}${where ? ' (' + where + ')' : ''}`;
    if (!game) return { name: '', placeholder: label };
    const o = gameOutcome(model, game, aliases, depth + 1);
    if (o) return { name: ref.kind === 'win' ? o.winner : o.loser, inferred: true };
    return { name: '', placeholder: label };
  }

  // ---- to the normalized model ----
  function build(csvByTab, cfg) {
    const text = csvByTab[cfg.tab || 'Schedule'];
    const notes = [];
    if (text == null) return { divisions: [], notes: ['Schedule tab could not be loaded.'] };
    const aliases = {};
    for (const [k, v] of Object.entries(cfg.poolAliases || {})) aliases[k] = new RegExp(v, 'i');
    const m = parseSheet(M.parseCSV(text), aliases);
    if (!m.days.length) return { divisions: [], notes: ['No schedule blocks found in the sheet.'] };
    const div = { id: cfg.divisionId || 'varsity', name: cfg.divisionName || 'Boys Varsity', entered: [], pools: [], games: [], venues: [] };

    // Site brackets (seeded) + the losers' round-robin groups derived from them.
    for (const p of m.pools) {
      div.pools.push({ id: p.letter, name: `${p.name} Bracket`, kind: 'bracket', slots: p.teams.map((t, i) => ({ seed: i + 1, name: t, placeholder: '', inferred: false })), teams: p.teams.slice() });
    }
    const groupPools = {};
    for (const p of m.pools) {
      const { members, rr, firstRound } = groupOf(m, p, aliases, 0);
      if (!firstRound.length) continue;
      const gp = { id: 'G' + p.letter, name: `Group ${p.letter} (${p.name})`, kind: 'pool', slots: members.map((t, i) => ({ seed: i + 1, name: t, placeholder: t ? '' : `Loser of Game ${firstRound[i].num}`, inferred: !!t })), teams: members.slice() };
      div.pools.push(gp); groupPools[p.letter] = { gp, rr };
    }
    div.entered = [...new Set(m.pools.flatMap(p => p.teams))].sort();

    for (const d of m.days) for (const b of d.blocks) for (const g of b.games) {
      const dark = resolveSide(m, g.sides[0], g.ctx, aliases, 0), white = resolveSide(m, g.sides[1], g.ctx, aliases, 0);
      const t = parseTime(g.time);
      const key = b.kind === 'pool' ? b.pool.letter : b.label.replace(/\W+/g, '');
      const ng = {
        id: `${div.id}-${key}-${g.num}`, num: g.num, day: d.index, date: d.date, dayLabel: '', minutes: t ? t.minutes : null,
        location: b.site || '', label: g.place || '', block: b.label,
        white: { raw: g.sides[1].raw, cap: 'white', ...white }, dark: { raw: g.sides[0].raw, cap: 'dark', ...dark },
        score: [g.score[1], g.score[0]], poolId: null,
      };
      if (b.kind === 'pool' && groupPools[b.pool.letter] && groupPools[b.pool.letter].rr.includes(g)) ng.poolId = 'G' + b.pool.letter;
      div.games.push(ng);
    }
    for (const p of div.pools) p.standings = standings(p.teams, div.games.filter(g => g.poolId === p.id));
    div.venues = [...new Set(div.games.map(g => g.location).filter(Boolean))];
    div.tab = cfg.tab || 'Schedule';
    return { divisions: [div], notes };
  }

  const A = { id: 'sheet-southcoast', parseSheet, build,
    urls(cfg) {
      const gid = cfg.gid != null ? cfg.gid : 0, tab = cfg.tab || 'Schedule';
      return [{ key: tab, url: `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/export?format=csv&gid=${gid}&_=${Date.now()}`,
                fallback: `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(tab)}&_=${Date.now()}` }];
    },
  };
  root.PoloAdapters = root.PoloAdapters || {};
  root.PoloAdapters['sheet-southcoast'] = A;
  if (typeof module !== 'undefined' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
