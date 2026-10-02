// Every D1 statement the backend runs. Nothing here receives, reads or
// writes a request's address: the functions take a validated payload or a
// clock, and that is all.

import { OS_FAMILIES, type OsFamily, osFamily } from "./os";
import type { Heartbeat } from "./validate";
import { type Downloads, downloadsFrom, readDownloadRows, refreshDownloads } from "./downloads";
import { isDispatchTick } from "./dispatch";
import {
  ACTIVE_REFRESH_MS,
  CONCURRENT_WINDOW_MS,
  DAILY_ACTIVE_WINDOW_MS,
  DAY_MS,
  RATE_LIMIT_MS,
  RETENTION_DAYS,
  ROLLING_WEEK_WINDOW_MS,
  UNIQUE_WINDOW_MS,
  VERSION_WINDOW_MS,
  bucketStart,
  dayKey,
  dayStartMs,
  iso,
} from "./time";

export type RecordOutcome = "recorded" | "rate-limited";

/**
 * Upserts the heartbeat into its (install, bucket) row, unless this install
 * already sent one in the last RATE_LIMIT_MS. One statement, so the check and
 * the write cannot interleave with a second request for the same id.
 *
 * The check is bounded by the primary key (install_id, bucket_start >= the
 * bucket 60 s ago), so it reads at most two rows however long the install
 * has been sending: D1's free tier counts rows READ.
 *
 * installsAllTime rides in the same D1 batch, which D1 runs as one
 * transaction: the first statement adds one to the all-time count if this id
 * has NO raw row, the second writes the row. An id with no row is never
 * rate-limited (the limit reads its rows), so the two always agree, and two
 * racing first heartbeats cannot both count: the batch that commits first
 * leaves a row the second one sees. The absence check is a primary-key prefix
 * lookup, so it reads at most one row.
 */
export async function recordHeartbeat(db: D1Database, hb: Heartbeat, nowMs: number): Promise<RecordOutcome> {
  const [, result] = await db.batch([
    db
      .prepare(
        `UPDATE all_time_total SET installs_first_seen = installs_first_seen + 1
         WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM heartbeat WHERE install_id = ?1)`,
      )
      .bind(hb.installId),
    db
      .prepare(
        `INSERT INTO heartbeat (install_id, bucket_start, app_version, os, last_seen_ms)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE NOT EXISTS (
           SELECT 1 FROM heartbeat
           WHERE install_id = ?1 AND bucket_start >= ?7 AND last_seen_ms > ?6
         )
         ON CONFLICT (install_id, bucket_start) DO UPDATE SET
           app_version  = excluded.app_version,
           os           = excluded.os,
           last_seen_ms = excluded.last_seen_ms`,
      )
      .bind(hb.installId, bucketStart(nowMs), hb.appVersion, hb.os, nowMs, nowMs - RATE_LIMIT_MS, bucketStart(nowMs - RATE_LIMIT_MS)),
  ]);
  return result.meta.changes > 0 ? "recorded" : "rate-limited";
}

/**
 * Hard-deletes every raw row for the id. Says nothing about whether any existed.
 * Touches heartbeat only: installsAllTime is an aggregate holding no id, so a
 * delete never lowers it.
 */
export async function deleteInstall(db: D1Database, installId: string): Promise<void> {
  await db.prepare(`DELETE FROM heartbeat WHERE install_id = ?1`).bind(installId).run();
}

/** The all-time first-seen count: one row, one read, no ids. 0 if the row is somehow absent. */
export async function installsAllTime(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT installs_first_seen AS n FROM all_time_total WHERE id = 1`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Deletes raw rows whose bucket started more than RETENTION_DAYS before `now`. */
export async function purgeExpired(db: D1Database, nowMs: number): Promise<number> {
  const cutoff = iso(nowMs - RETENTION_DAYS * DAY_MS);
  const result = await db.prepare(`DELETE FROM heartbeat WHERE bucket_start < ?1`).bind(cutoff).run();
  return result.meta.changes;
}

/**
 * Writes a bucket_count row for every bucket that has closed (started before
 * the current one) and is not yet recorded. A closed bucket can never gain a
 * row, because heartbeats are bucketed by the server's clock, so the first
 * count written is the final one and INSERT OR IGNORE keeps it.
 */
export async function closeBuckets(db: D1Database, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO bucket_count (bucket_start, distinct_ids)
       SELECT bucket_start, COUNT(DISTINCT install_id)
       FROM heartbeat
       WHERE bucket_start < ?1
         AND bucket_start >= COALESCE((SELECT MAX(bucket_start) FROM bucket_count), '')
       GROUP BY bucket_start`,
    )
    .bind(bucketStart(nowMs))
    .run();
}

/**
 * A row's last_seen_ms lies inside its own bucket, so "seen in (from, to]"
 * implies bucket_start in [bucket(from), to]. Stating that range lets the
 * bucket index bound the scan; the last_seen_ms test then makes it exact.
 */
const IN_WINDOW = `last_seen_ms > ?1 AND last_seen_ms <= ?2 AND bucket_start >= ?3 AND bucket_start <= ?4`;

function windowArgs(fromExclusiveMs: number, toInclusiveMs: number): [number, number, string, string] {
  return [fromExclusiveMs, toInclusiveMs, bucketStart(fromExclusiveMs), iso(toInclusiveMs)];
}

async function distinctIdsSeen(db: D1Database, fromExclusiveMs: number, toInclusiveMs: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(DISTINCT install_id) AS n FROM heartbeat WHERE ${IN_WINDOW}`)
    .bind(...windowArgs(fromExclusiveMs, toInclusiveMs))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface VersionShare {
  appVersion: string;
  count: number;
  share: number;
}

export interface VersionMix {
  denominator: number;
  versions: VersionShare[];
}

export interface OsShare {
  family: OsFamily;
  count: number;
  share: number;
}

/** Every family, always, in OS_FAMILIES order: a family nobody is on reads 0, not absent. */
export interface OsMix {
  denominator: number;
  families: OsShare[];
}

/** One day's two 7-day mixes. One query answers both, so they share a denominator. */
export interface WeeklyMix {
  versions: VersionMix;
  os: OsMix;
}

function share(n: number, denominator: number): number {
  return denominator > 0 ? Math.round((n / denominator) * 1000) / 1000 : 0;
}

/**
 * Among distinct ids seen in the 7 days up to `asOf`, the share on each version
 * and on each OS family, both read off each id's LATEST row in the window: the
 * same row, so an id is counted once in each mix and both denominators are the
 * one distinct set weeklyActive publishes. Versions largest first, ties by
 * version string so the output is deterministic; families in OS_FAMILIES order.
 *
 * One query, as versionMix alone was, so a rollup day still costs four.
 */
export async function weeklyMix(db: D1Database, asOfMs: number): Promise<WeeklyMix> {
  const { results } = await db
    .prepare(
      `WITH latest AS (
         SELECT app_version, os,
                ROW_NUMBER() OVER (PARTITION BY install_id ORDER BY last_seen_ms DESC) AS rn
         FROM heartbeat
         WHERE ${IN_WINDOW}
       )
       SELECT app_version, os, COUNT(*) AS n FROM latest WHERE rn = 1
       GROUP BY app_version, os`,
    )
    .bind(...windowArgs(asOfMs - VERSION_WINDOW_MS, asOfMs))
    .all<{ app_version: string; os: string; n: number }>();
  const denominator = results.reduce((sum, r) => sum + r.n, 0);

  const byVersion = new Map<string, number>();
  const byFamily = new Map<OsFamily, number>(OS_FAMILIES.map((f) => [f, 0]));
  for (const r of results) {
    byVersion.set(r.app_version, (byVersion.get(r.app_version) ?? 0) + r.n);
    const f = osFamily(r.os);
    byFamily.set(f, (byFamily.get(f) ?? 0) + r.n);
  }
  // Versions are printable ASCII (validate.ts), where code-unit order is SQLite's BINARY order.
  const versions = [...byVersion]
    .sort(([va, na], [vb, nb]) => nb - na || (va < vb ? -1 : va > vb ? 1 : 0))
    .map(([appVersion, n]) => ({ appVersion, count: n, share: share(n, denominator) }));
  return {
    versions: { denominator, versions },
    os: {
      denominator,
      families: OS_FAMILIES.map((family) => {
        const n = byFamily.get(family) ?? 0;
        return { family, count: n, share: share(n, denominator) };
      }),
    },
  };
}

/** The version half of weeklyMix. */
export async function versionMix(db: D1Database, asOfMs: number): Promise<VersionMix> {
  return (await weeklyMix(db, asOfMs)).versions;
}

/** The OS half of weeklyMix. */
export async function osMix(db: D1Database, asOfMs: number): Promise<OsMix> {
  return (await weeklyMix(db, asOfMs)).os;
}

/** Distinct ids seen in the 24 hours up to `asOf`. The rollup asks it at a day's end. */
export async function dailyActive(db: D1Database, asOfMs: number): Promise<number> {
  return distinctIdsSeen(db, asOfMs - DAILY_ACTIVE_WINDOW_MS, asOfMs);
}

export async function uniqueUsers30d(db: D1Database, asOfMs: number): Promise<number> {
  return distinctIdsSeen(db, asOfMs - UNIQUE_WINDOW_MS, asOfMs);
}

/** Distinct ids seen since 00:00 UTC today, up to `now`: the current UTC day so far. One query. */
export async function activeTodaySoFar(db: D1Database, nowMs: number): Promise<number> {
  // The window is open at its start, so starting 1 ms before midnight admits a beat AT midnight.
  return distinctIdsSeen(db, dayStartMs(nowMs) - 1, nowMs);
}

/**
 * The live figures that include the current moment, and when they were taken.
 * `dailyFloor` is what peakDailyActive takes today to be: the current UTC day's
 * distinct count when scanned, or the previous snapshot's peakDailyActive when
 * reused (itself an observed day, so it can never overstate the peak).
 */
export interface LiveActives {
  activeLast24h: number;
  activeLast7d: number;
  dailyFloor: number;
  asOfMs: number;
}

/**
 * The three live scans of the raw table: the rolling 24 hours, the rolling 7
 * days, and today since 00:00 UTC. Three queries, each reading every raw row in
 * its window, which is why the cron pass runs them at most once per
 * ACTIVE_REFRESH_MS (reusableActives) and not every 10 minutes: the 7-day one
 * alone would read about 1,008 rows per online install per pass (README, Known
 * limits).
 */
export async function scanActives(db: D1Database, nowMs: number): Promise<LiveActives> {
  return {
    activeLast24h: await distinctIdsSeen(db, nowMs - DAILY_ACTIVE_WINDOW_MS, nowMs),
    activeLast7d: await distinctIdsSeen(db, nowMs - ROLLING_WEEK_WINDOW_MS, nowMs),
    dailyFloor: await activeTodaySoFar(db, nowMs),
    asOfMs: nowMs,
  };
}

/**
 * The previous snapshot's live figures, if they may stand in for a fresh scan:
 * taken less than ACTIVE_REFRESH_MS before `now` (and not after it), with every
 * field present. Anything else (no snapshot, a snapshot from before these
 * fields, an unreadable one, a stale one) answers null, and the pass scans.
 */
export function reusableActives(snapshotBody: string | null, nowMs: number): LiveActives | null {
  if (!snapshotBody) return null;
  let m: Partial<Metrics>;
  try {
    m = JSON.parse(snapshotBody) as Partial<Metrics>;
  } catch {
    return null;
  }
  const asOfMs = typeof m.activeAsOf === "string" ? Date.parse(m.activeAsOf) : NaN;
  if (!Number.isFinite(asOfMs) || asOfMs > nowMs || nowMs - asOfMs >= ACTIVE_REFRESH_MS) return null;
  if (typeof m.activeLast24h !== "number" || typeof m.activeLast7d !== "number" || typeof m.peakDailyActive !== "number") return null;
  return { activeLast24h: m.activeLast24h, activeLast7d: m.activeLast7d, dailyFloor: m.peakDailyActive, asOfMs };
}

/**
 * peakDailyActive and peakWeeklyActive, today included. The per-day figures
 * come from the rollup rows the pass has already read (no query of their own),
 * so a peak outlives the 90-day purge of the raw rows; today adds the current
 * UTC day's distinct count and the rolling 7 days up to the live scan.
 */
export function peaksFrom(
  rows: readonly RollupRow[],
  dailyFloor: number,
  rolling7d: number,
): { peakDailyActive: number; peakWeeklyActive: number } {
  let daily = dailyFloor;
  let weekly = rolling7d;
  for (const r of rows) {
    daily = Math.max(daily, r.active_1d);
    weekly = Math.max(weekly, (JSON.parse(r.version_mix_7d) as VersionMix).denominator);
  }
  return { peakDailyActive: daily, peakWeeklyActive: weekly };
}

export async function concurrentNow(db: D1Database, nowMs: number): Promise<number> {
  return distinctIdsSeen(db, nowMs - CONCURRENT_WINDOW_MS, nowMs);
}

export async function peakConcurrent(db: D1Database): Promise<{ count: number; bucket: string | null }> {
  const row = await db
    .prepare(
      `SELECT bucket_start, distinct_ids FROM bucket_count
       ORDER BY distinct_ids DESC, bucket_start ASC LIMIT 1`,
    )
    .first<{ bucket_start: string; distinct_ids: number }>();
  return row ? { count: row.distinct_ids, bucket: row.bucket_start } : { count: 0, bucket: null };
}

/**
 * At most this many days are rolled up per cron pass. Each day costs four D1
 * queries, and Workers Free allows 50 queries per invocation (Cloudflare's D1
 * limits page, read 2026-09-24). Without a cap, catching up after a cron
 * outage of about two weeks would throw before the purge and the snapshot ran.
 * Seven days is 28 queries, so a whole pass (with both snapshots, the
 * today-so-far read, the all-time installs read, the previous snapshot's read
 * and the hourly live scans) is at most 44 (MAX_D1_QUERIES_PER_PASS). The rest
 * of the backlog waits for the next pass, ten minutes later.
 */
export const MAX_ROLLUP_DAYS_PER_PASS = 7;

/**
 * The most D1 queries one cron pass prepares, and rollup.test.ts pins the worst
 * case at exactly this: closeBuckets 1; the rollup's two starting reads plus
 * 4 x MAX_ROLLUP_DAYS_PER_PASS; the purge 1; readRollups 1; the metrics
 * snapshot 9 (the previous snapshot, peak concurrent, today's usage buckets,
 * the three live scans, concurrent now, all-time installs, the downloads read,
 * the write); the history snapshot 2; and on the hour's first tick, when
 * GitHub answered, the downloads row 1. Workers Free allows 50. It was 40
 * before the rolling actives and the peaks, and 44 before the downloads
 * (DRA-783). A pass that reuses the live scans (five in six) is 3 fewer, and a
 * pass off the hour's first tick 1 fewer again.
 * The peaks' per-day half reads the rollup rows already in the pass.
 */
export const MAX_D1_QUERIES_PER_PASS = 46;

/**
 * Writes a daily_rollup row for every COMPLETED UTC day that lacks one, from
 * the day after the last rollup (or the first raw heartbeat's day) up to
 * yesterday, MAX_ROLLUP_DAYS_PER_PASS at a time. Figures are as of the end of
 * the day. Catching up rather than firing once at midnight means a missed cron
 * run skips nothing.
 */
export async function writeDailyRollups(db: D1Database, nowMs: number): Promise<void> {
  const last = await db.prepare(`SELECT MAX(day) AS day FROM daily_rollup`).first<{ day: string | null }>();
  let dayMs: number;
  if (last?.day) {
    dayMs = Date.parse(`${last.day}T00:00:00Z`) + DAY_MS;
  } else {
    const first = await db
      .prepare(`SELECT MIN(bucket_start) AS b FROM heartbeat`)
      .first<{ b: string | null }>();
    if (!first?.b) return;
    dayMs = dayStartMs(Date.parse(first.b));
  }
  const today = dayStartMs(nowMs);
  // Raw rows only reach back RETENTION_DAYS, so there is nothing to roll up before that.
  dayMs = Math.max(dayMs, today - RETENTION_DAYS * DAY_MS);
  const stop = Math.min(today, dayMs + MAX_ROLLUP_DAYS_PER_PASS * DAY_MS);
  for (; dayMs < stop; dayMs += DAY_MS) {
    const endOfDay = dayMs + DAY_MS - 1;
    const unique = await uniqueUsers30d(db, endOfDay);
    // Both 7-day mixes come from one query (weeklyMix), so they cannot disagree.
    const mix = await weeklyMix(db, endOfDay);
    const active = await dailyActive(db, endOfDay);
    // The day's usage is summed from its closed buckets inside the same
    // statement, so the pass still costs four queries a day. closeBuckets runs
    // first in the pass, so a completed day's last bucket is already closed.
    await db
      .prepare(
        `INSERT OR IGNORE INTO daily_rollup (day, unique_30d, version_mix_7d, active_1d, usage_buckets_1d, os_mix_7d)
         SELECT ?1, ?2, ?3, ?4, COALESCE(SUM(distinct_ids), 0), ?7
         FROM bucket_count WHERE bucket_start >= ?5 AND bucket_start < ?6`,
      )
      .bind(dayKey(dayMs), unique, JSON.stringify(mix.versions), active, iso(dayMs), iso(dayMs + DAY_MS), JSON.stringify(mix.os))
      .run();
  }
}

/** One daily_rollup row, as the metrics and the history read it. */
export interface RollupRow {
  day: string;
  unique_30d: number;
  version_mix_7d: string;
  active_1d: number;
  usage_buckets_1d: number;
  /** JSON of an OsMix; null on a row written before migration 0006. */
  os_mix_7d: string | null;
}

/**
 * Every rollup row, oldest first: one row per day since launch. metrics.json
 * and history.json are both built from this ONE read per cron pass.
 */
export async function readRollups(db: D1Database): Promise<RollupRow[]> {
  const { results } = await db
    .prepare(`SELECT day, unique_30d, version_mix_7d, active_1d, usage_buckets_1d, os_mix_7d FROM daily_rollup ORDER BY day ASC`)
    .all<RollupRow>();
  return results;
}

/** Each distinct install in a 10-minute bucket is 10 minutes of use. Two decimals. */
export function bucketsToHours(installBuckets: number): number {
  return Math.round((installBuckets * 10 * 100) / 60) / 100;
}

export interface UsageHours {
  yesterday: number;
  last7d: number;
  last30d: number;
  allTime: number;
  todaySoFar: number;
  /** allTime to a whole hour, half up: a badge cannot round, and would print "3019.33" (DRA-783). */
  allTimeRounded: number;
}

/** Half up, to a whole number. Usage hours are never negative, so this is the schoolbook rule. */
export function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

/**
 * Install-buckets in the CURRENT UTC day's closed buckets. bucket_count only
 * ever holds closed buckets, so the bucket in progress is not in it yet. It
 * reads the id-free aggregate table whose per-bucket values history.json
 * already publishes as concurrent10m: one bounded query, at most 144 rows.
 */
export async function todayInstallBuckets(db: D1Database, nowMs: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(distinct_ids), 0) AS n FROM bucket_count WHERE bucket_start >= ?1`)
    .bind(iso(dayStartMs(nowMs)))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * yesterday, last7d and last30d are the days ending with the last complete UTC
 * day (the latest rollup), like every other daily number. todaySoFar is the
 * current UTC day's closed buckets, and allTime is every rollup row PLUS
 * today, so an "all time" figure never leaves out the day it is read on
 * (DRA-426). Rollups are never purged, so allTime outlives the raw heartbeats.
 */
export function usageHoursFrom(rows: readonly RollupRow[], todayBuckets = 0): UsageHours {
  const todaySoFar = bucketsToHours(todayBuckets);
  if (rows.length === 0) {
    return { yesterday: 0, last7d: 0, last30d: 0, allTime: todaySoFar, todaySoFar, allTimeRounded: roundHalfUp(todaySoFar) };
  }
  const lastMs = Date.parse(`${rows[rows.length - 1].day}T00:00:00Z`);
  const sumSince = (days: number): number => {
    const from = dayKey(lastMs - (days - 1) * DAY_MS);
    return rows.filter((r) => r.day >= from).reduce((s, r) => s + r.usage_buckets_1d, 0);
  };
  const allTime = bucketsToHours(rows.reduce((s, r) => s + r.usage_buckets_1d, 0) + todayBuckets);
  return {
    yesterday: bucketsToHours(sumSince(1)),
    last7d: bucketsToHours(sumSince(7)),
    last30d: bucketsToHours(sumSince(30)),
    allTime,
    todaySoFar,
    allTimeRounded: roundHalfUp(allTime),
  };
}

/** The public definitions, published beside the numbers (TEL-003). */
export const DEFINITIONS = {
  concurrentNow: "Distinct opted-in installs that sent a heartbeat in the last 10 minutes.",
  peakConcurrent: "The most distinct opted-in installs in any single 10-minute window.",
  uniqueUsers30d:
    "Distinct opted-in installs in the 30 days up to the end of the last complete UTC day. An install, not a person; telemetry is off unless the player turns it on.",
  versionMix7d:
    "Share of the distinct opted-in installs in the 7 days up to the end of the last complete UTC day on each version (each install counted once, on its latest version).",
  dailyActive:
    "Distinct opted-in installs that sent a heartbeat in the last complete UTC day (the 24 hours up to its end).",
  weeklyActive:
    "Distinct opted-in installs that sent a heartbeat in the 7 days up to the end of the last complete UTC day. The same installs versionMix7d divides among versions.",
  usageHours:
    "Estimated hours of use by opted-in installs only, at 10-minute resolution: each distinct install seen in a 10-minute window counts as 10 minutes. yesterday is the last complete UTC day; last7d and last30d are the 7 and 30 UTC days ending with it, so none of the three includes today. todaySoFar is the current UTC day's closed 10-minute windows only: the window in progress is not counted yet, and the figure is refreshed every 10 minutes and cached for up to 10 more, so it can run about 20 minutes behind. allTime is every complete UTC day since launch plus todaySoFar. allTimeRounded is allTime to the nearest whole hour (half up), for a badge that cannot round.",
  activeLast24h:
    "Distinct opted-in installs that sent a heartbeat in the 24 hours up to activeAsOf. A rolling window that includes today, unlike dailyActive, which ends at the last complete UTC day. Refreshed hourly, not every 10 minutes: activeAsOf is less than an hour before generatedAt.",
  activeLast7d:
    "Distinct opted-in installs that sent a heartbeat in the 7 days up to activeAsOf. A rolling window that includes today, unlike weeklyActive, which ends at the last complete UTC day. Refreshed hourly, not every 10 minutes: activeAsOf is less than an hour before generatedAt.",
  activeAsOf:
    "When activeLast24h, activeLast7d and the today part of peakDailyActive were last counted. They read every raw heartbeat in their windows, so they are counted once an hour and the figures in between repeat the last count.",
  peakDailyActive:
    "The most distinct opted-in installs seen in any single UTC day since launch, today included: the largest of every complete day's dailyActive and the distinct installs seen since 00:00 UTC today, as of activeAsOf (refreshed hourly).",
  peakWeeklyActive:
    "The most distinct opted-in installs seen in any 7-day window ending on a UTC day since launch, today included: the largest of every complete day's weeklyActive and activeLast7d (the 7 days up to activeAsOf, refreshed hourly).",
  downloads:
    "Not telemetry: the download counts GitHub publishes for the EQBuddy Evolved releases (every non-draft release tagged v2.*, from v2.0.0 on 2026-09-28), read from GitHub's public API once an hour. Fetches of the installer and the portable zip, summed; the .sha256 checksum files are left out, because the in-app updater fetches one beside every installer it verifies. A re-download, an update and a bot all count, so this is downloads, not people. total is every such fetch since v2.0.0, as of asOf. last30d is the fetches in the 30 days up to asOf: equal to total while v2.0.0 is inside that window, then total minus the total recorded at the end of the UTC day the window starts after. Daily totals are recorded from the day this field was first published, and nothing earlier is estimated, so where that day has no recorded total last30d is null and last30dNote says the first day a figure will exist. A failed read keeps the previous total and its asOf; it never publishes 0. null before the first successful read.",
  osMix7d:
    "Share of the same distinct opted-in installs versionMix7d divides (the 7 days up to the end of the last complete UTC day) by operating-system family, each install counted once, on the OS it reported last. Families: windows, macos-wine, linux-wine, wine-other (Wine on any other host), and other (a value matching none of the forms EQBuddy sends). Wine is counted only where the app reports it: Wine that hides itself, and any install whose app does not report Wine, counts as windows. since is the first UTC day this was counted; the days before it have no OS figure. null until that first day is complete.",
  installsAllTime:
    "Opted-in installs counted when first seen: each adds one the first time it sends a heartbeat. A lower bound, not total users: telemetry is off unless the player turns it on. It is a single running count, so no install id is kept to compute it; the raw heartbeats it is counted from are still deleted after 90 days. An install silent for more than 90 days, or one whose data was deleted, counts again if it comes back, and so does one that opts out and back in (a new id). Deleting an install's data does not lower it.",
} as const;

export interface Metrics {
  schema: 1;
  generatedAt: string;
  concurrentNow: number;
  peakConcurrent: number;
  peakConcurrentBucket: string | null;
  uniqueUsers30d: number;
  versionMix7d: VersionMix;
  dailyActive: number;
  weeklyActive: number;
  usageHours: UsageHours;
  installsAllTime: number;
  activeLast24h: number;
  activeLast7d: number;
  activeAsOf: string;
  peakDailyActive: number;
  peakWeeklyActive: number;
  downloads: Downloads | null;
  osMix7d: PublishedOsMix | null;
  definitions: typeof DEFINITIONS;
}

/** The latest day's OsMix, and the first day any rollup row carried one. */
export interface PublishedOsMix extends OsMix {
  since: string;
}

/**
 * From the rollup rows already read: the latest row's OS mix, with the first
 * day that has one. Rows written before migration 0006 have none, and they are
 * never filled in, so `since` is where the figure starts. null while the latest
 * row has none (no complete day since the column existed). No query.
 */
export function publishedOsMix(rows: readonly RollupRow[]): PublishedOsMix | null {
  const latest = rows[rows.length - 1];
  if (!latest?.os_mix_7d) return null;
  const first = rows.find((r) => r.os_mix_7d);
  return { since: first!.day, ...(JSON.parse(latest.os_mix_7d) as OsMix) };
}

/**
 * The trailing-window numbers come from the latest DAILY rollup, not a live
 * scan. A 30-day distinct count reads every raw row in 30 days; doing that on
 * every 10-minute pass would spend D1's free rows-read allowance 144 times a
 * day for a number that moves slowly. The 1- and 7-day counts follow the same
 * rule for the same reason. Before the first complete day all are zero, which
 * is the truth about a day that has not ended.
 *
 * activeLast24h, activeLast7d and today's part of peakDailyActive are the
 * deliberate exception: live scans that include today, because a headline that
 * leaves out the day it is read on reads as wrong (launch day, 2026-09-28).
 * Even they run hourly, not every pass (scanActives, reusableActives).
 *
 * weeklyActive is the 7-day version mix's denominator, not a second query: it
 * is the same distinct set over the same window, and one producer cannot
 * disagree with itself.
 */
function latestDaily(rows: readonly RollupRow[]): { unique30d: number; active1d: number; mix: VersionMix } {
  const row = rows[rows.length - 1];
  return row
    ? { unique30d: row.unique_30d, active1d: row.active_1d, mix: JSON.parse(row.version_mix_7d) as VersionMix }
    : { unique30d: 0, active1d: 0, mix: { denominator: 0, versions: [] } };
}

/**
 * `rollups` lets the cron pass share one read with the history; omitted, it is
 * read here. `live` is the previous snapshot's live figures when they may be
 * reused (reusableActives); omitted or null, the three live scans run.
 */
export async function computeMetrics(
  db: D1Database,
  nowMs: number,
  rollups?: readonly RollupRow[],
  live?: LiveActives | null,
): Promise<Metrics> {
  const rows = rollups ?? (await readRollups(db));
  const peak = await peakConcurrent(db);
  const daily = latestDaily(rows);
  const todayBuckets = await todayInstallBuckets(db, nowMs);
  const actives = live ?? (await scanActives(db, nowMs));
  const peaks = peaksFrom(rows, actives.dailyFloor, actives.activeLast7d);
  return {
    schema: 1,
    generatedAt: iso(nowMs),
    concurrentNow: await concurrentNow(db, nowMs),
    peakConcurrent: peak.count,
    peakConcurrentBucket: peak.bucket,
    uniqueUsers30d: daily.unique30d,
    versionMix7d: daily.mix,
    dailyActive: daily.active1d,
    weeklyActive: daily.mix.denominator,
    usageHours: usageHoursFrom(rows, todayBuckets),
    installsAllTime: await installsAllTime(db),
    activeLast24h: actives.activeLast24h,
    activeLast7d: actives.activeLast7d,
    activeAsOf: iso(actives.asOfMs),
    peakDailyActive: peaks.peakDailyActive,
    peakWeeklyActive: peaks.peakWeeklyActive,
    downloads: downloadsFrom(await readDownloadRows(db)),
    osMix7d: publishedOsMix(rows),
    definitions: DEFINITIONS,
  };
}

/**
 * Reads the snapshot it is about to replace first (one query, one row), so the
 * hourly live scans can be reused from it in between.
 */
export async function writeMetricsSnapshot(db: D1Database, nowMs: number, rollups?: readonly RollupRow[]): Promise<Metrics> {
  const live = reusableActives(await readMetricsSnapshot(db), nowMs);
  const metrics = await computeMetrics(db, nowMs, rollups, live);
  await db
    .prepare(
      `INSERT INTO metrics_snapshot (id, generated_at, body) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET generated_at = excluded.generated_at, body = excluded.body`,
    )
    .bind(metrics.generatedAt, JSON.stringify(metrics))
    .run();
  return metrics;
}

export async function readMetricsSnapshot(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT body FROM metrics_snapshot WHERE id = 1`).first<{ body: string }>();
  return row?.body ?? null;
}

/** The concurrent chart reaches back this far; older buckets live on only as rollups. */
export const HISTORY_BUCKET_WINDOW_MS = 7 * DAY_MS;

/** The public definitions of history.json's fields (TEL-003), beside the data. */
export const HISTORY_DEFINITIONS = {
  days:
    "One entry per complete UTC day since launch, oldest first. Each figure is as of the end of that day, exactly as metrics.json published it then.",
  day: "The UTC day, YYYY-MM-DD.",
  dailyActive: "Distinct opted-in installs that sent a heartbeat in that UTC day.",
  weeklyActive: "Distinct opted-in installs that sent a heartbeat in the 7 days up to the end of that UTC day.",
  uniqueUsers30d: "Distinct opted-in installs in the 30 days up to the end of that UTC day. An install, not a person.",
  usageHours:
    "Estimated hours of use that UTC day by opted-in installs only, at 10-minute resolution: each distinct install seen in a 10-minute window counts as 10 minutes.",
  versionMix7d: "The metrics.json versionMix7d object as of the end of that UTC day.",
  concurrent10m:
    "Distinct opted-in installs in each closed 10-minute UTC window of the last 7 days, oldest first. A window nobody was seen in has no entry and means 0.",
  bucket: "The window's start, ISO-8601 UTC.",
  count: "Distinct opted-in installs seen in that window.",
} as const;

export interface HistoryDay {
  day: string;
  dailyActive: number;
  weeklyActive: number;
  uniqueUsers30d: number;
  usageHours: number;
  versionMix7d: VersionMix;
}

export interface History {
  schema: 1;
  generatedAt: string;
  days: HistoryDay[];
  concurrent10m: Array<{ bucket: string; count: number }>;
  definitions: typeof HISTORY_DEFINITIONS;
}

/**
 * Built only from the id-free aggregate tables: daily_rollup and the last
 * week of bucket_count (at most 1,008 rows). Never reads heartbeat.
 */
export async function computeHistory(db: D1Database, nowMs: number, rollups?: readonly RollupRow[]): Promise<History> {
  const rows = rollups ?? (await readRollups(db));
  const { results } = await db
    .prepare(`SELECT bucket_start, distinct_ids FROM bucket_count WHERE bucket_start >= ?1 ORDER BY bucket_start ASC`)
    .bind(bucketStart(nowMs - HISTORY_BUCKET_WINDOW_MS))
    .all<{ bucket_start: string; distinct_ids: number }>();
  return {
    schema: 1,
    generatedAt: iso(nowMs),
    days: rows.map((r) => {
      const mix = JSON.parse(r.version_mix_7d) as VersionMix;
      return {
        day: r.day,
        dailyActive: r.active_1d,
        weeklyActive: mix.denominator,
        uniqueUsers30d: r.unique_30d,
        usageHours: bucketsToHours(r.usage_buckets_1d),
        versionMix7d: mix,
      };
    }),
    concurrent10m: results.map((b) => ({ bucket: b.bucket_start, count: b.distinct_ids })),
    definitions: HISTORY_DEFINITIONS,
  };
}

export async function writeHistorySnapshot(db: D1Database, nowMs: number, rollups?: readonly RollupRow[]): Promise<History> {
  const history = await computeHistory(db, nowMs, rollups);
  await db
    .prepare(
      `INSERT INTO history_snapshot (id, generated_at, body) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET generated_at = excluded.generated_at, body = excluded.body`,
    )
    .bind(history.generatedAt, JSON.stringify(history))
    .run();
  return history;
}

export async function readHistorySnapshot(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT body FROM history_snapshot WHERE id = 1`).first<{ body: string }>();
  return row?.body ?? null;
}

/**
 * The whole cron pass, in dependency order. The rollup (which records each
 * day's usage) runs before the purge, and the two snapshots share one read of
 * the rollups. `fetcher` reads GitHub's releases for the Evolved download
 * total on the first tick of each UTC hour (src/downloads.ts); omitted, as in
 * tests that do not mean to touch the network, no read is made. The read can
 * never fail the pass: any failure leaves the previous total standing.
 */
export async function runScheduled(db: D1Database, nowMs: number, fetcher?: typeof fetch): Promise<void> {
  await closeBuckets(db, nowMs);
  await writeDailyRollups(db, nowMs);
  await purgeExpired(db, nowMs);
  if (fetcher && isDispatchTick(nowMs)) {
    try {
      await refreshDownloads(db, nowMs, fetcher);
    } catch {
      // Deliberately silent (no log line): the previous total stands.
    }
  }
  const rollups = await readRollups(db);
  await writeMetricsSnapshot(db, nowMs, rollups);
  await writeHistorySnapshot(db, nowMs, rollups);
}

