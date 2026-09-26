import { createHash, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';
import { dropboxSetup } from '../storage/connections.js';
import { sealStorageSecret } from '../storage/crypto.js';
import { dropboxContentHash } from '../storage/dropbox.js';
import { installedDatabase } from './permitSchemaFixtures.js';

/**
 * Deterministic harness for Permit Dropbox lifecycle interleavings: the
 * application's pool routed into a real `permit` schema (PGlite), and a fake
 * Dropbox HTTP API whose calls can be held at named BARRIERS. A test arms a
 * barrier, starts an operation, awaits `reached` (the operation is now
 * blocked inside that provider call, outside any transaction), interleaves
 * other operations, then calls `release`. No sleeps decide correctness.
 *
 * Only synthetic tokens and identities; no network.
 */

export const CEO = '73000000-0000-4000-8000-000000000001';
export const ACCOUNT = 'dbid:synthetic-lifecycle';

interface Gate { reached: Promise<void>; release: (outcome?: 'ok' | 'fail' | 'lose') => void }
interface Armed { signal: () => void; wait: Promise<'ok' | 'fail' | 'lose'> }

export class LifecycleWorld {
  db!: PGlite;
  readonly files = new Map<string, { id: string; bytes: Buffer }>();
  readonly folders = new Set<string>();
  readonly calls: string[] = [];
  /** A revoked access token is refused by Dropbox with 401, as in production. */
  readonly revokedTokens = new Set<string>();
  readonly tokenAccounts = new Map<string, string>();
  private readonly armed = new Map<string, Armed[]>();
  private originals = { query: Pool.prototype.query, connect: Pool.prototype.connect, fetch: globalThis.fetch };
  private accessCounter = 0;
  failNext = new Map<string, number>();

  async start(): Promise<void> {
    this.db = await installedDatabase();
    await this.db.query(`INSERT INTO permit.users (id, email) VALUES ($1, 'lifecycle.ceo@example.test')`, [CEO]);
    const db = this.db;
    Pool.prototype.query = ((text: string, params?: unknown[]) => db.query(text, params)) as unknown as typeof Pool.prototype.query;
    Pool.prototype.connect = (async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {},
    }) as unknown as PoolClient) as typeof Pool.prototype.connect;
    globalThis.fetch = this.fetch.bind(this) as typeof fetch;
  }

  async stop(): Promise<void> {
    Pool.prototype.query = this.originals.query;
    Pool.prototype.connect = this.originals.connect;
    globalThis.fetch = this.originals.fetch;
    await this.db?.close();
  }

  /** Holds the next call to `endpoint` (e.g. '/2/auth/token/revoke') until released. */
  gate(endpoint: string): Gate {
    let signal!: () => void;
    const reached = new Promise<void>((resolve) => { signal = resolve; });
    let release!: (outcome?: 'ok' | 'fail' | 'lose') => void;
    const wait = new Promise<'ok' | 'fail' | 'lose'>((resolve) => { release = (outcome = 'ok') => resolve(outcome); });
    this.armed.set(endpoint, [...(this.armed.get(endpoint) ?? []), { signal, wait }]);
    return { reached, release };
  }

  /** A connected, healthy, sealed connection row (optionally selected). */
  async connection(options: { select?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const tokens = { accessToken: `sl.synthetic-${randomUUID()}`, refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3_600_000 };
    this.tokenAccounts.set(tokens.accessToken, `${ACCOUNT}-${id}`);
    await this.db.query(`INSERT INTO permit.storage_connections (id, provider, status, account_id, account_label, credentials, last_health_at)
      VALUES ($1, 'dropbox', 'connected', $2, 'Synthetic', $3, now())`,
    [id, `${ACCOUNT}-${id}`, sealStorageSecret(tokens, `connection:${id}`, dropboxSetup()!.key)]);
    if (options.select) await this.db.query('UPDATE permit.storage_selection SET connection_id = $1 WHERE singleton', [id]);
    return id;
  }

  /** A live CEO session, as the OAuth connect flow requires. */
  async session(): Promise<string> {
    return (await this.db.query<{ id: string }>(`INSERT INTO permit.user_sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, now() + interval '1 hour') RETURNING id`, [CEO, createHash('sha256').update(randomUUID()).digest()])).rows[0]!.id;
  }

  async deselect(): Promise<void> {
    await this.db.query('UPDATE permit.storage_selection SET connection_id = NULL WHERE singleton');
  }

  async row(id: string) {
    return (await this.db.query<{ status: string; revision: number; credentials: string | null; last_error_code: string | null }>(
      'SELECT status, revision, credentials, last_error_code FROM permit.storage_connections WHERE id = $1', [id])).rows[0]!;
  }

  async selectionRevision(): Promise<number> {
    return (await this.db.query<{ revision: number }>('SELECT revision FROM permit.storage_selection')).rows[0]!.revision;
  }

  /** The A01 invariant: no reference-bearing registry row points at a connection without credentials. */
  async orphanedFiles(): Promise<number> {
    return (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM permit.file_registry f
      JOIN permit.storage_connections c ON c.id = f.connection_id
     WHERE f.state IN ('pending', 'ready') AND c.credentials IS NULL`)).rows[0]!.n
      + (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM permit.storage_selection s
      JOIN permit.storage_connections c ON c.id = s.connection_id WHERE c.credentials IS NULL`)).rows[0]!.n;
  }

  private async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const endpoint = url.pathname;
    this.calls.push(endpoint);
    const queue = this.armed.get(endpoint);
    let outcome: 'ok' | 'fail' | 'lose' = 'ok';
    if (queue?.length) {
      const gate = queue.shift()!;
      gate.signal();
      outcome = await gate.wait;
    }
    const failures = this.failNext.get(endpoint) ?? 0;
    if (failures > 0) { this.failNext.set(endpoint, failures - 1); outcome = 'fail'; }
    if (outcome === 'fail') throw new TypeError('synthetic network failure');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (endpoint !== '/oauth2/token' && this.revokedTokens.has(bearer)) return json({ error: 'invalid_access_token' }, 401);
    const args = (() => {
      const header = new Headers(init?.headers).get('Dropbox-API-Arg');
      if (header) return JSON.parse(header) as Record<string, unknown>;
      try { return JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>; } catch { return null; }
    })();
    const meta = (file: { id: string; bytes: Buffer }) => ({ '.tag': 'file', id: file.id, size: file.bytes.length, content_hash: dropboxContentHash(file.bytes) });
    let response: Response;
    switch (endpoint) {
      case '/oauth2/token':
        this.accessCounter += 1;
        response = json({ access_token: `sl.synthetic-refreshed-${this.accessCounter}`, refresh_token: 'synthetic-refresh', expires_in: 14_400 });
        break;
      case '/2/users/get_current_account':
        response = json({ account_id: this.accountFor ?? this.tokenAccounts.get(bearer) ?? ACCOUNT, email: 'files@example.test' });
        break;
      case '/2/files/create_folder_v2':
        if (this.folders.has(String(args?.path))) response = json({ error: { path: { '.tag': 'conflict' } } }, 409);
        else { this.folders.add(String(args?.path)); response = json({ metadata: {} }); }
        break;
      case '/2/files/get_metadata': {
        const path = String(args?.path);
        if (this.folders.has(path) || path === '/Digital Permit System') response = json({ '.tag': 'folder' });
        else {
          const file = path.startsWith('id:') ? [...this.files.values()].find((f) => f.id === path) : this.files.get(path);
          response = file ? json(meta(file)) : json({ error: { path: { '.tag': 'not_found' } } }, 409);
        }
        break;
      }
      case '/2/files/upload': {
        const path = String(args?.path);
        if (this.files.has(path)) { response = json({ error: { reason: { '.tag': 'conflict' } } }, 409); break; }
        const file = { id: `id:${randomUUID().replaceAll('-', '')}`, bytes: Buffer.from(init!.body as Uint8Array) };
        this.files.set(path, file);
        response = json(meta(file));
        break;
      }
      case '/2/files/download': {
        const file = [...this.files.values()].find((f) => f.id === args?.path);
        response = file ? new Response(file.bytes) : json({ error: { path: { '.tag': 'not_found' } } }, 409);
        break;
      }
      case '/2/auth/token/revoke':
        this.revokedTokens.add(bearer);
        response = new Response('', { status: 200 });   // Dropbox answers a revoke with an empty body
        break;
      default:
        response = json({ error: 'unexpected' }, 400);
    }
    if (outcome === 'lose') throw new TypeError('synthetic lost response (the provider applied the call)');
    return response;
  }

  /** Override the account id the provider reports (reconnect tests). */
  accountFor: string | null = null;
}

export const tinyPng = (seed: string) => {
  // A valid 1x1 PNG is not needed by managed storage (bytes are opaque there); keep a stable, distinct payload.
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), createHash('sha256').update(seed).digest()]);
};
