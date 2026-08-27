-- Bring the ALREADY-BOOTSTRAPPED CEO into line with the forced
-- first-login password-change rule that every other account has always
-- had.
--
-- Migrations 0001-0027 are immutable applied history and are not edited
-- by this file. This migration creates no table, no function, no
-- sequence and no privilege, so it introduces no new ACL surface for
-- service_role, PUBLIC, app_runtime or privileged_runtime to be audited
-- against. It corrects ONE boolean flag on existing rows.
--
-- WHY THIS IS NEEDED. `bootstrapCeo.ts` originally inserted
-- `app_user_access (user_id, state)` and left `must_change_password` at
-- its default FALSE, while employee provisioning
-- (`domain/accounts/service.ts`) and Site Manager provisioning
-- (`domain/accounts/privilegedManagement.ts`) both insert it TRUE. The
-- CEO was therefore the single account permitted to keep operating on a
-- password an operator had chosen, typed into an environment variable,
-- and could still read - the one account where that matters most. The
-- application code is fixed alongside this migration; this file repairs
-- the row that was already written.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not touch the password
-- itself, does not revoke a session, does not create or remove a
-- privileged grant, and does not alter any audit row. Forcing a change
-- is an access-state flag, not a credential rotation - the CEO keeps
-- signing in with the bootstrap password exactly once, and the existing
-- forced-change flow then requires a personal replacement.

-- =====================================================================
-- 1. Precondition
-- =====================================================================
-- The columns and the CEO grant log this migration reasons about must
-- already exist (0017 and 0019 respectively). Failing here is far better
-- than silently updating nothing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'app_user_access'
       AND column_name = 'must_change_password'
  ) THEN
    RAISE EXCEPTION '0028 precondition failed: app_user_access.must_change_password is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'privileged_access_events'
  ) THEN
    RAISE EXCEPTION '0028 precondition failed: privileged_access_events is missing';
  END IF;
END;
$$;

-- =====================================================================
-- 2. The correction
-- =====================================================================
-- Scope, narrowest that is correct:
--
--   * holds a CURRENTLY ACTIVE CEO grant - derived from the append-only
--     log's latest event per user, never from a role column or a claim;
--   * is still ACTIVE (a disabled account is not made to owe anything);
--   * does not already owe a change (idempotent - re-running is a no-op);
--   * has NEVER completed a password change, evidenced by the absence of
--     an `EMPLOYEE_PASSWORD_CHANGED` audit event. A CEO who has already
--     replaced the bootstrap password personally is NOT dragged back
--     through the forced-change screen.
--
-- If a future CEO is bootstrapped by the fixed application code, they are
-- already TRUE on insert and this statement matches nothing.
UPDATE app_user_access a
   SET must_change_password = TRUE,
       updated_at = now()
 WHERE a.state = 'ACTIVE'
   AND a.must_change_password = FALSE
   AND EXISTS (
     SELECT 1
       FROM (
         SELECT DISTINCT ON (e.user_id) e.user_id, e.action
           FROM privileged_access_events e
          WHERE e.role = 'CEO'
          ORDER BY e.user_id, e.ordinal DESC
       ) latest
      WHERE latest.user_id = a.user_id
        AND latest.action = 'GRANTED'
   )
   AND NOT EXISTS (
     SELECT 1 FROM account_audit_events ev
      WHERE ev.target_user_id = a.user_id
        AND ev.event_type = 'EMPLOYEE_PASSWORD_CHANGED'
   );

-- =====================================================================
-- 3. Verify the result rather than assuming it
-- =====================================================================
-- Every active CEO who has never changed their password must now owe a
-- change. Asserting the POSTCONDITION (not the row count) keeps this
-- correct whether the environment had zero, one, or several such CEOs.
DO $$
DECLARE
  unconverted INTEGER;
BEGIN
  SELECT count(*) INTO unconverted
    FROM app_user_access a
   WHERE a.state = 'ACTIVE'
     AND a.must_change_password = FALSE
     AND EXISTS (
       SELECT 1 FROM (
         SELECT DISTINCT ON (e.user_id) e.user_id, e.action
           FROM privileged_access_events e
          WHERE e.role = 'CEO'
          ORDER BY e.user_id, e.ordinal DESC
       ) latest
        WHERE latest.user_id = a.user_id AND latest.action = 'GRANTED'
     )
     AND NOT EXISTS (
       SELECT 1 FROM account_audit_events ev
        WHERE ev.target_user_id = a.user_id
          AND ev.event_type = 'EMPLOYEE_PASSWORD_CHANGED'
     );

  IF unconverted <> 0 THEN
    RAISE EXCEPTION '0028 failed: % active CEO account(s) still do not owe a first-login password change', unconverted;
  END IF;
END;
$$;
