import { describe, expect, it } from 'vitest';
import { ceo, croEmployee, normalEmployee, siteManager, zplSiteManagerEmployee } from '../test/factories';
import { deriveCapabilities } from './capabilities';
import { applicantIdentityOf } from './applicantIdentity';

/**
 * Who a permit is recorded as coming from.
 *
 * The server is the authority - it derives and freezes this from the
 * append-only privileged grant log or the workforce assignment. These
 * tests pin that the screen shows the same conclusion, and in particular
 * that a privileged account is never described using workforce fields it
 * does not have.
 */

const identityOf = (user: Parameters<typeof deriveCapabilities>[0]) =>
  applicantIdentityOf(deriveCapabilities(user));

describe('privileged applicants', () => {
  it('describes a CEO as their real name, E-SET, and CEO', () => {
    const identity = identityOf(ceo());
    expect(identity.kind).toBe('PRIVILEGED');
    expect(identity.displayName).toBe(deriveCapabilities(ceo()).displayName);
    expect(identity.companyName).toBe('E-SET');
    expect(identity.role).toBe('CEO');
  });

  it('describes a System Site Manager as their real name, E-SET, and System Site Manager', () => {
    const identity = identityOf(siteManager());
    expect(identity.kind).toBe('PRIVILEGED');
    expect(identity.companyName).toBe('E-SET');
    expect(identity.role).toBe('System Site Manager');
  });

  it('gives a privileged account no team and no position - none is fabricated', () => {
    for (const user of [ceo(), siteManager()]) {
      const identity = identityOf(user);
      expect(identity.teamName).toBeNull();
      expect(identity.positionName).toBeNull();
      // The two shapes explicitly ruled out: no invented Admin team, no
      // invented Site Manager workforce position.
      expect(JSON.stringify(identity)).not.toMatch(/Admin/);
    }
  });

  it('needs no workforce profile at all', () => {
    // A privileged account genuinely has `profile: null`; the identity
    // must still be complete rather than falling back to blanks.
    const user = ceo();
    expect(user.profile).toBeNull();
    const identity = identityOf(user);
    expect(identity.displayName).not.toBe('');
    expect(identity.companyName).toBe('E-SET');
  });
});

describe('normal applicants', () => {
  it('keeps using the real workforce assignment', () => {
    const identity = identityOf(normalEmployee());
    const profile = normalEmployee().profile!;
    expect(identity.kind).toBe('NORMAL');
    expect(identity.displayName).toBe(profile.displayName);
    expect(identity.companyName).toBe(profile.company.name);
    expect(identity.teamName).toBe(profile.teamName);
    expect(identity.positionName).toBe(profile.positionName);
    // A normal employee has no privileged role, whatever their job title.
    expect(identity.role).toBeNull();
  });

  it('a ZPL Site Manager stays an ordinary employee - the job title is not the privileged role', () => {
    const identity = identityOf(zplSiteManagerEmployee());
    expect(identity.kind).toBe('NORMAL');
    expect(identity.role).toBeNull();
    expect(identity.companyName).not.toBe('E-SET');
    // Their position is shown as what it is: a workforce position.
    expect(identity.positionName).toMatch(/site manager/i);
  });

  it('a CRO is an ordinary applicant identity too', () => {
    const identity = identityOf(croEmployee());
    expect(identity.kind).toBe('NORMAL');
    expect(identity.role).toBeNull();
  });
});
