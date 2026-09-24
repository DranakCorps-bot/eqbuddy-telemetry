// Guards over the repo's own files. These run in Node, not workerd, because
// they read source and config from disk.
//
// TEL-004: "IPs are never persisted or logged — transport sees them, storage
// never does." The schema half is pinned in test/worker/rollup.test.ts. This
// file holds the code half and the platform half.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

/** Strips // line comments that start a line, the only kind wrangler.jsonc uses. */
function readJsonc(file: string): Record<string, any> {
  const text = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
  return JSON.parse(text);
}

// Anything that would let the Worker learn, and so be able to keep, the
// caller's address — plus every way the code could write a log line.
export const FORBIDDEN_IN_SOURCE: ReadonlyArray<[string, RegExp]> = [
  ["console output", /\bconsole\s*\./],
  ["CF-Connecting-IP", /cf-connecting-ip/i],
  ["X-Forwarded-For", /x-forwarded-for/i],
  ["X-Real-IP", /x-real-ip/i],
  ["True-Client-IP", /true-client-ip/i],
  ["request.cf (geo/ASN/colo metadata)", /\.cf\b/],
  ["any header read", /headers\s*\.\s*get\s*\(/i],
];

export function forbiddenHits(text: string): string[] {
  return FORBIDDEN_IN_SOURCE.filter(([, re]) => re.test(text)).map(([name]) => name);
}

describe("the code never reads or logs a caller's address", () => {
  const sources = filesUnder(path.join(ROOT, "src")).filter((f) => f.endsWith(".ts"));

  it("has source files to scan", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const file of sources) {
    it(`${path.relative(ROOT, file)} contains none of the forbidden reads`, () => {
      expect(forbiddenHits(readFileSync(file, "utf8"))).toEqual([]);
    });
  }

  // Trap 78: a detector must be proven to FIRE, in the same commit that adds it.
  it("the detector fires on every forbidden pattern", () => {
    const samples: Record<string, string> = {
      "console output": "console.log(x)",
      "CF-Connecting-IP": "request.headers.get('CF-Connecting-IP')",
      "X-Forwarded-For": "h['x-forwarded-for']",
      "X-Real-IP": "'X-Real-IP'",
      "True-Client-IP": "'True-Client-IP'",
      "request.cf (geo/ASN/colo metadata)": "const c = request.cf;",
      "any header read": "req.headers.get('User-Agent')",
    };
    expect(Object.keys(samples).sort()).toEqual(FORBIDDEN_IN_SOURCE.map(([n]) => n).sort());
    for (const [name, sample] of Object.entries(samples)) {
      expect(forbiddenHits(sample), name).toContain(name);
    }
    expect(forbiddenHits("const ok = 1;")).toEqual([]);
  });
});

describe("the platform is told not to log requests", () => {
  const config = readJsonc(path.join(ROOT, "wrangler.jsonc"));

  it("observability, Workers Logs and invocation logs are off", () => {
    expect(config.observability?.enabled).toBe(false);
    expect(config.observability?.logs?.enabled).toBe(false);
    expect(config.observability?.logs?.invocation_logs).toBe(false);
  });

  it("Logpush is off", () => {
    expect(config.logpush).toBe(false);
  });

  it("no tail consumers are attached", () => {
    expect(config.tail_consumers ?? []).toEqual([]);
  });

  it("the cron is the documented 10-minute one", () => {
    expect(config.triggers?.crons).toEqual(["*/10 * * * *"]);
  });

  it("carries no secrets or vars", () => {
    expect(config.vars).toBeUndefined();
  });
});

describe("no secrets are committed", () => {
  it(".dev.vars and .env are ignored", () => {
    const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    expect(ignore).toContain(".dev.vars*");
    expect(ignore).toContain(".env*");
  });

  it("git tracks no .dev.vars, .env or .wrangler file", () => {
    let tracked: string[];
    try {
      tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/);
    } catch {
      return; // not a git checkout (e.g. a tarball); the ignore rule above still holds
    }
    expect(tracked.filter((f) => /(^|\/)(\.dev\.vars|\.env|\.wrangler)/.test(f))).toEqual([]);
  });
});
