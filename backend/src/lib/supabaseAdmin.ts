import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

/**
 * A privileged Supabase Admin API client (service_role) - server-only,
 * NEVER exposed to the frontend. Distinct from `lib/supabase.ts`'s
 * publishable-key client (which only verifies user tokens): this one can
 * create auth users, access Storage as an admin, and bypass RLS -
 * exactly why it is created lazily, only when `SUPABASE_SERVICE_ROLE_KEY`
 * is actually configured, and only ever imported from the two places
 * that legitimately need it (the CEO bootstrap CLI and the Supabase
 * Storage document adapter) - never from request-handling route code.
 *
 * Returns null (never throws) when the key isn't configured, so a
 * caller can degrade safely (CEO bootstrap refuses to run; PDF storage
 * stays in its "pending" state) instead of the whole backend failing to
 * start - "successful issuance must not depend on an external file
 * service being available" (this batch's PDF storage requirement).
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
