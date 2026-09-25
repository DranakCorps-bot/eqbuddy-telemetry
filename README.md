# eqbuddy-telemetry

The backend for **EQBuddy Evolved's opt-in heartbeat**. It is public so you can
read exactly what it stores instead of taking our word for it.

- **Off unless you turn it on.** EQBuddy sends nothing until you say yes.
  EQBuddy 1.x and the legacy builds never send anything.
- **Three fields, and nothing else.** A random install id minted when you
  opted in, the app version, and your Windows version.
- **Your IP address is never stored and never logged.** It reaches Cloudflare
  because that is how the internet works. This code never reads it, and the
  database has nowhere to put it.
- **Delete is real.** "Delete my telemetry data" in EQBuddy removes every raw
  row for your install id, straight away.
- **Raw heartbeats are kept 90 days**, then deleted by a scheduled job. What is
  kept after that is counts: no ids, nothing that could be traced back to you.

The requirement this implements is `docs/v2/telemetry.md` in the
[EQBuddy repository](https://github.com/DranakCorps-bot/EQBuddy) (TEL-001…006).
That page wins any disagreement with this README.

> **Status: deployed 2026-09-24** (Cloudflare free tier) at
> `https://eqbuddy-telemetry.eqbuddy-telemetry.workers.dev`. No released
> EQBuddy build carries that host yet, so no player sends to it yet, and
> telemetry stays off unless a player turns it on. See [Deploying](#deploying).

## What it does

A Cloudflare Worker with a D1 (SQLite) database. Two POST routes, five public
GET routes and one cron.

| Request | Body | Answers |
|---|---|---|
| `POST /heartbeat` | Exactly `{"installId", "appVersion", "os"}` | `204` recorded. `400` any other key, a missing key, or a bad value; nothing stored. `429` a second heartbeat from the same id inside 60 s; nothing stored. |
| `POST /delete` | Exactly `{"installId"}` | `204` every raw row for that id is gone. Also `204` when there were none, so the endpoint never says whether an id existed. `400` malformed. |
| `GET /metrics.json` | — | `200`. The headline numbers. See [`metrics.json`](#metricsjson). |
| `GET /history.json` | — | `200`. One entry per complete UTC day, and the last week of 10-minute counts. See [`history.json`](#historyjson). |
| `GET /report` | — | `200`. The public report page, a thin page over the widget. See [The report and the widget](#the-report-and-the-widget). |
| `GET /widget.js` | — | `200`. The embeddable, dependency-free widget script. |
| `GET /widget.css` | — | `200`. The widget's stylesheet, every rule scoped under `.eqbt`. |

Every GET route also answers `HEAD`, is cacheable for 10 minutes, and carries
`Access-Control-Allow-Origin: *`. Each is a read-only, id-free public aggregate
or a static asset, so any page may read it. Any other method on them is `405`.
The POST routes carry no CORS header, so a browser page on another origin
cannot read their answers.

Accepted values: `installId` is a lowercase hyphenated GUID; `appVersion` is 1–32
characters of `0-9 A-Z a-z . -`; `os` is 1–64 printable ASCII characters. The
body is limited to 1 KiB. A refused body is not stored and not logged.

**Every 10 minutes the cron:**

1. closes each finished 10-minute bucket into `bucket_count` (bucket start and
   how many distinct ids it held, with no ids);
2. writes a `daily_rollup` row for each completed UTC day that lacks one
   (30-day uniques, 7-day version mix, that day's distinct installs, and that
   day's usage as the sum of its bucket counts, as of the end of that day),
   catching up any day a missed run skipped;
3. deletes raw heartbeats whose bucket started more than 90 days ago. This runs
   AFTER step 2, so a day is rolled up before its raw rows can go;
4. rewrites `metrics.json` and `history.json` into their snapshot rows, from
   one read of `daily_rollup`.

Every step is idempotent, so running twice changes nothing and missing a run
loses nothing.

## What it stores

[`migrations/`](migrations/) is the entire storage shape: `0001_init.sql`
creates it, `0002_daily_active.sql` adds one id-free count to
`daily_rollup`, and `0003_usage_history.sql` adds each day's usage to
`daily_rollup` (backfilled from `bucket_count`) and creates the
`history_snapshot` table. Only `heartbeat` holds an install id:

| Table | Columns | Kept |
|---|---|---|
| `heartbeat` | `install_id`, `bucket_start`, `app_version`, `os`, `last_seen_ms` | 90 days, or until you delete |
| `bucket_count` | `bucket_start`, `distinct_ids` | Indefinitely (no ids) |
| `daily_rollup` | `day`, `unique_30d`, `version_mix_7d`, `active_1d`, `usage_buckets_1d` | Indefinitely (no ids) |
| `metrics_snapshot` | `id`, `generated_at`, `body` | One row, overwritten |
| `history_snapshot` | `id`, `generated_at`, `body` | One row, overwritten |

A heartbeat **upserts** one row per install per 10-minute bucket. The client
sends every 5 minutes, so that is two writes against one row, and the table
grows with installs × buckets, not with requests. `last_seen_ms` is the server's
receive time of the latest heartbeat in that bucket. The 60-second rate limit and
the rolling "concurrent now" window read it.

A test pins every column of every table. Adding one fails the build.

## `metrics.json`

```json
{
  "schema": 1,
  "generatedAt": "2026-10-01T18:40:00Z",
  "concurrentNow": 12,
  "peakConcurrent": 31,
  "peakConcurrentBucket": "2026-09-28T02:10:00Z",
  "uniqueUsers30d": 140,
  "versionMix7d": {
    "denominator": 96,
    "versions": [
      { "appVersion": "2.0.1", "count": 80, "share": 0.833 },
      { "appVersion": "2.0.0", "count": 16, "share": 0.167 }
    ]
  },
  "dailyActive": 41,
  "weeklyActive": 96,
  "usageHours": { "yesterday": 61.5, "last7d": 402.33, "last30d": 1650.17, "allTime": 2210.83 },
  "definitions": { "concurrentNow": "…", "peakConcurrent": "…", "uniqueUsers30d": "…", "versionMix7d": "…", "dailyActive": "…", "weeklyActive": "…", "usageHours": "…" }
}
```

| Number | Definition | Refreshed |
|---|---|---|
| `concurrentNow` | Distinct ids with a heartbeat in the 10 minutes before `generatedAt` | Every 10 minutes |
| `peakConcurrent` | The most distinct ids in any one closed 10-minute bucket, with that bucket's start. The earliest bucket wins a tie | Every 10 minutes |
| `uniqueUsers30d` | Distinct ids in the 30 days up to the end of the last complete UTC day | Daily |
| `versionMix7d` | Among distinct ids in the 7 days up to the end of the last complete UTC day, the share on each version, counting each id once on its **latest** version | Daily |
| `dailyActive` | Distinct ids with a heartbeat in the last complete UTC day (the 24 hours up to its end) | Daily |
| `weeklyActive` | Distinct ids with a heartbeat in the 7 days up to the end of the last complete UTC day. The same set `versionMix7d` divides, so it always equals `versionMix7d.denominator` | Daily |
| `usageHours` | **Estimated, opted-in installs only, 10-minute resolution.** Each distinct id in a closed 10-minute bucket counts as 10 minutes, so hours = sum of bucket counts × 10 / 60, to two decimals. `yesterday` is the last complete UTC day. `last7d` and `last30d` are the 7 and 30 UTC days ending with it. `allTime` is every complete UTC day since launch | Daily |

**Usage hours are computed on the server only**, from the id-free
`bucket_count` table. The heartbeat payload did not change. The rollup writes
each day's total into `daily_rollup.usage_buckets_1d`, and it runs before the
90-day purge in the same pass. `allTime` sums that column. Rollups are never
purged, so the all-time total survives the purge of the raw rows (and would
survive a purge of `bucket_count` too). It is an estimate: an install seen for
one minute of a window counts as ten, and one that never heartbeats counts
nothing.

The `definitions` block carries those sentences, so a badge or page can print
the definition it was given rather than write its own. Every id is an
**install that opted in**, not a person. Opting out and back in mints a new id,
so one install can count twice inside a window. That is the cost of making
opt-out an identity reset.

**Why the trailing numbers are daily.** A 30-day distinct count reads every raw
row from 30 days. Running it on every 10-minute pass would spend the free
tier's rows-read allowance 144 times a day on a number that barely moves. The
1- and 7-day counts follow the same rule: a live 7-day scan every pass would
cost a quarter of that, and a live 24-hour one would still be the largest read
in the pass. Until the first UTC day completes, all four read zero.

**Field names are stable.** The report widget reads `metrics.json` and
`history.json`, and later the EQBuddy landing page will too. Fields are only
ever added. A rename or removal would bump `schema`.

## `history.json`

The cron builds it from the aggregate tables only (`daily_rollup` and the last
week of `bucket_count`) and stores it in `history_snapshot`. Each request is
one read of that row. No request scans `heartbeat`, and nothing in it is or
ever was an id.

```json
{
  "schema": 1,
  "generatedAt": "2026-10-03T00:05:00Z",
  "days": [
    {
      "day": "2026-10-02",
      "dailyActive": 41,
      "weeklyActive": 96,
      "uniqueUsers30d": 140,
      "usageHours": 61.5,
      "versionMix7d": { "denominator": 96, "versions": [{ "appVersion": "2.0.1", "count": 80, "share": 0.833 }] }
    }
  ],
  "concurrent10m": [{ "bucket": "2026-10-02T20:00:00Z", "count": 12 }],
  "definitions": { "days": "…", "day": "…", "dailyActive": "…", "weeklyActive": "…", "uniqueUsers30d": "…", "usageHours": "…", "versionMix7d": "…", "concurrent10m": "…", "bucket": "…", "count": "…" }
}
```

| Field | Meaning |
|---|---|
| `days[]` | One entry per complete UTC day since launch, oldest first. Each figure is as of the end of that day, exactly as `metrics.json` published it then. Kept indefinitely, so it outlives the 90-day purge |
| `days[].day` | The UTC day, `YYYY-MM-DD` |
| `days[].dailyActive` | Distinct ids with a heartbeat in that UTC day |
| `days[].weeklyActive` | Distinct ids in the 7 days up to that day's end (`versionMix7d.denominator`) |
| `days[].uniqueUsers30d` | Distinct ids in the 30 days up to that day's end |
| `days[].usageHours` | That day's usage hours: estimated, opted-in installs only, 10-minute resolution |
| `days[].versionMix7d` | The `metrics.json` `versionMix7d` object as of that day's end |
| `concurrent10m[]` | Distinct ids in each closed 10-minute UTC bucket of the last 7 days, oldest first. **A bucket with no entry held nobody: read it as 0** |
| `concurrent10m[].bucket`, `.count` | The bucket's start (ISO-8601 UTC) and its distinct-id count |

Before the first cron pass there is no snapshot yet. The route then answers a
live build from the same aggregate tables and writes nothing.

## The report and the widget

`GET /report` is the public report page. It is deliberately thin: a heading
and one embed of the widget. All the rendering lives in the widget, so the
EQBuddy landing page can later embed exactly what `/report` shows, or any part
of it, without copying code.

The widget is two files. `GET /widget.js` is plain ES5 with no dependencies,
no build step, and nothing loaded from another host. `GET /widget.css` scopes
every rule under `.eqbt`. The script fetches `/metrics.json` and
`/history.json` from the host it was loaded from and renders tiles and
inline-SVG charts into any container. `/report` is served with a
Content-Security-Policy that lets it load only its own script, stylesheet and
JSON.

The widget always shows the label *"Opted-in installs only: a lower bound, not
total users."* The usage tile and the usage chart always carry *"estimated,
opted-in installs only, 10-minute resolution"*, whatever subset is selected.
Until the first complete UTC day, a zero figure reads **collecting data**
instead of `0`. A chart without enough data to draw reads the same (the daily
trend needs two days), and so does everything if the JSON cannot be fetched.

### Embedding the widget

```html
<link rel="stylesheet" href="https://eqbuddy-telemetry.eqbuddy-telemetry.workers.dev/widget.css">
<div data-eqbuddy-telemetry
     data-tiles="dailyActive weeklyActive usageHours"
     data-charts="usageHours"></div>
<script src="https://eqbuddy-telemetry.eqbuddy-telemetry.workers.dev/widget.js" defer></script>
```

The widget fills in every element with `data-eqbuddy-telemetry` when the
script loads.

| Attribute | Default | Meaning |
|---|---|---|
| `data-tiles` | all | Tile names, space- or comma-separated, shown in the order given, or `all` or `none` |
| `data-charts` | all | Chart names, the same way |
| `data-base` | the host `widget.js` came from | Where to fetch `metrics.json` and `history.json` |

| Tile | Shows |
|---|---|
| `concurrentNow` | `concurrentNow` |
| `peakConcurrent` | `peakConcurrent`, with its bucket's time in America/Chicago |
| `dailyActive` | `dailyActive` |
| `weeklyActive` | `weeklyActive` |
| `uniqueUsers30d` | `uniqueUsers30d` |
| `usageHours` | `usageHours.last7d`, with yesterday, 30 days and all time beneath |

| Chart | Shows |
|---|---|
| `actives` | Daily and weekly actives by UTC day (lines) |
| `concurrent` | Concurrent installs per 10-minute bucket, last 7 days, times in America/Chicago |
| `usageHours` | Usage hours per UTC day (bars) |
| `versions` | The current 7-day version mix |

Each tile shows the definition `metrics.json` publishes for it. Charts have a
hover crosshair and tooltip, and the two daily charts also have a table view.

From script, the same options go through the API the widget publishes:

```js
EQBuddyTelemetry.mount(document.getElementById("stats"), {
  tiles: ["dailyActive", "usageHours"], // or "all" / "none"
  charts: "none",
  base: "https://eqbuddy-telemetry.eqbuddy-telemetry.workers.dev",
});
```

**Theming.** Set any of these CSS variables on the container or an ancestor
and the widget uses it: `--eqbt-bg`, `--eqbt-fg`, `--eqbt-muted`,
`--eqbt-surface` (tiles and chart cards), `--eqbt-border`, `--eqbt-accent`
(first series and bars), `--eqbt-accent-2` (second series), `--eqbt-font`,
`--eqbt-font-size`, `--eqbt-radius`, `--eqbt-gap`, `--eqbt-pad` and
`--eqbt-chart-height`. With none set, it follows the reader's light or dark
preference.

## Where logging is switched off

TEL-004 says IPs are never persisted **or logged**. The code logs nothing. It has
no `console` call and reads no request header of any kind. The platform is
told not to log on its behalf:

| Where | Setting | File |
|---|---|---|
| Workers Observability | `"observability": { "enabled": false }` | [`wrangler.jsonc`](wrangler.jsonc) |
| Workers Logs, invocation logs | `"logs": { "enabled": false, "invocation_logs": false }` | [`wrangler.jsonc`](wrangler.jsonc) |
| Logpush | `"logpush": false` | [`wrangler.jsonc`](wrangler.jsonc) |
| Tail Workers | none attached (`tail_consumers` absent) | [`wrangler.jsonc`](wrangler.jsonc) |

[`test/static/guards.test.ts`](test/static/guards.test.ts) fails the build if
any of those switches is turned on, or if any source file mentions a
client-address header, reads a header, reads request metadata (`request.cf`),
or calls `console`. The detector is itself tested to fire on each pattern.

**What code cannot promise, stated plainly:** Cloudflare's edge sees the
connection's address, as every host on the internet does. Anyone with access to
the Cloudflare account could attach a live `wrangler tail` session, and that
would show request metadata while it ran. The operating rule is that nobody
tails production. Only the account holder can see or change it, and it
is written down here so the rule can be checked.

## Known limits

- **Anyone can send a heartbeat.** The endpoint cannot tell a real install from
  a script minting GUIDs without collecting something identifying, and that is
  exactly what this backend refuses to do. The per-id rate limit bounds how
  fast one id can write, not how many ids exist. The public numbers count
  heartbeating ids, and the definitions say so.
- **Free tier only.** Cloudflare's published free limits (as of this writing:
  100,000 Worker requests a day; D1 100,000 rows written and 5 million rows
  read a day) cap how many opted-in installs this can serve. Each heartbeat
  writes about two rows once D1's index writes are counted, and each raw row is
  deleted again at 90 days. **Estimate, not a measurement:** somewhere between
  several hundred and about 1,500 opted-in installs playing a few hours a day.
  Moving to a paid plan costs money, and that is a decision for the project
  owner, not for this code. Workers Free also allows only 50 D1 queries per
  invocation, so after a cron outage the daily rollup catches up at most 7
  days per pass (`MAX_ROLLUP_DAYS_PER_PASS`); a pass stays under 40 queries
  and the backlog drains over the next passes.
- **No licence has been chosen yet.** The code is public so it can be read and
  checked. Choosing a licence is the project owner's decision.

## Developing

```sh
npm ci            # .npmrc sets legacy-peer-deps for the Workers Vitest pool
npm run typecheck
npm test          # Vitest: worker tests run in workerd against a local D1
```

The tests put the clock wherever they need it. Every store function takes
`now`, so rollup math, retention edges and rate limits are asserted against
fixtures with known answers:

- `test/worker/endpoints.test.ts`: payload validation (19 refused shapes, none
  stored), upsert, the rate limit and its boundary, delete across buckets
  that leaves other ids alone, and routing.
- `test/worker/report.test.ts`: usage-hours math and windows, the rollup
  running before the purge, all-time hours surviving it, the `history.json`
  shape and its snapshot-only reads (never `heartbeat`), the widget and report
  routes, and CORS on the GET routes only.
- `test/widget/widget.test.ts`: the served `widget.js`, run in Node against a
  stub DOM. Covers every tile and chart, subset selection, the opt-in and usage
  labels, the collecting-data states, escaping, mounting and auto-mounting.
- `test/worker/rollup.test.ts`: bucket closing, all six public numbers, window
  edges to the millisecond, daily catch-up, the 90-day purge boundary,
  aggregates that outlive the purge, the `metrics.json` shape and headers, and
  the storage-shape pin.
- `test/static/guards.test.ts`: no address read, no logging, platform logging
  off, no secrets tracked.

## Deploying

This needs the Cloudflare account, and nothing in this repository has done it:

```sh
npx wrangler d1 create eqbuddy-telemetry      # put the printed id in wrangler.jsonc
npx wrangler d1 migrations apply eqbuddy-telemetry --remote
npx wrangler deploy
```

No secrets are involved. The Worker has no API keys, and the D1 id in
`wrangler.jsonc` is useless without the account's own credentials. `.dev.vars`
and `.env*` are ignored anyway, and a test fails if one is ever tracked.

Once deployed, the host it answers on becomes the one endpoint the EQBuddy
client carries (`docs/v2/telemetry.md` §5, §9).
