import { describe, expect, it } from 'vitest';
import {
  ceo,
  croEmployee,
  hseApprover,
  normalEmployee,
  siteManager,
  zplHseEmployee,
  zplSiteManagerEmployee,
} from '../test/factories';
import { deriveCapabilities, describeApplicantIdentity, describePermitApplicant } from './capabilities';

/**
 * The identity model.
 *
 * These tests exist mainly to pin the two collisions that would be
 * genuinely dangerous to get wrong: ZPL's "Site Manager" POSITION versus
 * the privileged SITE_MANAGER ROLE, and ZPL's "HSE" POSITION versus real
 * HSE approval authority.
 */

describe('normal employee identity', () => {
  it('carries exactly one Company, Team, and Position', () => {
    const capabilities = deriveCapabilities(normalEmployee());
    expect(capabilities.profile).toEqual({
      displayName: 'Ali Khan',
      company: { code: 'ZPL', name: 'ZPL' },
      teamName: 'ZPL',
      positionName: 'Engineer',
    });
    expect(capabilities.displayName).toBe('Ali Khan');
    expect(capabilities.isPrivileged).toBe(false);
  });

  it('writes the applicant line as "Mr. NAME of Company COMPANY"', () => {
    expect(describeApplicantIdentity(normalEmployee())).toBe('Mr. Ali Khan of Company ZPL');
  });
});

describe('privileged identity', () => {
  it('has a null profile and uses the privileged display name', () => {
    for (const user of [ceo(), siteManager()]) {
      const capabilities = deriveCapabilities(user);
      expect(user.profile).toBeNull();
      expect(capabilities.profile).toBeNull();
      expect(capabilities.displayName).toBe(user.privilegedDisplayName);
      expect(capabilities.isPrivileged).toBe(true);
    }
  });

  it('writes the applicant line as the personal name ALONE', () => {
    // No role, no "E-SET", no Company/Team/Position appended.
    expect(describeApplicantIdentity(ceo())).toBe('Farhan Aziz');
    expect(describeApplicantIdentity(siteManager())).toBe('Sara Ahmed');
  });

  it('may apply for permits, and manages employees', () => {
    expect(deriveCapabilities(ceo()).canApplyForPermits).toBe(true);
    expect(deriveCapabilities(siteManager()).canApplyForPermits).toBe(true);
    expect(deriveCapabilities(ceo()).canManageEmployees).toBe(true);
    expect(deriveCapabilities(siteManager()).canManageEmployees).toBe(true);
  });

  it('reserves permanent deletion and Site Manager administration to the CEO', () => {
    expect(deriveCapabilities(ceo()).canDeleteEmployees).toBe(true);
    expect(deriveCapabilities(ceo()).canManageSiteManagers).toBe(true);
    expect(deriveCapabilities(siteManager()).canDeleteEmployees).toBe(false);
    expect(deriveCapabilities(siteManager()).canManageSiteManagers).toBe(false);
    // The ADMINISTRATIVE/SECURITY audit is CEO-only. A Site Manager
    // performs the actions it records, so they appear in it as an actor -
    // which is exactly why they may not read it.
    expect(deriveCapabilities(ceo()).canViewAdministrativeAudit).toBe(true);
    expect(deriveCapabilities(siteManager()).canViewAdministrativeAudit).toBe(false);
  });

  it('is NOT automatically a CRO or an HSE approver', () => {
    for (const user of [ceo(), siteManager()]) {
      const capabilities = deriveCapabilities(user);
      expect(capabilities.canReviewAsCro).toBe(false);
      expect(capabilities.canReviewAsHse).toBe(false);
    }
  });
});

describe('the ZPL "Site Manager" position is a NORMAL employee', () => {
  const user = zplSiteManagerEmployee();
  const capabilities = deriveCapabilities(user);

  it('is never treated as the privileged SITE_MANAGER role', () => {
    expect(user.profile?.positionName).toBe('Site Manager');
    expect(user.privilegedRoles).toEqual([]);
    expect(capabilities.isSiteManager).toBe(false);
    expect(capabilities.isPrivileged).toBe(false);
  });

  it('reaches no administration authority', () => {
    expect(capabilities.canManageEmployees).toBe(false);
    expect(capabilities.canManageSiteManagers).toBe(false);
    expect(capabilities.canDeleteEmployees).toBe(false);
    expect(capabilities.canViewAdministrativeAudit).toBe(false);
  });

  it('is an ordinary applicant with an ordinary applicant line', () => {
    expect(capabilities.canApplyForPermits).toBe(true);
    expect(describeApplicantIdentity(user)).toBe('Mr. Imran Sheikh of Company ZPL');
  });
});

describe('the ZPL "HSE" position is not an HSE approver', () => {
  it('holds no HSE review capability', () => {
    const capabilities = deriveCapabilities(zplHseEmployee());
    expect(capabilities.canReviewAsHse).toBe(false);
    expect(capabilities.canApplyForPermits).toBe(true);
  });

  it('unlike E-SET HSE Team Lead, which does', () => {
    expect(deriveCapabilities(hseApprover()).canReviewAsHse).toBe(true);
  });
});

describe('E-SET E-BOP CRO', () => {
  const capabilities = deriveCapabilities(croEmployee());

  it('reviews permits but cannot apply for them', () => {
    expect(capabilities.canReviewAsCro).toBe(true);
    expect(capabilities.canApplyForPermits).toBe(false);
  });

  it('holds operational authority over issued permits but no HSE authority', () => {
    expect(capabilities.hasIssuedPermitAuthority).toBe(true);
    expect(capabilities.canReviewAsHse).toBe(false);
  });
});

describe('view all permits', () => {
  it('is false for an ordinary employee without the individual grant', () => {
    expect(deriveCapabilities(normalEmployee()).canViewAllPermits).toBe(false);
  });

  it('is true once the backend reports the individual grant', () => {
    const user = normalEmployee({ capabilities: ['permit.create', 'permit.submit', 'permit.view_all'] });
    expect(deriveCapabilities(user).canViewAllPermits).toBe(true);
  });

  it('is true for privileged accounts, which the backend grants broad read access', () => {
    expect(deriveCapabilities(ceo()).canViewAllPermits).toBe(true);
    expect(deriveCapabilities(siteManager()).canViewAllPermits).toBe(true);
  });
});

describe('a permit’s own frozen applicant identity', () => {
  it('reads a normal applicant as "Mr. NAME of Company COMPANY"', () => {
    expect(
      describePermitApplicant({
        applicant_identity_kind: 'NORMAL',
        applicant_display_name: 'Ali Khan',
        applicant_company_name: 'ZPL',
      }),
    ).toBe('Mr. Ali Khan of Company ZPL');
  });

  it('reads a privileged applicant as the personal name alone, even when a company field is present', () => {
    expect(
      describePermitApplicant({
        applicant_identity_kind: 'PRIVILEGED',
        applicant_display_name: 'Farhan Aziz',
        applicant_company_name: 'E-SET',
      }),
    ).toBe('Farhan Aziz');
  });

  it('is null before submission, rather than a guessed name', () => {
    expect(describePermitApplicant({ applicant_display_name: null })).toBeNull();
  });
});
