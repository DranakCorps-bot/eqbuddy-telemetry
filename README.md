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

A Cloudflare Worker with a D1 (SQLite) database. Three routes and one cron.

| Request | Body | Answers |
|---|---|---|
| `POST /heartbeat` | Exactly `{"installId", "appVersion", "os"}` | `204` recorded. `400` any other key, a missing key, or a bad value; nothing stored. `429` a second heartbeat from the same id inside 60 s; nothing stored. |
| `POST /delete` | Exactly `{"installId"}` | `204` every raw row for that id is gone. Also `204` when there were none, so the endpoint never says whether an id existed. `400` malformed. |
| `GET /metrics.json` | — | `200`. Public, CORS-open, cacheable for 10 minutes. |

Accepted values: `installId` is a lowercase hyphenated GUID; `appVersion` is 1–32
characters of `0-9 A-Z a-z . -`; `os` is 1–64 printable ASCII characters. The
body is limited to 1 KiB. A refused body is not stored and not logged.

**Every 10 minutes the cron:**

1. closes each finished 10-minute bucket into `bucket_count` (bucket start and
   how many distinct ids it held, with no ids);
2. writes a `daily_rollup` row for each completed UTC day that lacks one
   (30-day uniques and 7-day version mix, as of the end of that day), catching
   up any day a missed run skipped;
3. deletes raw heartbeats whose bucket started more than 90 days ago;
4. rewrites `metrics.json`.

Every step is idempotent, so running twice changes nothing and missing a run
loses nothing.

## What it stores

[`migrations/0001_init.sql`](migrations/0001_init.sql) is the entire storage
shape. Only `heartbeat` holds an install id:

| Table | Columns | Kept |
|---|---|---|
| `heartbeat` | `install_id`, `bucket_start`, `app_version`, `os`, `last_seen_ms` | 90 days, or until you delete |
| `bucket_count` | `bucket_start`, `distinct_ids` | Indefinitely (no ids) |
| `daily_rollup` | `day`, `unique_30d`, `version_mix_7d` | Indefinitely (no ids) |
| `metrics_snapshot` | `id`, `generated_at`, `body` | One row, overwritten |

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
  "definitions": { "concurrentNow": "…", "peakConcurrent": "…", "uniqueUsers30d": "…", "versionMix7d": "…" }
}
```

| Number | Definition | Refreshed |
|---|---|---|
| `concurrentNow` | Distinct ids with a heartbeat in the 10 minutes before `generatedAt` | Every 10 minutes |
| `peakConcurrent` | The most distinct ids in any one closed 10-minute bucket, with that bucket's start. The earliest bucket wins a tie | Every 10 minutes |
| `uniqueUsers30d` | Distinct ids in the 30 days up to the end of the last complete UTC day | Daily |
| `versionMix7d` | Among distinct ids in the 7 days up to the end of the last complete UTC day, the share on each version, counting each id once on its **latest** version | Daily |

The `definitions` block carries those sentences, so a badge or page can print
the definition it was given rather than write its own. Every id is an
**install that opted in**, not a person. Opting out and back in mints a new id,
so one install can count twice inside a window. That is the cost of making
opt-out an identity reset.

**Why the trailing numbers are daily.** A 30-day distinct count reads every raw
row from 30 days. Running it on every 10-minute pass would spend the free
tier's rows-read allowance 144 times a day on a number that barely moves. Until
the first UTC day completes, both read zero.

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
  days per pass (`MAX_ROLLUP_DAYS_PER_PASS`); a pass stays under 30 queries
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
- `test/worker/rollup.test.ts`: bucket closing, all four public numbers, window
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
