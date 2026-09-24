// The payload, closed on the server end (EQBuddy docs/v2/telemetry.md §2).
//
// A heartbeat is exactly three string fields. Any other key, a missing key,
// or a value outside the accepted shape is refused, and a refused body is
// neither stored nor logged.

export const HEARTBEAT_KEYS = ["installId", "appVersion", "os"] as const;
export const DELETE_KEYS = ["installId"] as const;

/** Bodies are tiny; anything bigger is not a heartbeat. */
export const MAX_BODY_BYTES = 1024;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APP_VERSION = /^[0-9A-Za-z.\-]{1,32}$/;
const OS = /^[\x20-\x7E]{1,64}$/;

export interface Heartbeat {
  installId: string;
  appVersion: string;
  os: string;
}

/** Parses a JSON object whose key set is EXACTLY `keys`, every value a string. */
function closedObject(text: string, keys: readonly string[]): Record<string, string> | null {
  if (text.length > MAX_BODY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length) return null;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, k)) return null;
    if (typeof record[k] !== "string") return null;
  }
  return record as Record<string, string>;
}

export function parseHeartbeat(text: string): Heartbeat | null {
  const o = closedObject(text, HEARTBEAT_KEYS);
  if (!o) return null;
  if (!GUID.test(o.installId) || !APP_VERSION.test(o.appVersion) || !OS.test(o.os)) return null;
  return { installId: o.installId, appVersion: o.appVersion, os: o.os };
}

export function parseDelete(text: string): string | null {
  const o = closedObject(text, DELETE_KEYS);
  if (!o || !GUID.test(o.installId)) return null;
  return o.installId;
}
