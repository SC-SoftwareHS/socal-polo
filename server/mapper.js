/* ============================================================
   Mapper: fetch a Google Sheet, ask Claude to describe its layout as a
   cell map, validate it, and hand back a manifest entry.

   Claude is reached through the `claude` CLI (uses the machine's
   Claude login) or, if ANTHROPIC_API_KEY is set, the Messages API.
   ============================================================ */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
require('../src/model.js');
const M = globalThis.PoloModel;
const cellmap = require('../src/adapters/cellmap.js');

const MODEL = process.env.POLO_MAP_MODEL || 'sonnet';
const UA = 'Mozilla/5.0 (SoCalPoloBrackets mapper)';

function sheetIdFrom(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/(?:e\/)?([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : null;
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}
// Tab names + gids + document title from the sheet's htmlview page.
async function listTabs(sheetId) {
  const html = await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`);
  const tabs = [];
  for (const m of html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)", pageUrl: "((?:[^"\\]|\\.)*)"/g)) {
    const name = JSON.parse(`"${m[1]}"`);
    const gid = (m[2].match(/gid=(-?\d+)/) || [])[1];
    if (gid != null) tabs.push({ name, gid });
  }
  const title = ((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').replace(/\s*-\s*Google Sheets\s*$/i, '').trim();
  if (!tabs.length) throw new Error('No tabs found. Is the sheet shared as "Anyone with the link"?');
  return { tabs, title };
}
async function fetchTabs(sheetId, tabs) {
  const out = {};
  await Promise.all(tabs.map(async t => { out[t.name] = await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${t.gid}`); }));
  return out;
}

// CSV -> "R9: A="1. 2:40 PM" B="A1" ..." so the model can cite cells.
function colName(i) { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }
function dumpTab(name, gid, csv) {
  const rows = M.parseCSV(csv);
  const lines = [];
  rows.forEach((row, r) => {
    const cells = row.map((c, i) => [i, M.clean(c)]).filter(x => x[1]);
    if (cells.length) lines.push(`R${r + 1}: ` + cells.map(([i, v]) => `${colName(i)}=${JSON.stringify(v)}`).join(' '));
  });
  return `### Tab "${name}" (gid ${gid}, ${rows.length} rows)\n${lines.join('\n') || '(empty)'}`;
}

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'start', 'end', 'location', 'organizer', 'divisions'],
  properties: {
    name: { type: 'string' }, start: { type: ['string', 'null'] }, end: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] }, organizer: { type: ['string', 'null'] },
    divisions: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'name', 'tab', 'entered', 'aliases', 'pools', 'games'],
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, tab: { type: 'string' },
        entered: { type: 'array', items: { type: 'string' } },
        aliases: { type: 'object', additionalProperties: { type: 'string' } },
        pools: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'kind', 'slots'], properties: {
          id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['pool', 'rebracket', 'bracket'] },
          slots: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['seed'], properties: { seed: { type: 'integer' }, cell: { type: 'string' }, text: { type: 'string' } } } } } } },
        games: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['num', 'day'], properties: {
          num: { type: 'integer' }, block: { type: 'string' }, day: { type: 'integer' }, date: { type: ['string', 'null'] },
          timeCell: { type: 'string' }, time: { type: 'string' },
          whiteCell: { type: 'string' }, darkCell: { type: 'string' }, matchupCell: { type: 'string' }, firstIs: { type: 'string', enum: ['dark', 'white'] },
          scoreCell: { type: 'string' }, scoreOrder: { type: 'string', enum: ['white-dark', 'dark-white', 'first-second'] }, whiteScoreCell: { type: 'string' }, darkScoreCell: { type: 'string' },
          locationCell: { type: 'string' }, location: { type: 'string' }, labelCell: { type: 'string' }, label: { type: 'string' } } } } } } },
  },
};

const SYSTEM = `You map water polo tournament schedule spreadsheets into a strict JSON "cell map".
The map is read by deterministic code every minute: it re-reads the cells you point at, so your job is to say WHERE things are, never to copy scores or guess results.

How organizers lay these sheets out (any mix can appear, and they are often mid-edit and inconsistent):
- Pools/groups: a header row of pool codes (A, B, C or AA, BB for a re-bracket) with seeded team rows beneath ("1 SD Shores"). A division may instead be one un-lettered list of teams (a round robin), or seeded "site brackets" (a 7-team single-elimination per pool site).
- Game tables: a day header (SATURDAY, 9/17/2026) then columns like TIME | WHITE TEAM | DARK TEAM | SCORE | Location | (placement label). Sometimes several sites sit side by side in one row block, each with its own Score column. Sometimes a single "matchup" cell holds "4 Mira Costa v 5 San Marcos" (first team listed wears DARK caps) and a single score cell holds "14 - 7" in that same order. Sometimes there are two score cells (Dark score / White score).
- Team cells use references that the code resolves itself; keep them as cells, do not resolve them: "A1" (slot 1 of pool A), "1st B" (pool standing), "Winner 2", "Loser Game 7", "(WG1) Mira Costa", "(LG9 Foothill)", "Win Semi #1", "3rd A".
- Re-brackets: after pool play, new pools (AA, BB) are seeded from standings ("1 1st A", "2 1st B"). Model them as pools with kind "rebracket" whose slots point at those cells.
- Losers' round-robin groups (e.g. "Bottom 12 Group": 1st A/2nd A/3rd A are the first-round losers at site A ranked by their round robin among themselves) should be modelled as pools with kind "pool" and slots given as text references like "Loser G1 (Foothill)", "Loser G2 (Foothill)", "Loser G3 (Foothill)" so the code can rank them.
- Entry lists ("Teams Entered" tabs or a far-right column of team names) are informational: put them in "entered" of the matching division; they are not pools.
- If references abbreviate site names ("(LG1 FH)", "(WG9 Beck)"), fill "aliases" with each abbreviation mapped to the block name it means, e.g. {"FH": "Foothill", "Beck": "Beckman", "NH": "Newport"}. Otherwise aliases is {}.
- Game numbers restart per site in some sheets. When they do, set "block" to the site/pool name (e.g. "Foothill") on every game of that table so "Winner 9 (Foothill)" can be found. When numbers are unique across the division, omit block.
- day: 1 for the first day that appears in the division, 2 for the next, etc. If the sheet shows real dates, put the ISO date in "date". Time: prefer timeCell (the code strips a leading game number like "3. 4:10PM"); if a game has no time cell, omit timeCell.
- If a game row has no number, count on from the previous game in that table.

Output rules:
- One division per schedule tab. Tabs with no games are not divisions (use them for "entered" lists).
- Every game needs either whiteCell+darkCell, or matchupCell (+firstIs). Every referenced cell must literally exist in the dump, using the exact column letter and row number shown (R9 + column B is "B9"). Point at the cell even when it is currently empty (a score not yet played, a team not yet known).
- Pool ids must be the codes the game cells use to refer to them: if games say "A1" or "1st A", the pool id is "A". When a sheet reuses a letter for two things (a seeded site bracket "A" and the losers' group whose standings "1st A" refers to), give the round-robin group the plain letter and the seeded bracket a distinct id such as "siteA". "_" is the id for a single un-lettered pool. Pool names are short ("Pool A", "Bracket AA", "Foothill Bracket", "Round Robin").
- Location: use locationCell when the row has one; otherwise a literal "location" for the table's site if stated in a header; otherwise omit. Placement labels ("1st", "Semi #1", "5th place") the same way with labelCell/label.
- Tournament fields: name (from the document title or the sheet contents; prefix the year if you know it), start/end ISO dates if determinable (from day headers plus any dates or the current year given), location and organizer if evident, else null.
- Division id: short lowercase slug, unique. Division name: as the organizer calls it (e.g. "12U Boys/Coed").
Respond with the JSON object only.`;

function extractJSON(text) {
  const s = String(text || '');
  const start = s.indexOf('{'); if (start < 0) throw new Error('no JSON in model output');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) return JSON.parse(s.slice(start, i + 1)); }
  }
  throw new Error('unterminated JSON in model output');
}

function askClaudeCLI(prompt) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env); delete env.CLAUDECODE; delete env.CLAUDE_CODE_CHILD_SESSION;
    const args = ['-p', '--output-format', 'json', '--model', MODEL, '--json-schema', JSON.stringify(SCHEMA), '--system-prompt', SYSTEM, '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Agent'];
    const child = spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 400)}`));
      try {
        const env = JSON.parse(out);
        if (env.is_error) return reject(new Error(`claude error: ${String(env.result).slice(0, 400)}`));
        const structured = env.structured_output || (typeof env.result === 'object' ? env.result : null);
        resolve({ map: structured || extractJSON(env.result), cost: env.total_cost_usd || null, model: MODEL });
      } catch (e) { reject(new Error(`could not parse claude output: ${e.message}: ${out.slice(0, 300)}`)); }
    });
    child.stdin.end(prompt);
  });
}
async function askClaudeAPI(prompt) {
  const model = process.env.POLO_MAP_MODEL || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 32000, system: SYSTEM, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  return { map: extractJSON(text), cost: null, model };
}
const askClaude = prompt => (process.env.ANTHROPIC_API_KEY ? askClaudeAPI(prompt) : askClaudeCLI(prompt));

// Check every cell exists, every game has sides, then dry-run the adapter.
function validate(map, csvByTab, tabs) {
  const warnings = [];
  const tabNames = new Set(tabs.map(t => t.name));
  const rowsByTab = Object.fromEntries(Object.entries(csvByTab).map(([k, v]) => [k, M.parseCSV(v)]));
  for (const d of map.divisions || []) {
    if (!tabNames.has(d.tab)) { warnings.push(`division "${d.name}" points at unknown tab "${d.tab}"`); continue; }
    const rows = rowsByTab[d.tab];
    const check = (ref, what) => { if (!ref) return; const rc = cellmap.cellRef(ref); if (!rc) warnings.push(`${d.name}: bad cell "${ref}" (${what})`); else if (rc[0] >= rows.length) warnings.push(`${d.name}: ${ref} is past the end of the tab (${what})`); };
    (d.pools || []).forEach(p => (p.slots || []).forEach(s => check(s.cell, `${p.id} seed ${s.seed}`)));
    (d.games || []).forEach(g => {
      if (!g.matchupCell && !(g.whiteCell && g.darkCell)) warnings.push(`${d.name}: game ${g.num} has no team cells`);
      ['timeCell', 'whiteCell', 'darkCell', 'matchupCell', 'scoreCell', 'whiteScoreCell', 'darkScoreCell', 'locationCell', 'labelCell'].forEach(k => check(g[k], `game ${g.num} ${k}`));
    });
  }
  const model = cellmap.build(csvByTab, { map, startDate: map.start });
  const games = model.divisions.reduce((n, d) => n + d.games.length, 0);
  model.divisions.forEach(d => {
    const blank = d.games.filter(g => !g.white.name && !g.white.placeholder && !g.dark.name && !g.dark.placeholder).length;
    if (blank) warnings.push(`${d.name}: ${blank} games read as completely empty`);
    const noTime = d.games.filter(g => g.minutes == null).length;
    if (noTime) warnings.push(`${d.name}: ${noTime} games without a readable time`);
  });
  warnings.push(...model.notes);
  return { warnings, divisions: model.divisions.length, games };
}

async function mapSheet(url, hints) {
  hints = hints || {};
  const sheetId = sheetIdFrom(url);
  if (!sheetId) throw new Error('That is not a Google Sheets link.');
  const { tabs, title } = await listTabs(sheetId);
  const csvByTab = await fetchTabs(sheetId, tabs);
  const dump = tabs.map(t => dumpTab(t.name, t.gid, csvByTab[t.name])).join('\n\n');
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Document title: ${JSON.stringify(title || '(unknown)')}\nToday's date: ${today}${hints.start ? `\nThe tournament starts on ${hints.start}` : ''}${hints.name ? `\nThe tournament is called ${JSON.stringify(hints.name)}` : ''}\n\n${dump}`;
  const t0 = Date.now();
  const { map, cost, model } = await askClaude(prompt);
  const v = validate(map, csvByTab, tabs);
  const id = hints.id || M.norm((map.start ? map.start.slice(0, 4) + ' ' : '') + (map.name || title || sheetId)).replace(/^(\d{4})/, '$1-').slice(0, 60) || sheetId.slice(0, 12).toLowerCase();
  const entry = {
    id, name: hints.name || map.name || title || 'Untitled tournament',
    start: hints.start || map.start || null, end: hints.end || map.end || null,
    location: hints.location || map.location || '', organizer: hints.organizer || map.organizer || '',
    status: 'current', managed: true, mappedAt: new Date().toISOString(), mapModel: model, mapCost: cost, mapSeconds: Math.round((Date.now() - t0) / 1000),
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    source: { type: 'cellmap', sheetId, tabs, map: { divisions: map.divisions } },
    venues: hints.venues || [],
    warnings: v.warnings,
  };
  return { entry, stats: v };
}

module.exports = { mapSheet, sheetIdFrom, listTabs, fetchTabs, dumpTab, validate, SYSTEM, SCHEMA };

if (require.main === module) {
  const url = process.argv[2];
  if (!url) { console.error('usage: node server/mapper.js <google-sheet-url> [start YYYY-MM-DD]'); process.exit(1); }
  mapSheet(url, { start: process.argv[3] }).then(r => { console.log(JSON.stringify(r.entry, null, 1)); console.error('stats', r.stats); }).catch(e => { console.error(e); process.exit(1); });
}
