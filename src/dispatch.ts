// Hourly landing-page refresh (Founder, 2026-09-28).
//
// The EQBuddy landing page shows these metrics from a same-origin live.json that its
// GitHub Pages workflow writes at deploy time (so the page makes no third-party
// requests). That workflow's own `schedule` trigger proved unreliable: GitHub skipped
// three hourly slots in a row on launch day. This worker's cron has run every 10
// minutes without a miss, so once an hour it asks GitHub to run that workflow.
//
// What it sends: an empty "run pages.yml on main" request. Nothing about any install,
// no metric, no id. The token is a Worker SECRET (GITHUB_DISPATCH_TOKEN), a fine-grained
// token limited to Actions read/write on DranakCorps-bot/EQBuddy. With no secret set this
// is a no-op, so a fresh deploy or a revoked token degrades to "no refresh", never an
// error, and never interferes with the metrics pass that runs before it.

export const PAGES_DISPATCH_URL =
  "https://api.github.com/repos/DranakCorps-bot/EQBuddy/actions/workflows/pages.yml/dispatches";

export type DispatchOutcome = "skipped-no-token" | "skipped-not-hour" | "sent" | "failed";

/** The one cron tick per hour that refreshes the page: the tick in the first 10 minutes
 * of the UTC hour. The cron is every 10 minutes, so exactly one tick an hour qualifies. */
export function isDispatchTick(scheduledMs: number): boolean {
  return new Date(scheduledMs).getUTCMinutes() < 10;
}

export async function dispatchPagesRefresh(
  token: string | undefined,
  scheduledMs: number,
  fetcher: typeof fetch = fetch,
): Promise<DispatchOutcome> {
  if (!token) return "skipped-no-token";
  if (!isDispatchTick(scheduledMs)) return "skipped-not-hour";
  try {
    const response = await fetcher(PAGES_DISPATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "eqbuddy-telemetry",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    // GitHub answers 204 No Content when the run is queued.
    return response.status === 204 ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
