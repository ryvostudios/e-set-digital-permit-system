-- Section 6 hardening: restrict access to the migration metadata table.
-- public.schema_migrations tracks which migrations have been applied; it
-- must never be readable/writable by anon/authenticated (or PUBLIC) -
-- only the backend's own database role (table owner) uses it.
REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC, anon, authenticated;
