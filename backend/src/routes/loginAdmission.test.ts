import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { Pool, type PoolClient } from 'pg';
import type { PGlite } from '@electric-sql/pglite';

/*
  A05-P1 at the HTTP boundary: password-work admission, no attacker-
  triggered account lockout, the short per-address burst limit,
  forwarded-header spoofing, disconnects and shutdown. Tiny capacities so
  saturation is exact; a trusted loopback proxy so each request can carry
  its own client address.
*/
process.env.AUTH_KDF_CONCURRENCY = '1';
process.env.AUTH_KDF_QUEUE_MAX = '1';
process.env.RATE_LIMIT_LOGIN_MAX = '3';
process.env.RATE_LIMIT_LOGIN_WINDOW_MS = '3000';
process.env.TRUST_PROXY_CIDRS = 'loopback';
const { installedDatabase } = await import('../test/permitSchemaFixtures.js');
const { createApp } = await import('../app.js');
const { authWork, closePasswordWork, hashPassword, kdfCounters, verifyPassword } = await import('../domain/auth/passwords.js');

let db: PGlite; let server: http.Server; let url = '';
const originals = { query: Pool.prototype.query, connect: Pool.prototype.connect };
const PASSWORD = 'FAKE-admission-password';
const origin = 'http://localhost:5173';
const USERS = { active: '10000000-0000-4000-8000-0000000000a1', legacy: '10000000-0000-4000-8000-0000000000a2', ceo: '10000000-0000-4000-8000-0000000000a3' };
let ip = 0;
const next = () => `198.51.100.${(ip += 1)}`;
const login = (email: string, password = 'FAKE-wrong', headers: Record<string, string> = {}, signal?: AbortSignal) =>
  fetch(`${url}/auth/login`, { method: 'POST', ...(signal ? { signal } : {}), headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': next(), ...headers }, body: JSON.stringify({ email, password }) });
const hold = () => { let release!: () => void; const held = authWork.run(() => new Promise<void>((r) => { release = r; })); return { held, release: () => { release(); return held; } }; };
const until = async (check: () => boolean) => { for (let i = 0; i < 500 && !check(); i += 1) await new Promise((r) => setTimeout(r, 2)); assert.ok(check()); };

before(async () => {
  db = await installedDatabase();
  await db.query('INSERT INTO permit.users(id,email,password_hash,password_scheme) VALUES($1,$2,$3,$4),($5,$6,$7,$8)',
    [USERS.active, 'active@example.invalid', await hashPassword(PASSWORD), 'argon2id', USERS.legacy, 'legacy@example.invalid', await bcrypt.hash(PASSWORD, 10), 'bcrypt_legacy']);
  await db.query('INSERT INTO permit.users(id,email,password_hash,password_scheme) VALUES($1,$2,$3,$4)', [USERS.ceo, 'ceo@example.invalid', await hashPassword(PASSWORD), 'argon2id']);
  await db.query("INSERT INTO permit.app_user_access(user_id,state) VALUES($1,'ACTIVE'),($2,'ACTIVE'),($3,'ACTIVE')", [USERS.active, USERS.legacy, USERS.ceo]);
  await db.query("INSERT INTO permit.privileged_identities(user_id,display_name) VALUES($1,'Synthetic CEO')", [USERS.ceo]);
  await db.query("INSERT INTO permit.privileged_access_events(user_id,role,action,actor_user_id,reason) VALUES($1,'CEO','GRANTED',NULL,'initial bootstrap')", [USERS.ceo]);
  await db.exec('SET ROLE permit_runtime; SET search_path=pg_catalog,permit,pg_temp');
  Pool.prototype.query = (async (text: unknown, params?: unknown[]) => db.query(String(text), params)) as typeof Pool.prototype.query;
  Pool.prototype.connect = (async () => ({ query: db.query.bind(db), release: () => {} }) as unknown as PoolClient) as typeof Pool.prototype.connect;
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
after(async () => {
  Pool.prototype.query = originals.query; Pool.prototype.connect = originals.connect;
  await new Promise<void>((r) => server?.close(() => r())); await db?.close();
});

test('saturated password work: one queues, the next gets an immediate generic 429 - identical for real and unknown emails', async () => {
  const slot = hold();
  const queued = login('active@example.invalid');
  await until(() => authWork.stats().queued === 1);
  const bodies = new Set<string>();
  for (const email of ['active@example.invalid', 'ceo@example.invalid', 'nobody@example.invalid']) {
    const started = performance.now();
    const res = await login(email);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '2');
    bodies.add(JSON.stringify([await res.text(), res.headers.get('ratelimit'), res.headers.get('ratelimit-policy')]));
    assert.ok(performance.now() - started < 500, 'refused at once, not queued');
  }
  assert.equal(bodies.size, 1, 'the refusal does not depend on the email');
  assert.match([...bodies][0]!, /sign_in_busy/);
  await slot.release();
  assert.equal((await queued).status, 401, 'the queued attempt then completes normally');
  assert.deepEqual(authWork.stats(), { active: 0, queued: 0 });
});

test('a client that disconnects while queued leaves the queue; its KDF never runs', async () => {
  const slot = hold();
  const abandon = new AbortController();
  const gone = login('abandon@example.invalid', 'FAKE-wrong', {}, abandon.signal).catch((e: Error) => e.name);
  await until(() => authWork.stats().queued === 1);
  abandon.abort();
  assert.equal(await gone, 'AbortError');
  await until(() => authWork.stats().queued === 0);
  await slot.release();
  assert.deepEqual(authWork.stats(), { active: 0, queued: 0 });
});

test('logout and ordinary requests are served while password work is saturated; sign-in succeeds once capacity frees', async () => {
  const ok = await login('active@example.invalid', PASSWORD);
  assert.equal(ok.status, 204);
  const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
  const slot = hold();
  const me = await fetch(`${url}/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200, 'reads need no password work');
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/ready`)).status, 200);
  const out = await fetch(`${url}/auth/logout`, { method: 'POST', headers: { cookie, origin } });
  assert.ok([200, 204].includes(out.status), `logout ${out.status}`);
  await slot.release();
  assert.equal((await login('active@example.invalid', PASSWORD)).status, 204);
});

const failMany = async (email: string, n: number) => {
  for (let i = 0; i < n; i += 1) assert.equal((await login(email, `FAKE-guess-${i}`)).status, 401, 'every failure is verified, never pre-refused');
};

test('no attacker-triggered lockout: after many failures from many addresses the correct password still reaches verification', async () => {
  await failMany('active@example.invalid', 30);
  const variant = await login('  ACTIVE@example.INVALID ', PASSWORD);
  assert.equal(variant.status, 204, 'correct password from a clean address signs in');
  assert.equal(variant.headers.get('retry-after'), null);
  assert.doesNotMatch(variant.headers.get('ratelimit') ?? '', /remaining=0/);
});

test('the CEO account behaves the same: failures sent by others never block the correct CEO password', async () => {
  await failMany('ceo@example.invalid', 25);
  const ok = await login('ceo@example.invalid', PASSWORD);
  assert.equal(ok.status, 204);
  const me = await fetch(`${url}/auth/me`, { headers: { cookie: ok.headers.get('set-cookie')!.split(';')[0]! } });
  assert.deepEqual((await me.json() as { privilegedRoles: string[] }).privilegedRoles, ['CEO']);
});

test('aborted attempts against an account run no KDF and leave nothing that blocks its owner', async () => {
  const slot = hold();
  const before = { ...kdfCounters };
  for (let i = 0; i < 20; i += 1) {
    const abandon = new AbortController();
    const gone = login('active@example.invalid', 'FAKE-wrong', {}, abandon.signal).catch((e: Error) => e.name);
    await until(() => authWork.stats().queued === 1);
    abandon.abort();
    assert.equal(await gone, 'AbortError');
    await until(() => authWork.stats().queued === 0);
  }
  await slot.release();
  assert.deepEqual(kdfCounters, before, 'no password work for abandoned attempts');
  assert.equal((await login('active@example.invalid', PASSWORD)).status, 204);
  assert.deepEqual(authWork.stats(), { active: 0, queued: 0 });
});

const burst = async (headers: Record<string, string>, n = 5) =>
  Promise.all(Array.from({ length: n }, (_, i) => login(`burst-${i}-${Math.random()}@example.invalid`, 'FAKE-wrong', headers)
    .then(async (r) => (await r.json() as { error: string }).error)));
const limited = (errors: string[]) => errors.filter((e) => e === 'rate_limited').length;

test('per-address burst limit: a source beyond the burst is refused briefly, then admitted again', async () => {
  const source = { 'x-forwarded-for': '203.0.113.50' };
  const errors = await burst(source);
  assert.equal(limited(errors), 2, `3 unsuccessful attempts pass, the rest are refused: ${errors}`);
  const refused = await login('late@example.invalid', 'FAKE-wrong', source);
  const retryAfter = Number(refused.headers.get('retry-after'));
  assert.equal(refused.status, 429);
  assert.ok(retryAfter >= 1 && retryAfter <= 3, `short Retry-After, not a long lockout: ${retryAfter}`);
  await new Promise((r) => setTimeout(r, retryAfter * 1000 + 200));
  assert.notEqual((await (await login('later@example.invalid', 'FAKE-wrong', source)).json() as { error: string }).error, 'rate_limited');
});

test('successful sign-ins do not consume the burst budget (shared office NAT)', async () => {
  const office = { 'x-forwarded-for': '203.0.113.60' };
  for (let i = 0; i < 6; i += 1) assert.equal((await login('active@example.invalid', PASSWORD, office)).status, 204);
});

test('spoofed X-Forwarded-For prefixes cannot mint new per-address buckets behind a trusted proxy', async () => {
  const spoofed = await Promise.all(Array.from({ length: 5 }, (_, i) => login(`spoof-${i}@example.invalid`, 'FAKE-wrong', { 'x-forwarded-for': `10.9.${i}.1, 192.0.2.${i}, 203.0.113.9` })
    .then(async (r) => (await r.json() as { error: string }).error)));
  assert.equal(limited(spoofed), 2, 'the proxy-appended address is the key, not the spoofed prefix');
});

test('a non-IP forwarded value never becomes a new limiter identity', async () => {
  const garbage = await Promise.all(Array.from({ length: 5 }, (_, i) => login(`junk-${i}@example.invalid`, 'FAKE-wrong', { 'x-forwarded-for': `not-an-ip-${i}-${Math.random()}` })
    .then(async (r) => (await r.json() as { error: string }).error)));
  assert.equal(limited(garbage), 2, 'malformed values all fall back to the one trusted peer bucket');
  const ipv6 = await Promise.all(Array.from({ length: 5 }, (_, i) => login(`v6-${i}@example.invalid`, 'FAKE-wrong', { 'x-forwarded-for': `2001:db8:0:${i}::${i + 1}` })
    .then(async (r) => (await r.json() as { error: string }).error)));
  assert.equal(limited(ipv6), 2, 'addresses in one IPv6 /56 share one bucket');
});

test('two simultaneous correct legacy sign-ins leave one valid Argon2id credential (no corruption)', async () => {
  const results = await Promise.all([login('legacy@example.invalid', PASSWORD), login('legacy@example.invalid', PASSWORD)]);
  const statuses = results.map((r) => r.status).sort();
  assert.ok(statuses.includes(204), `at least one succeeds: ${statuses}`);
  const row = (await db.query<{ password_hash: string; password_scheme: string }>('SELECT password_hash, password_scheme FROM users WHERE id=$1', [USERS.legacy])).rows[0]!;
  assert.equal(row.password_scheme, 'argon2id');
  assert.equal((await verifyPassword({ hash: row.password_hash, scheme: row.password_scheme }, PASSWORD)).ok, true);
  assert.equal((await login('legacy@example.invalid', PASSWORD)).status, 204);
});

test('shutdown: queued sign-ins are refused, running work finishes, new work is refused', async () => {
  const slot = hold();
  const queued = login('shutdown-a@example.invalid');
  await until(() => authWork.stats().queued === 1);
  await closePasswordWork();
  const refused = await queued;
  assert.equal(refused.status, 429);
  assert.match(await refused.text(), /sign_in_busy/);
  const late = await login('shutdown-b@example.invalid', PASSWORD);
  assert.equal(late.status, 429);
  assert.match(await late.text(), /sign_in_busy/);
  await slot.release();
  assert.deepEqual(authWork.stats(), { active: 0, queued: 0 });
});
