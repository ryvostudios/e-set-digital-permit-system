import { getSupabaseAdminClient } from '../../lib/supabaseAdmin.js';
import type { AccountAdmin } from './service.js';

/**
 * The Supabase Auth Admin adapter for account management.
 *
 * Reuses the project's EXISTING server-only admin client
 * (`lib/supabaseAdmin.ts`) rather than creating a second client or a
 * second piece of configuration - the service-role key is read there,
 * once, and never leaves the server: it is never returned by an API,
 * never logged, never written to a business table, and never reachable
 * from route code except through the narrow `AccountAdmin` interface
 * below, which only ever accepts a password and returns an id or a
 * boolean.
 *
 * Returns null when `SUPABASE_SERVICE_ROLE_KEY` is not configured, so
 * account management degrades to an explicit "unavailable" response
 * exactly like PDF storage does - never a partial or faked success.
 */

/** Supabase reports a duplicate registration in more than one shape depending on version/config; all of them mean the same thing here. */
function isDuplicateEmail(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, status, message } = error as { code?: unknown; status?: unknown; message?: unknown };
  if (code === 'email_exists' || code === 'user_already_exists') return true;
  if (status === 422) return true;
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  return text.includes('already been registered') || text.includes('already registered') || text.includes('already exists');
}

export function createSupabaseAccountAdmin(): AccountAdmin | null {
  const client = getSupabaseAdminClient();
  if (!client) return null;

  return {
    async createUser(input) {
      // `email_confirm: true` provisions a directly usable account: the
      // employee signs in with the temporary password the Site Manager
      // set, then is forced to replace it. No invitation email flow is
      // introduced here.
      //
      // Supabase's own createUser REFUSES an email that already exists,
      // and this adapter deliberately does not fall back to looking the
      // existing identity up: adopting an existing Auth user would let
      // employee provisioning reach an identity it does not own.
      try {
        const { data, error } = await client.auth.admin.createUser({
          email: input.email,
          password: input.password,
          email_confirm: true,
        });
        if (error || !data.user) {
          return { ok: false, reason: isDuplicateEmail(error) ? 'email_unavailable' : 'failed' };
        }
        return { ok: true, userId: data.user.id };
      } catch {
        return { ok: false, reason: 'failed' };
      }
    },

    async setPassword(userId, password) {
      try {
        const { error } = await client.auth.admin.updateUserById(userId, { password });
        return { ok: !error };
      } catch {
        return { ok: false };
      }
    },

    async setEmailAndPassword(userId, email, password) {
      // One Auth call changes both. `email_confirm: true` keeps the new
      // address immediately usable without an invitation round-trip,
      // matching how provisioning already works - the employee is forced
      // to replace the temporary password on first use anyway.
      try {
        const { error } = await client.auth.admin.updateUserById(userId, {
          email,
          password,
          email_confirm: true,
        });
        if (error) {
          return { ok: false, reason: isDuplicateEmail(error) ? 'email_unavailable' : 'failed' };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: 'failed' };
      }
    },

    async deleteUser(userId) {
      try {
        const { error } = await client.auth.admin.deleteUser(userId);
        return { ok: !error };
      } catch {
        return { ok: false };
      }
    },
  };
}
