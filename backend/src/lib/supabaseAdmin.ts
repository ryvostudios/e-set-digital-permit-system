import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { createTimeoutFetch } from './timeoutFetch.js';

/**
 * A privileged Supabase Admin API client (service_role) - server-only,
 * NEVER exposed to the frontend. Distinct from `lib/supabase.ts`'s
 * publishable-key client (which only verifies user tokens): this one can
 * create and update Auth users and bypass RLS -
 * exactly why it is created lazily, only when `SUPABASE_SERVICE_ROLE_KEY`
 * is actually configured, and only ever imported from the two places
 * that legitimately need it: the CEO bootstrap CLI and the narrowly
 * authorized employee account-management adapter. PDF Storage uses the
 * separate Storage-scoped S3 credential and never this client.
 *
 * Returns null (never throws) when the key isn't configured, so a
 * caller can degrade safely at the feature boundary (CEO bootstrap
 * refuses to run; account endpoints return unavailable) instead of the
 * whole backend failing to start.
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      // This client is used only for privileged server-side Auth Admin
      // operations. Genuinely abort the underlying HTTP request at the
      // configured deadline so a stalled Auth endpoint cannot retain a
      // credential-reset DB connection/row lock indefinitely.
      fetch: createTimeoutFetch(globalThis.fetch, env.SUPABASE_AUTH_ADMIN_TIMEOUT_MS),
    },
  });
}
