// The OS family of a heartbeat's `os` value (DRA-784 D1). Pure: no I/O.
//
// The client builds `os` in ONE place, EQBuddy's TelemetryHeartbeat.OsFrom, as
// "Windows <Major>.<Minor>.<Build>" (docs/v2/telemetry.md §2). DRA-784 D2, if
// the Founder approves it, appends a Wine suffix to that same value:
//   "Windows 10.0.19045; Wine on macOS" | "...; Wine on Linux" | "...; Wine"
// Each form is matched WHOLE. Anything else is "other" and is counted as such,
// never guessed into a family: a value nobody has measured says so on /report.
//
// What this cannot see: Wine that hides itself, and any install whose app does
// not report Wine (every build before D2), sends the plain Windows form and is
// counted as "windows". The published definition and /report both say so.

export const OS_FAMILIES = ["windows", "macos-wine", "linux-wine", "wine-other", "other"] as const;
export type OsFamily = (typeof OS_FAMILIES)[number];

const WINDOWS = /^Windows \d+\.\d+\.\d+(?:; (Wine on macOS|Wine on Linux|Wine))?$/;

const WINE: Record<string, OsFamily> = {
  "Wine on macOS": "macos-wine",
  "Wine on Linux": "linux-wine",
  Wine: "wine-other",
};

export function osFamily(os: string): OsFamily {
  const m = WINDOWS.exec(os);
  if (!m) return "other";
  return m[1] === undefined ? "windows" : WINE[m[1]];
}
