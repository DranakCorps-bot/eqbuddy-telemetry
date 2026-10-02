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
| `POST /heartbeat` | Exactly `{"installId", "appVersion", "os"}` | `204` recorded (and, if the id has no raw row, the all-time install count goes up by one in the same transaction). `400` any other key, a missing key, or a bad value; nothing stored. `429` a second heartbeat from the same id inside 60 s; nothing stored. |
| `POST /delete` | Exactly `{"installId"}` | `204` every raw row for that id is gone. Also `204` when there were none, so the endpoint never says whether an id existed. `400` malformed. The id-free aggregates, including the all-time install count, are not lowered. |
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
4. on the first tick of each UTC hour, reads the EQBuddy Evolved download
   total from GitHub (see [Downloads](#downloads-not-telemetry)) and records it
   as today's `downloads_daily` row;
5. rewrites `metrics.json` and `history.json` into their snapshot rows, from
   one read of `daily_rollup`.

Every step is idempotent, so running twice changes nothing and missing a run
loses nothing.

## What it stores

[`migrations/`](migrations/) is the entire storage shape: `0001_init.sql`
creates it, `0002_daily_active.sql` adds one id-free count to
`daily_rollup`, `0003_usage_history.sql` adds each day's usage to
`daily_rollup` (backfilled from `bucket_count`) and creates the
`history_snapshot` table, `0004_installs_all_time.sql` creates the
one-row `all_time_total` count (backfilled from `heartbeat`), and
`0005_downloads.sql` creates `downloads_daily`, which holds a number GitHub
publishes and nothing from any install. Only `heartbeat` holds an install id:

| Table | Columns | Kept |
|---|---|---|
| `heartbeat` | `install_id`, `bucket_start`, `app_version`, `os`, `last_seen_ms` | 90 days, or until you delete |
| `bucket_count` | `bucket_start`, `distinct_ids` | Indefinitely (no ids) |
| `daily_rollup` | `day`, `unique_30d`, `version_mix_7d`, `active_1d`, `usage_buckets_1d` | Indefinitely (no ids) |
| `metrics_snapshot` | `id`, `generated_at`, `body` | One row, overwritten |
| `history_snapshot` | `id`, `generated_at`, `body` | One row, overwritten |
| `all_time_total` | `id`, `installs_first_seen` | One row, one integer, indefinitely (no ids). Only ever goes up |
| `downloads_daily` | `day`, `total`, `as_of` | One row per UTC day, indefinitely. Not telemetry: GitHub's download count for the Evolved releases, the latest read that day |

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
  "usageHours": { "yesterday": 61.5, "last7d": 402.33, "last30d": 1650.17, "allTime": 2214.33, "todaySoFar": 3.5, "allTimeRounded": 2214 },
  "installsAllTime": 212,
  "activeLast24h": 48,
  "activeLast7d": 104,
  "activeAsOf": "2026-10-01T18:00:00Z",
  "peakDailyActive": 57,
  "peakWeeklyActive": 118,
  "downloads": {
    "since": "2026-09-28", "sinceTag": "v2.0.0",
    "total": 1339, "last30d": 1339, "last30dNote": null,
    "asOf": "2026-10-02T12:00:00Z"
  },
  "definitions": { "concurrentNow": "…", "peakConcurrent": "…", "uniqueUsers30d": "…", "versionMix7d": "…", "dailyActive": "…", "weeklyActive": "…", "usageHours": "…", "activeLast24h": "…", "activeLast7d": "…", "activeAsOf": "…", "peakDailyActive": "…", "peakWeeklyActive": "…", "downloads": "…", "installsAllTime": "…" }
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
| `usageHours` | **Estimated, opted-in installs only, 10-minute resolution.** Each distinct id in a closed 10-minute bucket counts as 10 minutes, so hours = sum of bucket counts × 10 / 60, to two decimals. `yesterday` is the last complete UTC day. `last7d` and `last30d` are the 7 and 30 UTC days ending with it, so none of the three includes today. `todaySoFar` is the current UTC day's closed buckets only (the bucket in progress is not counted yet; with the 10-minute cache it can run about 20 minutes behind). `allTime` is every complete UTC day since launch plus `todaySoFar`. `allTimeRounded` is `allTime` to the nearest whole hour, half up, for a badge (shields.io cannot round, and would print `3019.33`) | Daily; `todaySoFar`, `allTime` and `allTimeRounded` every 10 minutes |
| `installsAllTime` | **Opted-in installs counted when first seen**, since launch: a lower bound, not total users. Each id adds one the first time it sends a heartbeat that finds no raw row for it. An install silent for more than 90 days, one whose data was deleted, and one that opted out and back in (a new id) each count again if they come back. `/delete` never lowers it | Every 10 minutes |
| `activeLast24h` | Distinct ids with a heartbeat in the 24 hours up to `activeAsOf`. **Rolling**: it includes today, unlike `dailyActive`, which ends at the last complete UTC day | Hourly |
| `activeLast7d` | Distinct ids with a heartbeat in the 7 days up to `activeAsOf`. **Rolling**: it includes today, unlike `weeklyActive`, which ends at the last complete UTC day | Hourly |
| `activeAsOf` | When `activeLast24h`, `activeLast7d` and today's part of `peakDailyActive` were last counted: less than an hour before `generatedAt`. The passes in between repeat that count | Hourly |
| `peakDailyActive` | The most distinct ids in any single UTC day since launch, **today included**: the largest of every complete day's `dailyActive` and the distinct ids seen since 00:00 UTC today (as of `activeAsOf`) | Hourly for today; daily for the days before |
| `peakWeeklyActive` | The most distinct ids in any 7-day window ending on a UTC day since launch, **today included**: the largest of every complete day's `weeklyActive` and `activeLast7d` | Hourly for the rolling week; daily for the days before |
| `downloads` | **Not telemetry.** Fetches of the EQBuddy Evolved installer and portable zip from GitHub, from v2.0.0 (2026-09-28). `total` since then, `last30d` in the 30 days up to `asOf` (or `null` with `last30dNote`). See [Downloads](#downloads-not-telemetry). `null` before the first successful read | Hourly |

**Usage hours are computed on the server only**, from the id-free
`bucket_count` table. The heartbeat payload did not change. The rollup writes
each day's total into `daily_rollup.usage_buckets_1d`, and it runs before the
90-day purge in the same pass. `allTime` sums that column and adds today's
closed buckets, read in one bounded query of `bucket_count` (the same per-bucket
counts `history.json` already publishes as `concurrent10m`), which is also
`todaySoFar` (DRA-426). Rollups are never
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

**The rolling actives are the deliberate exception.** On launch day
(2026-09-28) `/report` showed *Daily active 0* beside *Concurrent now 10*: both
true, but a headline that leaves out the day it is read on reads as wrong.
`activeLast24h`, `activeLast7d` and today's part of `peakDailyActive` are
live scans of the raw table, so they include today. They sit beside
`dailyActive` and `weeklyActive`, which keep their meaning, and the history
chart still draws the per-day rollups. They are still bound by the reasoning
above, which is why they run **once an hour**, not every pass. Each pass first
reads the snapshot it is about to replace (one query, one row). If that
snapshot's `activeAsOf` is less than an hour old, the pass publishes its
figures and `activeAsOf` again and skips the three scans. When no snapshot is
readable, or it is older or from before these fields, the pass scans. The
reuse needs no new table and no migration: it lives in the existing
`metrics_snapshot` row. The peaks' per-day half comes from the rollup rows the
pass already reads for the history, so it costs no query, and a peak outlives
the 90-day purge of the raw rows. A reused `peakDailyActive` is a floor, never
a ceiling, because it was itself an observed day. The costs are under Known
limits.

**The all-time install count keeps no install id.** It is one integer in
`all_time_total`. A heartbeat whose id has no row in `heartbeat` adds one to it
in the same D1 batch (one transaction) as the insert that gives the id its row,
so two racing first heartbeats cannot both count, and the count and the raw
table cannot disagree. "First seen" therefore means "first seen within the raw
table's 90-day retention": nothing remembers an id past its last raw row, which
is exactly the retention promise, and the price is that an install silent for
more than 90 days counts again when it returns. `/delete` removes the raw rows
and leaves the count alone: the count is an aggregate, with nothing in it to
delete. Migration `0004` backfilled it as `COUNT(DISTINCT install_id)` over the
raw table. The Worker went live on 2026-09-24, so before 2026-12-23 no raw row
had aged out, and that is every install seen since launch (less any deleted).

### Downloads: not telemetry

`downloads` is the one figure in `metrics.json` that does not come from a
heartbeat. It exists for the EQBuddy README's *Downloads, last 30 days* row
(DRA-783), which a shields.io badge cannot compute on its own: a badge over the
GitHub API joins several numbers with commas rather than adding them, and
cannot leave a file out.

**This is the Worker's one outbound read.** On the first cron tick of each UTC
hour it asks GitHub's public API for the EQBuddy releases
(`GET api.github.com/repos/DranakCorps-bot/EQBuddy/releases?per_page=100`,
unauthenticated: 24 requests a day against GitHub's 60 an hour) and sums the
`download_count` GitHub publishes for each asset. It sends nothing about any
install, and no token. Its only other outbound request is the landing refresh
under [Deploying](#deploying).

- **What counts:** every asset of every non-draft release whose tag starts
  `v2.` (EQBuddy Evolved, from v2.0.0), **except** files ending `.sha256`. The
  in-app updater fetches the `.sha256` beside every installer it verifies, so
  counting those would count each in-app update twice. What is left is
  fetches of the installer and the portable zip: a re-download, an update and
  a bot all count, so it is downloads, not people.
- **Pages:** GitHub lists releases newest first, 100 to a page, and there are
  more than 100. The read follows `page=2`, `page=3`… until a page is short or
  reaches a release created before 2026-09-28 (every later one is older), at
  most 5 pages. It follows page numbers rather than the `Link` header because
  the code reads no header of any kind (see
  [Where logging is switched off](#where-logging-is-switched-off)). Running out
  of pages first writes nothing rather than a partial sum.
- **A failed read writes nothing.** A non-200 answer, a body that is not the
  expected list, no v2 release, or a total of 0 leaves the previous total and
  its `asOf` standing. It never publishes 0.
- **The 30 days need history GitHub does not keep.** The API gives only
  cumulative counts, so the cron records each UTC day's latest total in
  `downloads_daily`, from the day this shipped. `last30d` is `total` while
  v2.0.0 is itself inside the window (through 2026-10-27). After that it is
  `total` minus the total recorded for the UTC day the window starts after,
  and where that day has no row (from 2026-10-28 until 30 days of rows exist)
  it is `null`, with `last30dNote` naming the first day a figure will exist.
  Nothing earlier is back-filled or estimated.

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
     data-tiles="activeLast24h activeLast7d usageHoursAllTime"
     data-charts="usageHours"></div>
<script src="https://eqbuddy-telemetry.eqbuddy-telemetry.workers.dev/widget.js" defer></script>
```

The widget fills in every element with `data-eqbuddy-telemetry` when the
script loads.

| Attribute | Default | Meaning |
|---|---|---|
| `data-tiles` | `concurrentNow peakConcurrent activeLast24h activeLast7d uniqueUsers30d usageHoursAllTime` | Tile names, space- or comma-separated, shown in the order given, or `all` (every tile) or `none` |
| `data-charts` | all | Chart names, the same way |
| `data-base` | the host `widget.js` came from | Where to fetch `metrics.json` and `history.json` |

| Tile | Shows |
|---|---|
| `concurrentNow` | `concurrentNow` |
| `peakConcurrent` | `peakConcurrent`, with its bucket's time in America/Chicago |
| `activeLast24h` | `activeLast24h`, labelled *Active, last 24 hours*, with *Counted* and `activeAsOf` in America/Chicago beneath and the note that it is rolling, counted hourly and includes today. Over a snapshot published before the field existed it shows `dailyActive` under that tile's own label and definition |
| `activeLast7d` | `activeLast7d`, labelled *Active, last 7 days*, the same way. Falls back to `weeklyActive` likewise |
| `peakDailyActive` | `peakDailyActive`, labelled *Peak daily users*. **Not a default.** `/report` shows it, beside `activeLast24h` |
| `peakWeeklyActive` | `peakWeeklyActive`, labelled *Peak weekly active*. **Not a default.** `/report` shows it, beside `activeLast7d` |
| `uniqueUsers30d` | `uniqueUsers30d` |
| `usageHoursAllTime` | `usageHours.allTime`, labelled *Usage hours (all time)*, with *Today so far X h · last 7 full days Y · last 30 full days Z* beneath. Before the first complete UTC day the full-day figures are left out rather than shown as 0 |
| `installsAllTime` | `installsAllTime`, labelled *Total installs (all time)*. **Not a default:** name it (or `all`) to show it. `/report` shows it, beside `uniqueUsers30d` |
| `dailyActive` | `dailyActive`, labelled *Active, last complete UTC day*. Not a default since 2026-09-28 |
| `weeklyActive` | `weeklyActive`, labelled *Active, 7 complete UTC days*. Not a default since 2026-09-28 |
| `usageHours` | `usageHours.last7d` (labelled as complete UTC days), with today so far, yesterday, 30 days and all time beneath. Not a default since 2026-09-28 |

**Tile names never change meaning.** On 2026-09-28 the defaults and `/report`
switched from `dailyActive`, `weeklyActive` and `usageHours` to the new
`activeLast24h`, `activeLast7d` and `usageHoursAllTime`, because the old
headlines all end at the last complete UTC day and so left out the day they
were read on. The old names were kept, not repurposed: an embed that names
them still gets exactly the figure it got before (only the two active tiles'
labels now name their window). An embed that names no tiles picks up the new
defaults. `all` now renders all twelve tiles, the new ones last. A peak tile
over a snapshot from before the peaks reads *collecting data*, never 0.

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
  tiles: ["activeLast24h", "usageHoursAllTime"], // or "all" / "none"
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
  owner, not for this code. A heartbeat is two statements in one batch (the
  all-time count's first-seen check, a primary-key lookup reading at most one
  row, then the upsert); the count's row is written only on an install's first
  heartbeat. Workers Free also allows only 50 D1 queries per
  invocation, so after a cron outage the daily rollup catches up at most 7
  days per pass (`MAX_ROLLUP_DAYS_PER_PASS`). A pass is at most 46 queries
  (`MAX_D1_QUERIES_PER_PASS`, pinned exactly by a test). It was 40 before the
  rolling actives and the peaks: they add the previous-snapshot read and the
  three hourly scans, and a pass that reuses the scans is 3 fewer. The
  downloads add 2 (DRA-783): one read of `downloads_daily` every pass, and one
  write on the hour's first tick when GitHub answered. The backlog
  drains over the next passes.
- **The live scans read the most rows, so they run hourly.** A raw row is one
  install in one 10-minute bucket, and a scan reads every row in its window.
  Measured against a local D1 (`meta.rows_read`, installs online around the
  clock), each online install cost 1,008 rows for the 7-day scan, 144 for the
  24-hour one, 73 for today at noon (about 72 averaged over a day) and 1 for
  `concurrentNow`. Run every 10-minute pass, the three scans would read about
  176,000 × N rows a day, for an average of N opted-in installs online. Run
  hourly, they read about 29,000 × N. With everything else in a day's passes
  (the daily rollup about 5,500 × N, heartbeats about 900 × N, `concurrentNow`,
  bucket closing and the purge about 500 × N, and about 160,000 rows that do not depend on N:
  mostly the history's week of `bucket_count`), **estimated** rows read per
  day against the free 5 million:

  | Average online (N) | Before the rolling figures | Every 10 minutes | Hourly (shipped) |
  |---|---|---|---|
  | 10 | about 0.23 M | about 2.0 M | about 0.52 M |
  | 30 | about 0.37 M | about 5.7 M (over) | about 1.25 M |
  | 100 | about 0.84 M | about 18.5 M (over) | about 3.8 M |

  The hourly design stays inside the free tier up to an average of about 130
  installs online. The next lever is the hourly 7-day scan: it is five sixths
  of what is left of the scans. The refresh interval is one constant,
  `ACTIVE_REFRESH_MS`.
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
  labels, the collecting-data states, escaping, mounting and auto-mounting,
  the rolling-active, peak and all-time-usage tiles with their fallbacks over
  an older snapshot, and the old tile names keeping their figures.
- `test/worker/installs.test.ts`: the all-time install count: first seen adds
  one; repeat, rate-limited and refused heartbeats add nothing; a same-moment
  race counts once; `/delete` and the purge never lower it; a return after 90
  days or after a delete counts again; migration `0004`'s backfill run against
  a seeded raw table; and the `metrics.json` field and its definition.
- `test/worker/rollup.test.ts`: bucket closing, all six public numbers, the
  rolling `activeLast24h`/`activeLast7d` against the complete-day figures,
  the peaks (launch day, an earlier busier day, the rolling week, UTC day not
  24 hours), the hourly scan and the reuse between (which snapshot may stand
  in, and that a reused peak is only a floor), window edges to the
  millisecond, daily catch-up, the per-pass query count (exactly
  `MAX_D1_QUERIES_PER_PASS` in the worst case, 3 fewer when reusing, 1 fewer off the hour), the 90-day purge boundary,
  aggregates that outlive the purge, the `metrics.json` shape and headers, and
  the storage-shape pin.
- `test/worker/downloads.test.ts`: the Evolved download total (DRA-783):
  `.sha256` files, v1 tags and drafts left out (the 2026-10-02 split, 1,339
  counted and 430 `.sha256` left out); paging past 100 releases and stopping at
  the first pre-2.0 one; every failed read keeping the previous total and never
  writing 0; `last30d` inside the window, after it, and `null` with its note in
  the gap; the hourly tick; and `usageHours.allTimeRounded` rounding half up.
- `test/static/guards.test.ts`: no address read, no logging, platform logging
  off, no secrets tracked.

## Deploying

This needs the Cloudflare account, and nothing in this repository has done it:

```sh
npx wrangler d1 create eqbuddy-telemetry      # put the printed id in wrangler.jsonc
npx wrangler d1 migrations apply eqbuddy-telemetry --remote
npx wrangler deploy
```

**Upgrading a live deployment:** apply migrations **before** deploying code
that reads the new tables (`0005_downloads.sql` before the code that reads
`downloads_daily`: every `metrics.json` build reads it). The heartbeat route writes `all_time_total`, so code
deployed ahead of migration `0004` would fail every heartbeat. A heartbeat from
a brand-new install that lands between the migration and the deploy is served
by the old code and not counted. If that matters, run the backfill again right
after the deploy. It only ever raises the figure, so it is safe to repeat:

```sh
npx wrangler d1 execute eqbuddy-telemetry --remote --command "UPDATE all_time_total SET installs_first_seen = MAX(installs_first_seen, (SELECT COUNT(DISTINCT install_id) FROM heartbeat)) WHERE id = 1"
```

**One optional secret** (since 2026-09-28): `GITHUB_DISPATCH_TOKEN`. Once an
hour, on the cron tick in the first ten minutes of the UTC hour and after the
metrics pass, the Worker asks GitHub to run the EQBuddy repo's `pages.yml`, so the
landing page's live figures refresh. GitHub's own `schedule` trigger skipped three
hours in a row on launch day (`src/dispatch.ts`). The request carries nothing but
`{"ref":"main"}`. The token is a **fine-grained** GitHub token scoped to the one
repository `DranakCorps-bot/EQBuddy`, with **Actions: Read and write** and nothing
else. Without the secret the refresh is a silent no-op, and it can never fail the
metrics pass. Set or rotate it with `npx wrangler secret put GITHUB_DISPATCH_TOKEN`,
and paste the token at the prompt, never on the command line. The D1 id in
`wrangler.jsonc` is useless without the account's own credentials. `.dev.vars`
and `.env*` are ignored anyway, and a test fails if one is ever tracked.

Once deployed, the host it answers on becomes the one endpoint the EQBuddy
client carries (`docs/v2/telemetry.md` §5, §9).
