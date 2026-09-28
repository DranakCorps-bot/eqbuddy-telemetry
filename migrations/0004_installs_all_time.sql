-- installsAllTime: an all-time count of opted-in installs, kept without
-- keeping a single install id past the raw table's 90-day retention.
--
-- One row, one integer, no ids. A heartbeat from an install that has NO row in
-- heartbeat adds one, in the same D1 batch (one transaction) as the insert
-- that gives it a row (src/store.ts recordHeartbeat). So "first seen" means
-- "first seen within the raw table's retention": an install silent for more
-- than 90 days, or one whose rows were deleted through /delete, is counted
-- again if it comes back. /delete never lowers the count: it is an aggregate,
-- and it holds nothing to delete.
--
-- The single-row shape (id = 1, like metrics_snapshot) leaves no free-text
-- column that could hold a name.
CREATE TABLE all_time_total (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  installs_first_seen INTEGER NOT NULL
);

-- Backfill: every distinct install the raw table still holds. The Worker went
-- live 2026-09-24, so when this is applied (before 2026-12-23) no raw row has
-- aged out yet and this is every install seen since launch, less any whose
-- data was deleted through /delete (a lower bound, like the count itself).
-- An aggregate query with no GROUP BY always returns one row, so the row
-- exists even on an empty table.
INSERT INTO all_time_total (id, installs_first_seen)
SELECT 1, COUNT(DISTINCT install_id) FROM heartbeat;
