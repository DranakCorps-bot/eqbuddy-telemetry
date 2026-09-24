// EQBuddy Evolved opt-in telemetry backend.
//
// Contract: EQBuddy docs/v2/telemetry.md §2–§6. Three routes and a cron.
//
// What this file deliberately never does: read a request's address (no
// client-address header, no header of any kind, no per-request edge
// metadata), log anything, or store anything other than a validated
// three-field payload. A refused body is dropped on the floor.
// test/static/guards.test.ts holds all of that, by name.

import { parseDelete, parseHeartbeat, MAX_BODY_BYTES } from "./validate";
import { computeMetrics, deleteInstall, readMetricsSnapshot, recordHeartbeat, runScheduled } from "./store";

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

async function metrics(env: Env, nowMs: number, method: string): Promise<Response> {
  // Before the first cron pass there is no snapshot; answer live figures
  // rather than a 404, without writing anything.
  const body = (await readMetricsSnapshot(env.DB)) ?? JSON.stringify(await computeMetrics(env.DB, nowMs));
  return new Response(method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${METRICS_CACHE_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function handle(request: Request, env: Env, nowMs: number): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  switch (pathname) {
    case "/heartbeat":
      return method === "POST" ? heartbeat(request, env, nowMs) : empty(405, { Allow: "POST" });
    case "/delete":
      return method === "POST" ? deleteRoute(request, env) : empty(405, { Allow: "POST" });
    case "/metrics.json":
      return method === "GET" || method === "HEAD" ? metrics(env, nowMs, method) : empty(405, { Allow: "GET, HEAD" });
    default:
      return empty(404);
  }
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
