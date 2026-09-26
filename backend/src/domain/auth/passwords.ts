import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { env } from '../../config/env.js';
import { AuthWorkLimiter } from './authWork.js';
import { bcryptCompare, closeBcryptWorker } from './bcryptWorker.js';

/**
 * Password hashing and verification for Permit-owned authentication.
 *
 * Every credential this application writes is Argon2id, with the same
 * parameters as the E-Set ESDMS security baseline (m=64 MiB, t=3, p=4).
 * The one other scheme ever accepted is `bcrypt_legacy`: a hash imported
 * from the standalone database's Supabase Auth. It is verified once and
 * replaced by Argon2id on that same successful sign-in (see
 * domain/auth/login.ts). Any other stored value verifies as FALSE - an
 * unknown format never authenticates and is never guessed at.
 *
 * No function here logs, returns or stores a plaintext password.
 */

export type PasswordScheme = 'argon2id' | 'bcrypt_legacy';

export interface StoredCredential {
  hash: string | null;
  scheme: string | null;
}

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

/** Supabase Auth's bcrypt output: `$2a$`/`$2b$`/`$2y$`, two-digit cost, 53-character salt+digest. */
const BCRYPT_FORMAT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * Supabase Auth hashes at bcrypt's default cost, 10. It is the only cost
 * accepted, so no imported row can make a sign-in attempt arbitrarily
 * expensive; an imported hash at another cost is refused by the import plan
 * (`unsupported_hash`) before cutover and never reaches bcrypt here.
 */
export const LEGACY_BCRYPT_COST = 10;

export function isSupportedLegacyHash(hash: string): boolean {
  return BCRYPT_FORMAT.test(hash) && Number(hash.slice(4, 6)) === LEGACY_BCRYPT_COST;
}

/*
  BOUNDED PASSWORD WORK (A05-P1, pre-production re-audit).

  Every KDF operation in this process runs through one admission limiter
  (authWork.ts): Argon2id hashing and verification on libuv's threadpool,
  legacy bcrypt in its own worker thread (bcryptWorker.ts). Neither runs on
  the main event loop, and attacker-controlled traffic can never have more
  than AUTH_KDF_CONCURRENCY of them running or AUTH_KDF_QUEUE_MAX waiting.

  ONE KDF PER ATTEMPT. A verification performs exactly one expensive
  operation: the account's own verifier (Argon2id, or bcrypt at cost 10),
  or - when there is nothing verifiable (no credential, unsupported or
  malformed hash) - one Argon2id verification against a dummy hash of
  random bytes, at the same parameters as every real Argon2id credential.
  The only second KDF is the Argon2id re-hash after a CORRECT legacy
  password, inside the same admission slot.

  The time difference between the verifiers is hidden by a non-CPU floor on
  failed sign-ins (login.ts, failureFloorMs below), not by extra work.
*/
export const authWork = new AuthWorkLimiter(env.AUTH_KDF_CONCURRENCY, env.AUTH_KDF_QUEUE_MAX, env.AUTH_KDF_QUEUE_TIMEOUT_MS);

/** Test-visible count of expensive operations actually performed. */
export const kdfCounters = { argon2Verify: 0, argon2Hash: 0, bcryptCompare: 0 };

type Kind = 'argon2' | 'bcrypt';
const SAMPLES = 50;
const durations: Record<Kind, number[]> = { argon2: [], bcrypt: [] };
function record(kind: Kind, startedAt: number): void {
  const list = durations[kind];
  list.push(performance.now() - startedAt);
  if (list.length > SAMPLES) list.shift();
}
function p95(list: number[]): number {
  if (!list.length) return 0;
  return [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * 0.95))]!;
}

/**
 * The minimum duration of a FAILED sign-in: 1.25 x the slower verifier's
 * recent p95 on this process's own hardware, capped at
 * AUTH_FAILURE_FLOOR_MAX_MS. Measured, not guessed: it follows the machine
 * and its load, so a fast Argon2id failure and a slower bcrypt failure both
 * end at the same point.
 */
export function failureFloorMs(): number {
  return Math.min(env.AUTH_FAILURE_FLOOR_MAX_MS, Math.ceil(1.25 * Math.max(p95(durations.argon2), p95(durations.bcrypt))));
}

async function argon2Verify(hash: string, password: string): Promise<boolean> {
  const startedAt = performance.now();
  kdfCounters.argon2Verify += 1;
  try { return await argon2.verify(hash, password); } catch { return false; } finally { record('argon2', startedAt); }
}

async function legacyVerify(hash: string, password: string): Promise<boolean> {
  const startedAt = performance.now();
  kdfCounters.bcryptCompare += 1;
  try { return await bcryptCompare(password, hash); } catch { return false; } finally { record('bcrypt', startedAt); }
}

async function argon2Hash(password: string): Promise<string> {
  kdfCounters.argon2Hash += 1;
  return argon2.hash(password, ARGON2_OPTIONS);
}

let dummy: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummy ??= argon2Hash(randomBytes(32).toString('hex')).catch((error: unknown) => { dummy = undefined; throw error; });
  return dummy;
}

export interface PasswordWorkOptions {
  /** Aborted when the client goes away: a queued request leaves the queue. */
  signal?: AbortSignal | undefined;
}

export async function hashPassword(password: string, options: PasswordWorkOptions = {}): Promise<string> {
  return authWork.run(() => argon2Hash(password), options.signal);
}

export interface VerificationResult {
  ok: boolean;
  /** True only for a correct legacy password: the caller must replace the hash with Argon2id. */
  needsUpgrade: boolean;
  /** With `rehashLegacy`, the Argon2id replacement computed in the same admission slot. */
  upgradedHash?: string;
}

export async function verifyPassword(stored: StoredCredential | null, password: string,
  options: PasswordWorkOptions & { rehashLegacy?: boolean } = {}): Promise<VerificationResult> {
  return authWork.run(async () => {
    if (stored?.scheme === 'argon2id' && stored.hash?.startsWith('$argon2id$')) {
      return { ok: await argon2Verify(stored.hash, password), needsUpgrade: false };
    }
    if (stored?.scheme === 'bcrypt_legacy' && stored.hash && isSupportedLegacyHash(stored.hash)
        && Buffer.byteLength(password, 'utf8') <= 72) {
      const ok = await legacyVerify(stored.hash, password);
      return { ok, needsUpgrade: ok, ...(ok && options.rehashLegacy ? { upgradedHash: await argon2Hash(password) } : {}) };
    }
    // Nothing verifiable (no credential, unsupported or malformed hash):
    // one dummy Argon2id verification, then fail closed.
    await argon2Verify(await dummyHash(), password);
    return { ok: false, needsUpgrade: false };
  }, options.signal);
}

/**
 * Warm-up at process start: creates the dummy hash and measures both
 * verifiers once, through the same admission limiter, so the failure floor
 * covers the slower verifier before the first real sign-in.
 */
export async function preparePasswordWork(): Promise<void> {
  const probe = randomBytes(16).toString('hex');
  await authWork.run(async () => { await argon2Verify(await dummyHash(), probe); });
  await authWork.run(async () => { await legacyVerify(CALIBRATION_BCRYPT_HASH, probe); });
}
// A well-formed cost-10 bcrypt string of random characters, built per process: bcrypt does its
// full cost-10 work before comparing, so it calibrates timing without being any credential.
const BCRYPT_ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CALIBRATION_BCRYPT_HASH = `$2b$10$${[...randomBytes(53)].map((byte) => BCRYPT_ALPHABET[byte % 64]).join('')}`;

/** Shutdown: refuse queued work and stop the bcrypt worker. */
export async function closePasswordWork(): Promise<void> {
  authWork.close();
  await closeBcryptWorker();
}
