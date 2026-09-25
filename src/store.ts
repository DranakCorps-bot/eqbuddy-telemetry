// Every D1 statement the backend runs. Nothing here receives, reads or
// writes a request's address: the functions take a validated payload or a
// clock, and that is all.

import type { Heartbeat } from "./validate";
import {
  CONCURRENT_WINDOW_MS,
  DAILY_ACTIVE_WINDOW_MS,
  DAY_MS,
  RATE_LIMIT_MS,
  RETENTION_DAYS,
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
 */
export async function recordHeartbeat(db: D1Database, hb: Heartbeat, nowMs: number): Promise<RecordOutcome> {
  const result = await db
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
    .bind(hb.installId, bucketStart(nowMs), hb.appVersion, hb.os, nowMs, nowMs - RATE_LIMIT_MS, bucketStart(nowMs - RATE_LIMIT_MS))
    .run();
  return result.meta.changes > 0 ? "recorded" : "rate-limited";
}

/** Hard-deletes every raw row for the id. Says nothing about whether any existed. */
export async function deleteInstall(db: D1Database, installId: string): Promise<void> {
  await db.prepare(`DELETE FROM heartbeat WHERE install_id = ?1`).bind(installId).run();
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

/**
 * Among distinct ids seen in the 7 days up to `asOf`, the share on each
 * version, taking each id's LATEST version in the window. Largest first;
 * ties by version string so the output is deterministic.
 */
export async function versionMix(db: D1Database, asOfMs: number): Promise<VersionMix> {
  const { results } = await db
    .prepare(
      `WITH latest AS (
         SELECT app_version,
                ROW_NUMBER() OVER (PARTITION BY install_id ORDER BY last_seen_ms DESC) AS rn
         FROM heartbeat
         WHERE ${IN_WINDOW}
       )
       SELECT app_version, COUNT(*) AS n FROM latest WHERE rn = 1
       GROUP BY app_version
       ORDER BY n DESC, app_version ASC`,
    )
    .bind(...windowArgs(asOfMs - VERSION_WINDOW_MS, asOfMs))
    .all<{ app_version: string; n: number }>();
  const denominator = results.reduce((sum, r) => sum + r.n, 0);
  return {
    denominator,
    versions: results.map((r) => ({
      appVersion: r.app_version,
      count: r.n,
      share: Math.round((r.n / denominator) * 1000) / 1000,
    })),
  };
}

/** Distinct ids seen in the 24 hours up to `asOf`. The rollup asks it at a day's end. */
export async function dailyActive(db: D1Database, asOfMs: number): Promise<number> {
  return distinctIdsSeen(db, asOfMs - DAILY_ACTIVE_WINDOW_MS, asOfMs);
}

export async function uniqueUsers30d(db: D1Database, asOfMs: number): Promise<number> {
  return distinctIdsSeen(db, asOfMs - UNIQUE_WINDOW_MS, asOfMs);
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
 * Seven days is 28 queries, so a whole pass (with both snapshots) stays under
 * 40. The rest of the
 * backlog waits for the next pass, ten minutes later.
 */
export const MAX_ROLLUP_DAYS_PER_PASS = 7;

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
    const mix = await versionMix(db, endOfDay);
    const active = await dailyActive(db, endOfDay);
    // The day's usage is summed from its closed buckets inside the same
    // statement, so the pass still costs four queries a day. closeBuckets runs
    // first in the pass, so a completed day's last bucket is already closed.
    await db
      .prepare(
        `INSERT OR IGNORE INTO daily_rollup (day, unique_30d, version_mix_7d, active_1d, usage_buckets_1d)
         SELECT ?1, ?2, ?3, ?4, COALESCE(SUM(distinct_ids), 0)
         FROM bucket_count WHERE bucket_start >= ?5 AND bucket_start < ?6`,
      )
      .bind(dayKey(dayMs), unique, JSON.stringify(mix), active, iso(dayMs), iso(dayMs + DAY_MS))
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
}

/**
 * Every rollup row, oldest first: one row per day since launch. metrics.json
 * and history.json are both built from this ONE read per cron pass.
 */
export async function readRollups(db: D1Database): Promise<RollupRow[]> {
  const { results } = await db
    .prepare(`SELECT day, unique_30d, version_mix_7d, active_1d, usage_buckets_1d FROM daily_rollup ORDER BY day ASC`)
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
}

/**
 * Usage hours over the days ending with the last complete UTC day (the latest
 * rollup), like every other daily number. allTime sums every rollup row, and
 * rollups are never purged, so it outlives the raw heartbeats.
 */
export function usageHoursFrom(rows: readonly RollupRow[]): UsageHours {
  if (rows.length === 0) return { yesterday: 0, last7d: 0, last30d: 0, allTime: 0 };
  const lastMs = Date.parse(`${rows[rows.length - 1].day}T00:00:00Z`);
  const sumSince = (days: number): number => {
    const from = dayKey(lastMs - (days - 1) * DAY_MS);
    return rows.filter((r) => r.day >= from).reduce((s, r) => s + r.usage_buckets_1d, 0);
  };
  return {
    yesterday: bucketsToHours(sumSince(1)),
    last7d: bucketsToHours(sumSince(7)),
    last30d: bucketsToHours(sumSince(30)),
    allTime: bucketsToHours(rows.reduce((s, r) => s + r.usage_buckets_1d, 0)),
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
    "Estimated hours of use by opted-in installs only, at 10-minute resolution: each distinct install seen in a 10-minute window counts as 10 minutes. yesterday is the last complete UTC day; last7d and last30d are the 7 and 30 UTC days ending with it; allTime is every complete UTC day since launch.",
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
  definitions: typeof DEFINITIONS;
}

/**
 * The trailing-window numbers come from the latest DAILY rollup, not a live
 * scan. A 30-day distinct count reads every raw row in 30 days; doing that on
 * every 10-minute pass would spend D1's free rows-read allowance 144 times a
 * day for a number that moves slowly. The 1- and 7-day counts follow the same
 * rule for the same reason. Before the first complete day all are zero, which
 * is the truth about a day that has not ended.
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

/** `rollups` lets the cron pass share one read with the history; omitted, it is read here. */
export async function computeMetrics(db: D1Database, nowMs: number, rollups?: readonly RollupRow[]): Promise<Metrics> {
  const rows = rollups ?? (await readRollups(db));
  const peak = await peakConcurrent(db);
  const daily = latestDaily(rows);
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
    usageHours: usageHoursFrom(rows),
    definitions: DEFINITIONS,
  };
}

export async function writeMetricsSnapshot(db: D1Database, nowMs: number, rollups?: readonly RollupRow[]): Promise<Metrics> {
  const metrics = await computeMetrics(db, nowMs, rollups);
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
 * the rollups.
 */
export async function runScheduled(db: D1Database, nowMs: number): Promise<void> {
  await closeBuckets(db, nowMs);
  await writeDailyRollups(db, nowMs);
  await purgeExpired(db, nowMs);
  const rollups = await readRollups(db);
  await writeMetricsSnapshot(db, nowMs, rollups);
  await writeHistorySnapshot(db, nowMs, rollups);
}

