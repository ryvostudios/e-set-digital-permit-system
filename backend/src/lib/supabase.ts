import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

/**
 * Server-side Supabase client used only to verify user access tokens
 * (via `auth.getClaims`). It never persists a session and holds no
 * privileged/service-role credentials.
 */
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

/** Formats an auth verification error for logging without leaking the token or claim contents. */
export function toSafeAuthErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    const code = 'code' in err ? (err as { code?: unknown }).code : undefined;
    return `auth error (${String(name)}${code ? `, code ${String(code)}` : ''})`;
  }
  return 'unknown auth error';
}
