/* ============================================================
   Adapter: "one division per tab" Google Sheets, as used by the
   2026 Fall Classic. Each tab looks like:

     A            | B              | ...            | <entered list>
     1 Team       | 1 Team         |
     2 Team       | 2 Team         |
     SATURDAY
     TIME | WHITE TEAM | DARK TEAM | SCORE | Location | (placement label)
     1. 8:00 | A1 | A4 |  | Westview Tank 2 |
     ...
     Rebracket
     AA          | BB
     1 1st A     | 1 3rd A
     SUNDAY
     ...

   References understood on either side of a game:
     A1, BB3, 4         -> slot in a pool (bare numbers mean the single unnamed pool)
     1st A, 2nd Pool B  -> pool standing (only projected once pool play is complete)
     Winner 2, Loser 3, Win of Game 7, Loser Game 8   -> result of game #N
     Win Semi #1, Loser Semi #2                       -> result of the game labelled "semi #1"
   ============================================================ */
(function (root) {
  'use strict';
  const M = root.PoloModel || (typeof require !== 'undefined' ? require('../model.js') : null);
  const { clean, norm, parseTime, parseScore, standings, outcome, ordinal, dateAdd, weekdayOf, WEEKDAYS } = M;

  const isPoolCode  = s => /^[A-Z]{1,3}$/.test(clean(s));
  const isDayHeader = s => { const t = clean(s).toLowerCase(); return WEEKDAYS.some(w => t === w || t === w.slice(0, 3) || t.startsWith(w + ' ') || t.startsWith(w.slice(0, 3) + ' ')) || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(t); };
  const isGameHeader = row => (row.some(c => /white/i.test(c)) && row.some(c => /dark/i.test(c))) || (row.some(c => /^score/i.test(c)) && row.some(c => /location|time|site|venue/i.test(c)));
  const seedCell = s => { const m = clean(s).match(/^(\d{1,2})(?:\s+|\s*[.)-]\s*)(.+)$/) || clean(s).match(/^(\d{1,2})$/); return m ? { seed: +m[1], text: clean(m[2] || '') } : null; };

  // "1. 2:40 PM", "11.11:20", "1 8:00", "1:00" -> { num, time }
  function parseTimeCell(s) {
    const t = clean(s);
    let m = t.match(/^(\d{1,3})\s*[.):-]\s*(.+)$/) || t.match(/^(\d{1,3})\s+(.+)$/);
    if (m) { const tm = parseTime(m[2]); if (tm) return { num: +m[1], time: tm }; }
    const tm = parseTime(t);
    if (tm) return { num: null, time: tm };
    m = t.match(/^(?:game|gm|g)?\s*#?\s*(\d{1,3})\s*[.)]?$/i);
    if (m) return { num: +m[1], time: null };
    return null;
  }

  function parseSide(text) {
    const raw = clean(text);
    const side = { raw, name: '', ref: null };
    if (!raw || /^(tbd|tba|bye)$/i.test(raw)) { side.placeholder = raw.toUpperCase() || 'TBD'; return side; }
    let m;
    if ((m = raw.match(/^([A-Z]{1,3})\s*(\d{1,2})$/i)))                       side.ref = { kind: 'slot', pool: m[1].toUpperCase(), n: +m[2] };
    else if ((m = raw.match(/^(\d{1,2})$/)))                                  side.ref = { kind: 'slot', pool: '_', n: +m[1] };
    else if ((m = raw.match(/^(\d{1,2})(?:st|nd|rd|th)\s+(?:place\s+)?(?:pool\s+|group\s+)?([A-Z]{1,3})$/i))) side.ref = { kind: 'rank', pool: m[2].toUpperCase(), rank: +m[1] };
    else if ((m = raw.match(/^(win(?:ner)?|los(?:er|s))\s*(?:of)?\s*(?:game|gm|g)?\s*#?\s*(\d{1,3})$/i))) side.ref = { kind: 'game', which: /^w/i.test(m[1]) ? 'win' : 'lose', game: +m[2] };
    else if ((m = raw.match(/^(win(?:ner)?|los(?:er|s))\s*(?:of)?\s*(.+)$/i)))  side.ref = { kind: 'label', which: /^w/i.test(m[1]) ? 'win' : 'lose', label: norm(m[2]) };
    else side.name = raw;
    return side;
  }

  // ---------- one tab -> one division ----------
  function parseDivision(rows, opts) {
    const notes = [];
    const cell = (r, i) => clean((rows[r] || [])[i]);
    // Locate the game-table columns from the first header row.
    let hdrRow = rows.findIndex(isGameHeader);
    const hdr = hdrRow >= 0 ? rows[hdrRow].map(clean) : [];
    const find = rx => hdr.findIndex(c => rx.test(c));
    let col = { white: find(/white/i), dark: find(/dark/i), score: find(/score/i), loc: find(/location|site|pool\b|venue/i), time: find(/time|gm|game/i) };
    if (col.time < 0) col.time = 0;
    if (col.white < 0) col.white = col.time + 1;
    if (col.dark < 0) col.dark = col.white + 1;
    if (col.score < 0) col.score = col.dark + 1;
    if (col.loc < 0) col.loc = col.score + 1;
    col.label = col.loc + 1;
    const enteredCol = col.label + 1;     // far-right column: division name + entered teams (if present)

    const div = { id: opts.id, name: '', entered: [], pools: [], games: [], venues: [], notes };
    const first = rows[0] || [];
    if (clean(first[enteredCol]) && !isPoolCode(first[enteredCol])) {
      div.name = clean(first[enteredCol]);
      for (let r = 1; r < rows.length; r++) { const t = cell(r, enteredCol); if (t && !/\$/.test(t)) div.entered.push(t); }
    } else if (clean(first[0]) && !isPoolCode(first[0]) && !isDayHeader(first[0]) && !isGameHeader(first)) {
      div.name = clean(first[0]);
    }
    if (!div.name) div.name = opts.tabName || opts.id;

    const width = enteredCol;                // columns that belong to the schedule/pool grid
    const poolById = id => div.pools.find(p => p.id === id);
    const gridCells = row => row.slice(0, width).map(clean);

    let mode = 'start';                      // start | pools | games
    let poolCols = [];                       // [{ pool, col }] while in pools mode
    let dayIndex = 0, dayLabel = '', lastMinutes = -1, autoNum = 0, gamesInDay = 0;
    let dayDates = {};

    const newDay = label => { dayIndex++; dayLabel = label; lastMinutes = -1; gamesInDay = 0; };

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      const g = gridCells(row);
      const nonEmpty = g.filter(Boolean);
      if (!nonEmpty.length) continue;

      if (nonEmpty.length === 1 && isDayHeader(nonEmpty[0])) { newDay(nonEmpty[0]); mode = 'games'; continue; }
      if (/^re-?bracket|^bracket|^placement|^crossover/i.test(nonEmpty[0]) && nonEmpty.length === 1) { mode = 'pools'; poolCols = []; continue; }

      if (isGameHeader(row)) {
        if (gamesInDay > 0) newDay('');                                       // second table without a day label
        if (dayIndex === 0) newDay('');
        mode = 'games'; continue;
      }

      // Pool header: every filled grid cell is a short code (A, B, AA ...)
      if (nonEmpty.every(isPoolCode)) {
        poolCols = [];
        g.forEach((c, i) => { if (c) {
          let pool = poolById(c);
          if (!pool) { pool = { id: c, name: (c.length > 1 ? 'Bracket ' : 'Pool ') + c, kind: c.length > 1 ? 'rebracket' : 'pool', slots: [] }; div.pools.push(pool); }
          poolCols.push({ pool, col: i });
        } });
        mode = 'pools'; continue;
      }

      if (mode !== 'games') {
        // Seed rows under pool headers ("1 Team", "1 1st A", bare "1").
        const seeds = (poolCols.length ? poolCols : [{ pool: null, col: 0 }]).map(pc => ({ pc, s: seedCell(g[pc.col]) })).filter(x => x.s);
        if (seeds.length) {
          for (const { pc, s } of seeds) {
            let pool = pc.pool;
            if (!pool) {                                   // single un-lettered pool (e.g. "12U Girls" list)
              pool = poolById('_');
              if (!pool) { pool = { id: '_', name: 'Round Robin', kind: 'pool', slots: [] }; div.pools.push(pool); poolCols = [{ pool, col: 0 }]; }
            }
            const side = parseSide(s.text);
            let idx = s.seed - 1;
            if (pool.slots[idx]) { idx = 0; while (pool.slots[idx]) idx++; }      // duplicate seed number in the sheet: take the next free slot
            pool.slots[idx] = { seed: idx + 1, side, name: side.name, placeholder: side.name ? '' : (side.raw || `${pool.id}${idx + 1}`) };
          }
          mode = 'pools'; continue;
        }
        if (mode === 'start' && !div.pools.length && nonEmpty.length === 1 && !isPoolCode(nonEmpty[0])) {
          // Title above an un-lettered list: use it as the pool name.
          const pool = { id: '_', name: nonEmpty[0], kind: 'pool', slots: [] }; div.pools.push(pool); poolCols = [{ pool, col: 0 }];
          continue;
        }
        continue;
      }

      // ---- game row ----
      const tc = parseTimeCell(g[col.time]);
      const w = g[col.white], d = g[col.dark];
      if (!tc && !w && !d) continue;
      if (!tc && (w || d)) { notes.push(`${div.name}: could not read time "${g[col.time]}" for ${w} v ${d}`); }
      let num = tc && tc.num != null ? tc.num : null;
      if (num == null) num = ++autoNum; else autoNum = Math.max(autoNum, num);
      let minutes = tc && tc.time ? tc.time.minutes : null;
      if (minutes != null && tc.time && !tc.time.explicit && lastMinutes >= 0 && minutes < lastMinutes && minutes < 12 * 60) minutes += 12 * 60;
      if (minutes != null) lastMinutes = Math.max(lastMinutes, minutes);
      div.games.push({
        id: `${div.id}-${num}`, num, dayIndex, dayLabel, minutes,
        location: g[col.loc] || '', label: g[col.label] || '',
        white: parseSide(w), dark: parseSide(d), score: parseScore(g[col.score]),
      });
      gamesInDay++;
    }

    // Day labels -> dates, sequential from the tournament start unless a weekday says otherwise.
    const days = [...new Set(div.games.map(x => x.dayIndex))].sort((a, b) => a - b);
    days.forEach((di, k) => {
      const label = (div.games.find(x => x.dayIndex === di) || {}).dayLabel || '';
      let date = opts.startDate ? dateAdd(opts.startDate, k) : null;
      const wd = WEEKDAYS.find(wn => label.toLowerCase().startsWith(wn.slice(0, 3)));
      if (wd && opts.startDate) {
        for (let i = 0; i < 7; i++) { const cand = dateAdd(opts.startDate, i); if (weekdayOf(cand) === wd) { date = cand; break; } }
      }
      dayDates[di] = { index: k + 1, label: label || (date ? '' : `Day ${k + 1}`), date };
    });
    div.games.forEach(x => { const dd = dayDates[x.dayIndex] || { index: 1, label: '', date: opts.startDate }; x.day = dd.index; x.date = dd.date; x.dayLabel = dd.label; delete x.dayIndex; });
    div.venues = [...new Set(div.games.map(x => x.location).filter(Boolean))];
    return div;
  }

  // ---------- reference resolution ----------
  function resolveDivision(div) {
    const byNum = Object.fromEntries(div.games.map(g => [g.num, g]));
    const pool = id => div.pools.find(p => p.id === id) || (id === '_' && div.pools.length === 1 && div.pools[0]) || null;
    const cache = new Map();

    function resolve(side, depth) {
      if (!side) return { name: '', placeholder: 'TBD' };
      if (side.name) return { name: side.name, inferred: false };
      const ref = side.ref;
      if (!ref) return { name: '', placeholder: side.placeholder || side.raw || 'TBD' };
      if (depth > 25) return { name: '', placeholder: side.raw };

      if (ref.kind === 'slot') {
        const p = pool(ref.pool);
        const slot = p && p.slots[ref.n - 1];
        if (!slot) return { name: '', placeholder: side.raw };
        if (slot.name) return { name: slot.name, inferred: false };
        const inner = resolve(slot.side, depth + 1);
        return inner.name ? { name: inner.name, inferred: true } : { name: '', placeholder: inner.placeholder || `${p.name} #${ref.n}` };
      }
      if (ref.kind === 'rank') {
        const p = pool(ref.pool);
        if (!p) return { name: '', placeholder: side.raw };
        const st = poolStandings(p, depth + 1);
        const row = st.rows[ref.rank - 1];
        if (st.complete && row && !row.tied) return { name: row.team, inferred: true };
        return { name: '', placeholder: `${ordinal(ref.rank)} ${p.name}` };
      }
      if (ref.kind === 'game' || ref.kind === 'label') {
        let g = ref.kind === 'game' ? byNum[ref.game] : div.games.find(x => norm(x.label) === ref.label || (ref.label && norm(x.label).replace(/place|game/g, '') === ref.label.replace(/place|game/g, '')));
        const what = ref.kind === 'game' ? `Game ${ref.game}` : clean(side.raw).replace(/^(win(?:ner)?|los(?:er|s))\s*(of)?\s*/i, '');
        const label = `${ref.which === 'win' ? 'Winner' : 'Loser'} of ${what}`;
        if (!g) return { name: '', placeholder: label };
        const rg = resolvedGame(g, depth + 1);
        const o = outcome(rg);
        if (o && !o.tie) return { name: ref.which === 'win' ? o.winner : o.loser, inferred: true };
        return { name: '', placeholder: label };
      }
      return { name: '', placeholder: side.raw };
    }
    const inProgress = new Set();
    function resolvedGame(g, depth) {
      const key = g.id;
      if (cache.has(key)) return cache.get(key);
      if (inProgress.has(key)) return { score: g.score, white: { name: '', placeholder: g.white.raw }, dark: { name: '', placeholder: g.dark.raw } };
      inProgress.add(key);
      const rg = { score: g.score, white: resolve(g.white, depth), dark: resolve(g.dark, depth) };
      inProgress.delete(key);
      cache.set(key, rg);
      return rg;
    }
    function poolTeams(p, depth) { return p.slots.map(s => s ? (s.name || resolve(s.side, depth).name) : ''); }
    // Pool-play games are the ones whose two sides are both slots of the same pool.
    div.games.forEach(g => {
      const a = g.white.ref, b = g.dark.ref;
      g.poolId = a && b && a.kind === 'slot' && b.kind === 'slot' && pool(a.pool) && pool(a.pool) === pool(b.pool) ? pool(a.pool).id : null;
    });
    // Standings also count crossover games between two members of the pool (e.g. "Winner 2 v Winner 3"),
    // but never games whose sides depend on standings themselves (rank refs), which would be circular.
    function poolGames(p, depth) {
      const teams = poolTeams(p, depth);
      const direct = s => !s.ref || s.ref.kind === 'slot' || s.ref.kind === 'game';
      return div.games.filter(g => {
        if (g.poolId === p.id) return true;
        if (g.poolId || !direct(g.white) || !direct(g.dark)) return false;      // games tagged to another pool/bracket never count
        const rg = resolvedGame(g, depth + 1);
        return rg.white.name && rg.dark.name && teams.includes(rg.white.name) && teams.includes(rg.dark.name);
      });
    }
    function poolStandings(p, depth) {
      const teams = poolTeams(p, depth);
      const games = poolGames(p, depth).map(g => resolvedGame(g, depth));
      return standings(teams, games);
    }

    // Write resolved sides back onto the model so the UI never sees references.
    const resolved = div.games.map(g => resolvedGame(g, 0));
    const poolInfo = div.pools.map(p => ({ p, teams: poolTeams(p, 0), games: poolGames(p, 0).map(g => resolvedGame(g, 0)) }));
    div.games.forEach((g, i) => {
      g.white = { raw: g.white.raw, ...resolved[i].white, cap: 'white' };
      g.dark  = { raw: g.dark.raw,  ...resolved[i].dark,  cap: 'dark' };
    });
    poolInfo.forEach(({ p, teams, games }) => {
      p.standings = standings(teams, games);
      p.slots = p.slots.map((s, i) => {
        if (!s) return { seed: i + 1, name: '', placeholder: `${p.id}${i + 1}`, inferred: false };
        const rs = s.name ? { name: s.name, inferred: false } : resolve(s.side, 0);
        return { seed: s.seed, name: rs.name || '', placeholder: rs.name ? '' : (rs.placeholder || s.placeholder), inferred: !!rs.inferred, raw: s.side ? s.side.raw : '' };
      });
      p.teams = p.slots.map(s => s.name);
    });
    return div;
  }

  // ---------- entered-teams tab (columns of teams under a division-name header) ----------
  function parseEntered(rows) {
    const out = {};
    const hdr = (rows[0] || []).map(clean);
    hdr.forEach((h, i) => {
      if (!h) return;
      const teams = [];
      for (let r = 1; r < rows.length; r++) { const t = clean((rows[r] || [])[i]); if (t && !/\$/.test(t)) teams.push(t); }
      out[norm(h)] = { name: h, teams };
    });
    return out;
  }

  // Build the whole tournament from { tabName: csvText } plus the source config.
  function build(csvByTab, cfg) {
    const notes = [];
    const entered = cfg.teamsTab && csvByTab[cfg.teamsTab] ? parseEntered(M.parseCSV(csvByTab[cfg.teamsTab])) : {};
    const divisions = [];
    for (const tab of cfg.tabs) {
      const text = csvByTab[tab];
      if (text == null) { notes.push(`Tab "${tab}" could not be loaded.`); continue; }
      const rows = M.parseCSV(text);
      const id = norm(tab) || `div${divisions.length + 1}`;
      let div;
      try { div = resolveDivision(parseDivision(rows, { id, tabName: tab, startDate: cfg.startDate })); }
      catch (e) { notes.push(`Tab "${tab}" could not be parsed: ${e.message}`); continue; }
      const ent = entered[norm(div.name)] || entered[norm(tab)];
      if (ent && !div.entered.length) div.entered = ent.teams;
      div.tab = tab;
      notes.push(...div.notes); delete div.notes;
      divisions.push(div);
    }
    return { divisions, notes };
  }

  const A = { id: 'sheet-tabs', parseDivision, resolveDivision, parseEntered, parseSide, parseTimeCell, build,
    // How the loader fetches this source: one CSV per tab, by tab name (works without knowing gids).
    urls(cfg) {
      const tabs = cfg.teamsTab ? [cfg.teamsTab, ...cfg.tabs] : cfg.tabs;
      return tabs.map(t => ({ key: t, url: `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(t)}&_=${Date.now()}` }));
    },
  };
  root.PoloAdapters = root.PoloAdapters || {};
  root.PoloAdapters['sheet-tabs'] = A;
  if (typeof module !== 'undefined' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
