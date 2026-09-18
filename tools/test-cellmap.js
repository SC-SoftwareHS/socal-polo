// node tools/test-cellmap.js <entry.json>   -- fetch the sheet live and print what the cellmap adapter reads
const fs = require('fs');
require('../src/model.js');
const M = globalThis.PoloModel;
const A = require('../src/adapters/cellmap.js');
const { fetchTabs } = require('../server/mapper.js');
(async () => {
  const entry = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const csv = await fetchTabs(entry.source.sheetId, entry.source.tabs);
  const T = A.build(csv, Object.assign({}, entry.source, { startDate: entry.start }));
  for (const d of T.divisions) {
    console.log(`\n=== ${d.name} — ${d.entered.length} entered, ${d.pools.length} pools, ${d.games.length} games; venues ${d.venues.join(' | ')}`);
    for (const p of d.pools) console.log(`  ${p.name} [${p.kind}]: ${p.slots.map(s => s.name || `<${s.placeholder}>`).join(', ')}  st ${p.standings.played}/${p.standings.scheduled}`);
    for (const g of d.games) {
      const side = s => s.name ? s.name + (s.inferred ? '*' : '') : `<${s.placeholder}>`;
      console.log(`  D${g.day} ${g.date || ''} ${(g.block || '').padEnd(10)} G${String(g.num).padStart(2)} ${M.fmtTime(g.minutes).padStart(8)}  ${side(g.white).padEnd(28)} v ${side(g.dark).padEnd(28)} ${g.score[0] != null ? g.score.join('-') : '   '} ${g.location}${g.label ? '  [' + g.label + ']' : ''}${g.poolId ? '  pool=' + g.poolId : ''}`);
    }
  }
  console.log('notes', T.notes);
})().catch(e => { console.error(e); process.exit(1); });
