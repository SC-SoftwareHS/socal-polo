// node tools/test-fall-classic.js [dir]  -- parse saved CSVs and print what the UI would show
const fs = require('fs'), path = require('path');
const A = require('../src/adapters/sheet-tabs.js');
const M = require('../src/model.js');
const dir = process.argv[2] || path.join(__dirname, '..', 'test-data', 'fall-classic');
const tabs = ['Teams Entered', '10U OPEN', '12U Boys/Coed', '12U Girls', '14U girls', '14U Boys A', '14U Boys B/Coed', '16U Girls', '18U Girls'];
const csv = {}; tabs.forEach((t, i) => { csv[t] = fs.readFileSync(path.join(dir, (i + 1) + '.csv'), 'utf8'); });
const T = A.build(csv, { sheetId: 'x', teamsTab: 'Teams Entered', tabs: tabs.slice(1), startDate: '2026-09-19' });
let total = 0;
for (const d of T.divisions) {
  console.log(`\n=== ${d.name} (${d.tab}) — ${d.entered.length} entered, ${d.pools.length} pools, ${d.games.length} games, venues: ${d.venues.join(' | ')}`);
  for (const p of d.pools) console.log(`  ${p.name} [${p.kind}]: ${p.slots.map(s => s.name || `<${s.placeholder}>`).join(', ')}  standings: ${p.standings.played}/${p.standings.scheduled}`);
  for (const g of d.games) {
    const side = s => s.name ? s.name + (s.inferred ? '*' : '') : `<${s.placeholder}>`;
    console.log(`  D${g.day} ${g.date || ''} G${String(g.num).padStart(2)} ${M.fmtTime(g.minutes).padStart(8)}  ${side(g.white).padEnd(24)} v ${side(g.dark).padEnd(24)} ${g.score[0] != null ? g.score.join('-') : '   '} ${g.location}${g.label ? '  [' + g.label + ']' : ''}${g.poolId ? '  pool=' + g.poolId : ''}`);
    total++;
  }
}
console.log('\nnotes:', T.notes);
console.log('total games', total);
