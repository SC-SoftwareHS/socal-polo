# SoCal Polo Brackets

A splashbracket-style board for Southern California water polo tournaments that reads each
organizer's schedule **live** instead of re-typing it. Open a tournament and you get, per division:
schedule by day and pool, live "in the water now" / "next up", pool standings with tiebreaks,
placement brackets whose matchups fill in as results land, team list with a ★ follow feature,
and venue directions.

Static site, no build step. Serve the folder (GitHub Pages works) and open `index.html`.

## Adding a tournament from a link (server mode)

Run the server and open the site through it:

```
node server/index.js            # http://localhost:8788
```

The home page gains an **Add a tournament** box. Paste any public Google Sheet link. The server
fetches every tab, asks Claude (through the `claude` CLI, or the Messages API when
`ANTHROPIC_API_KEY` is set) to describe the layout as a *cell map*: which cells hold each game's
teams, score, time and site, and which cells seed each pool. That map is stored in
`server/data/tournaments.json`; from then on the browser re-reads exactly those cells from the live
sheet every minute, so scores and next-round matchups stream through with no further model calls.
Mapping takes 2–5 minutes and has cost $0.35–$0.70 per sheet with Sonnet.

Each mapped tournament gets **Re-map layout** (organizer restructured the sheet) and **Remove**
buttons. `POLO_MAP_MODEL` picks the model (default `sonnet`). API: `GET /api/manifest`,
`POST /api/add {url,name?,start?}`, `POST /api/remap/:id`, `DELETE /api/tournament/:id`.

On the Beelink this runs as the `socal-polo` systemd user service on port 8788.

## Data sources

`data/manifest.js` lists every tournament and where its schedule lives. Each entry names a
`source.type`; the matching adapter in `src/adapters/` turns that source into one normalized
model (divisions → pools + games) that the UI renders. Adapters today:

| type | reads | used by |
|------|-------|---------|
| `sheet-tabs` | public Google Sheet, one tab per division (pools at the top, day tables below, optional rebracket) | 2026 Fall Classic |
| `sheet-southcoast` | the Newport Harbor "Schedule" tab layout (site brackets side by side, placement blocks) | 2026 Boys South Coast |
| `cellmap` | any public Google Sheet, via a Claude-generated cell map (see above) | everything added through the server |
| `static` | `data/<id>.js` produced by `tools/import-static.js` from CSV exports | Excel/PDF schedules |
| `pending` | nothing yet, shows a "needs source" card | Champions Cup until a link is supplied |

Google Sheets are fetched straight from the browser every 60 seconds (`gviz` CSV export by tab
name, so no tab ids are needed). Nothing is cached server-side; the last good copy is kept in
`localStorage` so the page paints instantly and survives a flaky pool-deck connection.

### Adding a tournament

1. Add an entry to `data/manifest.js` with `id`, `name`, `start`/`end`, `location`, `organizer`,
   `sheetUrl`, `source`, and a `venues` address book (regex `match` against the location names the
   sheet uses).
2. If the sheet follows one of the known layouts, that's it. Otherwise write a new adapter that
   exports `{ urls(cfg), build(csvByTab, cfg) }` and returns the normalized model (see the comment
   at the top of `src/model.js`), then add its `<script>` to `index.html`.
3. For an Excel/PDF schedule, export the tabs as CSV and run
   `node tools/import-static.js <id> <csv-dir> --start YYYY-MM-DD`.

### Following a team

Star teams on the Teams tab, or share a link that pre-follows a club:
`#/t/2026-fall-classic/mine?follow=Shores`. Starring a club name matches every team containing it.

## Testing the parsers

```
node tools/test-fall-classic.js            # parses test-data/fall-classic/*.csv and prints every game
node tools/test-south-coast.js             # same for test-data/south-coast.csv
node tools/test-cellmap.js <entry.json>    # fetch a mapped tournament's sheet live and print what the cell map reads
node server/mapper.js <sheet-url> [start]  # run the Claude mapping step by hand and print the entry
```

Refresh the fixtures with the current sheets:

```
S=10qNd5x-sAuuJH5Eys4J8RWlWsKq3Q4wJUMSCcf863RQ; i=0
for t in "Teams Entered" "10U OPEN" "12U Boys/Coed" "12U Girls" "14U girls" "14U Boys A" "14U Boys B/Coed" "16U Girls" "18U Girls"; do
  i=$((i+1)); curl -sL "https://docs.google.com/spreadsheets/d/$S/gviz/tq?tqx=out:csv&headers=0&sheet=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$t")" -o test-data/fall-classic/$i.csv
done
```

## Reference-resolution rules (sheet-tabs)

Sides of a game may be written as `A1` (pool slot), `1st B` (pool standing), `Winner 7` /
`Loser Game 7`, or `Win Semi #1` (result of the game labelled "semi #1"). Slots and game results
resolve as soon as scores exist. Standings positions only resolve once every pool game has a
score and the position is not tied (head-to-head, goal difference, goals for). Names the sheet
didn't literally write are tagged *auto* in the UI.
