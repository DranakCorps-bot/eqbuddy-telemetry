-- usageHours and /history.json (DRA-380). Two id-free additions.
--
-- 1. daily_rollup.usage_buckets_1d: the sum of bucket_count.distinct_ids over
--    the UTC day's 144 buckets. Each distinct install in a 10-minute bucket is
--    10 minutes of use, so the day's hours are usage_buckets_1d x 10 / 60. It is
--    an integer so every total adds up exactly; hours are derived when
--    published. The daily rollup writes it BEFORE the cron's purge step, and
--    the all-time total sums this column, so the total survives any purge.
--
--    The DEFAULT exists only because SQLite cannot add a NOT NULL column
--    without one. The UPDATE below backfills any existing row from
--    bucket_count, which has been kept since the first deploy, so no row
--    keeps the default by accident.
ALTER TABLE daily_rollup ADD COLUMN usage_buckets_1d INTEGER NOT NULL DEFAULT 0;

UPDATE daily_rollup SET usage_buckets_1d = (
  SELECT COALESCE(SUM(distinct_ids), 0) FROM bucket_count
  WHERE bucket_start >= daily_rollup.day || 'T00:00:00Z'
    AND bucket_start <  date(daily_rollup.day, '+1 day') || 'T00:00:00Z'
);

-- 2. The published history.json, rewritten by the cron exactly as
--    metrics_snapshot holds metrics.json: one row, one read per request, and
--    no request ever scans heartbeat. No ids.
CREATE TABLE history_snapshot (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at TEXT    NOT NULL,
  body         TEXT    NOT NULL
);
