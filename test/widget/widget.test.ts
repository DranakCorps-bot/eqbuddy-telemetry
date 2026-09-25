// The widget exactly as /widget.js serves it, run in a fresh VM context with
// no DOM beyond what each test hands it. The worker tests prove the route
// serves this text; these prove what the text does.

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { CHART_NAMES, TILE_NAMES, WIDGET_CSS, WIDGET_JS } from "../../src/widget";

interface Api {
  version: number;
  TILES: string[];
  CHARTS: string[];
  OPT_IN_LABEL: string;
  USAGE_LABEL: string;
  select(value: unknown, all: string[]): string[];
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
  usageHours: { yesterday: 12.5, last7d: 80, last30d: 300.25, allTime: 1234.5 },
  definitions: { dailyActive: "Distinct opted-in installs that sent a heartbeat in the last complete UTC day." },
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
  usageHours: { yesterday: 0, last7d: 0, last30d: 0, allTime: 0 },
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
    expect(attrValues(html, "data-tile")).toEqual([...TILE_NAMES]);
    expect(attrValues(html, "data-chart")).toEqual([...CHART_NAMES]);
    expect(html).toContain("Opted-in installs only: a lower bound, not total users.");
    // The usage tile and the usage chart each carry the exact label.
    expect(html.split("estimated, opted-in installs only, 10-minute resolution")).toHaveLength(3);
    for (const name of TILE_NAMES) expect(tileState(html, name), name).toBe("ready");
    expect(attrValues(html, "data-state").filter((s) => s !== "ready")).toEqual([]);
  });

  it("shows the figures, the peak's time in America/Chicago, and the server's definitions", () => {
    const html = load().render(METRICS, HISTORY);
    expect(html).toContain(">41<");
    expect(html).toContain(">140<");
    expect(html).toContain("10 minutes from Sep 27, 9:10 PM CDT");
    expect(html).toContain(">80<"); // usage hours, last 7 days
    expect(html).toContain("Yesterday 12.5 · 30 days 300 · all time 1,235");
    expect(html).toContain(METRICS.definitions.dailyActive);
    expect(html).toContain("83.3% (80)");
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
    for (const name of TILE_NAMES) expect(tileState(html, name), name).toBe("collecting");
    for (const name of CHART_NAMES) expect(html, name).toContain(`data-chart="${name}" data-state="collecting"`);
    expect(html).toContain("collecting data");
    expect(html).not.toMatch(/eqbt-tile-value">0</);
    expect(html).toContain("Opted-in installs only: a lower bound, not total users.");
  });

  it("a non-zero figure before the first complete day is shown as it is", () => {
    const html = load().render({ ...EMPTY_METRICS, concurrentNow: 3 }, EMPTY_HISTORY);
    expect(tileState(html, "concurrentNow")).toBe("ready");
    expect(tileState(html, "dailyActive")).toBe("collecting");
  });

  it("one day is too thin for a trend line, but enough for a day's bar", () => {
    const html = load().render(METRICS, { ...HISTORY, days: HISTORY.days.slice(1) });
    expect(html).toContain('data-chart="actives" data-state="collecting"');
    expect(html).toContain('data-chart="usageHours" data-state="ready"');
  });

  it("a zero after the first complete day is a real zero", () => {
    const html = load().render({ ...METRICS, concurrentNow: 0 }, HISTORY);
    expect(tileState(html, "concurrentNow")).toBe("ready");
  });

  it("with no data at all (a failed fetch) everything reads 'collecting data'", () => {
    const html = load().render(null, null);
    for (const name of TILE_NAMES) expect(tileState(html, name), name).toBe("collecting");
    expect(html).toContain("Figures are unavailable right now.");
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
    expect(tileState(el.innerHTML, "dailyActive")).toBe("collecting");
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
