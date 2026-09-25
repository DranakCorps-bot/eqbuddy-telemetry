// EQBuddy Evolved opt-in telemetry backend.
//
// Contract: EQBuddy docs/v2/telemetry.md §2–§6. Two POST routes, the public
// GET routes (metrics, history and the report widget, DRA-380) and a cron.
//
// What this file deliberately never does: read a request's address (no
// client-address header, no header of any kind, no per-request edge
// metadata), log anything, or store anything other than a validated
// three-field payload. A refused body is dropped on the floor.
// test/static/guards.test.ts holds all of that, by name.

import { parseDelete, parseHeartbeat, MAX_BODY_BYTES } from "./validate";
import {
  computeHistory,
  computeMetrics,
  deleteInstall,
  readHistorySnapshot,
  readMetricsSnapshot,
  recordHeartbeat,
  runScheduled,
} from "./store";
import { REPORT_HTML, WIDGET_CSS, WIDGET_JS } from "./widget";

export interface Env {
  DB: D1Database;
}

const METRICS_CACHE_SECONDS = 600;

function empty(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers });
}

/**
 * Reads at most MAX_BODY_BYTES + 1 bytes so an oversized body is refused
 * without buffering it; the validator then refuses anything past the limit.
 */
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

async function heartbeat(request: Request, env: Env, nowMs: number): Promise<Response> {
  const text = await readBody(request);
  const hb = text === null ? null : parseHeartbeat(text);
  if (!hb) return empty(400);
  const outcome = await recordHeartbeat(env.DB, hb, nowMs);
  return empty(outcome === "recorded" ? 204 : 429);
}

async function deleteRoute(request: Request, env: Env): Promise<Response> {
  const text = await readBody(request);
  const installId = text === null ? null : parseDelete(text);
  if (!installId) return empty(400);
  await deleteInstall(env.DB, installId);
  return empty(204);
}

/** /report may load only its own widget and JSON: no CDN, font or third-party script. */
const REPORT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";

/**
 * Every public GET answers the same way: 200, cacheable for 10 minutes, and
 * CORS-open (Access-Control-Allow-Origin: *), because it is a read-only,
 * id-free aggregate or a static asset. The POST routes carry none of this.
 */
function publicGet(method: string, body: string, contentType: string, extra?: Record<string, string>): Response {
  return new Response(method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${METRICS_CACHE_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

const JSON_TYPE = "application/json; charset=utf-8";

async function metrics(env: Env, nowMs: number, method: string): Promise<Response> {
  // Before the first cron pass there is no snapshot; answer live figures
  // rather than a 404, without writing anything.
  const body = (await readMetricsSnapshot(env.DB)) ?? JSON.stringify(await computeMetrics(env.DB, nowMs));
  return publicGet(method, body, JSON_TYPE);
}

async function history(env: Env, nowMs: number, method: string): Promise<Response> {
  // Same rule as metrics.json: one snapshot read, or a live build (from the
  // aggregate tables only) before the first cron pass.
  const body = (await readHistorySnapshot(env.DB)) ?? JSON.stringify(await computeHistory(env.DB, nowMs));
  return publicGet(method, body, JSON_TYPE);
}

/** The public GET routes. Each answers GET and HEAD; anything else is 405. */
const GET_ROUTES: Record<string, (env: Env, nowMs: number, method: string) => Response | Promise<Response>> = {
  "/metrics.json": metrics,
  "/history.json": history,
  "/widget.js": (_env, _now, method) => publicGet(method, WIDGET_JS, "text/javascript; charset=utf-8"),
  "/widget.css": (_env, _now, method) => publicGet(method, WIDGET_CSS, "text/css; charset=utf-8"),
  "/report": (_env, _now, method) =>
    publicGet(method, REPORT_HTML, "text/html; charset=utf-8", { "Content-Security-Policy": REPORT_CSP }),
};

export async function handle(request: Request, env: Env, nowMs: number): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  switch (pathname) {
    case "/heartbeat":
      return method === "POST" ? heartbeat(request, env, nowMs) : empty(405, { Allow: "POST" });
    case "/delete":
      return method === "POST" ? deleteRoute(request, env) : empty(405, { Allow: "POST" });
  }
  const route = Object.prototype.hasOwnProperty.call(GET_ROUTES, pathname) ? GET_ROUTES[pathname] : undefined;
  if (!route) return empty(404);
  return method === "GET" || method === "HEAD" ? route(env, nowMs, method) : empty(405, { Allow: "GET, HEAD" });
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env, Date.now());
    } catch {
      // Deliberately silent: an error log line is a log line.
      return empty(500);
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduled(env.DB, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
