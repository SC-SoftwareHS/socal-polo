// ============================================================
// Tournament registry. Every entry names a data source; the app
// picks the matching adapter in src/adapters/ and reads it live.
//
//   source.type = 'sheet-tabs'       one Google Sheet tab per division (Fall Classic style)
//   source.type = 'sheet-southcoast' the Newport Harbor "Schedule" tab layout
//   source.type = 'static'           a pre-built data/<id>.js file (for xlsx / PDF imports)
//   source.type = 'pending'          listed, but nobody has supplied a schedule source yet
//
// status: 'current' | 'upcoming' | 'completed' | 'pending'
// venues: address book for the location names that appear in the sheet (regex match).
// ============================================================
window.POLO_MANIFEST = [
  {
    id: '2026-fall-classic',
    name: '2026 Fall Classic',
    start: '2026-09-19', end: '2026-09-20',
    location: 'San Diego, CA',
    organizer: 'San Diego club water polo',
    status: 'current',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/10qNd5x-sAuuJH5Eys4J8RWlWsKq3Q4wJUMSCcf863RQ/edit',
    source: {
      type: 'sheet-tabs',
      sheetId: '10qNd5x-sAuuJH5Eys4J8RWlWsKq3Q4wJUMSCcf863RQ',
      teamsTab: 'Teams Entered',
      tabs: ['10U OPEN', '12U Boys/Coed', '12U Girls', '14U girls', '14U Boys A', '14U Boys B/Coed', '16U Girls', '18U Girls'],
    },
    venues: [
      { match: 'westview',            name: 'Westview High School',           address: '13500 Camino Del Sur, San Diego, CA 92129' },
      { match: 'granite',             name: 'Granite Hills High School',      address: '1719 E Madison Ave, El Cajon, CA 92019' },
      { match: 'coronado|bbmac',      name: 'Coronado BBMAC',                 address: '818 6th St, Coronado, CA 92118' },
    ],
  },
  {
    id: '2026-boys-south-coast',
    name: '2026 Boys South Coast Tournament',
    start: '2026-09-17', end: '2026-09-19',
    location: 'Orange County, CA',
    organizer: 'Newport Harbor High School',
    status: 'current',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/1KWrgWZqQCe3kjl7Oi48blynFqNs7-bBjRVn04Eh_c7M/edit',
    source: {
      type: 'sheet-southcoast',
      sheetId: '1KWrgWZqQCe3kjl7Oi48blynFqNs7-bBjRVn04Eh_c7M',
      gid: 0, tab: 'Schedule',
      divisionName: 'Boys Varsity',
      poolAliases: { fh: 'foothill', beck: 'beckman', nh: 'newport', cdm: 'cdm' },
    },
    venues: [
      { match: 'foothill',            name: 'Foothill High School',           address: '19251 Dodge Ave, Santa Ana, CA 92705' },
      { match: 'beckman',             name: 'Beckman High School',            address: '3588 Bryan Ave, Irvine, CA 92602' },
      { match: 'corona|\\bcdm\\b',    name: 'Corona del Mar High School',     address: '2101 Eastbluff Dr, Newport Beach, CA 92660' },
      { match: 'newport',             name: 'Newport Harbor High School',     address: '600 Irvine Ave, Newport Beach, CA 92663' },
    ],
  },
  {
    id: '2026-kap7-back-to-school',
    name: '2026 KAP7 Back to School',
    start: '2026-09-12', end: '2026-09-13',
    location: 'Irvine & Tustin, CA',
    organizer: 'KAP7',
    status: 'pending',
    sheetUrl: 'https://1drv.ms/x/c/6f253ef3afcfe1c8/IQDxf4RdL6DCQKxhqExGwLVmAZ6t8cN9vpwkB_z3c_K54Ss?e=HuiYAD',
    source: { type: 'pending', note: 'KAP7 publishes this schedule as an Excel file on OneDrive, which browsers cannot read directly. Import it once with tools/import-static.js, or ask KAP7 for a Google Sheet link.' },
    venues: [],
  },
  {
    id: '2026-champions-cup',
    name: '2026 Champions Cup',
    start: null, end: null,
    location: 'Southern California',
    organizer: 'USA Water Polo',
    status: 'pending',
    sheetUrl: '',
    source: { type: 'pending', note: 'Add the USA Water Polo schedule link (Google Sheet, or an export saved with tools/import-static.js) to start tracking this event.' },
    venues: [],
  },
];
