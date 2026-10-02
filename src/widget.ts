// The public report, as an embeddable widget (DRA-380).
//
// Three static assets the Worker serves as-is:
//   WIDGET_JS   GET /widget.js   dependency-free; fetches /metrics.json and
//                                /history.json and renders tiles and charts
//                                into any container element
//   WIDGET_CSS  GET /widget.css  every rule scoped under .eqbt; themed through
//                                --eqbt-* CSS variables
//   REPORT_HTML GET /report      a thin page that only uses the two above
//
// The widget reads nothing but those two public, id-free JSON files. It is
// kept as plain ES5 text (no template literals, no build step) so it runs in
// any browser exactly as written here, and so the landing page can lift it
// unchanged. test/widget/widget.test.ts runs it against a stub DOM.

/**
 * Every tile name, selectable with data-tiles or options.tiles; "all" is this list.
 * Names are only ever appended, and a name never changes what it shows: an embed
 * that names a tile keeps getting that figure.
 *
 * The rolling tiles (activeLast24h, activeLast7d) and the all-time usage tile
 * (usageHoursAllTime) were ADDED rather than repurposing dailyActive,
 * weeklyActive and usageHours, which still show the complete-UTC-day figures
 * they always did. The default and report lists switched to the new names,
 * because on launch day the old headlines left out the day they were read on.
 * The two peak tiles (peakDailyActive, peakWeeklyActive) are optional, like
 * installsAllTime: not defaults, but on /report.
 */
export const TILE_NAMES = [
  "concurrentNow", "peakConcurrent", "dailyActive", "weeklyActive", "uniqueUsers30d", "usageHours", "installsAllTime",
  "activeLast24h", "activeLast7d", "usageHoursAllTime", "peakDailyActive", "peakWeeklyActive",
] as const;
/** The tiles an embed with no data-tiles shows, in order. */
export const DEFAULT_TILE_NAMES = ["concurrentNow", "peakConcurrent", "activeLast24h", "activeLast7d", "uniqueUsers30d", "usageHoursAllTime"] as const;
/**
 * The tiles /report shows, in order: the defaults, each peak beside the rolling
 * figure it can never be below, and the all-time install count beside the 30-day one.
 */
export const REPORT_TILE_NAMES = [
  "concurrentNow", "peakConcurrent", "activeLast24h", "peakDailyActive", "activeLast7d", "peakWeeklyActive",
  "uniqueUsers30d", "installsAllTime", "usageHoursAllTime",
] as const;
/**
 * Every chart name, selectable with data-charts or options.charts; "all" is this
 * list. Appended only, like the tiles. "os" (DRA-784) is NOT a default: an embed
 * that never named its charts keeps the four it always drew, and /report names
 * all five.
 */
export const CHART_NAMES = ["actives", "concurrent", "usageHours", "versions", "os"] as const;
/** The charts an embed with no data-charts shows, in order. */
export const DEFAULT_CHART_NAMES = ["actives", "concurrent", "usageHours", "versions"] as const;
/** The charts /report shows, in order: the OS mix beside the version mix. */
export const REPORT_CHART_NAMES = ["actives", "concurrent", "usageHours", "versions", "os"] as const;

export const WIDGET_JS = String.raw`/* EQBuddy Evolved telemetry widget. Public, id-free aggregates only.
   Embed: see https://github.com/DranakCorps-bot/eqbuddy-telemetry#embedding-the-widget */
(function (root) {
  "use strict";

  var TILES = ["concurrentNow", "peakConcurrent", "dailyActive", "weeklyActive", "uniqueUsers30d", "usageHours", "installsAllTime",
    "activeLast24h", "activeLast7d", "usageHoursAllTime", "peakDailyActive", "peakWeeklyActive"];
  var DEFAULT_TILES = ["concurrentNow", "peakConcurrent", "activeLast24h", "activeLast7d", "uniqueUsers30d", "usageHoursAllTime"];
  var CHARTS = ["actives", "concurrent", "usageHours", "versions", "os"];
  var DEFAULT_CHARTS = ["actives", "concurrent", "usageHours", "versions"];
  var OPT_IN_LABEL = "Opted-in installs only: a lower bound, not total users.";
  var USAGE_LABEL = "estimated, opted-in installs only, 10-minute resolution";
  var USAGE_WINDOW = "7 days, yesterday and 30 days are complete UTC days, so today is not in them. Today so far and all time include today, up to about 20 minutes behind.";
  var USAGE_WINDOW_ALL = "All time and today so far include today, up to about 20 minutes behind. Full days are complete UTC days, so today is not in them.";
  var COLLECTING = "collecting data";
  /** The limit of the OS mix, said wherever it is drawn (DRA-784 plan section 2). */
  var OS_CAVEAT = "Wine is counted only where the app reports it: Wine that hides itself, and any install whose app does not report Wine, counts as Windows.";
  var OS_LABELS = {
    windows: "Windows",
    "macos-wine": "macOS (Wine)",
    "linux-wine": "Linux (Wine)",
    "wine-other": "Wine, other host",
    other: "Other"
  };
  var BUCKET_MS = 600000;
  var DAY_MS = 86400000;
  var W = 1000;
  var H = 240;

  var TILE_LABELS = {
    concurrentNow: "Concurrent now",
    peakConcurrent: "Peak concurrent",
    dailyActive: "Active, last complete UTC day",
    weeklyActive: "Active, 7 complete UTC days",
    uniqueUsers30d: "Unique installs, 30 days",
    usageHours: "Usage hours, last 7 complete UTC days",
    installsAllTime: "Total installs (all time)",
    activeLast24h: "Active, last 24 hours",
    activeLast7d: "Active, last 7 days",
    usageHoursAllTime: "Usage hours (all time)",
    peakDailyActive: "Peak daily users",
    peakWeeklyActive: "Peak weekly active"
  };
  var TILE_NOTES = {
    activeLast24h: "Rolling: the 24 hours up to the last hourly count, today included.",
    activeLast7d: "Rolling: the 7 days up to the last hourly count, today included.",
    peakDailyActive: "The busiest single UTC day since launch, today so far included (counted hourly).",
    peakWeeklyActive: "The busiest 7 days since launch, the last 7 days included (counted hourly)."
  };
  /**
   * A rolling tile over a snapshot published before its field existed shows the
   * complete-UTC-day figure instead, under THAT figure's own label and
   * definition, so it never claims a window it does not show.
   */
  var ROLLING_FALLBACK = { activeLast24h: "dailyActive", activeLast7d: "weeklyActive" };
  var CHART_TITLES = {
    actives: "Daily and weekly active installs",
    concurrent: "Concurrent installs per 10 minutes, last 7 days",
    usageHours: "Usage hours per day",
    versions: "Version mix, last 7 days",
    os: "Users by OS, last 7 days"
  };

  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * undefined -> the defaults (every name when none are given); "all" -> every
   * name; "none" or "" -> none; else the known names given, in the order given.
   */
  function select(value, all, defaults) {
    if (value === undefined || value === null) return (defaults || all).slice();
    var list = typeof value === "string" ? value.split(/[\s,]+/) : value;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = String(list[i]).trim();
      if (n === "all") return all.slice();
      if (all.indexOf(n) >= 0 && out.indexOf(n) < 0) out.push(n);
    }
    return out;
  }

  function num(n) {
    return Number(n).toLocaleString("en-US");
  }

  function hours(h) {
    return Number(h).toLocaleString("en-US", { maximumFractionDigits: h >= 100 ? 0 : 1 });
  }

  var chicagoFmt = null;
  /** A bucket or timestamp in America/Chicago, e.g. "Sep 28, 9:10 PM CDT". */
  function chicago(isoStr) {
    try {
      if (!chicagoFmt) {
        chicagoFmt = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Chicago", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit", timeZoneName: "short"
        });
      }
      // Newer ICU puts a narrow no-break space before AM/PM; print a plain one everywhere.
      return chicagoFmt.format(new Date(isoStr)).replace(/[  ]/g, " ");
    } catch (e) {
      return String(isoStr);
    }
  }

  function shortDay(day) {
    try {
      return new Date(day + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
    } catch (e) {
      return String(day);
    }
  }

  function daysOf(h) {
    return h && h.days && h.days.length ? h.days : [];
  }

  function collectingBox(loading) {
    return '<div class="eqbt-empty" data-state="' + (loading ? "loading" : "collecting") + '">' +
      (loading ? "loading" : COLLECTING) + "</div>";
  }

  // ---- tiles ----

  function tile(name, m, h, loading) {
    var defs = (m && m.definitions) || {};
    var value = null;
    var sub = "";
    var today = "";
    var extraNote = "";
    var fmt = num;
    // The label and the definition shown: the tile's own, unless a rolling tile fell back.
    var label = TILE_LABELS[name];
    var defKey = name;
    if (ROLLING_FALLBACK[name]) {
      if (m && typeof m[name] === "number") {
        value = m[name];
        extraNote = TILE_NOTES[name];
        if (m.activeAsOf) sub = "Counted " + chicago(m.activeAsOf);
      } else if (m) {
        defKey = ROLLING_FALLBACK[name];
        label = TILE_LABELS[defKey];
        value = m[defKey];
      }
    } else if (name === "usageHoursAllTime") {
      if (m && m.usageHours) {
        var ua = m.usageHours;
        value = ua.allTime;
        fmt = hours;
        var parts = [];
        // A snapshot written before todaySoFar existed simply has no today figure.
        if (typeof ua.todaySoFar === "number") parts.push("Today so far " + hours(ua.todaySoFar) + " h");
        // Before the first complete UTC day the full-day figures are not measured yet, so they are left out rather than shown as 0.
        if (daysOf(h).length > 0 || ua.last30d > 0) parts.push("last 7 full days " + hours(ua.last7d) + " · last 30 full days " + hours(ua.last30d));
        sub = parts.join(" · ");
      }
      extraNote = USAGE_LABEL + ". " + USAGE_WINDOW_ALL;
      defKey = "usageHours";
    } else if (m) {
      if (name === "concurrentNow") value = m.concurrentNow;
      else if (name === "peakConcurrent") {
        value = m.peakConcurrent;
        if (m.peakConcurrentBucket) sub = "10 minutes from " + chicago(m.peakConcurrentBucket);
      } else if (name === "dailyActive") value = m.dailyActive;
      else if (name === "weeklyActive") value = m.weeklyActive;
      else if (name === "uniqueUsers30d") value = m.uniqueUsers30d;
      // A snapshot written before installsAllTime existed has no figure, so it reads "collecting data".
      else if (name === "installsAllTime") value = m.installsAllTime;
      // Likewise the peaks: an older snapshot has no figure and reads "collecting data".
      else if (name === "peakDailyActive" || name === "peakWeeklyActive") {
        value = m[name];
        if (typeof value === "number") extraNote = TILE_NOTES[name];
      } else if (name === "usageHours" && m.usageHours) {
        var u = m.usageHours;
        value = u.last7d;
        fmt = hours;
        // A snapshot written before todaySoFar existed simply has no today figure.
        if (typeof u.todaySoFar === "number") today = "Today so far " + hours(u.todaySoFar) + " h";
        sub = "Yesterday " + hours(u.yesterday) + " · 30 days " + hours(u.last30d) + " · all time " + hours(u.allTime);
      }
    }
    if (name === "usageHours") extraNote = USAGE_LABEL + ". " + USAGE_WINDOW;
    // Before the first complete UTC day, a zero is "not measured yet", not 0.
    var collecting = typeof value !== "number" || (value === 0 && daysOf(h).length === 0);
    // Today is measured before any day completes, so a non-zero today shows even while the headline is collecting.
    if (today) sub = !collecting ? today + " · " + sub : m.usageHours.todaySoFar > 0 ? today : "";
    var state = loading ? "loading" : collecting ? "collecting" : "ready";
    var shown = loading ? '<span class="eqbt-collecting">loading</span>'
      : collecting ? '<span class="eqbt-collecting">' + COLLECTING + "</span>" : esc(fmt(value));
    return '<div class="eqbt-tile" data-tile="' + name + '" data-state="' + state + '">' +
      '<div class="eqbt-tile-label">' + esc(label) + "</div>" +
      '<div class="eqbt-tile-value">' + shown + "</div>" +
      (sub && (!collecting || today) ? '<div class="eqbt-tile-sub">' + esc(sub) + "</div>" : "") +
      (extraNote ? '<div class="eqbt-tile-note">' + esc(extraNote) + "</div>" : "") +
      (defs[defKey] ? '<p class="eqbt-def">' + esc(defs[defKey]) + "</p>" : "") +
      "</div>";
  }

  // ---- chart primitives: shapes in SVG, every word in HTML so it stays readable on a phone ----

  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v) return steps[i] * p;
    return 10 * p;
  }

  function y(v, max) {
    return (H - (v / max) * H).toFixed(1);
  }

  function linePoints(values, max) {
    var n = values.length;
    var pts = [];
    for (var i = 0; i < n; i++) {
      var x = n === 1 ? W / 2 : (i / (n - 1)) * W;
      pts.push(x.toFixed(1) + "," + y(values[i], max));
    }
    return pts.join(" ");
  }

  function plot(mode, marks, max, tips, label, fmt) {
    return '<div class="eqbt-plot" data-mode="' + mode + '" data-tips="' + esc(JSON.stringify(tips)) + '">' +
      '<svg class="eqbt-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '">' +
      '<line class="eqbt-grid" x1="0" y1="' + H / 2 + '" x2="' + W + '" y2="' + H / 2 + '" vector-effect="non-scaling-stroke"/>' +
      '<line class="eqbt-grid" x1="0" y1="' + H + '" x2="' + W + '" y2="' + H + '" vector-effect="non-scaling-stroke"/>' +
      marks + "</svg>" +
      '<span class="eqbt-ymax">' + esc(fmt(max)) + "</span>" +
      '<span class="eqbt-ymid">' + esc(fmt(max / 2)) + "</span>" +
      '<div class="eqbt-cross" hidden></div><div class="eqbt-tip" hidden></div>' +
      "</div>";
  }

  function line(values, max, cls) {
    return '<polyline class="eqbt-line ' + cls + '" points="' + linePoints(values, max) + '" vector-effect="non-scaling-stroke"/>';
  }

  function bars(values, max) {
    var n = values.length;
    var w = W / n;
    var gap = Math.min(w * 0.2, 8);
    var out = "";
    for (var i = 0; i < n; i++) {
      var top = Number(y(values[i], max));
      out += '<rect class="eqbt-bar" x="' + (i * w + gap / 2).toFixed(1) + '" y="' + top.toFixed(1) +
        '" width="' + (w - gap).toFixed(1) + '" height="' + (H - top).toFixed(1) + '"/>';
    }
    return out;
  }

  function xaxis(first, last) {
    return '<div class="eqbt-xaxis"><span>' + esc(first) + "</span><span>" + esc(last) + "</span></div>";
  }

  function table(head, rows) {
    var html = '<details class="eqbt-table"><summary>Table</summary><table><thead><tr>';
    for (var i = 0; i < head.length; i++) html += '<th scope="col">' + esc(head[i]) + "</th>";
    html += "</tr></thead><tbody>";
    for (var r = rows.length - 1; r >= 0; r--) {
      html += "<tr>";
      for (var c = 0; c < rows[r].length; c++) html += "<td>" + esc(rows[r][c]) + "</td>";
      html += "</tr>";
    }
    return html + "</tbody></table></details>";
  }

  /** One labelled share bar, as the version and OS mixes draw them. */
  function shareRow(label, count, share) {
    var pct = Math.round(share * 1000) / 10;
    return '<div class="eqbt-vrow" role="listitem"><span class="eqbt-vlabel">' + esc(label) + "</span>" +
      '<svg class="eqbt-vbar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">' +
      '<rect class="eqbt-vtrack" x="0" y="0" width="100" height="10"/>' +
      '<rect class="eqbt-bar" x="0" y="0" width="' + Math.max(0, Math.min(100, pct)) + '" height="10"/></svg>' +
      '<span class="eqbt-vval">' + esc(pct + "% (" + num(count) + ")") + "</span></div>";
  }

  // ---- charts ----

  function chart(name, m, h, loading) {
    var days = daysOf(h);
    var body = "";
    var legend = "";
    var note = name === "usageHours" ? USAGE_LABEL : "Opted-in installs only.";
    var ready = false;

    if (loading) {
      body = collectingBox(true);
    } else if (name === "actives") {
      if (days.length >= 2) {
        var d = [], wk = [], tips = [], rows = [];
        for (var i = 0; i < days.length; i++) {
          d.push(days[i].dailyActive);
          wk.push(days[i].weeklyActive);
          tips.push(shortDay(days[i].day) + ": daily " + num(days[i].dailyActive) + ", weekly " + num(days[i].weeklyActive));
          rows.push([days[i].day, num(days[i].dailyActive), num(days[i].weeklyActive)]);
        }
        var maxA = niceMax(Math.max.apply(null, wk.concat(d)));
        legend = '<div class="eqbt-legend"><span class="eqbt-key eqbt-key-s1">Daily active</span><span class="eqbt-key eqbt-key-s2">Weekly active</span></div>';
        body = plot("line", line(wk, maxA, "eqbt-s2") + line(d, maxA, "eqbt-s1"), maxA, tips, CHART_TITLES.actives, num) +
          xaxis(shortDay(days[0].day), shortDay(days[days.length - 1].day)) +
          table(["UTC day", "Daily active", "Weekly active"], rows);
        note = "Opted-in installs only. One point per complete UTC day.";
        ready = true;
      }
    } else if (name === "concurrent") {
      var buckets = h && h.concurrent10m && h.concurrent10m.length ? h.concurrent10m : [];
      var gen = h && h.generatedAt ? Date.parse(h.generatedAt) : NaN;
      if (buckets.length && !isNaN(gen)) {
        // Windows with no entry held nobody: fill them with 0 across the whole week.
        var start = Math.floor((gen - 7 * DAY_MS) / BUCKET_MS) * BUCKET_MS;
        var end = Math.floor(gen / BUCKET_MS) * BUCKET_MS - BUCKET_MS;
        var byTime = {};
        for (var b = 0; b < buckets.length; b++) byTime[Date.parse(buckets[b].bucket)] = buckets[b].count;
        var vals = [], ctips = [], peak = 0;
        for (var t = start; t <= end; t += BUCKET_MS) {
          var v = byTime[t] || 0;
          vals.push(v);
          if (v > peak) peak = v;
          ctips.push(chicago(new Date(t).toISOString()) + ": " + num(v));
        }
        var maxC = niceMax(peak);
        body = plot("line", '<polygon class="eqbt-area" points="0,' + H + " " + linePoints(vals, maxC) + " " + W + "," + H + '"/>' +
          line(vals, maxC, "eqbt-s1"), maxC, ctips, CHART_TITLES.concurrent, num) +
          xaxis(chicago(new Date(start).toISOString()), chicago(new Date(end).toISOString()));
        note = "Opted-in installs only. Times in America/Chicago.";
        ready = true;
      }
    } else if (name === "usageHours") {
      if (days.length >= 1) {
        var hv = [], htips = [], hrows = [];
        for (var k = 0; k < days.length; k++) {
          hv.push(days[k].usageHours);
          htips.push(shortDay(days[k].day) + ": " + hours(days[k].usageHours) + " h");
          hrows.push([days[k].day, hours(days[k].usageHours)]);
        }
        var maxH = niceMax(Math.max.apply(null, hv));
        body = plot("bar", bars(hv, maxH), maxH, htips, CHART_TITLES.usageHours, hours) +
          xaxis(shortDay(days[0].day), shortDay(days[days.length - 1].day)) +
          table(["UTC day", "Usage hours"], hrows);
        ready = true;
      }
    } else if (name === "versions") {
      var mix = m && m.versionMix7d;
      if (mix && mix.denominator > 0 && mix.versions && mix.versions.length) {
        var shown = mix.versions.slice(0, 6);
        var rest = mix.versions.slice(6);
        if (rest.length) {
          var other = { appVersion: "Other", count: 0, share: 0 };
          for (var o = 0; o < rest.length; o++) { other.count += rest[o].count; other.share += rest[o].share; }
          shown.push(other);
        }
        body = '<div class="eqbt-versions" role="list">';
        for (var s = 0; s < shown.length; s++) body += shareRow(shown[s].appVersion, shown[s].count, shown[s].share);
        body += "</div>";
        note = "Opted-in installs only. Of " + num(mix.denominator) + " installs seen in the 7 days to the last complete UTC day, each on its latest version.";
        ready = true;
      }
    } else if (name === "os") {
      // A snapshot from before osMix7d existed, or before its first day completes, has none: collecting.
      var om = m && m.osMix7d;
      if (om && om.denominator > 0 && om.families && om.families.length) {
        body = '<div class="eqbt-versions" role="list">';
        for (var f = 0; f < om.families.length; f++) {
          var fam = om.families[f];
          body += shareRow(OS_LABELS.hasOwnProperty(fam.family) ? OS_LABELS[fam.family] : fam.family, fam.count, fam.share);
        }
        body += "</div>";
        note = "Opted-in installs only. Of " + num(om.denominator) + " installs seen in the 7 days to the last complete UTC day, each on the OS it reported last" +
          (om.since ? ", counted from " + shortDay(om.since) + " on" : "") + ". " + OS_CAVEAT;
        ready = true;
      } else {
        note = "Opted-in installs only. " + OS_CAVEAT;
      }
    }
    if (!body) body = collectingBox(false);
    return '<figure class="eqbt-chart" data-chart="' + name + '" data-state="' + (loading ? "loading" : ready ? "ready" : "collecting") + '">' +
      '<figcaption class="eqbt-chart-title">' + esc(CHART_TITLES[name]) + "</figcaption>" +
      legend + body + '<p class="eqbt-note">' + esc(note) + "</p></figure>";
  }

  /**
   * The whole widget as an HTML string. m and h are the parsed metrics.json and
   * history.json, or null when missing. The opt-in label is always rendered,
   * whatever is selected.
   */
  function render(m, h, options, loading) {
    options = options || {};
    var tiles = select(options.tiles, TILES, DEFAULT_TILES);
    var charts = select(options.charts, CHARTS, DEFAULT_CHARTS);
    var html = '<div class="eqbt" data-eqbt-version="1"><p class="eqbt-optin">' + esc(OPT_IN_LABEL) + "</p>";
    if (tiles.length) {
      html += '<div class="eqbt-tiles">';
      for (var i = 0; i < tiles.length; i++) html += tile(tiles[i], m, h, loading);
      html += "</div>";
    }
    if (charts.length) {
      html += '<div class="eqbt-charts">';
      for (var j = 0; j < charts.length; j++) html += chart(charts[j], m, h, loading);
      html += "</div>";
    }
    var foot = loading ? "Loading figures."
      : m && m.generatedAt ? "Updated " + chicago(m.generatedAt) + ". Refreshed every 10 minutes; daily figures cover complete UTC days."
      : "Figures are unavailable right now.";
    return html + '<p class="eqbt-foot">' + esc(foot) + "</p></div>";
  }

  // ---- hover: a crosshair and a tooltip per plot ----

  function wire(el) {
    var plots = el.querySelectorAll ? el.querySelectorAll(".eqbt-plot") : [];
    for (var i = 0; i < plots.length; i++) (function (p) {
      var tips;
      try { tips = JSON.parse(p.getAttribute("data-tips") || "[]"); } catch (e) { tips = []; }
      var bar = p.getAttribute("data-mode") === "bar";
      var tip = p.querySelector(".eqbt-tip");
      var cross = p.querySelector(".eqbt-cross");
      if (!tips.length || !tip || !cross) return;
      p.addEventListener("pointermove", function (ev) {
        var r = p.getBoundingClientRect();
        if (!r.width) return;
        var f = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
        var n = tips.length;
        var idx = bar ? Math.min(n - 1, Math.floor(f * n)) : Math.round(f * (n - 1));
        var x = bar ? (idx + 0.5) / n : n === 1 ? 0.5 : idx / (n - 1);
        tip.textContent = tips[idx];
        tip.className = "eqbt-tip" + (x > 0.66 ? " eqbt-tip-r" : x < 0.34 ? " eqbt-tip-l" : "");
        tip.style.left = cross.style.left = (x * 100).toFixed(2) + "%";
        tip.hidden = cross.hidden = false;
      });
      p.addEventListener("pointerleave", function () {
        tip.hidden = cross.hidden = true;
      });
    })(plots[i]);
  }

  // ---- loading and mounting ----

  var doc = root.document;
  var script = doc && doc.currentScript;
  /** Where the JSON lives: wherever this script was loaded from, unless told otherwise. */
  var DEFAULT_BASE = script && script.src ? String(script.src).replace(/\/widget\.js(?:[?#].*)?$/, "") : "";
  var shared = {};

  function getJSON(fetchImpl, url) {
    return fetchImpl(url, { credentials: "omit" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(null, function () { return null; });
  }

  function load(base, fetchImpl) {
    return Promise.all([getJSON(fetchImpl, base + "/metrics.json"), getJSON(fetchImpl, base + "/history.json")]);
  }

  /**
   * Renders into el. options (each overrides the element's data-* attribute):
   *   tiles   names, "all" or "none"      (data-tiles)
   *   charts  names, "all" or "none"      (data-charts)
   *   base    origin serving the JSON     (data-base)
   *   fetch   a fetch implementation, for tests
   */
  function mount(el, opts) {
    opts = opts || {};
    var attr = function (n) { return el.getAttribute ? el.getAttribute(n) : null; };
    var base = String(opts.base != null ? opts.base : attr("data-base") || DEFAULT_BASE).replace(/\/+$/, "");
    var options = {
      tiles: opts.tiles !== undefined ? opts.tiles : attr("data-tiles") !== null ? attr("data-tiles") : undefined,
      charts: opts.charts !== undefined ? opts.charts : attr("data-charts") !== null ? attr("data-charts") : undefined
    };
    if (el.setAttribute) el.setAttribute("data-eqbt-mounted", "");
    el.innerHTML = render(null, null, options, true);
    var data;
    if (opts.fetch) data = load(base, opts.fetch);
    else data = shared[base] || (shared[base] = load(base, root.fetch.bind(root)));
    return data.then(function (res) {
      el.innerHTML = render(res[0], res[1], options, false);
      wire(el);
      return el;
    });
  }

  function mountAll() {
    var els = doc.querySelectorAll("[data-eqbuddy-telemetry]:not([data-eqbt-mounted])");
    for (var i = 0; i < els.length; i++) mount(els[i]);
  }

  root.EQBuddyTelemetry = {
    version: 1,
    TILES: TILES.slice(),
    DEFAULT_TILES: DEFAULT_TILES.slice(),
    CHARTS: CHARTS.slice(),
    DEFAULT_CHARTS: DEFAULT_CHARTS.slice(),
    OS_CAVEAT: OS_CAVEAT,
    OPT_IN_LABEL: OPT_IN_LABEL,
    USAGE_LABEL: USAGE_LABEL,
    USAGE_WINDOW: USAGE_WINDOW,
    USAGE_WINDOW_ALL: USAGE_WINDOW_ALL,
    select: select,
    render: render,
    mount: mount,
    mountAll: mountAll
  };

  if (doc && doc.querySelectorAll) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mountAll);
    else mountAll();
  }
})(typeof window !== "undefined" ? window : this);
`;

export const WIDGET_CSS = String.raw`/* EQBuddy Evolved telemetry widget. Every rule is scoped under .eqbt.
   Theme it by setting any --eqbt-* variable on the container or an ancestor. */
.eqbt {
  --eqbt-d-bg: #fcfcfb;
  --eqbt-d-surface: #f4f3f0;
  --eqbt-d-fg: #0b0b0b;
  --eqbt-d-muted: #52514e;
  --eqbt-d-border: #dcdbd6;
  --eqbt-d-s1: #2a78d6;
  --eqbt-d-s2: #eb6834;
  color-scheme: light;
  background: var(--eqbt-bg, var(--eqbt-d-bg));
  color: var(--eqbt-fg, var(--eqbt-d-fg));
  font-family: var(--eqbt-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  font-size: var(--eqbt-font-size, 16px);
  line-height: 1.4;
  padding: var(--eqbt-pad, 16px);
  border-radius: var(--eqbt-radius, 12px);
  box-sizing: border-box;
  max-width: 100%;
}
@media (prefers-color-scheme: dark) {
  .eqbt {
    color-scheme: dark;
    --eqbt-d-bg: #1a1a19;
    --eqbt-d-surface: #242422;
    --eqbt-d-fg: #ffffff;
    --eqbt-d-muted: #c3c2b7;
    --eqbt-d-border: #3b3b38;
    --eqbt-d-s1: #3987e5;
    --eqbt-d-s2: #d95926;
  }
}
.eqbt *, .eqbt *::before, .eqbt *::after { box-sizing: border-box; }
.eqbt [hidden] { display: none !important; }
.eqbt-optin { margin: 0 0 12px; font-size: 0.875em; font-weight: 600; color: var(--eqbt-muted, var(--eqbt-d-muted)); }
.eqbt-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr));
  gap: var(--eqbt-gap, 12px);
}
.eqbt-tile, .eqbt-chart {
  background: var(--eqbt-surface, var(--eqbt-d-surface));
  border: 1px solid var(--eqbt-border, var(--eqbt-d-border));
  border-radius: var(--eqbt-radius, 12px);
  padding: 12px;
  min-width: 0;
}
.eqbt-tile-label { font-size: 0.8125em; font-weight: 600; color: var(--eqbt-muted, var(--eqbt-d-muted)); }
.eqbt-tile-value { font-size: 1.75em; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: 2px; }
.eqbt-collecting { font-size: 0.55em; font-weight: 600; font-style: italic; color: var(--eqbt-muted, var(--eqbt-d-muted)); }
.eqbt-tile-sub { font-size: 0.8125em; margin-top: 2px; font-variant-numeric: tabular-nums; }
.eqbt-tile-note { font-size: 0.75em; margin-top: 4px; font-weight: 600; color: var(--eqbt-muted, var(--eqbt-d-muted)); }
.eqbt-def { margin: 6px 0 0; font-size: 0.75em; color: var(--eqbt-muted, var(--eqbt-d-muted)); }
.eqbt-charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: var(--eqbt-gap, 12px);
  margin-top: var(--eqbt-gap, 12px);
}
.eqbt-chart { margin: 0; }
.eqbt-chart-title { font-weight: 600; font-size: 0.9375em; }
.eqbt-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 0.8125em; }
.eqbt-key::before { content: ""; display: inline-block; width: 12px; height: 3px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.eqbt-key-s1::before { background: var(--eqbt-accent, var(--eqbt-d-s1)); }
.eqbt-key-s2::before { background: var(--eqbt-accent-2, var(--eqbt-d-s2)); }
/* The y labels sit in a left gutter outside the plot box, so they never cover the first bar or point. */
.eqbt-plot { position: relative; height: var(--eqbt-chart-height, 160px); margin: 20px 0 0 44px; touch-action: pan-y; }
.eqbt-svg { display: block; width: 100%; height: 100%; overflow: visible; }
.eqbt-grid { stroke: var(--eqbt-border, var(--eqbt-d-border)); stroke-width: 1; }
.eqbt-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.eqbt-s1 { stroke: var(--eqbt-accent, var(--eqbt-d-s1)); }
.eqbt-s2 { stroke: var(--eqbt-accent-2, var(--eqbt-d-s2)); }
.eqbt-area { fill: var(--eqbt-accent, var(--eqbt-d-s1)); opacity: 0.16; }
.eqbt-bar { fill: var(--eqbt-accent, var(--eqbt-d-s1)); }
.eqbt-vtrack { fill: var(--eqbt-border, var(--eqbt-d-border)); }
.eqbt-ymax, .eqbt-ymid {
  position: absolute; right: 100%; padding-right: 6px; transform: translateY(-50%); white-space: nowrap;
  font-size: 0.75em; color: var(--eqbt-muted, var(--eqbt-d-muted)); font-variant-numeric: tabular-nums;
}
.eqbt-ymax { top: 0; }
.eqbt-ymid { top: 50%; }
.eqbt-xaxis { display: flex; justify-content: space-between; gap: 8px; margin: 4px 0 0 44px;font-size: 0.75em; color: var(--eqbt-muted, var(--eqbt-d-muted)); }
.eqbt-cross { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--eqbt-muted, var(--eqbt-d-muted)); pointer-events: none; }
.eqbt-tip {
  position: absolute; top: -4px; transform: translate(-50%, -100%);
  padding: 4px 8px; border-radius: 6px; white-space: nowrap; pointer-events: none;
  font-size: 0.75em; background: var(--eqbt-fg, var(--eqbt-d-fg)); color: var(--eqbt-bg, var(--eqbt-d-bg));
}
.eqbt-tip-l { transform: translate(0, -100%); }
.eqbt-tip-r { transform: translate(-100%, -100%); }
.eqbt-empty {
  display: flex; align-items: center; justify-content: center; margin-top: 8px;
  height: var(--eqbt-chart-height, 160px); border: 1px dashed var(--eqbt-border, var(--eqbt-d-border));
  border-radius: 8px; font-style: italic; color: var(--eqbt-muted, var(--eqbt-d-muted));
}
.eqbt-versions { margin-top: 8px; display: grid; gap: 6px; }
.eqbt-vrow { display: grid; grid-template-columns: minmax(3.5em, auto) 1fr auto; gap: 8px; align-items: center; font-size: 0.8125em; font-variant-numeric: tabular-nums; }
.eqbt-vbar { display: block; width: 100%; height: 10px; }
.eqbt-note { margin: 8px 0 0; font-size: 0.75em; font-weight: 600; color: var(--eqbt-muted, var(--eqbt-d-muted)); }
.eqbt-table { margin-top: 8px; font-size: 0.75em; }
.eqbt-table summary { cursor: pointer; color: var(--eqbt-muted, var(--eqbt-d-muted)); }
.eqbt-table table { border-collapse: collapse; width: 100%; margin-top: 4px; font-variant-numeric: tabular-nums; }
.eqbt-table th, .eqbt-table td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--eqbt-border, var(--eqbt-d-border)); }
.eqbt-foot { margin: 12px 0 0; font-size: 0.75em; color: var(--eqbt-muted, var(--eqbt-d-muted)); }
`;

/** /report: a thin page. Everything it shows comes from the widget. */
export const REPORT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EQBuddy Evolved telemetry report</title>
<meta name="description" content="Public, opt-in usage counts for EQBuddy Evolved.">
<link rel="stylesheet" href="/widget.css">
<style>
  body { margin: 0; background: #fcfcfb; color: #0b0b0b; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: #1a1a19; color: #ffffff; } a { color: #86b6ef; } }
  main { max-width: 1100px; margin: 0 auto; padding: 16px 8px 32px; }
  h1 { font-size: 1.375rem; margin: 8px 8px 4px; }
  .intro { margin: 0 8px 8px; font-size: 0.9375rem; line-height: 1.5; }
</style>
</head>
<body>
<main>
<h1>EQBuddy Evolved telemetry</h1>
<p class="intro">Public counts from EQBuddy Evolved's opt-in heartbeat. Telemetry is off unless a player turns it on, so every figure is a lower bound.
Raw figures: <a href="/metrics.json">metrics.json</a> and <a href="/history.json">history.json</a>.
<a href="https://github.com/DranakCorps-bot/eqbuddy-telemetry">What is collected and how it is counted</a>.</p>
<div data-eqbuddy-telemetry data-tiles="${REPORT_TILE_NAMES.join(" ")}" data-charts="${REPORT_CHART_NAMES.join(" ")}"></div>
<noscript><p class="intro">The report draws its tiles and charts with JavaScript. The same figures are in metrics.json and history.json above.</p></noscript>
</main>
<script src="/widget.js"></script>
</body>
</html>
`;
