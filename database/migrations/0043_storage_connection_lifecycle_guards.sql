-- A01 (pre-production audit): Permit Dropbox connection lifecycle.
--
-- The application runs lifecycle transitions as compare-and-swap updates on
-- (revision, status) (backend/src/storage/admin.ts). These triggers enforce
-- the invariants in PostgreSQL itself, so they hold for every backend
-- process and every code path, whatever the interleaving:
--
--   * a connection leaves 'disconnecting'/'disconnected' only through a
--     revision-bumping reconnect: a stale health check can never revive it;
--   * while 'disconnecting', its credentials cannot be replaced (no stale
--     token refresh), only cleared by finalization;
--   * it enters 'disconnecting', and its credentials are cleared, only when
--     it is not selected and no pending/ready registry file references it;
--   * a registry reservation or a selection is accepted only for a
--     'connected' connection with credentials, read under FOR SHARE, which
--     conflicts with the FOR UPDATE lock the disconnect transition holds.
--
-- 'cleanup_pending' registry rows (a reservation verified to have no remote
-- object and no reference) do not count as dependencies.

CREATE FUNCTION permit.storage_connection_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  dependent boolean;
BEGIN
  dependent := EXISTS (SELECT 1 FROM permit.storage_selection s WHERE s.connection_id = OLD.id)
    OR EXISTS (SELECT 1 FROM permit.file_registry f WHERE f.connection_id = OLD.id AND f.state IN ('pending', 'ready'));

  IF OLD.status IN ('disconnecting', 'disconnected') AND NEW.status IN ('connected', 'error')
     AND NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'storage connection lifecycle: % cannot return to % without a new revision', OLD.status, NEW.status
      USING ERRCODE = 'serialization_failure';
  END IF;

  IF OLD.status = 'disconnecting' AND NEW.status = 'disconnecting'
     AND NEW.credentials IS DISTINCT FROM OLD.credentials THEN
    RAISE EXCEPTION 'storage connection lifecycle: credentials of a disconnecting connection are frozen'
      USING ERRCODE = 'serialization_failure';
  END IF;

  IF NEW.status = 'disconnecting' AND OLD.status <> 'disconnecting' AND dependent THEN
    RAISE EXCEPTION 'storage connection lifecycle: a selected or referenced connection cannot start disconnecting'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.credentials IS NULL AND OLD.credentials IS NOT NULL
     AND (OLD.status <> 'disconnecting' OR NEW.status <> 'disconnected' OR dependent) THEN
    RAISE EXCEPTION 'storage connection lifecycle: credentials may be cleared only by finalizing an unreferenced disconnect'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION permit.storage_connection_lifecycle_guard() FROM PUBLIC;
CREATE TRIGGER storage_connection_lifecycle_guard BEFORE UPDATE ON permit.storage_connections
  FOR EACH ROW EXECUTE FUNCTION permit.storage_connection_lifecycle_guard();

CREATE FUNCTION permit.storage_connection_usable_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  target uuid := NEW.connection_id;
  usable boolean;
BEGIN
  IF target IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF target IS NOT DISTINCT FROM OLD.connection_id THEN
      RETURN NEW;   -- re-saving the current selection does not re-validate it
    END IF;
  END IF;
  SELECT c.status = 'connected' AND c.credentials IS NOT NULL INTO usable
    FROM permit.storage_connections c WHERE c.id = target FOR SHARE;
  IF usable IS NOT TRUE THEN
    RAISE EXCEPTION 'storage connection lifecycle: connection is not connected'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION permit.storage_connection_usable_guard() FROM PUBLIC;
CREATE TRIGGER file_registry_connection_usable BEFORE INSERT ON permit.file_registry
  FOR EACH ROW EXECUTE FUNCTION permit.storage_connection_usable_guard();
CREATE TRIGGER storage_selection_connection_usable BEFORE UPDATE ON permit.storage_selection
  FOR EACH ROW EXECUTE FUNCTION permit.storage_connection_usable_guard();
