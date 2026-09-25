import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';

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

export function isSupportedLegacyHash(hash: string): boolean {
  return BCRYPT_FORMAT.test(hash) && Number(hash.slice(4, 6)) >= 4 && Number(hash.slice(4, 6)) <= 16;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

// A real Argon2id hash of random bytes nobody knows, computed once. Verifying
// against it when there is no usable credential keeps a missing, disabled or
// credential-less account indistinguishable by response time.
let dummyHash: Promise<string> | undefined;
async function spendEquivalentTime(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  await argon2.verify(await dummyHash, password).catch(() => false);
}

export interface VerificationResult {
  ok: boolean;
  /** True only for a correct legacy password: the caller must replace the hash with Argon2id. */
  needsUpgrade: boolean;
}

export async function verifyPassword(stored: StoredCredential | null, password: string): Promise<VerificationResult> {
  const fail = { ok: false, needsUpgrade: false };
  if (!stored?.hash || !stored.scheme) {
    await spendEquivalentTime(password);
    return fail;
  }
  if (stored.scheme === 'argon2id' && stored.hash.startsWith('$argon2id$')) {
    const ok = await argon2.verify(stored.hash, password).catch(() => false);
    return { ok, needsUpgrade: false };
  }
  if (stored.scheme === 'bcrypt_legacy' && isSupportedLegacyHash(stored.hash)) {
    if (Buffer.byteLength(password, 'utf8') > 72) { await spendEquivalentTime(password); return fail; }
    const ok = await bcrypt.compare(password, stored.hash).catch(() => false);
    return { ok, needsUpgrade: ok };
  }
  // Unknown scheme or malformed hash: fail closed, same cost as a miss.
  await spendEquivalentTime(password);
  return fail;
}
