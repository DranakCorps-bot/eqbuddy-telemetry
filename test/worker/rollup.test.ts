import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../../src/index";
import {
  DEFINITIONS,
  MAX_D1_QUERIES_PER_PASS,
  MAX_ROLLUP_DAYS_PER_PASS,
  closeBuckets,
  computeMetrics,
  dailyActive,
  peaksFrom,
  purgeExpired,
  recordHeartbeat,
  reusableActives,
  runScheduled,
  scanActives,
  uniqueUsers30d,
  versionMix,
  writeDailyRollups,
} from "../../src/store";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.parse("2026-10-01T12:00:00Z");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";
const E = "eeeeeeee-0000-4000-8000-000000000005";

async function beat(installId: string, appVersion: string, at: number): Promise<void> {
  const outcome = await recordHeartbeat(env.DB, { installId, appVersion, os: "Windows 10.0.26200" }, at);
  expect(outcome).toBe("recorded");
}

/** The database, with every statement it is asked to prepare recorded in order. */
function recording(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (q: string) => {
          sql.push(q);
          return target.prepare(q);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, sql };
}

async function bucketCounts(): Promise<Record<string, number>> {
  const { results } = await env.DB
    .prepare("SELECT bucket_start, distinct_ids FROM bucket_count ORDER BY bucket_start")
    .all<{ bucket_start: string; distinct_ids: number }>();
  return Object.fromEntries(results.map((r) => [r.bucket_start, r.distinct_ids]));
}

/**
 * The fixture with known answers. Five installs:
 *   A  12:01 and 12:06 (bucket 12:00), 12:11 (bucket 12:10)   2.0.1 throughout — spans two buckets
 *   B  12:02 on 2.0.0 (bucket 12:00), 12:13 on 2.0.1 (bucket 12:10)  — changed version
 *   C  12:03 on 2.0.0 (bucket 12:00) only
 *   D  20 days earlier, 2.0.0 — inside 30 days, outside 7
 *   E  40 days earlier, 1.9.0 — outside 30 days
 */
async function seedFixture(): Promise<void> {
  await beat(E, "1.9.0", T0 - 40 * DAY);
  await beat(D, "2.0.0", T0 - 20 * DAY);
  await beat(A, "2.0.1", T0 + 1 * MIN);
  await beat(B, "2.0.0", T0 + 2 * MIN);
  await beat(C, "2.0.0", T0 + 3 * MIN);
  await beat(A, "2.0.1", T0 + 6 * MIN);
  await beat(A, "2.0.1", T0 + 11 * MIN);
  await beat(B, "2.0.1", T0 + 13 * MIN);
}

describe("rollup math against a fixture with known answers", () => {
  it("closes only finished buckets, each with its distinct-id count", async () => {
    await seedFixture();
    await closeBuckets(env.DB, T0 + 15 * MIN);
    expect(await bucketCounts()).toEqual({
      "2026-08-22T12:00:00Z": 1, // E
      "2026-09-11T12:00:00Z": 1, // D
      "2026-10-01T12:00:00Z": 3, // A (twice), B, C — A counted once
      // 12:10 is the current bucket at 12:15 and must not be closed yet
    });

    await closeBuckets(env.DB, T0 + 25 * MIN);
    expect((await bucketCounts())["2026-10-01T12:10:00Z"]).toBe(2); // A, B
  });

  it("computes concurrent-now and peak live", async () => {
    await seedFixture();
    await closeBuckets(env.DB, T0 + 25 * MIN);
    const m = await computeMetrics(env.DB, T0 + 15 * MIN);

    // Last 10 minutes = after 12:05: A (12:06, 12:11) and B (12:13). C last seen 12:03.
    expect(m.concurrentNow).toBe(2);
    // The 12:00 bucket held A, B, C.
    expect(m.peakConcurrent).toBe(3);
    expect(m.peakConcurrentBucket).toBe("2026-10-01T12:00:00Z");
  });

  it("computes the trailing-window numbers", async () => {
    await seedFixture();
    const asOf = T0 + 15 * MIN;
    // A, B, C, D. E is 40 days old.
    expect(await uniqueUsers30d(env.DB, asOf)).toBe(4);
    // Trailing 24 hours: A, B, C. A beat three times and counts once; D is 20 days old.
    expect(await dailyActive(env.DB, asOf)).toBe(3);
    // Trailing 7 days: A, B, C. B counts ONCE, on its latest version.
    expect(await versionMix(env.DB, asOf)).toEqual({
      denominator: 3,
      versions: [
        { appVersion: "2.0.1", count: 2, share: 0.667 },
        { appVersion: "2.0.0", count: 1, share: 0.333 },
      ],
    });
  });

  it("the window edges are exact: 30 days is 30 days, not the bucket containing it", async () => {
    const asOf = T0 + 15 * MIN;
    await beat(A, "2.0.0", asOf - 30 * DAY); // exactly 30 days: outside (the window is open at its start)
    await beat(B, "2.0.0", asOf - 30 * DAY + 1); // one ms inside
    await beat(C, "2.0.0", asOf + 1); // after asOf: not yet seen
    expect(await uniqueUsers30d(env.DB, asOf)).toBe(1);
  });

  it("the 24-hour edge is exact too", async () => {
    const asOf = T0 + 15 * MIN;
    await beat(A, "2.0.0", asOf - DAY); // exactly 24 hours: outside
    await beat(B, "2.0.0", asOf - DAY + 1); // one ms inside
    await beat(C, "2.0.0", asOf + 1); // after asOf: not yet seen
    expect(await dailyActive(env.DB, asOf)).toBe(1);
  });

  it("publishes the trailing-window numbers from the latest daily rollup", async () => {
    await seedFixture();
    // Before any day has completed, the trailing numbers are zero rather than a live scan.
    const before = await computeMetrics(env.DB, T0 + 15 * MIN);
    expect(before.uniqueUsers30d).toBe(0);
    expect(before.versionMix7d).toEqual({ denominator: 0, versions: [] });
    expect(before.dailyActive).toBe(0);
    expect(before.weeklyActive).toBe(0);

    // The fixture reaches back 40 days, so the rollup backlog is 41 days and
    // drains MAX_ROLLUP_DAYS_PER_PASS per pass: six passes, ten minutes apart.
    const nextDay = Date.parse("2026-10-02T00:05:00Z");
    const passes = Math.ceil(41 / MAX_ROLLUP_DAYS_PER_PASS);
    for (let pass = 0; pass < passes; pass++) await runScheduled(env.DB, nextDay + pass * 10 * MIN);
    const after = await computeMetrics(env.DB, nextDay);
    expect(after.uniqueUsers30d).toBe(4);
    expect(after.versionMix7d.denominator).toBe(3);
    // Oct 1 is the last complete day and held A, B, C.
    expect(after.dailyActive).toBe(3);
    // The same distinct set the version mix divides: A, B, C (D is 20 days old).
    expect(after.weeklyActive).toBe(3);
    expect(after.weeklyActive).toBe(after.versionMix7d.denominator);
    expect(after.concurrentNow).toBe(0);
  });

  it("a peak tie reports the earliest bucket", async () => {
    await beat(A, "2.0.0", T0);
    await beat(A, "2.0.0", T0 + 30 * MIN);
    await closeBuckets(env.DB, T0 + 45 * MIN);
    const m = await computeMetrics(env.DB, T0 + 45 * MIN);
    expect(m.peakConcurrent).toBe(1);
    expect(m.peakConcurrentBucket).toBe("2026-10-01T12:00:00Z");
  });

  it("an empty backend publishes zeros and a null peak bucket, never a fabricated figure", async () => {
    const m = await computeMetrics(env.DB, T0);
    expect(m).toMatchObject({
      concurrentNow: 0,
      peakConcurrent: 0,
      peakConcurrentBucket: null,
      uniqueUsers30d: 0,
      versionMix7d: { denominator: 0, versions: [] },
      dailyActive: 0,
      weeklyActive: 0,
      installsAllTime: 0,
    });
  });

  it("daily and weekly active differ when an install went quiet mid-week", async () => {
    const DAY1 = Date.parse("2026-10-01T00:00:00Z");
    await beat(A, "2.0.0", DAY1 - 3 * DAY + 60 * MIN); // Sep 28: inside 7 days of Oct 1's end, not on Oct 1
    await beat(B, "2.0.0", DAY1 + 60 * MIN); // Oct 1
    await beat(C, "2.0.0", DAY1 + DAY - 1); // Oct 1, last ms of the day
    await beat(D, "2.0.0", DAY1 + DAY); // Oct 2, first ms: not part of Oct 1
    await writeDailyRollups(env.DB, DAY1 + DAY + 5 * MIN);
    const m = await computeMetrics(env.DB, DAY1 + DAY + 5 * MIN);
    expect(m.dailyActive).toBe(2); // B, C
    expect(m.weeklyActive).toBe(3); // A, B, C
  });

  it("a closed bucket's count is final: a later delete does not rewrite it", async () => {
    await beat(A, "2.0.0", T0);
    await beat(B, "2.0.0", T0 + MIN);
    await closeBuckets(env.DB, T0 + 11 * MIN);
    await handle(
      new Request("https://t.test/delete", { method: "POST", body: JSON.stringify({ installId: A }) }),
      env,
      T0 + 12 * MIN,
    );
    await closeBuckets(env.DB, T0 + 21 * MIN);
    expect((await bucketCounts())["2026-10-01T12:00:00Z"]).toBe(2);
  });
});

describe("rolling actives: activeLast24h and activeLast7d include the current moment", () => {
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const X = A; // 2 hours ago: today
  const Y = B; // 3 days ago
  const Z = C; // 8 days ago

  it("a beat 2 hours ago counts in both and in no complete-day figure; 3 days ago only in the 7 days; 8 days ago in neither", async () => {
    await beat(Z, "2.0.0", NOW - 8 * DAY);
    await beat(Y, "2.0.0", NOW - 3 * DAY);
    await beat(X, "2.0.0", NOW - 2 * 60 * MIN);
    // The backlog reaches back 9 days: two passes roll every complete day up.
    await runScheduled(env.DB, NOW - 10 * MIN);
    await runScheduled(env.DB, NOW);
    const m = await computeMetrics(env.DB, NOW);

    expect(m.activeLast24h).toBe(1); // X
    expect(m.activeLast7d).toBe(2); // X, Y
    // The complete-day figures end at Oct 9's end, before X's beat.
    expect(m.dailyActive).toBe(0);
    expect(m.weeklyActive).toBe(1); // Y; Z is 8 days back, outside Oct 3..Oct 9
    expect(m.uniqueUsers30d).toBe(2); // Y, Z
    // The cron's snapshot publishes the same.
    const snap = await env.DB.prepare("SELECT body FROM metrics_snapshot WHERE id = 1").first<{ body: string }>();
    expect(JSON.parse(snap!.body)).toMatchObject({ activeLast24h: 1, activeLast7d: 2, dailyActive: 0, weeklyActive: 1 });
  });

  it("the edges are exact: 24 hours and 7 days back are outside, one ms later is inside, after now is not yet seen", async () => {
    await beat(A, "2.0.0", NOW - DAY); // exactly 24 hours: outside the day, inside the week
    await beat(B, "2.0.0", NOW - DAY + 1); // inside both
    await beat(C, "2.0.0", NOW - 7 * DAY); // exactly 7 days: outside both
    await beat(D, "2.0.0", NOW - 7 * DAY + 1); // inside the week only
    await beat(E, "2.0.0", NOW + 1); // after now: in neither
    // None of them is in today since 00:00 UTC.
    expect(await scanActives(env.DB, NOW)).toEqual({ activeLast24h: 1, activeLast7d: 3, dailyFloor: 0, asOfMs: NOW });
  });

  it("today is since 00:00 UTC to the millisecond: a beat AT midnight counts, one ms before does not", async () => {
    const midnight = Date.parse("2026-10-10T00:00:00Z");
    await beat(A, "2.0.0", midnight - 1);
    await beat(B, "2.0.0", midnight);
    expect((await scanActives(env.DB, NOW)).dailyFloor).toBe(1);
  });

  it("a live scan costs three queries, each bounded to its window", async () => {
    const { db, sql } = recording();
    await scanActives(db, NOW);
    expect(sql).toHaveLength(3);
    for (const q of sql) expect(q).toMatch(/last_seen_ms > \?1 AND last_seen_ms <= \?2 AND bucket_start >= \?3/);
  });

  it("defines both as rolling windows that include today and refresh hourly, unlike dailyActive and weeklyActive", () => {
    for (const key of ["activeLast24h", "activeLast7d"] as const) {
      expect(DEFINITIONS[key], key).toMatch(/up to activeAsOf/);
      expect(DEFINITIONS[key], key).toMatch(/rolling window that includes today/);
      expect(DEFINITIONS[key], key).toMatch(/ends at the last complete UTC day/);
      expect(DEFINITIONS[key], key).toMatch(/Refreshed hourly, not every 10 minutes/);
    }
    expect(DEFINITIONS.activeLast24h).toMatch(/24 hours/);
    expect(DEFINITIONS.activeLast24h).toMatch(/unlike dailyActive/);
    expect(DEFINITIONS.activeLast7d).toMatch(/7 days/);
    expect(DEFINITIONS.activeLast7d).toMatch(/unlike weeklyActive/);
    expect(DEFINITIONS.activeAsOf).toMatch(/counted once an hour/);
  });
});

describe("peakDailyActive and peakWeeklyActive: the busiest day and week since launch, today included", () => {
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const TODAY = Date.parse("2026-10-10T00:00:00Z");

  /** Runs cron passes, ten minutes apart and ending at `now`, until every complete day is rolled up. */
  async function catchUp(now: number, passes = 6): Promise<void> {
    for (let p = passes - 1; p >= 0; p--) await runScheduled(env.DB, now - p * 10 * MIN);
  }

  it("on launch day, today-only activity sets both peaks", async () => {
    await beat(A, "2.0.0", TODAY + 60 * MIN);
    await beat(B, "2.0.0", TODAY + 120 * MIN);
    await runScheduled(env.DB, NOW);
    const m = await computeMetrics(env.DB, NOW);
    expect(m.dailyActive).toBe(0); // no complete day yet
    expect(m.peakDailyActive).toBe(2);
    expect(m.peakWeeklyActive).toBe(2);
    const snap = await env.DB.prepare("SELECT body FROM metrics_snapshot WHERE id = 1").first<{ body: string }>();
    expect(JSON.parse(snap!.body)).toMatchObject({ peakDailyActive: 2, peakWeeklyActive: 2 });
  });

  it("an earlier, busier day keeps its peak", async () => {
    // Sep 20 held A, B and C; today only D.
    for (const [id, m] of [[A, 60], [B, 120], [C, 180]] as const) await beat(id, "2.0.0", TODAY - 20 * DAY + m * MIN);
    await beat(D, "2.0.0", TODAY + 60 * MIN);
    await catchUp(NOW);
    const m = await computeMetrics(env.DB, NOW);
    expect(m.activeLast7d).toBe(1); // D: Sep 20 is 20 days back
    expect(m.peakDailyActive).toBe(3);
    expect(m.peakWeeklyActive).toBe(3); // Sep 20's 7-day figure, from its rollup
  });

  it("the rolling 7 days count toward the weekly peak", async () => {
    await beat(A, "2.0.0", NOW - 3 * DAY); // Oct 7
    await beat(B, "2.0.0", TODAY + 60 * MIN);
    await beat(C, "2.0.0", TODAY + 120 * MIN);
    await catchUp(NOW);
    const m = await computeMetrics(env.DB, NOW);
    // Every complete day's 7-day figure is 1 (A); the 7 days up to now hold A, B and C.
    expect(m.weeklyActive).toBe(1);
    expect(m.activeLast7d).toBe(3);
    expect(m.peakWeeklyActive).toBe(3);
    expect(m.peakDailyActive).toBe(2); // today: B, C
  });

  it("today is the UTC day since 00:00, not the rolling 24 hours", async () => {
    await beat(A, "2.0.0", TODAY - 60 * MIN); // yesterday 23:00
    await beat(B, "2.0.0", TODAY + 60 * MIN); // today 01:00
    const now = TODAY + 120 * MIN;
    await catchUp(now);
    const m = await computeMetrics(env.DB, now);
    expect(m.activeLast24h).toBe(2);
    expect(m.peakDailyActive).toBe(1); // yesterday held A, today B: never both in one UTC day
  });

  it("the per-day half reads the rollup rows already in the pass: peaksFrom is pure", () => {
    const row = (day: string, active_1d: number, weekly: number) => ({
      day,
      unique_30d: 0,
      version_mix_7d: JSON.stringify({ denominator: weekly, versions: [] }),
      active_1d,
      usage_buckets_1d: 0,
    });
    const rows = [row("2026-10-01", 5, 9), row("2026-10-02", 2, 7)];
    expect(peaksFrom(rows, 4, 8)).toEqual({ peakDailyActive: 5, peakWeeklyActive: 9 });
    expect(peaksFrom(rows, 6, 10)).toEqual({ peakDailyActive: 6, peakWeeklyActive: 10 });
    expect(peaksFrom([], 0, 0)).toEqual({ peakDailyActive: 0, peakWeeklyActive: 0 });
  });

  it("defines both, today included, refreshed hourly", () => {
    expect(DEFINITIONS.peakDailyActive).toMatch(/any single UTC day since launch, today included/);
    expect(DEFINITIONS.peakDailyActive).toMatch(/since 00:00 UTC today/);
    expect(DEFINITIONS.peakWeeklyActive).toMatch(/any 7-day window ending on a UTC day since launch, today included/);
    expect(DEFINITIONS.peakWeeklyActive).toMatch(/activeLast7d/);
    for (const d of [DEFINITIONS.peakDailyActive, DEFINITIONS.peakWeeklyActive]) expect(d).toMatch(/refreshed hourly/);
  });
});

describe("the live scans run at most hourly; the passes between reuse the last snapshot", () => {
  const H = Date.parse("2026-10-10T12:00:00Z");

  async function snapshot(): Promise<Record<string, unknown>> {
    const snap = await env.DB.prepare("SELECT body FROM metrics_snapshot WHERE id = 1").first<{ body: string }>();
    return JSON.parse(snap!.body);
  }

  /** The heartbeat distinct-count scans a statement list holds: concurrentNow is one, each live scan another. */
  function heartbeatScans(sql: string[]): number {
    return sql.filter((q) => /COUNT\(DISTINCT install_id\) AS n FROM heartbeat/.test(q)).length;
  }

  it("scans at the hour, reuses for the five passes after it, and scans again an hour on", async () => {
    await beat(A, "2.0.0", H - 5 * MIN);
    const first = recording();
    await runScheduled(first.db, H);
    expect(heartbeatScans(first.sql)).toBe(4); // three live scans + concurrentNow
    expect(await snapshot()).toMatchObject({ activeLast24h: 1, activeAsOf: "2026-10-10T12:00:00Z", generatedAt: "2026-10-10T12:00:00Z" });

    await beat(B, "2.0.0", H + 5 * MIN);
    for (let p = 1; p <= 5; p++) {
      const pass = recording();
      await runScheduled(pass.db, H + p * 10 * MIN);
      expect(heartbeatScans(pass.sql), `pass ${p}`).toBe(1); // concurrentNow only
      const s = await snapshot();
      // B is not counted yet: the figures and their time are the 12:00 scan's.
      expect(s, `pass ${p}`).toMatchObject({ activeLast24h: 1, activeLast7d: 1, peakDailyActive: 1, activeAsOf: "2026-10-10T12:00:00Z" });
      expect(s.generatedAt).toBe(new Date(H + p * 10 * MIN).toISOString().replace(/\.\d{3}Z$/, "Z"));
    }

    const hourOn = recording();
    await runScheduled(hourOn.db, H + 60 * MIN);
    expect(heartbeatScans(hourOn.sql)).toBe(4);
    expect(await snapshot()).toMatchObject({ activeLast24h: 2, activeLast7d: 2, peakDailyActive: 2, activeAsOf: "2026-10-10T13:00:00Z" });
  });

  it("reuses a snapshot only when it is under an hour old, not from the future, and carries every field", () => {
    const body = (fields: Record<string, unknown>) =>
      JSON.stringify({ activeLast24h: 4, activeLast7d: 9, peakDailyActive: 6, activeAsOf: "2026-10-10T12:00:00Z", ...fields });
    const reused = { activeLast24h: 4, activeLast7d: 9, dailyFloor: 6, asOfMs: H };
    expect(reusableActives(body({}), H + 59 * MIN)).toEqual(reused);
    expect(reusableActives(body({}), H)).toEqual(reused);
    expect(reusableActives(body({}), H + 60 * MIN)).toBeNull(); // an hour on: scan
    expect(reusableActives(body({}), H - 1)).toBeNull(); // taken after now: scan
    expect(reusableActives(body({ activeAsOf: undefined }), H)).toBeNull(); // a snapshot from before activeAsOf
    expect(reusableActives(body({ peakDailyActive: undefined }), H)).toBeNull();
    expect(reusableActives(body({ activeLast7d: "9" }), H)).toBeNull();
    expect(reusableActives(body({ activeAsOf: "not a time" }), H)).toBeNull();
    expect(reusableActives("{not json", H)).toBeNull();
    expect(reusableActives(null, H)).toBeNull();
  });

  it("a reused peakDailyActive is a floor, never a ceiling: a busier completed day still raises it", async () => {
    // A snapshot claiming a peak of 1, reused; then the rollups show a day of 3.
    const prev = { activeLast24h: 1, activeLast7d: 1, dailyFloor: 1, asOfMs: H };
    const rows = [
      { day: "2026-10-09", unique_30d: 3, version_mix_7d: JSON.stringify({ denominator: 3, versions: [] }), active_1d: 3, usage_buckets_1d: 0 },
    ];
    const m = await computeMetrics(env.DB, H + 10 * MIN, rows, prev);
    expect(m).toMatchObject({ peakDailyActive: 3, peakWeeklyActive: 3, activeLast24h: 1, activeAsOf: "2026-10-10T12:00:00Z" });
  });
});

describe("daily rollups", () => {
  const DAY1 = Date.parse("2026-10-01T00:00:00Z");

  async function daily(): Promise<Array<{ day: string; unique_30d: number; version_mix_7d: string; active_1d: number }>> {
    const { results } = await env.DB
      .prepare("SELECT day, unique_30d, version_mix_7d, active_1d FROM daily_rollup ORDER BY day")
      .all<{ day: string; unique_30d: number; version_mix_7d: string; active_1d: number }>();
    return results;
  }

  it("writes one row per completed day, as of that day's end, and catches up missed days", async () => {
    await beat(A, "2.0.0", DAY1 + 10 * 60 * MIN);
    await beat(B, "2.0.0", DAY1 + 2 * DAY + 5 * 60 * MIN);
    await beat(A, "2.0.1", DAY1 + 2 * DAY + 6 * 60 * MIN);

    // First cron run of Oct 4th: Oct 1, 2 and 3 are complete; Oct 4 is not.
    await writeDailyRollups(env.DB, DAY1 + 3 * DAY + 5 * MIN);
    const rows = await daily();
    expect(rows.map((r) => [r.day, r.unique_30d, r.active_1d])).toEqual([
      ["2026-10-01", 1, 1], // A
      ["2026-10-02", 1, 0], // A still inside 30 days; nobody beat on Oct 2
      ["2026-10-03", 2, 2], // A and B
    ]);
    expect(JSON.parse(rows[0].version_mix_7d)).toEqual({
      denominator: 1,
      versions: [{ appVersion: "2.0.0", count: 1, share: 1 }],
    });
    expect(JSON.parse(rows[2].version_mix_7d)).toEqual({
      denominator: 2,
      versions: [
        { appVersion: "2.0.0", count: 1, share: 0.5 },
        { appVersion: "2.0.1", count: 1, share: 0.5 },
      ],
    });

    // Re-running the same day changes nothing.
    await writeDailyRollups(env.DB, DAY1 + 3 * DAY + 15 * MIN);
    expect(await daily()).toEqual(rows);

    // Skipping two days of cron, then running: the gap is filled.
    await writeDailyRollups(env.DB, DAY1 + 6 * DAY + 5 * MIN);
    expect((await daily()).map((r) => r.day)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
    ]);
  });

  it("keeps a whole cron pass under the free tier's 50 queries after a long outage, and drains the backlog over later passes", async () => {
    await beat(A, "2.0.0", DAY1 + 10 * 60 * MIN);
    await writeDailyRollups(env.DB, DAY1 + DAY + 5 * MIN); // Oct 1 rolled up
    await beat(B, "2.0.0", DAY1 + 30 * DAY + 60 * MIN); // then the cron is down for 40 days

    // Counts every statement the pass prepares, the way D1 counts queries per invocation.
    let queries = 0;
    const counted = new Proxy(env.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "prepare") {
          return (sql: string) => {
            queries++;
            return target.prepare(sql);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const back = DAY1 + 41 * DAY + 5 * MIN; // first pass of Nov 11th: Oct 2..Nov 10 are missing
    await runScheduled(counted, back);
    expect(queries).toBeLessThanOrEqual(MAX_D1_QUERIES_PER_PASS);
    // A rollup already exists, so the first-heartbeat read is skipped, and there is no
    // snapshot to reuse, so the live scans run; no GitHub read was asked for, so no
    // downloads row is written: two under the worst case.
    expect(queries).toBe(MAX_D1_QUERIES_PER_PASS - 2);
    expect((await daily()).length).toBe(1 + MAX_ROLLUP_DAYS_PER_PASS);
    // The pass got past the rollup: the snapshot was written.
    const snap = await env.DB.prepare("SELECT generated_at FROM metrics_snapshot WHERE id = 1").first<{ generated_at: string }>();
    expect(snap?.generated_at).toBe("2026-11-11T00:05:00Z");
    const hist = await env.DB.prepare("SELECT generated_at FROM history_snapshot WHERE id = 1").first<{ generated_at: string }>();
    expect(hist?.generated_at).toBe("2026-11-11T00:05:00Z");

    for (let pass = 1; pass <= 5; pass++) await runScheduled(env.DB, back + pass * 10 * MIN);
    const days = (await daily()).map((r) => r.day);
    expect(days.length).toBe(41); // Oct 1 .. Nov 10, no gap
    expect(days[days.length - 1]).toBe("2026-11-10");
  });

  it("the worst-case pass is exactly MAX_D1_QUERIES_PER_PASS, 46, under the free tier's 50; a pass reusing the live scans is 3 fewer", async () => {
    // No rollup and no snapshot has ever been written, and the first heartbeat is
    // twenty days back: both starting reads run, a full MAX_ROLLUP_DAYS_PER_PASS
    // days roll up, the three live scans run, and it is the hour's first tick with
    // GitHub answering, so the downloads row is written (DRA-783).
    await beat(A, "2.0.0", DAY1 - 20 * DAY + 60 * MIN);
    const github = (async () =>
      new Response(
        JSON.stringify([{ tag_name: "v2.0.0", draft: false, created_at: "2026-09-28T20:52:47Z", assets: [{ name: "EQBuddyEvolvedSetup.exe", download_count: 5 }] }]),
        { status: 200 },
      )) as unknown as typeof fetch;
    const first = recording();
    await runScheduled(first.db, DAY1 + 5 * MIN, github);
    expect((await daily()).length).toBe(MAX_ROLLUP_DAYS_PER_PASS);
    expect(MAX_D1_QUERIES_PER_PASS).toBe(46);
    expect(first.sql).toHaveLength(MAX_D1_QUERIES_PER_PASS);
    expect(MAX_D1_QUERIES_PER_PASS).toBeLessThan(50);

    // Ten minutes on, another full seven days roll up. A rollup now exists (no
    // first-heartbeat read), the snapshot is fresh (no live scans) and it is not the
    // hour's first tick (no downloads write).
    const second = recording();
    await runScheduled(second.db, DAY1 + 15 * MIN, github);
    expect((await daily()).length).toBe(2 * MAX_ROLLUP_DAYS_PER_PASS);
    expect(second.sql).toHaveLength(MAX_D1_QUERIES_PER_PASS - 1 - 3 - 1);
  });

  it("writes nothing when there has never been a heartbeat", async () => {
    await writeDailyRollups(env.DB, DAY1);
    expect(await daily()).toEqual([]);
  });
});

describe("90-day retention", () => {
  // An aligned `now`, so the boundary rows sit exactly on the cutoff.
  const NOW = Date.parse("2026-12-30T00:00:00Z");
  const CUTOFF = NOW - 90 * DAY; // 2026-10-01T00:00:00Z

  it("purges exactly the raw rows whose bucket started more than 90 days ago", async () => {
    await beat(A, "2.0.0", CUTOFF - 10 * MIN); // bucket 2026-09-30T23:50 — past 90 days
    await beat(B, "2.0.0", CUTOFF - 1); // bucket 2026-09-30T23:50 — past 90 days
    await beat(C, "2.0.0", CUTOFF); // bucket 2026-10-01T00:00 — exactly 90 days: kept
    await beat(D, "2.0.0", NOW - MIN); // yesterday-ish: kept

    const purged = await purgeExpired(env.DB, NOW);
    expect(purged).toBe(2);
    const { results } = await env.DB.prepare("SELECT install_id FROM heartbeat ORDER BY install_id").all();
    expect(results.map((r) => r.install_id)).toEqual([C, D]);
  });

  it("keeps the id-free aggregates the purged rows produced", async () => {
    await beat(A, "2.0.0", CUTOFF - 10 * MIN);
    await closeBuckets(env.DB, CUTOFF);
    await purgeExpired(env.DB, NOW);
    await closeBuckets(env.DB, NOW);
    expect(await bucketCounts()).toEqual({ "2026-09-30T23:50:00Z": 1 });
    const m = await computeMetrics(env.DB, NOW);
    expect(m.peakConcurrent).toBe(1);
  });

  it("the cron pass purges too", async () => {
    await beat(A, "2.0.0", CUTOFF - 10 * MIN);
    await runScheduled(env.DB, NOW);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM heartbeat").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("GET /metrics.json", () => {
  it("serves the cron's snapshot, public and cacheable for 10 minutes, in the documented shape", async () => {
    await seedFixture();
    await runScheduled(env.DB, T0 - DAY); // a pass on an earlier day, so a daily rollup exists
    await runScheduled(env.DB, T0 + 15 * MIN);
    // More traffic after the snapshot must not change what is served until the next pass.
    await beat(D, "2.0.1", T0 + 16 * MIN);

    const res = await handle(new Request("https://t.test/metrics.json"), env, T0 + 17 * MIN);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual([
      "schema",
      "generatedAt",
      "concurrentNow",
      "peakConcurrent",
      "peakConcurrentBucket",
      "uniqueUsers30d",
      "versionMix7d",
      "dailyActive",
      "weeklyActive",
      "usageHours",
      "installsAllTime",
      "activeLast24h",
      "activeLast7d",
      "activeAsOf",
      "peakDailyActive",
      "peakWeeklyActive",
      "downloads",
      "definitions",
    ]);
    expect(body).toMatchObject({
      schema: 1,
      generatedAt: "2026-10-01T12:15:00Z",
      concurrentNow: 2,
      peakConcurrent: 3,
      // Rolled up through 2026-09-30: D (20 days before T0) is the only install then.
      uniqueUsers30d: 1,
      // Sep 29, the last complete day, held nobody; D is outside its 7 days too.
      dailyActive: 0,
      weeklyActive: 0,
      // A, B, C, D and E each counted once, when first seen; D's later beat is not in the snapshot yet and is not new anyway.
      installsAllTime: 5,
      // Rolling, up to the snapshot's 12:15: A, B and C beat today. D is 20 days old, E 40.
      activeLast24h: 3,
      activeLast7d: 3,
      activeAsOf: "2026-10-01T12:15:00Z", // the pass a day earlier is over an hour old: scanned afresh
      // Today's A, B and C beat every earlier day and week.
      peakDailyActive: 3,
      peakWeeklyActive: 3,
    });
    expect(body.definitions).toEqual(DEFINITIONS);
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no install id leaks into the public file
  });

  it("answers live figures before the first cron pass, without writing a snapshot", async () => {
    await beat(A, "2.0.0", T0);
    const res = await handle(new Request("https://t.test/metrics.json"), env, T0 + MIN);
    expect((await res.json<{ concurrentNow: number }>()).concurrentNow).toBe(1);
    const snap = await env.DB.prepare("SELECT COUNT(*) AS n FROM metrics_snapshot").first<{ n: number }>();
    expect(snap?.n).toBe(0);
  });

  it("HEAD answers the headers with no body", async () => {
    const res = await handle(new Request("https://t.test/metrics.json", { method: "HEAD" }), env, T0);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("the storage shape", () => {
  // Every column of every table, pinned. There is no column that could hold an
  // IP address, a path or a name; adding one fails here until the requirement
  // page (EQBuddy docs/v2/telemetry.md §6) is amended to say why.
  const EXPECTED: Record<string, string[]> = {
    heartbeat: ["install_id", "bucket_start", "app_version", "os", "last_seen_ms"],
    bucket_count: ["bucket_start", "distinct_ids"],
    daily_rollup: ["day", "unique_30d", "version_mix_7d", "active_1d", "usage_buckets_1d"],
    metrics_snapshot: ["id", "generated_at", "body"],
    history_snapshot: ["id", "generated_at", "body"],
    all_time_total: ["id", "installs_first_seen"],
    downloads_daily: ["day", "total", "as_of"],
  };

  it("has exactly the documented tables and columns", async () => {
    const { results: tables } = await env.DB
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
      )
      .all<{ name: string }>();
    expect(tables.map((t) => t.name)).toEqual(Object.keys(EXPECTED).sort());
    for (const [table, columns] of Object.entries(EXPECTED)) {
      const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(results.map((c) => c.name), table).toEqual(columns);
    }
  });

  it("holds an install id in exactly one table", () => {
    const withId = Object.entries(EXPECTED).filter(([, cols]) => cols.includes("install_id"));
    expect(withId.map(([t]) => t)).toEqual(["heartbeat"]);
  });
});
