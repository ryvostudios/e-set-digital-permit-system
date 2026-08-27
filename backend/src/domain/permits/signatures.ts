import type { QueryFn } from '../../db/pool.js';

/**
 * Authoritative digital signatures.
 *
 * A signature is never typed, chosen, or uploaded. It is produced as a
 * side effect of an authenticated workflow action: the applicant signs
 * by performing the authenticated submission, CRO by performing the
 * authenticated CRO authorization, HSE by performing the authenticated
 * HSE approval, and CRO fallback approval signs as CRO FALLBACK -
 * never as HSE. The identity printed is resolved here, server-side,
 * from `workforce_profiles` plus the signer's primary Team + Position
 * (their authoritative SIGNING DESIGNATION), and is then COPIED into
 * the signature row, so a later rename or a later change of primary
 * assignment cannot alter a document that was already signed.
 *
 * FAIL CLOSED: if a signer has no workforce profile, or their profile's
 * primary assignment is not one they currently hold, no signature can be
 * produced and the whole workflow transaction is rolled back. There is
 * deliberately no fallback to an email address, Supabase
 * `user_metadata`, a client-supplied name, or a client-supplied
 * position - each of those is either client-writable or not an identity
 * at all, and none may ever appear on a permit as a person's signature.
 *
 * The database enforces the same rules independently (migration 0016's
 * `permit_signature_authenticity_guard`): the signer must BE the
 * authenticated actor of the lifecycle event the signature belongs to,
 * the event must belong to the same permit, and each role is pinned to
 * the exact event type that can produce it.
 */

export const SIGNATURE_ROLES = ['APPLICANT', 'CRO', 'HSE', 'CRO_FALLBACK', 'RENEWAL'] as const;
export type SignatureRole = (typeof SIGNATURE_ROLES)[number];

export interface SigningIdentity {
  userId: string;
  displayName: string;
  companyCode: string;
  companyName: string;
  teamPositionId: string;
  teamName: string;
  positionName: string;
}

export interface PermitSignatureRow {
  id: string;
  permit_id: string;
  source_event_id: string;
  signature_role: SignatureRole;
  signer_user_id: string;
  signer_display_name: string;
  signer_team_position_id: string;
  signer_team_name: string;
  signer_position_name: string;
  signed_at: string;
  created_at: string;
}

/** Raised when a would-be signer has no usable authoritative signing identity. Callers turn this into a conflict outcome; it is never swallowed, and never substituted with a guessed name. */
export class SigningIdentityUnavailableError extends Error {
  constructor(public readonly userId: string) {
    super('No authoritative workforce signing identity is available for this user');
    this.name = 'SigningIdentityUnavailableError';
  }
}

/**
 * Resolves the authoritative signing identity for `userId`. The join
 * through `user_team_positions` re-proves, at signing time, that the
 * profile's primary Team + Position is an assignment this same user
 * CURRENTLY holds (`ended_at IS NULL`, migration 0019) - the same
 * invariant migration 0016's composite foreign key enforces
 * structurally, checked again here so a signature is never produced from
 * a profile whose assignment has since been ended or revoked. A
 * transferred employee signs with their new designation or not at all;
 * they never sign with a retired one.
 *
 * Note this resolves the SIGNING DESIGNATION only. Authorization is
 * unchanged and still comes solely from `authz/capabilities.ts`; holding
 * a primary Team + Position grants nothing.
 */
export async function resolveSigningIdentity(queryFn: QueryFn, userId: string): Promise<SigningIdentity> {
  const result = await queryFn<{
    display_name: string;
    company_code: string;
    company_name: string;
    primary_team_position_id: string;
    team_name: string;
    position_name: string;
  }>(
    `SELECT wp.display_name, wp.primary_team_position_id,
            c.code AS company_code, c.name AS company_name,
            t.name AS team_name, p.name AS position_name
       FROM workforce_profiles wp
       JOIN companies c ON c.id = wp.company_id
       JOIN user_team_positions utp
         ON utp.user_id = wp.user_id AND utp.team_position_id = wp.primary_team_position_id
        AND utp.ended_at IS NULL
       JOIN team_positions tp ON tp.id = wp.primary_team_position_id
       JOIN teams t ON t.id = tp.team_id
       JOIN positions p ON p.id = tp.position_id
      WHERE wp.user_id = $1`,
    [userId],
  );

  const row = result.rows[0];
  if (
    !row ||
    row.display_name.trim() === '' ||
    row.company_code.trim() === '' ||
    row.company_name.trim() === '' ||
    row.team_name.trim() === '' ||
    row.position_name.trim() === ''
  ) {
    throw new SigningIdentityUnavailableError(userId);
  }

  return {
    userId,
    displayName: row.display_name,
    companyCode: row.company_code,
    companyName: row.company_name,
    teamPositionId: row.primary_team_position_id,
    teamName: row.team_name,
    positionName: row.position_name,
  };
}

export interface RecordSignatureInput {
  permitId: string;
  /** The lifecycle event this signing act IS - the database checks that its actor is `actorUserId`. */
  sourceEventId: string;
  role: SignatureRole;
  /** Always the authenticated actor from `req.auth`, never a request body value. */
  actorUserId: string;
}

/**
 * Records one signature, inside the caller's already-open workflow
 * transaction, immediately after that action's lifecycle event was
 * inserted. `signed_at` is DB-authoritative (`now()` via the column
 * default), never an application or client clock.
 */
export async function recordPermitSignature(
  queryFn: QueryFn,
  input: RecordSignatureInput,
): Promise<PermitSignatureRow> {
  const identity = await resolveSigningIdentity(queryFn, input.actorUserId);
  const result = await queryFn<PermitSignatureRow>(
    `INSERT INTO permit_signatures (
       permit_id, source_event_id, signature_role, signer_user_id,
       signer_display_name, signer_team_position_id, signer_team_name, signer_position_name
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.permitId,
      input.sourceEventId,
      input.role,
      input.actorUserId,
      identity.displayName,
      identity.teamPositionId,
      identity.teamName,
      identity.positionName,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected a permit_signatures row after insert but got none');
  return row;
}

/**
 * Every signature recorded against `permitId`, in the true order the
 * signing actions happened (`permit_lifecycle_events.ordinal`, the
 * append-only insertion order - not a timestamp, which two acts inside
 * one transaction could share).
 */
export async function getPermitSignatures(
  queryFn: QueryFn,
  permitId: string,
): Promise<PermitSignatureRow[]> {
  const result = await queryFn<PermitSignatureRow>(
    `SELECT s.*
       FROM permit_signatures s
       JOIN permit_lifecycle_events e ON e.id = s.source_event_id
      WHERE s.permit_id = $1
      ORDER BY e.ordinal ASC`,
    [permitId],
  );
  return result.rows;
}

/** The frozen form of one signature as it appears in the immutable issued snapshot and on the PDF. */
export interface SnapshotSignature {
  role: SignatureRole;
  userId: string;
  displayName: string;
  designation: string;
  teamName: string;
  positionName: string;
  teamPositionId: string;
  signedAt: string;
  sourceEventId: string;
}

/**
 * The signature block frozen into an issued document. Every field is
 * nullable because not every permit is signed by every role: a permit
 * issued by CRO fallback approval has `croFallback` set and `hse` NULL -
 * a fallback approval NEVER produces an HSE signature - and a renewed
 * permit carries `renewal` alongside the signatures inherited from the
 * permit it renewed.
 */
export interface SnapshotSignatureSet {
  applicant: SnapshotSignature | null;
  cro: SnapshotSignature | null;
  hse: SnapshotSignature | null;
  croFallback: SnapshotSignature | null;
  renewal: SnapshotSignature | null;
}

export const EMPTY_SIGNATURE_SET: SnapshotSignatureSet = {
  applicant: null,
  cro: null,
  hse: null,
  croFallback: null,
  renewal: null,
};

function toSnapshotSignature(row: PermitSignatureRow): SnapshotSignature {
  return {
    role: row.signature_role,
    userId: row.signer_user_id,
    displayName: row.signer_display_name,
    // The printed designation - the signer's authoritative Team +
    // Position at the moment they signed, frozen as text.
    designation: `${row.signer_position_name}, ${row.signer_team_name}`,
    teamName: row.signer_team_name,
    positionName: row.signer_position_name,
    teamPositionId: row.signer_team_position_id,
    signedAt: new Date(row.signed_at).toISOString(),
    sourceEventId: row.source_event_id,
  };
}

/**
 * Folds a permit's signature rows into the snapshot's signature block.
 * Where a role legitimately signed more than once (an applicant who
 * submitted, was sent back for correction, and resubmitted), the LAST
 * such act before issuance is the one the issued document carries -
 * later rows simply overwrite earlier ones as the ordered list is
 * walked.
 */
export function buildSnapshotSignatureSet(
  rows: readonly PermitSignatureRow[],
  inherited: SnapshotSignatureSet = EMPTY_SIGNATURE_SET,
): SnapshotSignatureSet {
  const set: SnapshotSignatureSet = { ...inherited };
  for (const row of rows) {
    const signature = toSnapshotSignature(row);
    switch (row.signature_role) {
      case 'APPLICANT':
        set.applicant = signature;
        break;
      case 'CRO':
        set.cro = signature;
        break;
      case 'HSE':
        set.hse = signature;
        break;
      case 'CRO_FALLBACK':
        set.croFallback = signature;
        break;
      case 'RENEWAL':
        set.renewal = signature;
        break;
    }
  }
  return set;
}
