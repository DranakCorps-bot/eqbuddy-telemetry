// The widget exactly as /widget.js serves it, run in a fresh VM context with
// no DOM beyond what each test hands it. The worker tests prove the route
// serves this text; these prove what the text does.

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { CHART_NAMES, DEFAULT_TILE_NAMES, REPORT_TILE_NAMES, TILE_NAMES, WIDGET_CSS, WIDGET_JS } from "../../src/widget";

interface Api {
  version: number;
  TILES: string[];
  DEFAULT_TILES: string[];
  CHARTS: string[];
  OPT_IN_LABEL: string;
  USAGE_LABEL: string;
  select(value: unknown, all: string[], defaults?: string[]): string[];
  render(m: unknown, h: unknown, options?: { tiles?: unknown; charts?: unknown }, loading?: boolean): string;
  mount(el: FakeElement, opts?: Record<string, unknown>): Promise<FakeElement>;
}

/** Loads the widget into its own global, as a browser would, and returns the API it publishes. */
function load(window: Record<string, unknown> = {}): Api {
  const context = vm.createContext({ window });
  vm.runInContext(WIDGET_JS, context, { filename: "widget.js" });
  return window.EQBuddyTelemetry as Api;
}

class FakeElement {
  innerHTML = "";
  constructor(private attrs: Record<string, string> = {}) {}
  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  querySelectorAll(): never[] {
    return [];
  }
}

const METRICS = {
  schema: 1,
  generatedAt: "2026-10-03T00:05:00Z",
  concurrentNow: 2,
  peakConcurrent: 3,
  peakConcurrentBucket: "2026-09-28T02:10:00Z",
  uniqueUsers30d: 140,
  versionMix7d: {
    denominator: 96,
    versions: [
      { appVersion: "2.0.1", count: 80, share: 0.833 },
      { appVersion: "2.0.0", count: 16, share: 0.167 },
    ],
  },
  dailyActive: 41,
  weeklyActive: 96,
  usageHours: { yesterday: 12.5, last7d: 80, last30d: 300.25, allTime: 1238, todaySoFar: 3.5 },
  installsAllTime: 1512,
  activeLast24h: 55,
  activeLast7d: 120,
  definitions: {
    dailyActive: "Distinct opted-in installs that sent a heartbeat in the last complete UTC day.",
    weeklyActive: "Distinct opted-in installs in the 7 days up to the end of the last complete UTC day.",
    installsAllTime: "Opted-in installs counted when first seen.",
    usageHours: "Estimated hours of use by opted-in installs only.",
    activeLast24h: "Distinct opted-in installs in the 24 hours up to generatedAt. A rolling window.",
    activeLast7d: "Distinct opted-in installs in the 7 days up to generatedAt. A rolling window.",
  },
};

const HISTORY = {
  schema: 1,
  generatedAt: "2026-10-03T00:05:00Z",
  days: [
    { day: "2026-10-01", dailyActive: 40, weeklyActive: 90, uniqueUsers30d: 130, usageHours: 11, versionMix7d: METRICS.versionMix7d },
    { day: "2026-10-02", dailyActive: 41, weeklyActive: 96, uniqueUsers30d: 140, usageHours: 12.5, versionMix7d: METRICS.versionMix7d },
  ],
  concurrent10m: [
    { bucket: "2026-10-02T20:00:00Z", count: 3 },
    { bucket: "2026-10-02T20:10:00Z", count: 2 },
  ],
  definitions: {},
};

const EMPTY_METRICS = {
  ...METRICS,
  concurrentNow: 0,
  peakConcurrent: 0,
  peakConcurrentBucket: null,
  uniqueUsers30d: 0,
  versionMix7d: { denominator: 0, versions: [] },
  dailyActive: 0,
  weeklyActive: 0,
  usageHours: { yesterday: 0, last7d: 0, last30d: 0, allTime: 0, todaySoFar: 0 },
  installsAllTime: 0,
  activeLast24h: 0,
  activeLast7d: 0,
};
const EMPTY_HISTORY = { ...HISTORY, days: [], concurrent10m: [] };

function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))].map((m) => m[1]);
}

function tileState(html: string, name: string): string | undefined {
  return html.match(new RegExp(`data-tile="${name}" data-state="(\\w+)"`))?.[1];
}

describe("the widget module", () => {
  it("publishes its API on window with the documented tile and chart names", () => {
    const api = load();
    expect(api.version).toBe(1);
    expect(api.TILES).toEqual([...TILE_NAMES]);
    expect(api.DEFAULT_TILES).toEqual([...DEFAULT_TILE_NAMES]);
    expect(api.CHARTS).toEqual([...CHART_NAMES]);
    expect(api.USAGE_LABEL).toBe("estimated, opted-in installs only, 10-minute resolution");
  });

  it("depends on nothing: no import, no remote URL fetched, no header or console use", () => {
    expect(WIDGET_JS).not.toMatch(/\bimport\b|\brequire\(/);
    expect(WIDGET_JS).not.toMatch(/fetch(Impl)?\(\s*["']https?:/);
    expect(WIDGET_JS).not.toMatch(/\bconsole\s*\.|document\.cookie|localStorage/);
  });

  it("scopes every CSS rule under .eqbt and themes through --eqbt-* variables", () => {
    const selectors = [...WIDGET_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim())
      .filter((s) => !s.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(10);
    for (const group of selectors) {
      for (const sel of group.split(",")) expect(sel.trim(), sel).toMatch(/^\.eqbt/);
    }
    for (const v of ["--eqbt-bg", "--eqbt-fg", "--eqbt-muted", "--eqbt-surface", "--eqbt-border", "--eqbt-accent", "--eqbt-accent-2", "--eqbt-font"]) {
      expect(WIDGET_CSS).toContain(`var(${v},`);
    }
  });
});

describe("rendering", () => {
  it("renders every tile and chart by default, with the opt-in and usage labels", () => {
    const html = load().render(METRICS, HISTORY);
    expect(attrValues(html, "data-tile")).toEqual([...DEFAULT_TILE_NAMES]);
    expect(attrValues(html, "data-chart")).toEqual([...CHART_NAMES]);
    expect(html).toContain("Opted-in installs only: a lower bound, not total users.");
    // The usage tile and the usage chart each carry the exact label.
    expect(html.split("estimated, opted-in installs only, 10-minute resolution")).toHaveLength(3);
    for (const name of DEFAULT_TILE_NAMES) expect(tileState(html, name), name).toBe("ready");
    expect(attrValues(html, "data-state").filter((s) => s !== "ready")).toEqual([]);
  });

  it("shows the figures, the peak's time in America/Chicago, and the server's definitions", () => {
    const html = load().render(METRICS, HISTORY);
    expect(html).toContain(">55<"); // active, last 24 hours
    expect(html).toContain(">140<");
    expect(html).toContain("10 minutes from Sep 27, 9:10 PM CDT");
    expect(html).toContain(">1,238<"); // usage hours, all time
    expect(html).toContain("Today so far 3.5 h · last 7 full days 80 · last 30 full days 300");
    expect(html).toContain(METRICS.definitions.activeLast24h);
    expect(html).toContain("83.3% (80)");
    // The old tiles still show the old figures when named.
    const old = load().render(METRICS, HISTORY, { tiles: "dailyActive usageHours", charts: "none" });
    expect(old).toContain(">41<");
    expect(old).toContain(">80<"); // usage hours, last 7 complete days
    expect(old).toContain("Today so far 3.5 h · Yesterday 12.5 · 30 days 300 · all time 1,238");
    expect(old).toContain(METRICS.definitions.dailyActive);
  });

  it("fills the week of 10-minute windows with zeros where nobody was seen", () => {
    const html = load().render(METRICS, HISTORY, { tiles: "none", charts: "concurrent" });
    const tips = JSON.parse(
      html.match(/data-tips="([^"]*)"/)![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
    ) as string[];
    expect(tips).toHaveLength(7 * 144);
    expect(tips.filter((t) => !t.endsWith(": 0"))).toEqual(["Oct 2, 3:00 PM CDT: 3", "Oct 2, 3:10 PM CDT: 2"]);
  });

  it("escapes everything it prints", () => {
    const hostile = { ...METRICS, versionMix7d: { denominator: 1, versions: [{ appVersion: "<img src=x onerror=alert(1)>", count: 1, share: 1 }] } };
    const html = load().render(hostile, HISTORY, { tiles: "none", charts: "versions" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("selecting a subset", () => {
  it("shows only the named tiles and charts, in the order given", () => {
    const html = load().render(METRICS, HISTORY, { tiles: "usageHours, dailyActive", charts: "versions" });
    expect(attrValues(html, "data-tile")).toEqual(["usageHours", "dailyActive"]);
    expect(attrValues(html, "data-chart")).toEqual(["versions"]);
  });

  it("accepts arrays, ignores unknown and repeated names, and treats 'all' and 'none' as words", () => {
    const api = load();
    expect(api.select(["weeklyActive", "bogus", "weeklyActive"], api.TILES)).toEqual(["weeklyActive"]);
    expect(api.select("all", api.CHARTS)).toEqual([...CHART_NAMES]);
    expect(api.select(undefined, api.CHARTS)).toEqual([...CHART_NAMES]);
    expect(api.select("none", api.CHARTS)).toEqual([]);
    expect(api.select("", api.CHARTS)).toEqual([]);
  });

  it("keeps the opt-in label when nothing at all is selected", () => {
    const html = load().render(METRICS, HISTORY, { tiles: "none", charts: "none" });
    expect(attrValues(html, "data-tile")).toEqual([]);
    expect(attrValues(html, "data-chart")).toEqual([]);
    expect(html).toContain("Opted-in installs only: a lower bound, not total users.");
  });
});

describe("empty and thin data", () => {
  it("before the first complete UTC day, zero figures read 'collecting data', not 0", () => {
    const html = load().render(EMPTY_METRICS, EMPTY_HISTORY);
    for (const name of DEFAULT_TILE_NAMES) expect(tileState(html, name), name).toBe("collecting");
    for (const name of CHART_NAMES) expect(html, name).toContain(`data-chart="${name}" data-state="collecting"`);
    expect(html).toContain("collecting data");
    expect(html).not.toMatch(/eqbt-tile-value">0</);
    expect(html).toContain("Opted-in installs only: a lower bound, not total users.");
  });

  it("a non-zero figure before the first complete day is shown as it is", () => {
    const html = load().render({ ...EMPTY_METRICS, concurrentNow: 3 }, EMPTY_HISTORY);
    expect(tileState(html, "concurrentNow")).toBe("ready");
    expect(tileState(html, "activeLast24h")).toBe("collecting");
  });

  it("one day is too thin for a trend line, but enough for a day's bar", () => {
    const html = load().render(METRICS, { ...HISTORY, days: HISTORY.days.slice(1) });
    expect(html).toContain('data-chart="actives" data-state="collecting"');
    expect(html).toContain('data-chart="usageHours" data-state="ready"');
  });

  it("the usage tile names its complete-UTC-day window, so the headline cannot read as today (DRA-426)", () => {
    const api = load() as Api & { USAGE_WINDOW: string };
    const html = api.render(METRICS, HISTORY, { tiles: "usageHours", charts: "none" });
    expect(html).toContain("Usage hours, last 7 complete UTC days");
    expect(api.USAGE_WINDOW).toMatch(/complete UTC days, so today is not in them/);
    expect(html).toContain(api.USAGE_WINDOW);
  });

  it("today so far shows while the headline is still collecting, but a zero today does not", () => {
    const today = { ...EMPTY_METRICS, usageHours: { ...EMPTY_METRICS.usageHours, allTime: 1.83, todaySoFar: 1.83 } };
    const html = load().render(today, EMPTY_HISTORY, { tiles: "usageHours", charts: "none" });
    expect(tileState(html, "usageHours")).toBe("collecting");
    expect(html).toContain('<div class="eqbt-tile-sub">Today so far 1.8 h</div>');
    const zero = load().render(EMPTY_METRICS, EMPTY_HISTORY, { tiles: "usageHours", charts: "none" });
    expect(zero).not.toContain("eqbt-tile-sub");
  });

  it("a snapshot published before todaySoFar existed renders the old sub-line unchanged", () => {
    const { todaySoFar: _, ...old } = METRICS.usageHours;
    const html = load().render({ ...METRICS, usageHours: old }, HISTORY, { tiles: "usageHours", charts: "none" });
    expect(html).toContain('<div class="eqbt-tile-sub">Yesterday 12.5 · 30 days 300 · all time 1,238</div>');
    expect(html).not.toMatch(/Today so far \d/);
  });

  it("a zero after the first complete day is a real zero", () => {
    const html = load().render({ ...METRICS, concurrentNow: 0 }, HISTORY);
    expect(tileState(html, "concurrentNow")).toBe("ready");
  });

  it("with no data at all (a failed fetch) everything reads 'collecting data'", () => {
    const html = load().render(null, null, { tiles: "all" });
    for (const name of TILE_NAMES) expect(tileState(html, name), name).toBe("collecting");
    expect(html).toContain("Figures are unavailable right now.");
  });
});

describe("the all-time installs tile", () => {
  it("is selectable by name but not a default", () => {
    const api = load();
    expect(TILE_NAMES).toContain("installsAllTime");
    expect(DEFAULT_TILE_NAMES).not.toContain("installsAllTime");
    expect(api.select(undefined, api.TILES, api.DEFAULT_TILES)).toEqual([...DEFAULT_TILE_NAMES]);
    expect(api.select("all", api.TILES, api.DEFAULT_TILES)).toEqual([...TILE_NAMES]);
    expect(api.select("installsAllTime", api.TILES, api.DEFAULT_TILES)).toEqual(["installsAllTime"]);
    for (const name of DEFAULT_TILE_NAMES) expect(TILE_NAMES, name).toContain(name);
    expect(attrValues(api.render(METRICS, HISTORY), "data-tile")).not.toContain("installsAllTime");
  });

  it("shows the figure with its label and the server's definition", () => {
    const html = load().render(METRICS, HISTORY, { tiles: "installsAllTime", charts: "none" });
    expect(tileState(html, "installsAllTime")).toBe("ready");
    expect(html).toContain("Total installs (all time)");
    expect(html).toContain(">1,512<");
    expect(html).toContain(METRICS.definitions.installsAllTime);
    expect(html).toContain("Opted-in installs only: a lower bound, not total users.");
  });

  it("a snapshot published before installsAllTime existed reads 'collecting data', never 0", () => {
    const { installsAllTime: _, ...old } = METRICS;
    const html = load().render(old, HISTORY, { tiles: "installsAllTime", charts: "none" });
    expect(tileState(html, "installsAllTime")).toBe("collecting");
    expect(html).not.toMatch(/eqbt-tile-value">0</);
  });

  it("a non-zero count shows before the first complete UTC day; a zero one reads 'collecting data'", () => {
    const early = load().render({ ...EMPTY_METRICS, installsAllTime: 2 }, EMPTY_HISTORY, { tiles: "installsAllTime", charts: "none" });
    expect(tileState(early, "installsAllTime")).toBe("ready");
    const zero = load().render(EMPTY_METRICS, EMPTY_HISTORY, { tiles: "installsAllTime", charts: "none" });
    expect(tileState(zero, "installsAllTime")).toBe("collecting");
  });

  it("the report's tile list is every default plus installsAllTime, beside the 30-day count", () => {
    expect([...REPORT_TILE_NAMES].sort()).toEqual([...DEFAULT_TILE_NAMES, "installsAllTime"].sort());
    expect(REPORT_TILE_NAMES.indexOf("installsAllTime")).toBe(REPORT_TILE_NAMES.indexOf("uniqueUsers30d") + 1);
  });
});

describe("rolling actives and the all-time usage headline (launch day, 2026-09-28)", () => {
  // What /report read on launch day: 10 concurrent, a complete-day daily active
  // of 0, and a 7-day usage headline (3.2) smaller than today alone (11).
  const LAUNCH = {
    ...METRICS,
    concurrentNow: 10,
    dailyActive: 0,
    weeklyActive: 4,
    usageHours: { yesterday: 1.5, last7d: 3.2, last30d: 3.2, allTime: 14.2, todaySoFar: 11 },
    activeLast24h: 12,
    activeLast7d: 14,
  };
  const LAUNCH_HISTORY = { ...HISTORY, days: HISTORY.days.slice(1) };

  /** One tile's markup, from its opening tag to the next tile's (or the end of the tile grid). */
  function tileHtml(html: string, name: string): string {
    const start = html.indexOf(`<div class="eqbt-tile" data-tile="${name}"`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const next = html.indexOf('<div class="eqbt-tile" data-tile="', start + 1);
    return html.slice(start, next < 0 ? undefined : next);
  }

  it("the default and report tiles lead with the rolling actives and all-time usage, not the complete-day figures", () => {
    expect(DEFAULT_TILE_NAMES).toEqual(["concurrentNow", "peakConcurrent", "activeLast24h", "activeLast7d", "uniqueUsers30d", "usageHoursAllTime"]);
    for (const old of ["dailyActive", "weeklyActive", "usageHours"]) {
      expect(DEFAULT_TILE_NAMES as readonly string[], old).not.toContain(old);
      expect(REPORT_TILE_NAMES as readonly string[], old).not.toContain(old);
      // Still a tile: an embed that names it keeps getting it.
      expect(TILE_NAMES as readonly string[], old).toContain(old);
    }
    // Names are only ever appended: the list up to installsAllTime is the old one, in its old order.
    expect(TILE_NAMES.slice(0, 7)).toEqual(["concurrentNow", "peakConcurrent", "dailyActive", "weeklyActive", "uniqueUsers30d", "usageHours", "installsAllTime"]);
  });

  it("the usage headline is all time, and the sub-line is today, 7 full days and 30 full days", () => {
    const api = load() as Api & { USAGE_WINDOW_ALL: string };
    const html = api.render(LAUNCH, LAUNCH_HISTORY, { tiles: "usageHoursAllTime", charts: "none" });
    expect(tileState(html, "usageHoursAllTime")).toBe("ready");
    expect(html).toContain('<div class="eqbt-tile-label">Usage hours (all time)</div>');
    expect(html).toContain('<div class="eqbt-tile-value">14.2</div>');
    expect(html).not.toContain('<div class="eqbt-tile-value">3.2</div>');
    expect(html).toContain('<div class="eqbt-tile-sub">Today so far 11 h · last 7 full days 3.2 · last 30 full days 3.2</div>');
    expect(api.USAGE_WINDOW_ALL).toMatch(/All time and today so far include today/);
    expect(api.USAGE_WINDOW_ALL).toMatch(/Full days are complete UTC days, so today is not in them/);
    expect(html).toContain("estimated, opted-in installs only, 10-minute resolution. " + api.USAGE_WINDOW_ALL);
    expect(html).toContain(METRICS.definitions.usageHours);
  });

  it("before the first complete UTC day the usage sub-line is today alone, never a 0 for a full day", () => {
    const early = { ...EMPTY_METRICS, usageHours: { ...EMPTY_METRICS.usageHours, allTime: 1.83, todaySoFar: 1.83 } };
    const html = load().render(early, EMPTY_HISTORY, { tiles: "usageHoursAllTime", charts: "none" });
    expect(tileState(html, "usageHoursAllTime")).toBe("ready");
    expect(html).toContain('<div class="eqbt-tile-sub">Today so far 1.8 h</div>');
    const zero = load().render(EMPTY_METRICS, EMPTY_HISTORY, { tiles: "usageHoursAllTime", charts: "none" });
    expect(tileState(zero, "usageHoursAllTime")).toBe("collecting");
    expect(zero).not.toContain("eqbt-tile-sub");
  });

  it("the rolling tiles show activeLast24h and activeLast7d, each labelled with its window and a one-line note", () => {
    const html = load().render(LAUNCH, LAUNCH_HISTORY, { tiles: "activeLast24h activeLast7d", charts: "none" });
    const day = tileHtml(html, "activeLast24h");
    expect(day).toContain('data-state="ready"');
    expect(day).toContain('<div class="eqbt-tile-label">Active, last 24 hours</div>');
    expect(day).toContain('<div class="eqbt-tile-value">12</div>');
    expect(day).toContain('<div class="eqbt-tile-note">Rolling: the 24 hours up to this update, today included.</div>');
    expect(day).toContain(METRICS.definitions.activeLast24h);
    const week = tileHtml(html, "activeLast7d");
    expect(week).toContain('<div class="eqbt-tile-label">Active, last 7 days</div>');
    expect(week).toContain('<div class="eqbt-tile-value">14</div>');
    expect(week).toContain('<div class="eqbt-tile-note">Rolling: the 7 days up to this update, today included.</div>');
    expect(week).toContain(METRICS.definitions.activeLast7d);
  });

  it("a rolling figure is shown before the first complete UTC day", () => {
    const html = load().render({ ...EMPTY_METRICS, activeLast24h: 10, activeLast7d: 10 }, EMPTY_HISTORY, { tiles: "activeLast24h activeLast7d", charts: "none" });
    expect(tileState(html, "activeLast24h")).toBe("ready");
    expect(tileState(html, "activeLast7d")).toBe("ready");
  });

  it("a snapshot published before the rolling fields falls back to the complete-day figure, under that figure's own label", () => {
    const { activeLast24h: _d, activeLast7d: _w, ...old } = LAUNCH;
    const html = load().render({ ...old, dailyActive: 3 }, LAUNCH_HISTORY, { tiles: "activeLast24h activeLast7d", charts: "none" });
    const day = tileHtml(html, "activeLast24h");
    expect(day).toContain('<div class="eqbt-tile-label">Active, last complete UTC day</div>');
    expect(day).toContain('<div class="eqbt-tile-value">3</div>');
    expect(day).toContain(METRICS.definitions.dailyActive);
    expect(day).not.toContain("Rolling");
    expect(day).not.toContain("Active, last 24 hours");
    const week = tileHtml(html, "activeLast7d");
    expect(week).toContain('<div class="eqbt-tile-label">Active, 7 complete UTC days</div>');
    expect(week).toContain('<div class="eqbt-tile-value">4</div>');
    expect(week).toContain(METRICS.definitions.weeklyActive);
  });

  it("the old tile keys keep their figures, now labelled with their complete-UTC-day window", () => {
    const html = load().render(LAUNCH, LAUNCH_HISTORY, { tiles: "dailyActive weeklyActive usageHours", charts: "none" });
    expect(tileHtml(html, "dailyActive")).toContain('<div class="eqbt-tile-label">Active, last complete UTC day</div>');
    expect(tileHtml(html, "weeklyActive")).toContain('<div class="eqbt-tile-label">Active, 7 complete UTC days</div>');
    expect(tileHtml(html, "weeklyActive")).toContain('<div class="eqbt-tile-value">4</div>');
    const usage = tileHtml(html, "usageHours");
    expect(usage).toContain('<div class="eqbt-tile-label">Usage hours, last 7 complete UTC days</div>');
    expect(usage).toContain('<div class="eqbt-tile-value">3.2</div>');
  });

  it("the actives chart still draws the per-day rollup fields, not the rolling ones", () => {
    const html = load().render(LAUNCH, HISTORY, { tiles: "none", charts: "actives" });
    expect(html).toContain("Oct 2: daily 41, weekly 96");
    expect(html).not.toContain("daily 12");
  });
});

describe("mounting into a container", () => {
  function fakeFetch(bodies: Record<string, unknown>, calls: string[]) {
    return (url: string) => {
      calls.push(url);
      const body = bodies[url];
      return Promise.resolve(
        body === undefined ? { ok: false, status: 404, json: () => Promise.reject(new Error("404")) } : { ok: true, status: 200, json: () => Promise.resolve(body) },
      );
    };
  }

  it("fetches the two JSON files from the base and honours the element's data attributes", async () => {
    const api = load();
    const el = new FakeElement({ "data-tiles": "dailyActive usageHours", "data-charts": "usageHours" });
    const calls: string[] = [];
    const base = "https://telemetry.example";
    const done = api.mount(el, {
      base: base + "/",
      fetch: fakeFetch({ [`${base}/metrics.json`]: METRICS, [`${base}/history.json`]: HISTORY }, calls),
    });
    expect(el.innerHTML).toContain('data-state="loading"');
    await done;
    expect(calls).toEqual([`${base}/metrics.json`, `${base}/history.json`]);
    expect(attrValues(el.innerHTML, "data-tile")).toEqual(["dailyActive", "usageHours"]);
    expect(attrValues(el.innerHTML, "data-chart")).toEqual(["usageHours"]);
    expect(el.getAttribute("data-eqbt-mounted")).toBe("");
  });

  it("options override the data attributes", async () => {
    const api = load();
    const el = new FakeElement({ "data-tiles": "dailyActive", "data-base": "https://a.example" });
    const calls: string[] = [];
    await api.mount(el, { tiles: ["weeklyActive"], charts: "none", base: "https://b.example", fetch: fakeFetch({}, calls) });
    expect(calls[0]).toBe("https://b.example/metrics.json");
    expect(attrValues(el.innerHTML, "data-tile")).toEqual(["weeklyActive"]);
    expect(attrValues(el.innerHTML, "data-chart")).toEqual([]);
  });

  it("a failed fetch leaves the collecting-data state and the opt-in label, not an error", async () => {
    const api = load();
    const el = new FakeElement({ "data-base": "https://down.example" });
    await api.mount(el, { fetch: () => Promise.reject(new Error("offline")) });
    expect(tileState(el.innerHTML, "activeLast24h")).toBe("collecting");
    expect(el.innerHTML).toContain("Opted-in installs only: a lower bound, not total users.");
  });

  it("auto-mounts every [data-eqbuddy-telemetry] element, defaulting the base to where the script came from", async () => {
    const el = new FakeElement({ "data-charts": "none" });
    const calls: string[] = [];
    const fetch = fakeFetch({}, calls);
    const selectors: string[] = [];
    const document = {
      readyState: "complete",
      currentScript: { src: "https://eqbuddy-telemetry.example.workers.dev/widget.js?v=1" },
      querySelectorAll: (sel: string) => {
        selectors.push(sel);
        return [el];
      },
      addEventListener: () => {},
    };
    load({ document, fetch });
    await new Promise((r) => setTimeout(r, 0));
    expect(selectors).toEqual(["[data-eqbuddy-telemetry]:not([data-eqbt-mounted])"]);
    expect(calls).toEqual([
      "https://eqbuddy-telemetry.example.workers.dev/metrics.json",
      "https://eqbuddy-telemetry.example.workers.dev/history.json",
    ]);
    expect(attrValues(el.innerHTML, "data-chart")).toEqual([]);
  });
});
