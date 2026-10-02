// EQBuddy Evolved's download total (DRA-783 D1), for the EQBuddy README's
// "Downloads, last 30 days" row.
//
// Not telemetry: nothing here comes from a player. Once an hour the cron reads
// GitHub's public releases API (the worker's one outbound READ; the landing
// refresh in dispatch.ts is its one outbound write) and sums the download_count
// GitHub publishes for each Evolved release asset. shields.io cannot do this
// itself: a dynamic badge over the API joins several matches with commas
// rather than adding them, and cannot leave the .sha256 files out.
//
// What is counted: assets of every non-draft release whose tag starts "v2."
// (EQBuddy Evolved, from v2.0.0 on 2026-09-28), EXCEPT files ending ".sha256".
// The in-app updater fetches the .sha256 beside every installer it verifies,
// so counting it would count each in-app update twice. What is left is fetches
// of the installer and the portable zip: a re-download, an update and a bot
// all count, so it is downloads, not people.
//
// A failed read (a non-200, a body that is not the expected list, no v2
// release, a total of 0, or more pages than MAX_RELEASE_PAGES) answers null and
// the cron writes NOTHING: the previous total stands with its own as-of. It
// never writes 0.

import { DAY_MS, dayKey, iso } from "./time";

export const RELEASES_URL = "https://api.github.com/repos/DranakCorps-bot/EQBuddy/releases";
export const RELEASES_PER_PAGE = 100;
/**
 * The most release pages one read follows. GitHub lists releases newest first,
 * and the read stops at the first page holding a release created before
 * DOWNLOADS_SINCE, so today that is ONE page (2026-10-02: 180 releases, the
 * four v2 ones first). Hitting the cap without reaching that point answers
 * null rather than a partial sum.
 */
export const MAX_RELEASE_PAGES = 5;

/** EQBuddy Evolved 2.0, the first release counted. */
export const DOWNLOADS_SINCE = "2026-09-28";
export const DOWNLOADS_SINCE_TAG = "v2.0.0";
/** The window the README row names. */
export const DOWNLOADS_WINDOW_DAYS = 30;

const EVOLVED_TAG = /^v2\./;

/**
 * The Evolved download total across one or more pages of the releases API,
 * or null when there is nothing honest to say: not a list, or no admitted
 * release, or a total of 0.
 */
export function sumEvolvedDownloads(releases: unknown): number | null {
  if (!Array.isArray(releases)) return null;
  let admitted = 0;
  let total = 0;
  for (const r of releases) {
    if (!r || typeof r !== "object") return null;
    const release = r as { tag_name?: unknown; draft?: unknown; assets?: unknown };
    if (typeof release.tag_name !== "string" || !EVOLVED_TAG.test(release.tag_name)) continue;
    if (release.draft !== false) continue;
    if (!Array.isArray(release.assets)) return null;
    admitted++;
    for (const a of release.assets) {
      const asset = a as { name?: unknown; download_count?: unknown };
      if (typeof asset?.name !== "string" || typeof asset.download_count !== "number") return null;
      if (!Number.isInteger(asset.download_count) || asset.download_count < 0) return null;
      if (asset.name.toLowerCase().endsWith(".sha256")) continue;
      total += asset.download_count;
    }
  }
  return admitted > 0 && total > 0 ? total : null;
}

/** True once a page reaches a release created before Evolved 2.0: every later page is older still. */
function reachedBeforeSince(page: unknown[]): boolean {
  return page.some((r) => {
    const created = (r as { created_at?: unknown })?.created_at;
    return typeof created === "string" && created < `${DOWNLOADS_SINCE}T00:00:00Z`;
  });
}

/**
 * Reads every releases page down to the first release older than Evolved 2.0
 * and sums it. Pages are followed by number rather than by the Link header:
 * the code reads no header of any kind (test/static/guards.test.ts), and a
 * short page or the first pre-2.0 release ends the list either way.
 */
export async function fetchEvolvedDownloads(fetcher: typeof fetch): Promise<number | null> {
  const releases: unknown[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    let body: unknown;
    try {
      const response = await fetcher(`${RELEASES_URL}?per_page=${RELEASES_PER_PAGE}&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "eqbuddy-telemetry",
        },
      });
      if (response.status !== 200) return null;
      body = await response.json();
    } catch {
      return null;
    }
    if (!Array.isArray(body)) return null;
    releases.push(...body);
    if (body.length < RELEASES_PER_PAGE || reachedBeforeSince(body)) return sumEvolvedDownloads(releases);
  }
  return null; // ran out of pages before the list ended: a partial sum is not written
}

/** One downloads_daily row. */
export interface DownloadsRow {
  day: string;
  total: number;
  as_of: string;
}

/** metrics.json `downloads`. */
export interface Downloads {
  since: string;
  sinceTag: string;
  total: number;
  last30d: number | null;
  last30dNote: string | null;
  asOf: string;
}

/**
 * Records the total read at `nowMs` as its UTC day's row: the latest read of a
 * day replaces the earlier ones, so a completed day holds its end-of-day total.
 */
export async function recordDownloads(db: D1Database, total: number, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO downloads_daily (day, total, as_of) VALUES (?1, ?2, ?3)
       ON CONFLICT (day) DO UPDATE SET total = excluded.total, as_of = excluded.as_of`,
    )
    .bind(dayKey(nowMs), total, iso(nowMs))
    .run();
}

/**
 * The fetch tick: read GitHub and, only if the read succeeded, write today's
 * row. Answers whether a row was written.
 */
export async function refreshDownloads(db: D1Database, nowMs: number, fetcher: typeof fetch): Promise<boolean> {
  const total = await fetchEvolvedDownloads(fetcher);
  if (total === null) return false;
  await recordDownloads(db, total, nowMs);
  return true;
}

/** The UTC day whose end-of-day total a 30-day window up to `asOfMs` subtracts. */
export function windowBaseDay(asOfMs: number): string {
  return dayKey(asOfMs - DOWNLOADS_WINDOW_DAYS * DAY_MS);
}

/**
 * The rows downloadsFrom needs, in ONE query: the latest row, the row for the
 * window's base day, and the first row after the base day (which names the
 * day a figure will exist when the base day has none). The base day is taken
 * from the latest row's as-of, so a total that has stopped refreshing keeps
 * the window it was read in.
 */
export async function readDownloadRows(db: D1Database): Promise<DownloadsRow[]> {
  const { results } = await db
    .prepare(
      `WITH latest AS (SELECT day, total, as_of FROM downloads_daily ORDER BY day DESC LIMIT 1),
            base AS (SELECT date(as_of, '-${DOWNLOADS_WINDOW_DAYS} days') AS d FROM latest)
       SELECT day, total, as_of FROM downloads_daily
       WHERE day = (SELECT day FROM latest)
          OR day = (SELECT d FROM base)
          OR day = (SELECT MIN(day) FROM downloads_daily WHERE day > (SELECT d FROM base))
       ORDER BY day ASC`,
    )
    .all<DownloadsRow>();
  return results;
}

/**
 * metrics.json `downloads` from the rows readDownloadRows answers (any superset
 * of them works), or null before the first successful read.
 *
 * last30d is the downloads in the 30 days up to asOf: `total` while Evolved 2.0
 * itself is inside the window (every Evolved download is), then `total` minus
 * the window base day's end-of-day total. With no row for that day it is null,
 * and last30dNote names the first day a figure will exist. Nothing is
 * back-filled or estimated.
 */
export function downloadsFrom(rows: readonly DownloadsRow[]): Downloads | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const latest = sorted[sorted.length - 1];
  const asOfMs = Date.parse(latest.as_of);
  const baseDay = windowBaseDay(asOfMs);
  const out: Downloads = {
    since: DOWNLOADS_SINCE,
    sinceTag: DOWNLOADS_SINCE_TAG,
    total: latest.total,
    last30d: null,
    last30dNote: null,
    asOf: latest.as_of,
  };
  if (baseDay < DOWNLOADS_SINCE) {
    out.last30d = latest.total;
    return out;
  }
  const base = sorted.find((r) => r.day === baseDay);
  if (base && base.day < latest.day) {
    const diff = latest.total - base.total;
    if (diff >= 0) {
      out.last30d = diff;
    } else {
      out.last30dNote = `The download total fell after ${baseDay} (a release or file was removed), so no 30-day figure is published from it.`;
    }
    return out;
  }
  const next = sorted.find((r) => r.day > baseDay);
  const firstDay = dayKey(Date.parse(`${next ? next.day : latest.day}T00:00:00Z`) + DOWNLOADS_WINDOW_DAYS * DAY_MS);
  out.last30dNote = `No daily download total was recorded for ${baseDay}, the day this 30-day window starts after, so no 30-day figure is published. The first one will be on ${firstDay}.`;
  return out;
}
