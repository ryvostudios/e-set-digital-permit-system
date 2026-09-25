-- Prints one line per ESDMS-owned definition in schema `public` (and the
-- ESDMS ledger and roles), so two runs can be compared with `diff`.
-- Read-only. Run as the database administrator.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
SET search_path = pg_catalog;
SELECT line FROM (
  SELECT 'schema|' || nspname || '|' || pg_get_userbyid(nspowner) || '|' || coalesce(nspacl::text, '') AS line
    FROM pg_namespace WHERE nspname = 'public'
  UNION ALL
  SELECT 'relation|' || c.relname || '|' || c.relkind::text || '|' || pg_get_userbyid(c.relowner) || '|'
         || coalesce(c.relacl::text, '') || '|rls=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'column|' || c.relname || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|'
         || a.attnotnull || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || coalesce(a.attacl::text, '')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint|' || conrelid::regclass || '|' || conname || '|' || pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'index|' || indexrelid::regclass || '|' || pg_get_indexdef(indexrelid)
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'function|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
         || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, '') || '|secdef=' || p.prosecdef
         || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || md5(p.prosrc)
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'trigger|' || t.tgrelid::regclass || '|' || t.tgname || '|' || t.tgenabled::text || '|' || pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
  UNION ALL
  SELECT 'policy|' || tablename || '|' || policyname || '|' || roles::text || '|' || cmd || '|'
         || coalesce(qual, '') || '|' || coalesce(with_check, '')
    FROM pg_policies WHERE schemaname = 'public'
  UNION ALL
  SELECT 'ledger|' || name || '|' || run_on FROM public.pgmigrations
  UNION ALL
  SELECT 'default_acl|' || pg_get_userbyid(defaclrole) || '|' || coalesce(defaclnamespace::regnamespace::text, '*')
         || '|' || defaclobjtype::text || '|' || defaclacl::text
    FROM pg_default_acl
   WHERE defaclnamespace = 'public'::regnamespace
      OR defaclrole IN (SELECT oid FROM pg_roles WHERE rolname LIKE 'esdms\_%')
      OR defaclrole = (SELECT nspowner FROM pg_namespace WHERE nspname = 'public')
  UNION ALL
  SELECT 'role|' || r.rolname || '|super=' || r.rolsuper || '|bypassrls=' || r.rolbypassrls || '|createrole='
         || r.rolcreaterole || '|createdb=' || r.rolcreatedb || '|inherit=' || r.rolinherit || '|login=' || r.rolcanlogin
         || '|' || coalesce(array_to_string(r.rolconfig, ','), '')
         || '|member_of=' || coalesce((SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m
                                          JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '')
    FROM pg_roles r WHERE r.rolname LIKE 'esdms\_%'
) inventory ORDER BY line;
