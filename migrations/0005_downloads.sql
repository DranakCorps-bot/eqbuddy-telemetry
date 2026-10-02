-- downloads: EQBuddy Evolved's download total, one row per UTC day (DRA-783 D1).
--
-- Not telemetry, and nothing about a player: it is a number GitHub publishes
-- about the EQBuddy releases (the per-asset download_count), read once an hour
-- by the cron from GitHub's public API. No install id, no request, no address.
--
-- GitHub keeps only a cumulative count, so a "last 30 days" figure needs the
-- total as it stood 30 days earlier. Each row holds the LATEST cumulative total
-- seen that UTC day (so a completed day's row is its end-of-day total) and when
-- it was read. Rows start the day this migration is deployed; nothing is
-- back-filled, because no per-day split of earlier downloads exists to copy.
CREATE TABLE downloads_daily (
  day   TEXT PRIMARY KEY,   -- YYYY-MM-DD UTC
  total INTEGER NOT NULL,   -- Evolved installer + portable zip fetches since v2.0.0, cumulative
  as_of TEXT NOT NULL       -- ISO-8601 UTC of the read that produced `total`
);
