import { describe, expect, it } from "vitest";
import { dispatchPagesRefresh, isDispatchTick, PAGES_DISPATCH_URL } from "../../src/dispatch";

const HOUR = Date.parse("2026-09-29T01:00:00Z");
const MIN = 60_000;

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, calls: Call[]): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status });
  }) as typeof fetch;
}

describe("hourly landing refresh", () => {
  it("fires on exactly one of the six ten-minute ticks in an hour", () => {
    const ticks = [0, 10, 20, 30, 40, 50].map((m) => isDispatchTick(HOUR + m * MIN));
    expect(ticks).toEqual([true, false, false, false, false, false]);
    // a tick that runs a little late still belongs to its hour
    expect(isDispatchTick(HOUR + 3 * MIN)).toBe(true);
  });

  it("asks GitHub to run pages.yml on main, and sends nothing about any install", async () => {
    const calls: Call[] = [];
    const outcome = await dispatchPagesRefresh("tok", HOUR, fakeFetch(204, calls));
    expect(outcome).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PAGES_DISPATCH_URL);
    expect(calls[0].url).toContain("/repos/DranakCorps-bot/EQBuddy/actions/workflows/pages.yml/dispatches");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ref: "main" });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("does nothing without a token, and nothing off the hour", async () => {
    const calls: Call[] = [];
    expect(await dispatchPagesRefresh(undefined, HOUR, fakeFetch(204, calls))).toBe("skipped-no-token");
    expect(await dispatchPagesRefresh("", HOUR, fakeFetch(204, calls))).toBe("skipped-no-token");
    expect(await dispatchPagesRefresh("tok", HOUR + 20 * MIN, fakeFetch(204, calls))).toBe("skipped-not-hour");
    expect(calls).toHaveLength(0);
  });

  it("reports a refusal or a network error as failed instead of throwing", async () => {
    const calls: Call[] = [];
    expect(await dispatchPagesRefresh("tok", HOUR, fakeFetch(401, calls))).toBe("failed");
    const throwing = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await dispatchPagesRefresh("tok", HOUR, throwing)).toBe("failed");
  });
});
