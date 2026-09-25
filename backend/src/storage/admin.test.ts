import '../test/syntheticDropboxEnv.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';
import { installedDatabase } from '../test/permitSchemaFixtures.js';
import {
  completeDropboxConnect, disconnectDropbox, selectDropbox, startDropboxConnect, storageStatus, StorageConflict,
  testDropboxConnection,
} from './admin.js';
import { connectionClient, dropboxSetup, type StorageConnectionRow } from './connections.js';
import { sealStorageSecret } from './crypto.js';

/**
 * Permit Dropbox administration end to end against the real `permit`
 * schema, with Dropbox itself replaced by a fake HTTP endpoint. No real
 * provider, account, token or network is involved.
 */

const CEO = '71000000-0000-4000-8000-000000000001';
const OTHER = '71000000-0000-4000-8000-000000000002';
let sessionId = '';
let otherSessionId = '';
let db: PGlite;

const originalQuery = Pool.prototype.query;
const originalConnect = Pool.prototype.connect;
const originalFetch = globalThis.fetch;

const provider = {
  exchanges: [] as URLSearchParams[],
  revocations: 0,
  accessCounter: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

before(async () => {
  db = await installedDatabase();
  await db.query(`INSERT INTO permit.users (id, email) VALUES ($1, 'ceo@example.test'), ($2, 'other@example.test')`, [CEO, OTHER]);
  sessionId = (await db.query<{ id: string }>(
    `INSERT INTO permit.user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
    [CEO, createHash('sha256').update('ceo-session').digest()])).rows[0]!.id;
  otherSessionId = (await db.query<{ id: string }>(
    `INSERT INTO permit.user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
    [CEO, createHash('sha256').update('second-ceo-session').digest()])).rows[0]!.id;

  // The application's pool, routed into the PGlite database.
  Pool.prototype.query = ((text: string, params?: unknown[]) => db.query(text, params)) as unknown as typeof Pool.prototype.query;
  Pool.prototype.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  }) as unknown as PoolClient) as typeof Pool.prototype.connect;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/oauth2/token') {
      const body = new URLSearchParams(String(init?.body));
      provider.exchanges.push(body);
      provider.accessCounter += 1;
      return json({
        access_token: `sl.synthetic-access-${provider.accessCounter}`, refresh_token: 'synthetic-refresh-token',
        expires_in: 14_400, scope: 'account_info.read files.metadata.read files.content.write files.content.read',
      });
    }
    if (url.pathname === '/2/users/get_current_account') return json({ account_id: 'dbid:synthetic', email: 'files@example.test' });
    if (url.pathname === '/2/files/create_folder_v2') return json({ metadata: {} });
    if (url.pathname === '/2/files/get_metadata') return json({ '.tag': 'folder' });
    if (url.pathname === '/2/auth/token/revoke') { provider.revocations += 1; return json({}); }
    return json({ error: 'unexpected' }, 400);
  }) as typeof fetch;
});

after(async () => {
  Pool.prototype.query = originalQuery;
  Pool.prototype.connect = originalConnect;
  globalThis.fetch = originalFetch;
  await db?.close();
});

beforeEach(() => {
  provider.exchanges = [];
});

function stateFrom(url: string): string {
  return new URL(url).searchParams.get('state')!;
}

test('connect start stores only a hash of the state and a sealed PKCE verifier; the URL carries the S256 challenge', async () => {
  const { authorizationUrl } = await startDropboxConnect(CEO, sessionId);
  const url = new URL(authorizationUrl);
  assert.equal(url.origin, 'https://www.dropbox.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('token_access_type'), 'offline');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3001/api/v1/cms/dropbox/callback');
  const state = url.searchParams.get('state')!;
  const stored = (await db.query<{ state_hash: Uint8Array; verifier_envelope: string }>(
    'SELECT state_hash, verifier_envelope FROM permit.storage_oauth_states')).rows;
  assert.ok(stored.some((row) => Buffer.from(row.state_hash).equals(createHash('sha256').update(state).digest())));
  assert.ok(stored.every((row) => !row.verifier_envelope.includes(state)));
  assert.ok(stored.every((row) => /"tag":/.test(row.verifier_envelope)), 'authenticated-encryption envelope');
});

test('a forged, foreign-session, replayed or expired callback is refused; the genuine one binds PKCE', async () => {
  const { authorizationUrl } = await startDropboxConnect(CEO, sessionId);
  const state = stateFrom(authorizationUrl);
  const challenge = new URL(authorizationUrl).searchParams.get('code_challenge');

  await assert.rejects(completeDropboxConnect(CEO, sessionId, 'x'.repeat(43), 'code'), StorageConflict);
  await assert.rejects(completeDropboxConnect(CEO, otherSessionId, state, 'code'), StorageConflict, 'bound to the starting session');
  await assert.rejects(completeDropboxConnect(OTHER, sessionId, state, 'code'), StorageConflict, 'bound to the starting user');

  await completeDropboxConnect(CEO, sessionId, state, 'synthetic-code');
  const exchange = provider.exchanges.find((body) => body.get('grant_type') === 'authorization_code')!;
  const verifier = exchange.get('code_verifier')!;
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge, 'the verifier matches the challenge');
  assert.equal(exchange.get('client_secret'), 'synthetic-client-secret-not-real', 'the secret only travels server-to-provider');

  await assert.rejects(completeDropboxConnect(CEO, sessionId, state, 'synthetic-code'), StorageConflict, 'single use');

  const late = await startDropboxConnect(CEO, sessionId);
  await db.query(`UPDATE permit.storage_oauth_states SET expires_at = now() - interval '1 minute'`);
  await assert.rejects(completeDropboxConnect(CEO, sessionId, stateFrom(late.authorizationUrl), 'code'), StorageConflict);
});

test('tokens are stored sealed only; status, audit and API views never contain them', async () => {
  const row = (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections')).rows[0]!;
  assert.equal(row.status, 'connected');
  assert.doesNotMatch(row.credentials ?? '', /sl\.synthetic-access|synthetic-refresh-token/);
  const status = JSON.stringify(await storageStatus());
  assert.doesNotMatch(status, /sl\.synthetic|synthetic-refresh|credentials|"tag"/);
  const audit = JSON.stringify((await db.query('SELECT * FROM permit.storage_audit_events')).rows);
  assert.doesNotMatch(audit, /sl\.synthetic|synthetic-refresh/);
  assert.match(audit, /CONNECTED/);
});

test('an expiring access token is refreshed server-side and re-sealed under a new token revision', async () => {
  const row = (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections')).rows[0]!;
  const setup = dropboxSetup()!;
  const expiring = sealStorageSecret({ accessToken: 'sl.old', refreshToken: 'synthetic-refresh-token', expiresAt: Date.now() - 1000 },
    `connection:${row.id}`, setup.key);
  await db.query('UPDATE permit.storage_connections SET credentials = $2 WHERE id = $1', [row.id, expiring]);
  const current = (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections')).rows[0]!;
  await connectionClient(current);
  assert.equal(provider.exchanges.at(-1)?.get('grant_type'), 'refresh_token');
  const after = (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections')).rows[0]!;
  assert.equal(after.token_revision, current.token_revision + 1);
  assert.notEqual(after.credentials, expiring);
});

test('disconnect is refused while the connection is active or any file depends on it', async () => {
  const connection = (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections')).rows[0]!;
  await testDropboxConnection(CEO, connection.id);
  const selection = (await db.query<{ revision: number }>('SELECT revision FROM permit.storage_selection')).rows[0]!;
  await selectDropbox(CEO, selection.revision, true, connection.id);
  let latest = (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections')).rows[0]!;
  await assert.rejects(disconnectDropbox(CEO, connection.id, latest.revision), StorageConflict, 'active');

  const deactivatedAt = (await db.query<{ revision: number }>('SELECT revision FROM permit.storage_selection')).rows[0]!;
  await selectDropbox(CEO, deactivatedAt.revision, false);
  await db.query(
    `INSERT INTO permit.file_registry (provider, connection_id, logical_key, remote_path, category, original_filename,
       mime_type, size_bytes, sha256, created_by)
     VALUES ('dropbox', $1, 'cms/dependent.png', 'Digital Permit System/Branding/dependent.png', 'BRANDING', 'x.png',
       'image/png', 10, $2, $3)`, [connection.id, 'a'.repeat(64), CEO]);
  latest = (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections')).rows[0]!;
  await assert.rejects(disconnectDropbox(CEO, connection.id, latest.revision), StorageConflict, 'files depend on it');
  const refused = await db.query(`SELECT 1 FROM permit.storage_audit_events WHERE event_type = 'DISCONNECT_REFUSED'`);
  assert.ok(refused.rows.length > 0);
  assert.equal(provider.revocations, 0, 'nothing was revoked');

  // Only once nothing depends on it may it be disconnected (test cleanup as superuser).
  await db.query(`DELETE FROM permit.file_registry WHERE logical_key = 'cms/dependent.png'`);
  latest = (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections')).rows[0]!;
  await disconnectDropbox(CEO, connection.id, latest.revision);
  const gone = (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections')).rows[0]!;
  assert.equal(gone.status, 'disconnected');
  assert.equal(gone.credentials, null);
  assert.equal(provider.revocations, 1);
});
