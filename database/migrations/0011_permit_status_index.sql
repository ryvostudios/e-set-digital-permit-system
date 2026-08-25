-- Supports the new capability-gated queue/list read endpoints
-- (GET /permits/queue?status=..., GET /permits/mine), which filter on
-- `status` - no existing index covers that column. Read-only
-- performance change: no new tables, no privilege/RLS changes, no new
-- invariants, and no data touched.
CREATE INDEX permits_status_idx ON permits (status);
