import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../../src/index";
import {
  DEFINITIONS,
  closeBuckets,
  computeMetrics,
  purgeExpired,
  recordHeartbeat,
  runScheduled,
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

  it("publishes the trailing-window numbers from the latest daily rollup", async () => {
    await seedFixture();
    // Before any day has completed, the trailing numbers are zero rather than a live scan.
    const before = await computeMetrics(env.DB, T0 + 15 * MIN);
    expect(before.uniqueUsers30d).toBe(0);
    expect(before.versionMix7d).toEqual({ denominator: 0, versions: [] });

    const nextDay = Date.parse("2026-10-02T00:05:00Z");
    await runScheduled(env.DB, nextDay);
    const after = await computeMetrics(env.DB, nextDay);
    expect(after.uniqueUsers30d).toBe(4);
    expect(after.versionMix7d.denominator).toBe(3);
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
    });
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

describe("daily rollups", () => {
  const DAY1 = Date.parse("2026-10-01T00:00:00Z");

  async function daily(): Promise<Array<{ day: string; unique_30d: number; version_mix_7d: string }>> {
    const { results } = await env.DB
      .prepare("SELECT day, unique_30d, version_mix_7d FROM daily_rollup ORDER BY day")
      .all<{ day: string; unique_30d: number; version_mix_7d: string }>();
    return results;
  }

  it("writes one row per completed day, as of that day's end, and catches up missed days", async () => {
    await beat(A, "2.0.0", DAY1 + 10 * 60 * MIN);
    await beat(B, "2.0.0", DAY1 + 2 * DAY + 5 * 60 * MIN);
    await beat(A, "2.0.1", DAY1 + 2 * DAY + 6 * 60 * MIN);

    // First cron run of Oct 4th: Oct 1, 2 and 3 are complete; Oct 4 is not.
    await writeDailyRollups(env.DB, DAY1 + 3 * DAY + 5 * MIN);
    const rows = await daily();
    expect(rows.map((r) => [r.day, r.unique_30d])).toEqual([
      ["2026-10-01", 1],
      ["2026-10-02", 1],
      ["2026-10-03", 2],
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
      "definitions",
    ]);
    expect(body).toMatchObject({
      schema: 1,
      generatedAt: "2026-10-01T12:15:00Z",
      concurrentNow: 2,
      peakConcurrent: 3,
      // Rolled up through 2026-09-30: D (20 days before T0) is the only install then.
      uniqueUsers30d: 1,
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
    daily_rollup: ["day", "unique_30d", "version_mix_7d"],
    metrics_snapshot: ["id", "generated_at", "body"],
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
