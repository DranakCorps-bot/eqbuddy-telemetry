// DRA-783 D1: the EQBuddy Evolved download total, its daily rows, the 30-day
// figure, and usageHours.allTimeRounded.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DOWNLOADS_SINCE,
  MAX_RELEASE_PAGES,
  RELEASES_PER_PAGE,
  downloadsFrom,
  fetchEvolvedDownloads,
  readDownloadRows,
  recordDownloads,
  refreshDownloads,
  sumEvolvedDownloads,
  type DownloadsRow,
} from "../../src/downloads";
import { DEFINITIONS, computeMetrics, roundHalfUp, runScheduled, usageHoursFrom } from "../../src/store";
import { handle } from "../../src/index";

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

type Asset = { name: string; download_count: number };
type Release = { tag_name: string; draft: boolean; created_at: string; assets: Asset[] };

function release(tag: string, created: string, assets: Array<[string, number]>, draft = false): Release {
  return { tag_name: tag, draft, created_at: created, assets: assets.map(([name, download_count]) => ({ name, download_count })) };
}

/**
 * The shape of the live list on 2026-10-02 (the four v2 releases, newest first,
 * then v1): the installer + portable counts sum to 1,339 and the .sha256 files
 * to 430, the split the plan review measured with `gh api`.
 */
const LIVE_SHAPE: Release[] = [
  release("v2.0.3", "2026-10-01T23:42:21Z", [["EQBuddyEvolved-portable.zip", 2], ["EQBuddyEvolved-portable.zip.sha256", 2], ["EQBuddyEvolvedSetup.exe", 95], ["EQBuddyEvolvedSetup.exe.sha256", 65]]),
  release("v2.0.2", "2026-10-01T06:26:05Z", [["EQBuddyEvolved-portable.zip", 1], ["EQBuddyEvolved-portable.zip.sha256", 8], ["EQBuddyEvolvedSetup.exe", 195], ["EQBuddyEvolvedSetup.exe.sha256", 152]]),
  release("v2.0.1", "2026-09-29T22:26:43Z", [["EQBuddyEvolved-portable.zip", 1], ["EQBuddyEvolved-portable.zip.sha256", 0], ["EQBuddyEvolvedSetup.exe", 451], ["EQBuddyEvolvedSetup.exe.sha256", 199]]),
  release("v2.0.0", "2026-09-28T20:52:47Z", [["EQBuddyEvolved-portable.zip", 3], ["EQBuddyEvolved-portable.zip.sha256", 0], ["EQBuddyEvolvedSetup.exe", 591], ["EQBuddyEvolvedSetup.exe.sha256", 4]]),
  release("v1.99.18", "2026-09-04T18:51:12Z", [["EQBuddySetup.exe", 900], ["EQBuddy-portable.zip", 80]]),
];

/** A fetch that serves `pages` (page N = pages[N-1]) and records every URL asked for. */
function github(pages: unknown[], status = 200): { fetcher: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status });
  }) as unknown as typeof fetch;
  return { fetcher, urls };
}

async function rows(): Promise<DownloadsRow[]> {
  const { results } = await env.DB.prepare("SELECT day, total, as_of FROM downloads_daily ORDER BY day").all<DownloadsRow>();
  return results;
}

describe("what is counted", () => {
  it("sums the installer and the portable zip of every v2 release: the live split's 1,339", () => {
    expect(sumEvolvedDownloads(LIVE_SHAPE)).toBe(1339);
  });

  it("leaves the .sha256 files out (430 of them in the live split)", () => {
    // Prove-fail of the rule: the same list with the .sha256 files renamed is 430 more.
    const renamed = LIVE_SHAPE.map((r) => ({ ...r, assets: r.assets.map((a) => ({ ...a, name: a.name.replace(/\.sha256$/, ".checksum") })) }));
    expect(sumEvolvedDownloads(renamed)! - sumEvolvedDownloads(LIVE_SHAPE)!).toBe(430);
    expect(sumEvolvedDownloads([release("v2.0.0", "2026-09-28T20:52:47Z", [["a.exe", 7], ["a.exe.SHA256", 50]])])).toBe(7);
  });

  it("leaves v1 tags out, however many downloads they carry", () => {
    expect(sumEvolvedDownloads([...LIVE_SHAPE, release("v1.99.19", "2026-10-05T00:00:00Z", [["EQBuddySetup.exe", 5000]])])).toBe(1339);
    expect(sumEvolvedDownloads([release("v1.99.18", "2026-09-04T18:51:12Z", [["EQBuddySetup.exe", 900]])])).toBeNull();
    // A tag that merely contains "v2." is not an Evolved release.
    expect(sumEvolvedDownloads([...LIVE_SHAPE, release("legacy-v2.0", "2026-10-05T00:00:00Z", [["x.exe", 5000]])])).toBe(1339);
  });

  it("leaves drafts out", () => {
    expect(sumEvolvedDownloads([...LIVE_SHAPE, release("v2.1.0", "2026-10-05T00:00:00Z", [["EQBuddyEvolvedSetup.exe", 40]], true)])).toBe(1339);
  });

  it("answers null, never 0, for nothing to count or a list it cannot read", () => {
    expect(sumEvolvedDownloads([])).toBeNull();
    expect(sumEvolvedDownloads([release("v2.0.0", "2026-09-28T20:52:47Z", [["a.exe", 0], ["a.exe.sha256", 9]])])).toBeNull();
    expect(sumEvolvedDownloads({ message: "API rate limit exceeded" })).toBeNull();
    expect(sumEvolvedDownloads([{ tag_name: "v2.0.0", draft: false, assets: [{ name: "a.exe", download_count: "12" }] }])).toBeNull();
    expect(sumEvolvedDownloads([{ tag_name: "v2.0.0", draft: false }])).toBeNull();
  });
});

describe("reading GitHub", () => {
  it("reads one page when it ends the list, without a token, as eqbuddy-telemetry", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(LIVE_SHAPE), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchEvolvedDownloads(fetcher)).toBe(1339);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/DranakCorps-bot/EQBuddy/releases?per_page=100&page=1",
    ]);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("eqbuddy-telemetry");
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    // The whole request header set, pinned: the unauthenticated read sends these three and nothing else.
    expect(Object.keys(headers).sort()).toEqual(["Accept", "User-Agent", "X-GitHub-Api-Version"]);
  });

  // DRA-835. Unauthenticated, GitHub's 60/hour is per egress IP and Workers share
  // Cloudflare's, so the read was rate-limited before it ever ran (403, 0 remaining).
  // With the dispatch token the request admits exactly ONE more header,
  // Authorization, and the token appears nowhere else.
  const TOKEN = "github_pat_TEST_ONLY_not_a_real_token";

  it("with a token, every page carries it as a Bearer header and nothing else changes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const page1 = Array.from({ length: RELEASES_PER_PAGE }, () => release("v2.0.0", "2026-11-01T00:00:00Z", [["a.exe", 1]]));
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return new Response(JSON.stringify(page === 1 ? page1 : LIVE_SHAPE), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchEvolvedDownloads(fetcher, TOKEN)).toBe(RELEASES_PER_PAGE + 1339);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(Object.keys(headers).sort()).toEqual(["Accept", "Authorization", "User-Agent", "X-GitHub-Api-Version"]);
      expect(call.url).not.toContain(TOKEN);
    }
  });

  it("an empty or absent token reads unauthenticated, with the same result", async () => {
    for (const token of [undefined, ""]) {
      const calls: Array<RequestInit | undefined> = [];
      const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init);
        return new Response(JSON.stringify(LIVE_SHAPE), { status: 200 });
      }) as unknown as typeof fetch;
      expect(await fetchEvolvedDownloads(fetcher, token)).toBe(1339);
      expect(Object.keys(calls[0]?.headers as Record<string, string>).map((h) => h.toLowerCase())).not.toContain("authorization");
    }
  });

  it("a token GitHub refuses answers null and writes nothing, never throws", async () => {
    expect(await fetchEvolvedDownloads(github([LIVE_SHAPE], 401).fetcher, TOKEN)).toBeNull();
    expect(await refreshDownloads(env.DB, Date.parse("2026-10-02T12:00:00Z"), github([LIVE_SHAPE], 403).fetcher, TOKEN)).toBe(false);
    expect(await rows()).toEqual([]);
  });

  it("follows the pages while a full page is all Evolved, and stops at the first release older than 2.0", async () => {
    // Exactly RELEASES_PER_PAGE releases already exist, so one page is not the whole list.
    const page1 = Array.from({ length: RELEASES_PER_PAGE }, (_, i) =>
      release(`v2.${i}.0`, "2026-11-01T00:00:00Z", [["EQBuddyEvolvedSetup.exe", 1], ["EQBuddyEvolvedSetup.exe.sha256", 1]]),
    );
    const page2 = [...LIVE_SHAPE, ...Array.from({ length: RELEASES_PER_PAGE - LIVE_SHAPE.length }, () => LIVE_SHAPE[4])];
    const page3 = [release("v2.9.9", "2026-11-01T00:00:00Z", [["never.exe", 99999]])];
    const { fetcher, urls } = github([page1, page2, page3]);
    expect(await fetchEvolvedDownloads(fetcher)).toBe(RELEASES_PER_PAGE + 1339);
    expect(urls.map((u) => new URL(u).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("writes nothing when the list does not end within MAX_RELEASE_PAGES pages", async () => {
    const full = Array.from({ length: RELEASES_PER_PAGE }, () => release("v2.0.0", "2026-11-01T00:00:00Z", [["a.exe", 1]]));
    const { fetcher, urls } = github(Array.from({ length: MAX_RELEASE_PAGES + 1 }, () => full));
    expect(await fetchEvolvedDownloads(fetcher)).toBeNull();
    expect(urls).toHaveLength(MAX_RELEASE_PAGES);
  });

  it("answers null for a refusal, a throw, or a body that is not JSON", async () => {
    expect(await fetchEvolvedDownloads(github([LIVE_SHAPE], 403).fetcher)).toBeNull();
    expect(await fetchEvolvedDownloads(github([LIVE_SHAPE], 500).fetcher)).toBeNull();
    expect(await fetchEvolvedDownloads((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
    expect(await fetchEvolvedDownloads((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).toBeNull();
  });
});

describe("a failed read keeps the old figure and never writes 0", () => {
  const T = Date.parse("2026-10-02T11:00:00Z");

  it("keeps the previous total and its as-of through every kind of failure", async () => {
    expect(await refreshDownloads(env.DB, T, github([LIVE_SHAPE]).fetcher)).toBe(true);
    const failures: Array<typeof fetch> = [
      github([LIVE_SHAPE], 500).fetcher,
      github([[]]).fetcher, // no release at all
      github([[release("v1.99.18", "2026-09-04T18:51:12Z", [["EQBuddySetup.exe", 900]])]]).fetcher, // no v2 release
      github([[release("v2.0.0", "2026-09-28T20:52:47Z", [["a.exe", 0]])]]).fetcher, // a total of 0
      (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    ];
    for (const [i, f] of failures.entries()) {
      expect(await refreshDownloads(env.DB, T + (i + 1) * 60 * MIN, f)).toBe(false);
    }
    expect(await rows()).toEqual([{ day: "2026-10-02", total: 1339, as_of: "2026-10-02T11:00:00Z" }]);
    const m = await computeMetrics(env.DB, T + 6 * 60 * MIN);
    expect(m.downloads?.total).toBe(1339);
    expect(m.downloads?.asOf).toBe("2026-10-02T11:00:00Z");
  });

  it("publishes downloads: null before the first successful read, never a 0", async () => {
    await refreshDownloads(env.DB, T, github([[]]).fetcher);
    expect(await rows()).toEqual([]);
    expect((await computeMetrics(env.DB, T)).downloads).toBeNull();
  });

  it("a later read the same UTC day replaces that day's row: it holds the day's latest total", async () => {
    await recordDownloads(env.DB, 1339, T);
    await recordDownloads(env.DB, 1350, T + 60 * MIN);
    expect(await rows()).toEqual([{ day: "2026-10-02", total: 1350, as_of: "2026-10-02T12:00:00Z" }]);
  });
});

describe("last30d", () => {
  const at = (iso: string) => Date.parse(iso);

  it("equals total while v2.0.0 is inside the window (through 2026-10-27)", () => {
    for (const asOf of ["2026-10-02T11:00:00Z", "2026-10-27T23:00:00Z"]) {
      const d = downloadsFrom([{ day: asOf.slice(0, 10), total: 1339, as_of: asOf }])!;
      expect(d).toEqual({
        since: DOWNLOADS_SINCE,
        sinceTag: "v2.0.0",
        total: 1339,
        last30d: 1339,
        last30dNote: null,
        asOf,
      });
    }
  });

  it("is null, with the first day a figure will exist, in the gap before 30 days of daily totals", () => {
    // Daily totals start 2026-10-02 (the deploy day). On 2026-10-28 the window starts
    // after 2026-09-28, which has no recorded total.
    const d = downloadsFrom([
      { day: "2026-10-02", total: 1339, as_of: "2026-10-02T23:00:00Z" },
      { day: "2026-10-28", total: 3000, as_of: "2026-10-28T09:00:00Z" },
    ])!;
    expect(d.total).toBe(3000);
    expect(d.last30d).toBeNull();
    expect(d.last30dNote).toContain("2026-09-28");
    expect(d.last30dNote).toContain("The first one will be on 2026-11-01.");
  });

  it("is total minus the total at the end of the window's base day, once that day was recorded", () => {
    const d = downloadsFrom([
      { day: "2026-10-02", total: 1339, as_of: "2026-10-02T23:00:00Z" },
      { day: "2026-11-01", total: 3400, as_of: "2026-11-01T09:00:00Z" },
    ])!;
    expect(d.last30d).toBe(3400 - 1339);
    expect(d.last30dNote).toBeNull();
  });

  it("is null with the reason, not negative, if the total fell", () => {
    const d = downloadsFrom([
      { day: "2026-10-02", total: 1339, as_of: "2026-10-02T23:00:00Z" },
      { day: "2026-11-01", total: 1200, as_of: "2026-11-01T09:00:00Z" },
    ])!;
    expect(d.last30d).toBeNull();
    expect(d.last30dNote).toContain("fell");
  });

  it("the database read answers exactly the rows the rule needs, and the published figure is the difference", async () => {
    // A daily row for every day 2026-10-02 .. 2026-11-05, 100 more each day.
    const start = at("2026-10-02T23:00:00Z");
    for (let i = 0; i <= 34; i++) await recordDownloads(env.DB, 1339 + 100 * i, start + i * DAY);
    const read = await readDownloadRows(env.DB);
    // Latest 2026-11-05; base day 2026-10-06; and the first row after the base day.
    expect(read.map((r) => r.day)).toEqual(["2026-10-06", "2026-10-07", "2026-11-05"]);
    const d = (await computeMetrics(env.DB, at("2026-11-05T23:05:00Z"))).downloads!;
    expect(d.total).toBe(1339 + 3400);
    expect(d.last30d).toBe(3000);
  });

  it("the database read, in the gap, still carries the row that names the first figure's day", async () => {
    await recordDownloads(env.DB, 1339, at("2026-10-02T23:00:00Z"));
    await recordDownloads(env.DB, 1500, at("2026-10-03T23:00:00Z"));
    await recordDownloads(env.DB, 3000, at("2026-10-29T09:00:00Z"));
    const d = (await computeMetrics(env.DB, at("2026-10-29T09:05:00Z"))).downloads!;
    expect(d.last30d).toBeNull();
    expect(d.last30dNote).toContain("The first one will be on 2026-11-01.");
  });
});

describe("the cron and metrics.json", () => {
  const HOUR = Date.parse("2026-10-02T11:00:00Z");

  it("reads GitHub on the hour's first tick only, and metrics.json publishes the result", async () => {
    const { fetcher, urls } = github([LIVE_SHAPE]);
    await runScheduled(env.DB, HOUR + 10 * MIN, fetcher);
    await runScheduled(env.DB, HOUR + 50 * MIN, fetcher);
    expect(urls).toEqual([]);
    await runScheduled(env.DB, HOUR + 60 * MIN, fetcher);
    expect(urls).toHaveLength(1);
    const body = await (await handle(new Request("https://t.test/metrics.json"), env, HOUR + 61 * MIN)).json<any>();
    expect(body.schema).toBe(1);
    expect(body.downloads).toEqual({
      since: "2026-09-28",
      sinceTag: "v2.0.0",
      total: 1339,
      last30d: 1339,
      last30dNote: null,
      asOf: "2026-10-02T12:00:00Z",
    });
    expect(typeof body.usageHours.allTimeRounded).toBe("number");
  });

  it("the pass hands the token to the read, and metrics.json never carries it", async () => {
    const token = "github_pat_TEST_ONLY_pass_token";
    const seen: string[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify(LIVE_SHAPE), { status: 200 });
    }) as unknown as typeof fetch;
    await runScheduled(env.DB, HOUR, fetcher, token);
    expect(seen).toEqual([`Bearer ${token}`]);
    const text = await (await handle(new Request("https://t.test/metrics.json"), env, HOUR + MIN)).text();
    expect(JSON.parse(text).downloads.total).toBe(1339);
    expect(text).not.toContain(token);
  });

  it("a pass whose GitHub read throws still writes the snapshot", async () => {
    await runScheduled(env.DB, HOUR, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    const snap = await env.DB.prepare("SELECT generated_at FROM metrics_snapshot WHERE id = 1").first<{ generated_at: string }>();
    expect(snap?.generated_at).toBe("2026-10-02T11:00:00Z");
  });

  it("without a fetcher the pass makes no read at all", async () => {
    await runScheduled(env.DB, HOUR);
    expect(await rows()).toEqual([]);
  });

  it("defines downloads as not telemetry, installer and portable zip only, and every kind of fetch counting", () => {
    expect(DEFINITIONS.downloads).toMatch(/^Not telemetry/);
    expect(DEFINITIONS.downloads).toContain("installer and the portable zip");
    expect(DEFINITIONS.downloads).toContain(".sha256");
    expect(DEFINITIONS.downloads).toContain("A re-download, an update and a bot all count");
    expect(DEFINITIONS.downloads).toContain("never publishes 0");
    expect(DEFINITIONS.usageHours).toContain("allTimeRounded is allTime to the nearest whole hour (half up)");
  });
});

describe("usageHours.allTimeRounded", () => {
  it("rounds half up", () => {
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(2.49)).toBe(2);
    expect(roundHalfUp(3019.33)).toBe(3019);
    expect(roundHalfUp(3019.5)).toBe(3020);
    expect(roundHalfUp(0.17)).toBe(0);
  });

  it("is allTime rounded, from the same producer", () => {
    const row = (day: string, usage_buckets_1d: number) => ({
      day,
      unique_30d: 0,
      version_mix_7d: '{"denominator":0,"versions":[]}',
      active_1d: 0,
      usage_buckets_1d,
      os_mix_7d: null,
    });
    // 3 install-buckets are 0.5 h: exactly half, so up.
    expect(usageHoursFrom([row("2026-10-01", 3)]).allTimeRounded).toBe(1);
    // 18116 + 0 install-buckets = 3019.33 h.
    const u = usageHoursFrom([row("2026-10-01", 18116)]);
    expect(u.allTime).toBe(3019.33);
    expect(u.allTimeRounded).toBe(3019);
  });
});
