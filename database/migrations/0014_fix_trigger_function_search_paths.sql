-- Pin the search path for the two SECURITY INVOKER trigger functions
-- introduced by migration 0013. Their bodies only inspect OLD/NEW and
-- raise exceptions, so they require no caller-controlled schema lookup.
ALTER FUNCTION public.notifications_restrict_update() SET search_path = pg_catalog;
ALTER FUNCTION public.permit_document_jobs_restrict_update() SET search_path = pg_catalog;
