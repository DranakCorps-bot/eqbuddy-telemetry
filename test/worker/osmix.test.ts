// DRA-784 D1: users by OS family, last 7 days. One query answers it with the
// version mix, so its denominator is weeklyActive's by construction.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../../src/index";
import {
  DEFINITIONS,
  type RollupRow,
  computeMetrics,
  osMix,
  publishedOsMix,
  recordHeartbeat,
  runScheduled,
  versionMix,
  weeklyMix,
  writeDailyRollups,
} from "../../src/store";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const OCT1 = Date.parse("2026-10-01T00:00:00Z");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";
const E = "eeeeeeee-0000-4000-8000-000000000005";

const WIN = "Windows 10.0.26200";
const MAC = "Windows 10.0.19045; Wine on macOS";

async function beat(installId: string, at: number, os: string, appVersion = "2.0.0"): Promise<void> {
  expect(await recordHeartbeat(env.DB, { installId, appVersion, os }, at)).toBe("recorded");
}

/**
 * Up to the end of Oct 3:
 *   A  Windows on 2.0.1 throughout
 *   B  Windows on Oct 1, then Wine on macOS on Oct 3: counted ONCE, on the later
 *   C  a value that matches no form: "other"
 *   D  Wine on Linux, but 8 days back: outside the 7 days
 *   E  Wine on macOS on 2.0.0
 */
async function seed(): Promise<void> {
  await beat(D, OCT1 - 6 * DAY, "Windows 10.0.19045; Wine on Linux");
  await beat(A, OCT1 + 60 * MIN, WIN, "2.0.1");
  await beat(B, OCT1 + 120 * MIN, WIN);
  await beat(C, OCT1 + DAY + 60 * MIN, "Darwin 23.4.0");
  await beat(B, OCT1 + 2 * DAY + 60 * MIN, MAC);
  await beat(E, OCT1 + 2 * DAY + 120 * MIN, MAC);
}
const END_OCT3 = OCT1 + 3 * DAY - 1;

describe("the OS mix", () => {
  it("counts each id once, on its latest OS, with every family present and zeros kept", async () => {
    await seed();
    expect(await osMix(env.DB, END_OCT3)).toEqual({
      denominator: 4,
      families: [
        { family: "windows", count: 1, share: 0.25 }, // A
        { family: "macos-wine", count: 2, share: 0.5 }, // B (its later OS), E
        { family: "linux-wine", count: 0, share: 0 }, // D is 8 days back
        { family: "wine-other", count: 0, share: 0 },
        { family: "other", count: 1, share: 0.25 }, // C
      ],
    });
  });

  it("shares the version mix's denominator, from ONE query, and leaves the version mix as it was", async () => {
    await seed();
    const both = await weeklyMix(env.DB, END_OCT3);
    expect(both.os.denominator).toBe(both.versions.denominator);
    expect(both.versions).toEqual({
      denominator: 4,
      versions: [
        { appVersion: "2.0.0", count: 3, share: 0.75 },
        { appVersion: "2.0.1", count: 1, share: 0.25 },
      ],
    });
    expect(await versionMix(env.DB, END_OCT3)).toEqual(both.versions);
  });

  it("an id that changed version AND OS is read off one row for both", async () => {
    await beat(A, OCT1 + 60 * MIN, WIN, "2.0.0");
    await beat(A, OCT1 + 120 * MIN, MAC, "2.0.1");
    const both = await weeklyMix(env.DB, OCT1 + DAY - 1);
    expect(both.versions.versions).toEqual([{ appVersion: "2.0.1", count: 1, share: 1 }]);
    expect(both.os.families.filter((f) => f.count > 0)).toEqual([{ family: "macos-wine", count: 1, share: 1 }]);
  });

  it("an empty window is a zero denominator with every family at 0, never NaN", async () => {
    expect(await osMix(env.DB, END_OCT3)).toEqual({
      denominator: 0,
      families: ["windows", "macos-wine", "linux-wine", "wine-other", "other"].map((family) => ({ family, count: 0, share: 0 })),
    });
  });

  it("version ties still break by version string, as the SQL ORDER BY did", async () => {
    await beat(A, OCT1 + 60 * MIN, WIN, "2.0.10");
    await beat(B, OCT1 + 60 * MIN, MAC, "2.0.1");
    await beat(C, OCT1 + 60 * MIN, WIN, "2.0.2");
    const v = await versionMix(env.DB, OCT1 + DAY - 1);
    expect(v.versions.map((x) => x.appVersion)).toEqual(["2.0.1", "2.0.10", "2.0.2"]);
  });
});

describe("the rollup writes it and metrics.json publishes it", () => {
  it("each completed day gets os_mix_7d beside version_mix_7d, and osMix7d.denominator is weeklyActive", async () => {
    await seed();
    const now = OCT1 + 3 * DAY + 5 * MIN;
    await runScheduled(env.DB, now);
    const { results } = await env.DB
      .prepare("SELECT day, version_mix_7d, os_mix_7d FROM daily_rollup ORDER BY day")
      .all<{ day: string; version_mix_7d: string; os_mix_7d: string }>();
    expect(results.map((r) => r.day)).toEqual(["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
    for (const r of results) expect(JSON.parse(r.os_mix_7d).denominator, r.day).toBe(JSON.parse(r.version_mix_7d).denominator);

    // The backlog reaches back to D's day: one more pass rolls up Oct 2 and 3.
    await runScheduled(env.DB, now + 10 * MIN);
    const m = await computeMetrics(env.DB, now + 10 * MIN);
    expect(m.osMix7d).toEqual({ since: "2026-09-25", ...(await osMix(env.DB, END_OCT3)) });
    expect(m.osMix7d!.denominator).toBe(m.weeklyActive);
    expect(m.definitions.osMix7d).toBe(DEFINITIONS.osMix7d);
  });

  it("days rolled up before the column existed stay empty, and since names the first day that has one", async () => {
    // Two days written before migration 0005: no OS figure.
    for (const day of ["2026-09-29", "2026-09-30"]) {
      await env.DB
        .prepare("INSERT INTO daily_rollup (day, unique_30d, version_mix_7d, active_1d, usage_buckets_1d) VALUES (?1, 1, ?2, 1, 6)")
        .bind(day, JSON.stringify({ denominator: 1, versions: [{ appVersion: "2.0.0", count: 1, share: 1 }] }))
        .run();
    }
    await beat(A, OCT1 - DAY + 60 * MIN, WIN);
    // While the latest row is one of them, there is no OS figure to publish.
    expect((await computeMetrics(env.DB, OCT1 + 5 * MIN)).osMix7d).toBeNull();

    await writeDailyRollups(env.DB, OCT1 + DAY + 5 * MIN);
    const { results } = await env.DB
      .prepare("SELECT day, os_mix_7d FROM daily_rollup ORDER BY day")
      .all<{ day: string; os_mix_7d: string | null }>();
    // Not backfilled: the old days are left as they were.
    expect(results.map((r) => [r.day, r.os_mix_7d === null])).toEqual([
      ["2026-09-29", true],
      ["2026-09-30", true],
      ["2026-10-01", false],
    ]);
    const m = await computeMetrics(env.DB, OCT1 + DAY + 5 * MIN);
    expect(m.osMix7d).toMatchObject({ since: "2026-10-01", denominator: 1 });
    expect(m.osMix7d!.families[0]).toEqual({ family: "windows", count: 1, share: 1 });
  });

  it("publishedOsMix is pure over the rows already read: no query", () => {
    const row = (day: string, os: string | null): RollupRow => ({
      day,
      unique_30d: 0,
      version_mix_7d: '{"denominator":0,"versions":[]}',
      active_1d: 0,
      usage_buckets_1d: 0,
      os_mix_7d: os,
    });
    const mix = (n: number) => JSON.stringify({ denominator: n, families: [{ family: "windows", count: n, share: 1 }] });
    expect(publishedOsMix([])).toBeNull();
    expect(publishedOsMix([row("2026-10-01", null)])).toBeNull();
    expect(publishedOsMix([row("2026-10-01", null), row("2026-10-02", mix(2)), row("2026-10-03", mix(5))])).toEqual({
      since: "2026-10-02",
      denominator: 5,
      families: [{ family: "windows", count: 5, share: 1 }],
    });
  });

  it("publishes families and counts only: no raw os value reaches metrics.json", async () => {
    await seed();
    await runScheduled(env.DB, OCT1 + 3 * DAY + 5 * MIN);
    await runScheduled(env.DB, OCT1 + 3 * DAY + 15 * MIN);
    const res = await handle(new Request("https://t.test/metrics.json"), env, OCT1 + 3 * DAY + 16 * MIN);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.osMix7d.families.map((f: { family: string }) => f.family)).toEqual(["windows", "macos-wine", "linux-wine", "wine-other", "other"]);
    // The values the fixture sent appear nowhere outside the published definition.
    const { definitions: _d, ...figures } = body;
    for (const raw of [WIN, MAC, "Darwin 23.4.0", "Wine on Linux"]) expect(JSON.stringify(figures), raw).not.toContain(raw);
  });

  it("defines it beside the number: the shared denominator, the families, the Wine limit and since", () => {
    expect(DEFINITIONS.osMix7d).toMatch(/same distinct opted-in installs versionMix7d divides/);
    expect(DEFINITIONS.osMix7d).toMatch(/on the OS it reported last/);
    expect(DEFINITIONS.osMix7d).toMatch(/windows, macos-wine, linux-wine, wine-other/);
    expect(DEFINITIONS.osMix7d).toMatch(/Wine that hides itself, and any install whose app does not report Wine, counts as windows/);
    expect(DEFINITIONS.osMix7d).toMatch(/since is the first UTC day/);
  });
});
