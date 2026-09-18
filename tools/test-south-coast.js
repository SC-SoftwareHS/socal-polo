const fs = require('fs'), path = require('path');
const A = require('../src/adapters/sheet-southcoast.js');
const M = require('../src/model.js');
const text = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'test-data', 'south-coast.csv'), 'utf8');
const T = A.build({ Schedule: text }, { sheetId: 'x', tab: 'Schedule', poolAliases: { fh: 'foothill', beck: 'beckman', nh: 'newport', cdm: 'cdm' } });
for (const d of T.divisions) {
  console.log(`=== ${d.name}: ${d.entered.length} teams, ${d.pools.length} pools, ${d.games.length} games; venues ${d.venues.join(' | ')}`);
  for (const p of d.pools) console.log(`  ${p.name} [${p.kind}]: ${p.slots.map(s => s.name || `<${s.placeholder}>`).join(', ')}  st ${p.standings.played}/${p.standings.scheduled}`);
  for (const g of d.games) {
    const side = s => s.name ? s.name + (s.inferred ? '*' : '') : `<${s.placeholder}>`;
    console.log(`  D${g.day} ${g.date} ${g.block.padEnd(18)} G${String(g.num).padStart(2)} ${M.fmtTime(g.minutes).padStart(8)}  ${side(g.white).padEnd(30)} v ${side(g.dark).padEnd(30)} ${g.score[0] != null ? g.score.join('-') : '   '} ${g.location}${g.label ? '  [' + g.label + ']' : ''}${g.poolId ? '  pool=' + g.poolId : ''}`);
  }
}
console.log('notes', T.notes);
