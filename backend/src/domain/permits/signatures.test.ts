import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../../db/pool.js';
import {
  buildSnapshotSignatureSet,
  EMPTY_SIGNATURE_SET,
  getPermitSignatures,
  recordPermitSignature,
  resolveSigningIdentity,
  SigningIdentityUnavailableError,
  type PermitSignatureRow,
} from './signatures.js';

interface ProfileRow {
  display_name: string;
  primary_team_position_id: string;
  team_name: string;
  position_name: string;
}

/**
 * A query stub that answers only the two shapes `signatures.ts` issues.
 * `profiles` stands in for the whole resolver join (workforce_profiles ->
 * user_team_positions -> team_positions -> teams/positions): a user
 * absent from it is exactly the fail-closed case - no profile row, OR a
 * profile whose primary assignment they do not actually hold, since the
 * real join returns nothing in both cases.
 */
function buildQuery(profiles: Record<string, ProfileRow>, inserted: Record<string, unknown>[] = []): QueryFn {
  return (async (text: string, params: unknown[] = []) => {
    const sql = text.trim();
    if (sql.includes('FROM workforce_profiles')) {
      const profile = profiles[params[0] as string];
      return { rows: profile ? [profile] : [] };
    }
    if (sql.startsWith('INSERT INTO permit_signatures')) {
      const [permitId, sourceEventId, role, signerUserId, displayName, teamPositionId, teamName, positionName] =
        params as string[];
      const row = {
        id: `signature-${inserted.length + 1}`,
        permit_id: permitId,
        source_event_id: sourceEventId,
        signature_role: role,
        signer_user_id: signerUserId,
        signer_display_name: displayName,
        signer_team_position_id: teamPositionId,
        signer_team_name: teamName,
        signer_position_name: positionName,
        signed_at: '2026-01-01T09:00:00.000Z',
        created_at: '2026-01-01T09:00:00.000Z',
      };
      inserted.push(row);
      return { rows: [row] };
    }
    if (sql.includes('FROM permit_signatures s')) {
      return { rows: inserted.filter((row) => (row as { permit_id: string }).permit_id === params[0]) };
    }
    throw new Error(`unhandled query: ${sql}`);
  }) as QueryFn;
}

const CRO_PROFILE: ProfileRow = {
  display_name: 'Bilal Ahmed',
  primary_team_position_id: 'tp-2',
  team_name: 'Operations',
  position_name: 'Control Room Operator',
};

function makeRow(overrides: Partial<PermitSignatureRow> = {}): PermitSignatureRow {
  return {
    id: 'signature-1',
    permit_id: 'permit-1',
    source_event_id: 'event-1',
    signature_role: 'APPLICANT',
    signer_user_id: 'applicant-1',
    signer_display_name: 'Ayesha Khan',
    signer_team_position_id: 'tp-1',
    signer_team_name: 'Maintenance Team A',
    signer_position_name: 'Technician',
    signed_at: '2026-01-01T08:00:00.000Z',
    created_at: '2026-01-01T08:00:00.000Z',
    ...overrides,
  };
}

test('resolveSigningIdentity returns the authoritative name and signing designation', async () => {
  const identity = await resolveSigningIdentity(buildQuery({ 'cro-1': CRO_PROFILE }), 'cro-1');
  assert.deepEqual(identity, {
    userId: 'cro-1',
    displayName: 'Bilal Ahmed',
    teamPositionId: 'tp-2',
    teamName: 'Operations',
    positionName: 'Control Room Operator',
  });
});

test('a missing workforce profile FAILS CLOSED - no email, metadata, or guessed name is substituted', async () => {
  await assert.rejects(
    resolveSigningIdentity(buildQuery({}), 'nobody@example.com'),
    (error: unknown) => {
      assert.ok(error instanceof SigningIdentityUnavailableError);
      assert.equal(error.userId, 'nobody@example.com');
      // The failure never carries a substitute identity of any kind.
      assert.doesNotMatch(error.message, /@example\.com/);
      return true;
    },
  );
});

test('a profile whose primary assignment the user does not hold FAILS CLOSED (the resolver join returns nothing)', async () => {
  // The resolver joins workforce_profiles to user_team_positions on BOTH
  // user_id and team_position_id, so a primary assignment that is not
  // actually held resolves to zero rows - the same fail-closed path as a
  // missing profile, never a partially-filled identity.
  const queryFn = buildQuery({});
  await assert.rejects(resolveSigningIdentity(queryFn, 'cro-1'), SigningIdentityUnavailableError);
});

test('a blank display name or designation FAILS CLOSED rather than printing an empty signature', async () => {
  for (const broken of [
    { ...CRO_PROFILE, display_name: '   ' },
    { ...CRO_PROFILE, team_name: '' },
    { ...CRO_PROFILE, position_name: '  ' },
  ]) {
    await assert.rejects(
      resolveSigningIdentity(buildQuery({ 'cro-1': broken }), 'cro-1'),
      SigningIdentityUnavailableError,
    );
  }
});

test('recordPermitSignature copies the identity of the AUTHENTICATED ACTOR - a caller cannot name anyone else', async () => {
  const inserted: Record<string, unknown>[] = [];
  const queryFn = buildQuery({ 'cro-1': CRO_PROFILE }, inserted);
  const row = await recordPermitSignature(queryFn, {
    permitId: 'permit-1',
    sourceEventId: 'event-9',
    role: 'CRO',
    actorUserId: 'cro-1',
  });

  assert.equal(row.signer_user_id, 'cro-1');
  assert.equal(row.signer_display_name, 'Bilal Ahmed');
  assert.equal(row.signer_position_name, 'Control Room Operator');
  // The insert binds the resolved identity, never anything supplied by
  // the caller beyond the authenticated actor id itself.
  assert.equal(inserted.length, 1);
  assert.equal((inserted[0] as { signer_user_id: string }).signer_user_id, 'cro-1');
});

test('recording a signature for a signer with no identity fails closed and writes nothing', async () => {
  const inserted: Record<string, unknown>[] = [];
  await assert.rejects(
    recordPermitSignature(buildQuery({}, inserted), {
      permitId: 'permit-1',
      sourceEventId: 'event-9',
      role: 'HSE',
      actorUserId: 'hse-1',
    }),
    SigningIdentityUnavailableError,
  );
  assert.equal(inserted.length, 0);
});

test('the snapshot signature set freezes name, designation, and signing time per role', () => {
  const set = buildSnapshotSignatureSet([
    makeRow(),
    makeRow({
      id: 'signature-2',
      signature_role: 'CRO',
      signer_user_id: 'cro-1',
      signer_display_name: 'Bilal Ahmed',
      signer_team_name: 'Operations',
      signer_position_name: 'Control Room Operator',
      source_event_id: 'event-2',
      signed_at: '2026-01-01T08:30:00.000Z',
    }),
  ]);

  assert.equal(set.applicant?.displayName, 'Ayesha Khan');
  assert.equal(set.applicant?.designation, 'Technician, Maintenance Team A');
  assert.equal(set.applicant?.signedAt, '2026-01-01T08:00:00.000Z');
  assert.equal(set.cro?.designation, 'Control Room Operator, Operations');
  assert.equal(set.hse, null);
  assert.equal(set.croFallback, null);
  assert.equal(set.renewal, null);
});

test('a resubmitted permit carries the LAST applicant signature, with earlier ones still recorded', async () => {
  const inserted: Record<string, unknown>[] = [
    makeRow({ signed_at: '2026-01-01T08:00:00.000Z', signer_display_name: 'Ayesha Khan' }),
    makeRow({ id: 'signature-2', source_event_id: 'event-2', signed_at: '2026-01-02T08:00:00.000Z', signer_display_name: 'Ayesha Khan (after correction)' }),
  ] as unknown as Record<string, unknown>[];
  const rows = await getPermitSignatures(buildQuery({}, inserted), 'permit-1');
  assert.equal(rows.length, 2);

  const set = buildSnapshotSignatureSet(rows);
  assert.equal(set.applicant?.displayName, 'Ayesha Khan (after correction)');
  assert.equal(set.applicant?.sourceEventId, 'event-2');
});

test('CRO FALLBACK APPROVAL never produces an HSE signature', () => {
  const set = buildSnapshotSignatureSet([
    makeRow(),
    makeRow({
      id: 'signature-2',
      signature_role: 'CRO_FALLBACK',
      signer_user_id: 'cro-1',
      signer_display_name: 'Bilal Ahmed',
      signer_team_name: 'Operations',
      signer_position_name: 'Control Room Operator',
      source_event_id: 'event-3',
    }),
  ]);

  assert.equal(set.croFallback?.displayName, 'Bilal Ahmed');
  assert.equal(set.croFallback?.role, 'CRO_FALLBACK');
  assert.equal(set.hse, null, 'a fallback approval must never fabricate an HSE signature');
});

test('inherited signatures (renewal) are used only where the new permit has none of its own', () => {
  const inherited = buildSnapshotSignatureSet([
    makeRow(),
    makeRow({ id: 'signature-2', signature_role: 'HSE', signer_user_id: 'hse-1', signer_display_name: 'Cara Noor', source_event_id: 'event-2' }),
  ]);
  const renewed = buildSnapshotSignatureSet(
    [
      makeRow({
        id: 'signature-3',
        permit_id: 'permit-2',
        signature_role: 'RENEWAL',
        signer_user_id: 'cro-1',
        signer_display_name: 'Bilal Ahmed',
        source_event_id: 'event-renewed',
      }),
    ],
    { ...inherited, renewal: null },
  );

  assert.equal(renewed.applicant?.displayName, 'Ayesha Khan');
  assert.equal(renewed.hse?.displayName, 'Cara Noor');
  assert.equal(renewed.renewal?.displayName, 'Bilal Ahmed');
});

test('an empty signature set is genuinely empty - no placeholder identities', () => {
  assert.deepEqual(buildSnapshotSignatureSet([]), EMPTY_SIGNATURE_SET);
  assert.deepEqual(Object.values(EMPTY_SIGNATURE_SET), [null, null, null, null, null]);
});
