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

/**
 * Supabase Auth hashes at bcrypt's default cost, 10. It is the only cost
 * accepted: every sign-in spends exactly one bcrypt comparison at this cost
 * (see verifyPassword), so a legacy account at any other cost would be
 * distinguishable by timing, and a higher one would let a single imported
 * row make each attempt expensive. An imported hash at another cost is
 * refused by the import plan (`unsupported_hash`) before cutover.
 */
export const LEGACY_BCRYPT_COST = 10;

export function isSupportedLegacyHash(hash: string): boolean {
  return BCRYPT_FORMAT.test(hash) && Number(hash.slice(4, 6)) === LEGACY_BCRYPT_COST;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/*
  EQUAL COST (A05, pre-production audit). Every verification spends exactly
  one Argon2id verification and one bcrypt comparison at
  LEGACY_BCRYPT_COST - against the stored hash where the account has one of
  that scheme, otherwise against a dummy hash of random bytes nobody knows.
  An unknown email, a disabled account, an unsupported scheme, a wrong
  Argon2id password and a wrong legacy password therefore do the same work;
  what remains is scheduling noise (docs/SECURITY.md). No sleeps: padding
  with real work stays equal on any hardware.
*/
let dummies: Promise<{ argon2: string; bcrypt: string }> | undefined;
function dummyHashes() {
  dummies ??= (async () => {
    const secret = randomBytes(32).toString('hex');
    const [argon2Hash, bcryptHash] = await Promise.all([hashPassword(secret), bcrypt.hash(secret, LEGACY_BCRYPT_COST)]);
    return { argon2: argon2Hash, bcrypt: bcryptHash };
  })();
  return dummies;
}

export interface VerificationResult {
  ok: boolean;
  /** True only for a correct legacy password: the caller must replace the hash with Argon2id. */
  needsUpgrade: boolean;
}

export async function verifyPassword(stored: StoredCredential | null, password: string): Promise<VerificationResult> {
  const dummy = await dummyHashes();
  const argon2Hash = stored?.scheme === 'argon2id' && stored.hash?.startsWith('$argon2id$') ? stored.hash : null;
  const legacyHash = stored?.scheme === 'bcrypt_legacy' && stored.hash && isSupportedLegacyHash(stored.hash)
    && Buffer.byteLength(password, 'utf8') <= 72 ? stored.hash : null;
  const argon2Ok = await argon2.verify(argon2Hash ?? dummy.argon2, password).catch(() => false);
  const legacyOk = await bcrypt.compare(password, legacyHash ?? dummy.bcrypt).catch(() => false);
  if (argon2Hash) return { ok: argon2Ok, needsUpgrade: false };
  if (legacyHash) return { ok: legacyOk, needsUpgrade: legacyOk };
  // No usable credential, unknown scheme or malformed hash: fail closed.
  return { ok: false, needsUpgrade: false };
}
