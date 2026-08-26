import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { QueryFn } from '../db/pool.js';
import { bootstrapInitialCeo, runBootstrapCeoCli, type BootstrapAdmin, type BootstrapCeoDeps } from './bootstrapCeo.js';

class FakeBootstrapSystem {
  reservation: { email: string; status: 'RESERVED' | 'COMPLETED'; token: string | null; authUserId: string | null; stale: boolean } | null = null;
  ceos = new Set<string>();
  authUsers = new Map<string, string>();
  createCalls = 0;
  failAuthPersistenceOnce = false;
  access = new Map<string, 'ACTIVE' | 'DISABLED'>();

  admin: BootstrapAdmin = {
    createUser: async ({ email }) => {
      this.createCalls += 1;
      if (this.authUsers.has(email.toLowerCase())) return { user: null, error: true };
      const id = `auth-${this.authUsers.size + 1}`;
      this.authUsers.set(email.toLowerCase(), id);
      return { user: { id }, error: false };
    },
    findUserByEmail: async (email) => {
      const id = this.authUsers.get(email.toLowerCase());
      return id ? { id } : null;
    },
  };

  query: QueryFn = (async (text: string, params: unknown[] = []) => {
    const sql = text.trim();
    if (sql.startsWith('SELECT user_id FROM (')) return { rows: [...this.ceos].slice(0, 1).map((user_id) => ({ user_id })) };
    if (sql.startsWith('INSERT INTO initial_ceo_bootstrap')) {
      if (this.reservation) return { rows: [] };
      this.reservation = { email: String(params[0]).toLowerCase(), status: 'RESERVED', token: String(params[1]), authUserId: null, stale: false };
      return { rows: [{ singleton: true }] };
    }
    if (sql.startsWith('UPDATE initial_ceo_bootstrap SET claim_token')) {
      if (this.reservation?.status === 'RESERVED' && this.reservation.email === String(params[0]).toLowerCase() && this.reservation.stale) {
        this.reservation.token = String(params[1]);
        this.reservation.stale = false;
        return { rows: [{ singleton: true }] };
      }
      return { rows: [] };
    }
    if (sql.startsWith('SELECT email, status FROM initial_ceo_bootstrap')) return { rows: this.reservation ? [{ email: this.reservation.email, status: this.reservation.status }] : [] };
    if (sql.startsWith('UPDATE initial_ceo_bootstrap SET auth_user_id')) {
      if (this.failAuthPersistenceOnce) { this.failAuthPersistenceOnce = false; throw new Error('transient database failure'); }
      if (this.reservation?.status === 'RESERVED' && this.reservation.token === params[0]) this.reservation.authUserId = String(params[1]);
      return { rows: [] };
    }
    if (sql.startsWith('SELECT auth_user_id FROM initial_ceo_bootstrap')) {
      return { rows: this.reservation?.status === 'RESERVED' && this.reservation.token === params[0] ? [{ auth_user_id: this.reservation.authUserId }] : [] };
    }
    if (sql.startsWith('INSERT INTO app_user_access')) { if (!this.access.has(String(params[0]))) this.access.set(String(params[0]), 'ACTIVE'); return { rows: [] }; }
    if (sql.startsWith('SELECT state FROM app_user_access')) { const state = this.access.get(String(params[0])); return { rows: state ? [{ state }] : [] }; }
    if (sql.startsWith('INSERT INTO privileged_access_events')) { this.ceos.add(String(params[0])); return { rows: [] }; }
    if (sql.startsWith('UPDATE initial_ceo_bootstrap') && sql.includes("status = 'COMPLETED'")) {
      if (this.reservation?.status === 'RESERVED' && this.reservation.token === params[0]) {
        this.reservation.status = 'COMPLETED'; this.reservation.token = null; return { rows: [{ singleton: true }] };
      }
      return { rows: [] };
    }
    throw new Error(`unhandled bootstrap query: ${sql}`);
  }) as QueryFn;

  deps(token: string): BootstrapCeoDeps {
    return {
      query: this.query,
      admin: this.admin,
      claimToken: token,
      withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>) => fn({ query: this.query } as unknown as PoolClient),
    };
  }
}

const input = { email: 'ceo@example.com', password: 'a-strong-temporary-password' };

test('CEO bootstrap creates exactly one authoritative CEO and rejects a duplicate', async () => {
  const system = new FakeBootstrapSystem();
  const first = await bootstrapInitialCeo(input, system.deps('claim-1'));
  const second = await bootstrapInitialCeo(input, system.deps('claim-2'));
  assert.equal(first.outcome, 'ok');
  assert.deepEqual(second, { outcome: 'conflict', reason: 'ceo_exists' });
  assert.equal(system.ceos.size, 1);
  assert.equal(system.createCalls, 1);
});

test('concurrent CEO bootstrap reservations have one winner before any Auth identity is created', async () => {
  const system = new FakeBootstrapSystem();
  const [first, second] = await Promise.all([
    bootstrapInitialCeo(input, system.deps('claim-1')),
    bootstrapInitialCeo({ ...input, email: 'other@example.com' }, system.deps('claim-2')),
  ]);
  assert.equal([first, second].filter((result) => result.outcome === 'ok').length, 1);
  assert.equal(system.ceos.size, 1);
  assert.equal(system.createCalls, 1);
});

test('Auth-created/DB-failed bootstrap reconciles the same Auth identity on retry instead of creating an orphan repeatedly', async () => {
  const system = new FakeBootstrapSystem();
  system.failAuthPersistenceOnce = true;
  await assert.rejects(() => bootstrapInitialCeo(input, system.deps('claim-1')), /transient database failure/);
  assert.equal(system.authUsers.size, 1);
  system.reservation!.stale = true;
  const retried = await bootstrapInitialCeo(input, system.deps('claim-2'));
  assert.equal(retried.outcome, 'ok');
  if (retried.outcome === 'ok') assert.equal(retried.authUserCreated, false);
  assert.equal(system.authUsers.size, 1);
  assert.equal(system.ceos.size, 1);
});

test('a pre-existing matching Auth identity is safely reused and secrets are not part of the result', async () => {
  const system = new FakeBootstrapSystem();
  system.authUsers.set(input.email, 'existing-auth-id');
  const result = await bootstrapInitialCeo(input, system.deps('claim-1'));
  assert.deepEqual(result, { outcome: 'ok', userId: 'existing-auth-id', authUserCreated: false });
  assert.doesNotMatch(JSON.stringify(result), /temporary-password/);
});

test('CEO bootstrap CLI failure output cannot reveal password, token, service secret, URL, or raw exception data', async () => {
  const output: string[] = [];
  const hostile = `${input.password} Authorization: Bearer abc123 sb_secret_FAKE_SECRET https://secret.example/?token=SUPER_SECRET_TOKEN`;
  const ok = await runBootstrapCeoCli({
    execute: async () => { throw new Error(hostile); },
    error: (message) => output.push(message),
  });
  assert.equal(ok, false);
  const rendered = output.join('\n');
  assert.equal(rendered, 'bootstrap:ceo: failed safely');
  assert.doesNotMatch(rendered, /strong-temporary|abc123|sb_secret|SUPER_SECRET_TOKEN|https:/);
});
