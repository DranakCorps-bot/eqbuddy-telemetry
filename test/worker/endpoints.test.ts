import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker, { handle } from "../../src/index";
import { HEARTBEAT_KEYS } from "../../src/validate";

const ID_A = "3f2b8c1e-9a47-4d2e-b0c6-5e81a7d4f920";
const ID_B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const T0 = Date.parse("2026-10-01T12:00:00Z");
const MIN = 60_000;

function post(path: string, body: string): Request {
  return new Request(`https://telemetry.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function hb(id: string, appVersion = "2.0.0", os = "Windows 10.0.26200"): string {
  return JSON.stringify({ installId: id, appVersion, os });
}

async function rows(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM heartbeat ORDER BY install_id, bucket_start").all();
  return results;
}

describe("the payload key set", () => {
  it("is exactly the three signed fields", () => {
    expect([...HEARTBEAT_KEYS].sort()).toEqual(["appVersion", "installId", "os"]);
  });
});

describe("POST /heartbeat", () => {
  it("records a valid heartbeat into its 10-minute bucket and answers 204", async () => {
    const res = await handle(post("/heartbeat", hb(ID_A)), env, T0 + 7 * MIN + 13_000);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await rows()).toEqual([
      {
        install_id: ID_A,
        bucket_start: "2026-10-01T12:00:00Z",
        app_version: "2.0.0",
        os: "Windows 10.0.26200",
        last_seen_ms: T0 + 7 * MIN + 13_000,
      },
    ]);
  });

  it("upserts: two heartbeats in one bucket are one row carrying the later version", async () => {
    await handle(post("/heartbeat", hb(ID_A, "2.0.0")), env, T0 + 1 * MIN);
    const res = await handle(post("/heartbeat", hb(ID_A, "2.0.1")), env, T0 + 6 * MIN);
    expect(res.status).toBe(204);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ app_version: "2.0.1", last_seen_ms: T0 + 6 * MIN });
  });

  it("writes a new row when the next heartbeat falls in the next bucket", async () => {
    await handle(post("/heartbeat", hb(ID_A)), env, T0 + 8 * MIN);
    await handle(post("/heartbeat", hb(ID_A)), env, T0 + 13 * MIN);
    expect((await rows()).map((r) => r.bucket_start)).toEqual(["2026-10-01T12:00:00Z", "2026-10-01T12:10:00Z"]);
  });

  const refused: Array<[string, string]> = [
    ["a fourth key", JSON.stringify({ installId: ID_A, appVersion: "2.0.0", os: "Windows", locale: "en-US" })],
    ["a missing key", JSON.stringify({ installId: ID_A, appVersion: "2.0.0" })],
    ["a non-GUID id", hb("not-a-guid")],
    ["an uppercase GUID", hb(ID_A.toUpperCase())],
    ["a braced GUID", hb(`{${ID_A}}`)],
    ["a numeric value", JSON.stringify({ installId: ID_A, appVersion: 2, os: "Windows" })],
    ["a null value", JSON.stringify({ installId: ID_A, appVersion: "2.0.0", os: null })],
    ["a version with build metadata", hb(ID_A, "2.0.0+abc")],
    ["an empty version", hb(ID_A, "")],
    ["a 33-char version", hb(ID_A, "1".repeat(33))],
    ["an empty os", hb(ID_A, "2.0.0", "")],
    ["a 65-char os", hb(ID_A, "2.0.0", "W".repeat(65))],
    ["a non-ASCII os", hb(ID_A, "2.0.0", "Windowsé")],
    ["an os with a newline", hb(ID_A, "2.0.0", "Windows\n10")],
    ["an array", JSON.stringify([ID_A, "2.0.0", "Windows"])],
    ["JSON null", "null"],
    ["invalid JSON", "{installId:"],
    ["an empty body", ""],
    ["an oversized body", JSON.stringify({ installId: ID_A, appVersion: "2.0.0", os: "W", pad: "x".repeat(2000) })],
  ];

  for (const [what, body] of refused) {
    it(`refuses ${what} with 400 and stores nothing`, async () => {
      const res = await handle(post("/heartbeat", body), env, T0);
      expect(res.status).toBe(400);
      expect(await rows()).toEqual([]);
    });
  }

  it("rate-limits the same id to one heartbeat per 60 s, storing nothing on 429", async () => {
    expect((await handle(post("/heartbeat", hb(ID_A, "2.0.0")), env, T0)).status).toBe(204);
    const limited = await handle(post("/heartbeat", hb(ID_A, "9.9.9")), env, T0 + 59_999);
    expect(limited.status).toBe(429);
    expect(await rows()).toEqual([expect.objectContaining({ app_version: "2.0.0", last_seen_ms: T0 })]);
    expect((await handle(post("/heartbeat", hb(ID_A, "2.0.1")), env, T0 + 60_000)).status).toBe(204);
    expect(await rows()).toEqual([expect.objectContaining({ app_version: "2.0.1", last_seen_ms: T0 + 60_000 })]);
  });

  it("rate-limits per id, not globally", async () => {
    expect((await handle(post("/heartbeat", hb(ID_A)), env, T0)).status).toBe(204);
    expect((await handle(post("/heartbeat", hb(ID_B)), env, T0 + 1)).status).toBe(204);
    expect(await rows()).toHaveLength(2);
  });

  it("rate-limits across a bucket boundary too", async () => {
    expect((await handle(post("/heartbeat", hb(ID_A)), env, T0 + 9 * MIN + 50_000)).status).toBe(204);
    expect((await handle(post("/heartbeat", hb(ID_A)), env, T0 + 10 * MIN + 10_000)).status).toBe(429);
    expect(await rows()).toHaveLength(1);
  });
});

describe("POST /delete", () => {
  it("hard-deletes every raw row for the id, in every bucket, and no other id's rows", async () => {
    await handle(post("/heartbeat", hb(ID_A)), env, T0);
    await handle(post("/heartbeat", hb(ID_A)), env, T0 + 15 * MIN);
    await handle(post("/heartbeat", hb(ID_A)), env, T0 + 40 * 24 * 60 * MIN);
    await handle(post("/heartbeat", hb(ID_B)), env, T0);
    expect(await rows()).toHaveLength(4);

    const res = await handle(post("/delete", JSON.stringify({ installId: ID_A })), env, T0);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect((await rows()).map((r) => r.install_id)).toEqual([ID_B]);
  });

  it("answers 204 for an id that never existed, indistinguishable from a real delete", async () => {
    const res = await handle(post("/delete", JSON.stringify({ installId: ID_B })), env, T0);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("is not rate-limited by a heartbeat a moment ago", async () => {
    await handle(post("/heartbeat", hb(ID_A)), env, T0);
    expect((await handle(post("/delete", JSON.stringify({ installId: ID_A })), env, T0 + 1)).status).toBe(204);
    expect(await rows()).toEqual([]);
  });

  it("touches only raw rows: an already-closed bucket aggregate keeps its count (it holds no id)", async () => {
    await handle(post("/heartbeat", hb(ID_A)), env, T0);
    await env.DB.prepare("INSERT INTO bucket_count VALUES ('2026-10-01T12:00:00Z', 1)").run();
    await handle(post("/delete", JSON.stringify({ installId: ID_A })), env, T0 + 11 * MIN);
    const agg = await env.DB.prepare("SELECT distinct_ids FROM bucket_count").first<{ distinct_ids: number }>();
    expect(agg?.distinct_ids).toBe(1);
  });

  for (const [what, body] of [
    ["a heartbeat-shaped body", hb(ID_A)],
    ["a non-GUID id", JSON.stringify({ installId: "x" })],
    ["no id", "{}"],
    ["invalid JSON", "nope"],
  ] as const) {
    it(`refuses ${what} with 400 and deletes nothing`, async () => {
      await handle(post("/heartbeat", hb(ID_A)), env, T0);
      expect((await handle(post("/delete", body), env, T0)).status).toBe(400);
      expect(await rows()).toHaveLength(1);
    });
  }
});

describe("routing", () => {
  it("answers 405 with Allow for a wrong method and 404 for an unknown path", async () => {
    const get = await handle(new Request("https://telemetry.test/heartbeat"), env, T0);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
    expect((await handle(new Request("https://telemetry.test/delete"), env, T0)).status).toBe(405);
    expect((await handle(post("/metrics.json", "{}"), env, T0)).status).toBe(405);
    expect((await handle(new Request("https://telemetry.test/"), env, T0)).status).toBe(404);
    expect((await handle(new Request("https://telemetry.test/admin"), env, T0)).status).toBe(404);
  });

  it("the exported fetch handler serves requests end to end", async () => {
    const res = await worker.fetch(post("/heartbeat", hb(ID_A)) as Parameters<typeof worker.fetch>[0], env);
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(1);
  });
});
