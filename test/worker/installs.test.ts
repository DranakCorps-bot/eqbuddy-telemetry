// installsAllTime: an all-time count of opted-in installs, counted when each is
// first seen, kept as one integer so no install id outlives the raw table's
// 90-day retention (migration 0004).

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../../src/index";
import { DEFINITIONS, computeMetrics, installsAllTime, purgeExpired, recordHeartbeat, runScheduled } from "../../src/store";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.parse("2026-10-01T12:00:00Z");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const ID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function post(path: string, body: unknown): Request {
  return new Request(`https://t.test${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function send(installId: string, at: number, appVersion = "2.0.0"): Promise<number> {
  return (await handle(post("/heartbeat", { installId, appVersion, os: "Windows 10.0.26200" }), env, at)).status;
}

async function count(): Promise<number> {
  return installsAllTime(env.DB);
}

describe("counting an install when it is first seen", () => {
  it("the first heartbeat from an id adds one", async () => {
    expect(await count()).toBe(0);
    expect(await send(A, T0)).toBe(204);
    expect(await count()).toBe(1);
  });

  it("repeat heartbeats add nothing: same bucket, next bucket, next day, new version", async () => {
    expect(await send(A, T0)).toBe(204);
    expect(await send(A, T0 + 5 * MIN)).toBe(204); // same bucket, an upsert
    expect(await send(A, T0 + 15 * MIN)).toBe(204); // next bucket, a new row
    expect(await send(A, T0 + DAY, "2.0.1")).toBe(204); // next day, another version
    expect(await count()).toBe(1);
  });

  it("each distinct id adds one, however the heartbeats interleave", async () => {
    await send(A, T0);
    await send(B, T0 + MIN);
    await send(A, T0 + 11 * MIN);
    await send(C, T0 + 12 * MIN);
    await send(B, T0 + 13 * MIN);
    expect(await count()).toBe(3);
  });

  it("a rate-limited heartbeat adds nothing (it is never a first one)", async () => {
    expect(await send(A, T0)).toBe(204);
    expect(await send(A, T0 + 30_000)).toBe(429);
    expect(await count()).toBe(1);
  });

  it("a refused heartbeat adds nothing", async () => {
    const res = await handle(post("/heartbeat", { installId: A, appVersion: "2.0.0", os: "Windows", extra: 1 }), env, T0);
    expect(res.status).toBe(400);
    expect(await send("not-a-guid", T0)).toBe(400);
    expect(await count()).toBe(0);
  });

  it("two first heartbeats for one id at the same moment count once", async () => {
    const statuses = await Promise.all([send(A, T0), send(A, T0)]);
    expect(statuses.sort()).toEqual([204, 429]);
    expect(await count()).toBe(1);
  });

  it("the count and the raw row move together: recordHeartbeat reports recorded exactly when a row was written", async () => {
    expect(await recordHeartbeat(env.DB, { installId: A, appVersion: "2.0.0", os: "W" }, T0)).toBe("recorded");
    expect(await recordHeartbeat(env.DB, { installId: A, appVersion: "2.0.0", os: "W" }, T0 + 1)).toBe("rate-limited");
    expect(await count()).toBe(1);
  });
});

describe("the count is an aggregate: it holds no id and nothing lowers it", () => {
  it("/delete does not lower it", async () => {
    await send(A, T0);
    await send(B, T0);
    expect((await handle(post("/delete", { installId: A }), env, T0 + MIN)).status).toBe(204);
    expect(await count()).toBe(2);
  });

  it("an install that deleted its data and comes back is counted again (it cannot be told from a new one)", async () => {
    await send(A, T0);
    await handle(post("/delete", { installId: A }), env, T0 + MIN);
    expect(await send(A, T0 + 2 * MIN)).toBe(204);
    expect(await count()).toBe(2);
  });

  it("the 90-day purge does not lower it", async () => {
    await send(A, T0);
    await send(B, T0);
    const later = T0 + 91 * DAY;
    expect(await purgeExpired(env.DB, later)).toBe(2);
    expect(await count()).toBe(2);
    await runScheduled(env.DB, later);
    expect((await computeMetrics(env.DB, later)).installsAllTime).toBe(2);
  });

  it("an install silent for more than 90 days is counted again when it returns; one that kept sending is not", async () => {
    await send(A, T0);
    await send(B, T0);
    // B keeps sending every 60 days, so it always has a raw row inside retention.
    await send(B, T0 + 60 * DAY);
    const later = T0 + 120 * DAY;
    await purgeExpired(env.DB, later);
    await send(A, later);
    await send(B, later);
    expect(await count()).toBe(3);
  });
});

describe("migration 0004 backfills the count from the raw table", () => {
  const MIGRATION = "0004_installs_all_time";

  async function applyMigration(): Promise<void> {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith(MIGRATION));
    expect(migration, MIGRATION).toBeDefined();
    await env.DB.prepare("DROP TABLE all_time_total").run();
    for (const query of migration!.queries) await env.DB.prepare(query).run();
  }

  it("counts each distinct id once, however many buckets and versions it has", async () => {
    // Seeded straight into heartbeat, as the table stood before the migration: A in three buckets, B in two, C in one.
    const rows: Array<[string, string, string]> = [
      [A, "2026-09-24T19:40:00Z", "2.0.0"],
      [A, "2026-09-24T19:50:00Z", "2.0.0"],
      [A, "2026-09-26T08:00:00Z", "2.0.1"],
      [B, "2026-09-25T01:00:00Z", "2.0.0"],
      [B, "2026-09-25T01:10:00Z", "2.0.0"],
      [C, "2026-09-28T19:00:00Z", "2.0.1"],
    ];
    for (const [id, bucket, v] of rows) {
      await env.DB
        .prepare("INSERT INTO heartbeat VALUES (?1, ?2, ?3, 'W', ?4)")
        .bind(id, bucket, v, Date.parse(bucket))
        .run();
    }
    await applyMigration();
    expect(await count()).toBe(3);

    // And the live counting carries on from the backfilled figure.
    await send(A, T0); // already counted
    await send("dddddddd-0000-4000-8000-000000000004", T0); // new
    expect(await count()).toBe(4);
  });

  it("an empty raw table backfills a row holding 0, so the first heartbeat has a row to add to", async () => {
    await applyMigration();
    const rows = await env.DB.prepare("SELECT id, installs_first_seen FROM all_time_total").all();
    expect(rows.results).toEqual([{ id: 1, installs_first_seen: 0 }]);
    await send(A, T0);
    expect(await count()).toBe(1);
  });

  it("the table can hold only its one row", async () => {
    await expect(env.DB.prepare("INSERT INTO all_time_total VALUES (2, 7)").run()).rejects.toThrow();
  });
});

describe("installsAllTime in metrics.json", () => {
  it("is published by the cron's snapshot, and a live heartbeat shows at the next pass", async () => {
    await send(A, T0);
    await send(B, T0 + MIN);
    await runScheduled(env.DB, T0 + 15 * MIN);
    await send(C, T0 + 16 * MIN); // after the snapshot: not served until the next pass

    const served = await (await handle(new Request("https://t.test/metrics.json"), env, T0 + 17 * MIN)).json<Record<string, unknown>>();
    expect(served.installsAllTime).toBe(2);
    expect(served.schema).toBe(1); // additive: the schema does not move
    expect(JSON.stringify(served)).not.toMatch(ID_SHAPED);

    await runScheduled(env.DB, T0 + 25 * MIN);
    const next = await (await handle(new Request("https://t.test/metrics.json"), env, T0 + 26 * MIN)).json<Record<string, unknown>>();
    expect(next.installsAllTime).toBe(3);
  });

  it("reads one row of the id-free total, never heartbeat", async () => {
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
    await installsAllTime(db);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/FROM all_time_total WHERE id = 1/);
    expect(sql[0]).not.toMatch(/\bheartbeat\b/);
  });

  it("is defined: first seen, opted-in only, a lower bound, no ids kept, counted again after 90 days, never lowered by a delete", () => {
    const d = DEFINITIONS.installsAllTime;
    expect(d).toMatch(/counted when first seen/);
    expect(d).toMatch(/Opted-in installs/);
    expect(d).toMatch(/A lower bound/);
    expect(d).toMatch(/no install id is kept to compute it/);
    expect(d).toMatch(/silent for more than 90 days.*counts again/);
    expect(d).toMatch(/Deleting an install's data does not lower it/);
  });
});
