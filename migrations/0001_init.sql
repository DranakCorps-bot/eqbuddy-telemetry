-- EQBuddy Evolved opt-in telemetry: the whole storage shape.
--
-- There is no column that could hold an IP address, a path or a name, and
-- that is the point. test/static/guards.test.ts pins every column of every
-- table, so adding one fails the build until the requirement page
-- (EQBuddy docs/v2/telemetry.md) is amended.

-- Raw heartbeats. 90-day retention. The ONLY table holding an install id.
-- One row per (install, 10-minute bucket): a heartbeat every 5 minutes is two
-- writes against one row, so the row count is bounded by ids x buckets.
CREATE TABLE heartbeat (
  install_id   TEXT    NOT NULL,  -- the payload's random GUID, lowercase
  bucket_start TEXT    NOT NULL,  -- ISO-8601 UTC, 10-minute aligned
  app_version  TEXT    NOT NULL,
  os           TEXT    NOT NULL,
  last_seen_ms INTEGER NOT NULL,  -- server receive time of the latest heartbeat in
                                  -- this bucket (epoch ms). Read by the per-id rate
                                  -- limit and the rolling "concurrent now" window.
  PRIMARY KEY (install_id, bucket_start)
);
-- Deliberately no index on last_seen_ms: it changes on every heartbeat, and
-- D1 counts each index entry touched as a row written. Window queries bound
-- themselves by bucket_start instead (src/store.ts IN_WINDOW).
CREATE INDEX heartbeat_bucket ON heartbeat (bucket_start);

-- Aggregates. Kept indefinitely. No ids.
CREATE TABLE bucket_count (
  bucket_start TEXT    PRIMARY KEY,
  distinct_ids INTEGER NOT NULL
);
-- The peak query reads one row through this, not every bucket since launch.
CREATE INDEX bucket_count_peak ON bucket_count (distinct_ids DESC, bucket_start ASC);

CREATE TABLE daily_rollup (
  day            TEXT    PRIMARY KEY,  -- YYYY-MM-DD, UTC; figures are as of the day's end
  unique_30d     INTEGER NOT NULL,
  version_mix_7d TEXT    NOT NULL      -- JSON: the metrics.json versionMix7d object
);

-- The published metrics.json, rewritten by the cron. One row, no ids.
CREATE TABLE metrics_snapshot (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at TEXT    NOT NULL,
  body         TEXT    NOT NULL
);
