// DRA-380: usageHours, /history.json, the report widget's routes, and CORS
// on the public GET routes only.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../../src/index";
import {
  DEFINITIONS,
  HISTORY_DEFINITIONS,
  type RollupRow,
  bucketsToHours,
  computeHistory,
  computeMetrics,
  recordHeartbeat,
  runScheduled,
  usageHoursFrom,
} from "../../src/store";
import { REPORT_HTML, WIDGET_CSS, WIDGET_JS } from "../../src/widget";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const OCT1 = Date.parse("2026-10-01T00:00:00Z");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const ID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function beat(installId: string, at: number, appVersion = "2.0.0"): Promise<void> {
  expect(await recordHeartbeat(env.DB, { installId, appVersion, os: "Windows 10.0.26200" }, at)).toBe("recorded");
}

/** A beats in 4 buckets and B in 2 on Oct 1 (6 install-buckets = 1 h); A in 3 on Oct 2 (0.5 h). */
async function seedUsage(): Promise<void> {
  for (const m of [0, 10, 20, 30]) await beat(A, OCT1 + 60 * MIN + m * MIN);
  for (const m of [0, 10]) await beat(B, OCT1 + 60 * MIN + m * MIN + 2 * MIN);
  for (const m of [0, 10, 20]) await beat(A, OCT1 + DAY + 120 * MIN + m * MIN, "2.0.1");
}

/** Every statement prepared against the database, in order. */
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

function row(day: string, usage_buckets_1d: number): RollupRow {
  return { day, unique_30d: 0, version_mix_7d: '{"denominator":0,"versions":[]}', active_1d: 0, usage_buckets_1d };
}

describe("usageHours math", () => {
  it("is install-buckets x 10 / 60, to two decimals", () => {
    expect(bucketsToHours(0)).toBe(0);
    expect(bucketsToHours(1)).toBe(0.17);
    expect(bucketsToHours(6)).toBe(1);
    expect(bucketsToHours(9)).toBe(1.5);
    expect(bucketsToHours(1000)).toBe(166.67);
  });

  it("windows end with the last complete UTC day: yesterday, 7 and 30 days, and all time", () => {
    const rows = [
      row("2026-08-01", 600), // 40 days before the last: all time only
      row("2026-08-10", 60), // 30 days before the last: outside 30 days (day 31)
      row("2026-08-11", 6), // 29 days before: inside 30 days (day 30)
      row("2026-09-02", 12), // 7 days before: outside 7 days (day 8)
      row("2026-09-03", 18), // 6 days before: inside 7 days
      row("2026-09-09", 36), // the last complete day
    ];
    expect(usageHoursFrom(rows)).toEqual({
      yesterday: 6,
      last7d: 9, // (18 + 36) / 6
      last30d: 12, // (6 + 12 + 18 + 36) / 6
      allTime: 122, // 732 / 6
    });
    expect(usageHoursFrom([])).toEqual({ yesterday: 0, last7d: 0, last30d: 0, allTime: 0 });
  });

  it("the cron rolls each day's install-buckets into daily_rollup and metrics.json publishes the hours", async () => {
    await seedUsage();
    const oct3 = OCT1 + 2 * DAY + 5 * MIN;
    await runScheduled(env.DB, oct3);
    const { results } = await env.DB
      .prepare("SELECT day, usage_buckets_1d FROM daily_rollup ORDER BY day")
      .all<{ day: string; usage_buckets_1d: number }>();
    expect(results).toEqual([
      { day: "2026-10-01", usage_buckets_1d: 6 }, // the shared bucket counts A and B: 2 + 1 + 1 + 1 + 1
      { day: "2026-10-02", usage_buckets_1d: 3 },
    ]);
    const m = await computeMetrics(env.DB, oct3);
    expect(m.usageHours).toEqual({ yesterday: 0.5, last7d: 1.5, last30d: 1.5, allTime: 1.5 });
    expect(m.definitions.usageHours).toBe(DEFINITIONS.usageHours);
    expect(DEFINITIONS.usageHours).toMatch(/Estimated.*opted-in installs only.*10-minute resolution/);
  });

  it("the current, unfinished day is not counted until it completes", async () => {
    await seedUsage();
    // Midday Oct 2: A's three Oct 2 buckets are closed, but Oct 2 has not ended.
    const noonOct2 = OCT1 + DAY + 12 * 60 * MIN;
    await runScheduled(env.DB, noonOct2);
    const m = await computeMetrics(env.DB, noonOct2);
    expect(m.usageHours).toEqual({ yesterday: 1, last7d: 1, last30d: 1, allTime: 1 });
  });
});

describe("usage hours survive the 90-day purge", () => {
  it("the pass rolls the day up BEFORE it purges", async () => {
    await seedUsage();
    const { db, sql } = recording();
    await runScheduled(db, OCT1 + 2 * DAY + 5 * MIN);
    const rollup = sql.findIndex((q) => /INSERT OR IGNORE INTO daily_rollup/.test(q));
    const purge = sql.findIndex((q) => /DELETE FROM heartbeat/.test(q));
    expect(rollup).toBeGreaterThanOrEqual(0);
    expect(purge).toBeGreaterThan(rollup);
  });

  it("all-time and per-day hours outlive the raw rows, and even the buckets", async () => {
    await seedUsage();
    await runScheduled(env.DB, OCT1 + 2 * DAY + 5 * MIN);

    // 92 days on, the Oct 1 and Oct 2 raw rows are past retention.
    await runScheduled(env.DB, OCT1 + 92 * DAY + 5 * MIN);
    const raw = await env.DB.prepare("SELECT COUNT(*) AS n FROM heartbeat").first<{ n: number }>();
    expect(raw?.n).toBe(0);
    // Were bucket_count ever pruned too, the rolled-up hours would stand.
    await env.DB.prepare("DELETE FROM bucket_count").run();

    const m = await computeMetrics(env.DB, OCT1 + 92 * DAY + 10 * MIN);
    expect(m.usageHours.allTime).toBe(1.5);
    const h = await computeHistory(env.DB, OCT1 + 92 * DAY + 10 * MIN);
    expect(h.days.slice(0, 2).map((d) => [d.day, d.usageHours])).toEqual([
      ["2026-10-01", 1],
      ["2026-10-02", 0.5],
    ]);
  });
});

describe("GET /history.json", () => {
  it("serves the cron's snapshot in the documented shape, with per-day history and no ids", async () => {
    await seedUsage();
    // A bucket older than 7 days must not appear in concurrent10m.
    await env.DB.prepare("INSERT INTO bucket_count (bucket_start, distinct_ids) VALUES ('2026-09-24T12:00:00Z', 9)").run();
    const now = OCT1 + 2 * DAY + 5 * MIN;
    await runScheduled(env.DB, now);

    const res = await handle(new Request("https://t.test/history.json"), env, now + MIN);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const text = await res.text();
    expect(text).not.toMatch(ID_SHAPED);
    expect(text).not.toMatch(/install_id|installId/);
    const body = JSON.parse(text);
    expect(Object.keys(body)).toEqual(["schema", "generatedAt", "days", "concurrent10m", "definitions"]);
    expect(body.schema).toBe(1);
    expect(body.generatedAt).toBe("2026-10-03T00:05:00Z");
    expect(body.days).toEqual([
      {
        day: "2026-10-01",
        dailyActive: 2,
        weeklyActive: 2,
        uniqueUsers30d: 2,
        usageHours: 1,
        versionMix7d: { denominator: 2, versions: [{ appVersion: "2.0.0", count: 2, share: 1 }] },
      },
      {
        day: "2026-10-02",
        dailyActive: 1,
        weeklyActive: 2,
        uniqueUsers30d: 2,
        usageHours: 0.5,
        versionMix7d: {
          denominator: 2,
          versions: [
            { appVersion: "2.0.0", count: 1, share: 0.5 },
            { appVersion: "2.0.1", count: 1, share: 0.5 },
          ],
        },
      },
    ]);
    expect(body.concurrent10m).toEqual([
      { bucket: "2026-10-01T01:00:00Z", count: 2 },
      { bucket: "2026-10-01T01:10:00Z", count: 2 },
      { bucket: "2026-10-01T01:20:00Z", count: 1 },
      { bucket: "2026-10-01T01:30:00Z", count: 1 },
      { bucket: "2026-10-02T02:00:00Z", count: 1 },
      { bucket: "2026-10-02T02:10:00Z", count: 1 },
      { bucket: "2026-10-02T02:20:00Z", count: 1 },
    ]);
    expect(body.definitions).toEqual(HISTORY_DEFINITIONS);
    // Every published field has a definition.
    for (const key of [...Object.keys(body.days[0]), "days", "concurrent10m", "bucket", "count"]) {
      expect(body.definitions, key).toHaveProperty(key);
    }
  });

  it("reads one snapshot row per request: never heartbeat, never a rebuild", async () => {
    await seedUsage();
    const now = OCT1 + 2 * DAY + 5 * MIN;
    await runScheduled(env.DB, now);
    const snapshot = await env.DB.prepare("SELECT body FROM history_snapshot WHERE id = 1").first<{ body: string }>();
    // Pull the tables out from under it: the served body is the snapshot.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM heartbeat"),
      env.DB.prepare("DELETE FROM bucket_count"),
      env.DB.prepare("DELETE FROM daily_rollup"),
    ]);
    const { db, sql } = recording();
    const res = await handle(new Request("https://t.test/history.json"), { DB: db }, now + 5 * MIN);
    expect(await res.text()).toBe(snapshot?.body);
    expect(sql).toEqual(["SELECT body FROM history_snapshot WHERE id = 1"]);
  });

  it("before the first cron pass it answers from the aggregate tables, never heartbeat, and writes nothing", async () => {
    await seedUsage();
    const { db, sql } = recording();
    const res = await handle(new Request("https://t.test/history.json"), { DB: db }, OCT1 + DAY);
    expect(res.status).toBe(200);
    const body = await res.json<{ days: unknown[]; concurrent10m: unknown[] }>();
    expect(body.days).toEqual([]);
    expect(body.concurrent10m).toEqual([]); // no bucket has been closed by a cron pass yet
    expect(sql.some((q) => /\bheartbeat\b/.test(q))).toBe(false);
    expect(sql.some((q) => /INSERT|UPDATE|DELETE/.test(q))).toBe(false);
  });

  it("HEAD answers the headers with no body", async () => {
    const res = await handle(new Request("https://t.test/history.json", { method: "HEAD" }), env, OCT1);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.text()).toBe("");
  });
});

describe("the widget routes", () => {
  it("/widget.js is the widget module, as JavaScript", async () => {
    const res = await handle(new Request("https://t.test/widget.js"), env, OCT1);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toBe(WIDGET_JS);
  });

  it("/widget.css is the scoped stylesheet", async () => {
    const res = await handle(new Request("https://t.test/widget.css"), env, OCT1);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.text()).toBe(WIDGET_CSS);
  });

  it("/report is a thin page over the widget, loading nothing from anywhere else", async () => {
    const res = await handle(new Request("https://t.test/report"), env, OCT1);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    const html = await res.text();
    expect(html).toBe(REPORT_HTML);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<script src="/widget.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/widget.css">');
    expect(html).toContain("<div data-eqbuddy-telemetry></div>");
    // Only the widget script, and no remote stylesheet, font, image or script.
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<(script|link|img|iframe)\b[^>]*(src|href)="(https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(/);
    expect(html).not.toMatch(ID_SHAPED);
  });
});

describe("CORS is on the public GET routes and nowhere else", () => {
  const GET_ROUTES = ["/metrics.json", "/history.json", "/widget.js", "/widget.css", "/report"];

  for (const path of GET_ROUTES) {
    it(`${path}: GET and HEAD carry Access-Control-Allow-Origin: *; other methods are 405 without it`, async () => {
      for (const method of ["GET", "HEAD"]) {
        const res = await handle(new Request(`https://t.test${path}`, { method }), env, OCT1);
        expect(res.status, method).toBe(200);
        expect(res.headers.get("Access-Control-Allow-Origin"), method).toBe("*");
      }
      const post = await handle(new Request(`https://t.test${path}`, { method: "POST", body: "{}" }), env, OCT1);
      expect(post.status).toBe(405);
      expect(post.headers.get("Allow")).toBe("GET, HEAD");
      expect(post.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  }

  it("POST /heartbeat and POST /delete answer exactly as before, with no CORS header", async () => {
    const hb = (id: string) => JSON.stringify({ installId: id, appVersion: "2.0.0", os: "Windows" });
    const responses = [
      await handle(new Request("https://t.test/heartbeat", { method: "POST", body: hb(A) }), env, OCT1), // 204
      await handle(new Request("https://t.test/heartbeat", { method: "POST", body: hb(A) }), env, OCT1 + 1000), // 429
      await handle(new Request("https://t.test/heartbeat", { method: "POST", body: "{}" }), env, OCT1), // 400
      await handle(new Request("https://t.test/delete", { method: "POST", body: JSON.stringify({ installId: A }) }), env, OCT1), // 204
      await handle(new Request("https://t.test/delete", { method: "POST", body: "{}" }), env, OCT1), // 400
      await handle(new Request("https://t.test/heartbeat"), env, OCT1), // 405
      await handle(new Request("https://t.test/nope"), env, OCT1), // 404
    ];
    expect(responses.map((r) => r.status)).toEqual([204, 429, 400, 204, 400, 405, 404]);
    for (const r of responses) {
      expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect([...r.headers.keys()].sort()).toEqual(r.status === 405 ? ["allow"] : []);
    }
  });

  it("no inherited object key is a route", async () => {
    for (const path of ["/constructor", "/__proto__", "/toString", "/hasOwnProperty"]) {
      expect((await handle(new Request(`https://t.test${path}`), env, OCT1)).status, path).toBe(404);
    }
  });
});
