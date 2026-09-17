/**
 * Backend generation of a company's machine-readable CODE.
 *
 * THE CODE IS NOT AUTHORITY, AND NOT CLIENT INPUT. A company's
 * authoritative database identity is its UUID; the code exists so audit
 * output, the employee API and the frozen permit applicant snapshot can
 * name a company in a stable, readable way. No request body carries a
 * code - the create-company schema accepts a display name and nothing
 * else - so a client can never propose `E_SET`, `CEO`, or any other
 * privileged-looking value. Nothing anywhere reads a code to decide
 * whether an action is permitted.
 *
 * IMMUTABLE AFTER CREATION. Migration 0035's
 * `companies_freeze_identity` trigger refuses any change to `id` or
 * `code`, and the runtime role holds UPDATE only on
 * `(name, deactivated_at)`, so a code cannot be rewritten by this
 * application even by mistake.
 *
 * THE SEEDED CODES ARE NEVER REGENERATED. `E_SET`, `ZPL` and `SGRE`
 * predate this module and are untouched by it; generation applies only
 * to companies created at runtime.
 */

/** Keeps a generated code comfortably inside the `companies.code` format bound. */
const MAX_CODE_LENGTH = 48;

/**
 * Normalizes a display name into the code alphabet migration 0035
 * enforces: `^[A-Z][A-Z0-9_]*$`.
 *
 *   "ABC Contractors"  -> "ABC_CONTRACTORS"
 *   "  acme-services " -> "ACME_SERVICES"
 *   "3M Solutions"     -> "C_3M_SOLUTIONS"   (a code must begin with a letter)
 *
 * NFKD runs first so an accented letter decomposes into a base letter
 * plus a combining mark; the mark is then not in `[A-Z0-9]` and is
 * folded away by the same pass that handles spaces and punctuation. A
 * name that normalizes to nothing at all (punctuation or non-Latin
 * script only) still receives a valid code through the `COMPANY`
 * fallback plus the uniqueness suffix - the display NAME remains the
 * real label in every screen and document, so no readability is lost.
 */
export function normalizeCompanyCode(displayName: string): string {
  const collapsed = displayName
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_CODE_LENGTH)
    .replace(/_+$/g, '');

  if (collapsed === '') return 'COMPANY';
  // The format constraint requires a leading letter; a name starting
  // with a digit is prefixed rather than rejected.
  return /^[A-Z]/.test(collapsed) ? collapsed : `C_${collapsed}`.slice(0, MAX_CODE_LENGTH);
}

/**
 * The candidate code for the Nth attempt at inserting a company.
 *
 * Attempt 0 is the plain normalized code; every later attempt appends an
 * ascending numeric suffix - `ABC_CONTRACTORS`, `ABC_CONTRACTORS_2`,
 * `ABC_CONTRACTORS_3`. Deterministic, readable, and stable for a given
 * attempt number.
 *
 * THIS IS A CANDIDATE, NOT A RESERVATION. Uniqueness is decided by the
 * database's UNIQUE constraint on `companies.code` when the INSERT runs,
 * never by a prior SELECT: two concurrent requests for the same name
 * both generate `ABC_CONTRACTORS`, one commits, and the other retries
 * with the next attempt. A read-then-write pre-check would let both pass
 * the check before either inserted.
 */
export function companyCodeCandidate(displayName: string, attempt: number): string {
  const base = normalizeCompanyCode(displayName);
  if (attempt === 0) return base;

  const suffix = `_${attempt + 1}`;
  // Keep the whole code inside the length bound by trimming the base,
  // never the suffix - dropping the suffix would reintroduce a collision.
  const room = MAX_CODE_LENGTH - suffix.length;
  const trimmed = base.slice(0, room).replace(/_+$/g, '');
  return `${trimmed === '' ? 'COMPANY' : trimmed}${suffix}`;
}

/** How many codes are tried before a create is reported as failed. */
export const COMPANY_CODE_ATTEMPTS = 25;

/** PostgreSQL's unique-violation SQLSTATE, the signal that a candidate was taken. */
export const UNIQUE_VIOLATION = '23505';

/** Whether a thrown database error is a unique violation. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Which unique index a violation came from, so a duplicate NAME can be
 * reported to the administrator as a duplicate name while a duplicate
 * generated CODE is retried silently. Both arrive as SQLSTATE 23505, and
 * confusing them would either retry forever on a duplicate name or
 * surface an internal code collision to the user as an error.
 */
export function uniqueViolationTarget(err: unknown): string | null {
  if (!isUniqueViolation(err)) return null;
  const constraint = (err as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : null;
}
