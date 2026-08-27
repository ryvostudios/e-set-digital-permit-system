import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../../db/pool.js';
import { resolvePermitApplicantAuthority } from './applicantIdentity.js';

function queryFor(options: { privilegedName?: string; normal?: Record<string, string> }): QueryFn {
  return (async <T>(sql: string) => {
    if (sql.includes('privileged_access_events')) return { rows: options.privilegedName
      ? [{ role: 'CEO', display_name: options.privilegedName }] : [] } as { rows: T[] };
    if (sql.includes('workforce_profiles')) return { rows: options.normal ? [options.normal] : [] } as { rows: T[] };
    throw new Error('unexpected query');
  }) as QueryFn;
}

test('normal applicant identity is authoritative workforce/company data', async () => {
  const identity = await resolvePermitApplicantAuthority(queryFor({ normal: {
    display_name: 'Ali Khan', company_code: 'ZPL', company_name: 'ZPL', team_name: 'ZPL', position_name: 'Engineer',
  } }), 'user');
  assert.deepEqual(identity.identity, { kind: 'NORMAL', displayName: 'Ali Khan', companyCode: 'ZPL', companyName: 'ZPL' });
});

test('privileged applicant uses only privileged personal name and internal E_SET context', async () => {
  const identity = await resolvePermitApplicantAuthority(queryFor({ privilegedName: 'Sana Iqbal' }), 'ceo');
  assert.deepEqual(identity.identity, { kind: 'PRIVILEGED', displayName: 'Sana Iqbal', companyCode: 'E_SET', companyName: 'E-SET' });
});

test('identity fails closed with no authoritative profile and never inspects email or metadata', async () => {
  assert.deepEqual(await resolvePermitApplicantAuthority(queryFor({}), 'name@zpl.example'), { allowed: false });
});
