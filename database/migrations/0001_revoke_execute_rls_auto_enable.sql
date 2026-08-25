-- Mirrors a security fix already applied directly in Supabase: restrict
-- who can invoke the rls_auto_enable() function.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
