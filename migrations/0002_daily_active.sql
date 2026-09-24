-- dailyActive (DRA-369): distinct opted-in installs with a heartbeat in the
-- completed UTC day. Written by the daily rollup beside unique_30d; no ids.
--
-- weeklyActive needs no column: it is the same distinct set as the rollup's
-- 7-day version mix, and is published from that one producer.
--
-- The DEFAULT exists only because SQLite cannot add a NOT NULL column without
-- one. Production held zero daily_rollup rows when this was applied
-- (2026-09-24), so no row carries it.
ALTER TABLE daily_rollup ADD COLUMN active_1d INTEGER NOT NULL DEFAULT 0;
