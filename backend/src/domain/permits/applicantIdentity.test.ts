import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../../db/pool.js';
import { resolvePermitApplicantAuthority } from './applicantIdentity.js';

function queryFor(options: {
  privilegedName?: string;
  privilegedRoles?: Array<'CEO' | 'SITE_MANAGER'>;
  normal?: Record<string, string>;
}): QueryFn {
  return (async <T>(sql: string) => {
    if (sql.includes('privileged_access_events')) return { rows: options.privilegedName
      ? (options.privilegedRoles ?? ['CEO']).map((role) => ({ role, display_name: options.privilegedName })) : [] } as { rows: T[] };
    if (sql.includes('FROM companies')) {
      // The authoritative E-SET row a privileged applicant is described by.
      return { rows: [{ id: 'company-eset', code: 'E_SET', name: 'E-SET' }] } as { rows: T[] };
    }
    if (sql.includes('workforce_profiles')) return { rows: options.normal ? [options.normal] : [] } as { rows: T[] };
    throw new Error('unexpected query');
  }) as QueryFn;
}

test('normal applicant identity is authoritative workforce/company data', async () => {
  const identity = await resolvePermitApplicantAuthority(queryFor({ normal: {
    display_name: 'Ali Khan', company_id: 'company-zpl', company_code: 'ZPL', company_name: 'ZPL',
    team_name: 'ZPL', position_name: 'Engineer',
  } }), 'user');
  assert.deepEqual(identity.identity, {
    kind: 'NORMAL', displayName: 'Ali Khan', companyId: 'company-zpl',
    companyCode: 'ZPL', companyName: 'ZPL', privilegedRole: null,
  });
});

test('privileged applicant uses only privileged personal name and internal E_SET context', async () => {
  const identity = await resolvePermitApplicantAuthority(queryFor({ privilegedName: 'Sana Iqbal' }), 'ceo');
  assert.deepEqual(identity.identity, {
    kind: 'PRIVILEGED', displayName: 'Sana Iqbal', companyId: 'company-eset',
    companyCode: 'E_SET', companyName: 'E-SET', privilegedRole: 'CEO',
  });
});

test('a CEO applicant is name + E-SET + CEO, with no fabricated team or position', async () => {
  const resolved = await resolvePermitApplicantAuthority(
    queryFor({ privilegedName: 'Sana Iqbal', privilegedRoles: ['CEO'] }), 'ceo',
  );
  assert.equal(resolved.identity?.displayName, 'Sana Iqbal');
  assert.equal(resolved.identity?.companyName, 'E-SET');
  assert.equal(resolved.identity?.privilegedRole, 'CEO');
  // The whole point: a privileged account has no workforce assignment and
  // is never given an invented one.
  assert.equal(resolved.identity?.kind, 'PRIVILEGED');
  assert.ok(!('teamName' in (resolved.identity ?? {})));
  assert.ok(!('positionName' in (resolved.identity ?? {})));
});

test('a System Site Manager applicant is name + E-SET + System Site Manager', async () => {
  const resolved = await resolvePermitApplicantAuthority(
    queryFor({ privilegedName: 'Sara Ahmed', privilegedRoles: ['SITE_MANAGER'] }), 'sm',
  );
  assert.equal(resolved.identity?.displayName, 'Sara Ahmed');
  assert.equal(resolved.identity?.companyName, 'E-SET');
  assert.equal(resolved.identity?.privilegedRole, 'System Site Manager');
});

test('a privileged applicant needs no workforce profile at all', async () => {
  // The workforce lookup must never even be consulted for a privileged
  // account - if it were, a CEO without a profile would be refused.
  let workforceConsulted = false;
  const query = (async <T>(sql: string) => {
    if (sql.includes('privileged_access_events')) {
      return { rows: [{ role: 'CEO', display_name: 'Sana Iqbal' }] } as { rows: T[] };
    }
    if (sql.includes('FROM companies')) {
      return { rows: [{ id: 'company-eset', code: 'E_SET', name: 'E-SET' }] } as { rows: T[] };
    }
    workforceConsulted = true;
    return { rows: [] } as { rows: T[] };
  }) as QueryFn;

  const resolved = await resolvePermitApplicantAuthority(query, 'ceo');
  assert.equal(resolved.allowed, true);
  assert.equal(resolved.identity?.privilegedRole, 'CEO');
  assert.equal(workforceConsulted, false, 'a privileged identity must not depend on workforce data');
});

test('the role comes from the grant log, never from anything a caller supplies', async () => {
  // `resolvePermitApplicantAuthority` takes only a user id. There is no
  // parameter through which a role, company or name could be injected,
  // and a ZPL "Site Manager" POSITION resolves as a normal employee -
  // never as the privileged System Site Manager role.
  const zplSiteManager = await resolvePermitApplicantAuthority(queryFor({ normal: {
    display_name: 'Bilal Ahmed', company_id: 'company-zpl', company_code: 'ZPL', company_name: 'ZPL',
    team_name: 'ZPL', position_name: 'Site Manager',
  } }), 'employee');
  assert.equal(zplSiteManager.identity?.kind, 'NORMAL');
  assert.equal(zplSiteManager.identity?.privilegedRole, null);
  assert.equal(zplSiteManager.identity?.companyName, 'ZPL');
});

test('identity fails closed with no authoritative profile and never inspects email or metadata', async () => {
  assert.deepEqual(await resolvePermitApplicantAuthority(queryFor({}), 'name@zpl.example'), { allowed: false });
});
