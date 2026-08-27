import { describe, expect, it } from 'vitest';
import { ROUTES } from '../app/routes';
import { deriveCapabilities } from '../auth/capabilities';
import {
  ceo,
  croEmployee,
  hseApprover,
  normalEmployee,
  siteManager,
  zplHseEmployee,
  zplSiteManagerEmployee,
} from '../test/factories';
import { buildNavigation } from './navigation';

/**
 * Capability-aware navigation.
 *
 * Hiding a link is a courtesy, not a control - every route behind these
 * links re-asks the server. What these tests pin is that the courtesy is
 * derived from the RIGHT source: `privilegedRoles` and `capabilities`
 * from `/auth/me`, never a Position name.
 */

function linksFor(user: Parameters<typeof deriveCapabilities>[0]): string[] {
  return buildNavigation(deriveCapabilities(user)).flatMap((group) => group.items.map((item) => item.to));
}

function labelsFor(user: Parameters<typeof deriveCapabilities>[0]): string[] {
  return buildNavigation(deriveCapabilities(user)).flatMap((group) => group.items.map((item) => item.label));
}

describe('an ordinary employee', () => {
  const links = linksFor(normalEmployee());

  it('gets home, apply, and their own records', () => {
    expect(links).toContain(ROUTES.home);
    expect(links).toContain(ROUTES.apply);
    expect(links).toContain(ROUTES.records);
  });

  it('sees NO employee administration and NO Site Manager administration', () => {
    expect(links).not.toContain(ROUTES.employees);
    expect(links).not.toContain(ROUTES.siteManagers);
  });

  it('sees no review queue', () => {
    expect(links).not.toContain(ROUTES.croQueue);
    expect(links).not.toContain(ROUTES.hseQueue);
  });

  it('has its records link worded as "My permits" without the broad-visibility grant', () => {
    expect(labelsFor(normalEmployee())).toContain('My permits');
  });

  it('has it worded as "Permit records" once the backend reports the grant', () => {
    const withGrant = normalEmployee({ capabilities: ['permit.create', 'permit.submit', 'permit.view_all'] });
    expect(labelsFor(withGrant)).toContain('Permit records');
  });
});

describe('the ZPL "Site Manager" position', () => {
  it('reaches no administration - it is an ordinary employee, not the privileged role', () => {
    const links = linksFor(zplSiteManagerEmployee());
    expect(links).not.toContain(ROUTES.employees);
    expect(links).not.toContain(ROUTES.siteManagers);
    expect(links).toEqual(linksFor(normalEmployee()));
  });
});

describe('the ZPL "HSE" position', () => {
  it('reaches no HSE review queue', () => {
    expect(linksFor(zplHseEmployee())).not.toContain(ROUTES.hseQueue);
  });
});

describe('E-SET E-BOP CRO', () => {
  const links = linksFor(croEmployee());

  it('gets the CRO queue', () => {
    expect(links).toContain(ROUTES.croQueue);
  });

  it('does NOT get the HSE queue', () => {
    expect(links).not.toContain(ROUTES.hseQueue);
  });

  it('does NOT get an apply link - CRO reviews permits rather than raising them', () => {
    expect(links).not.toContain(ROUTES.apply);
  });

  it('gets no administration', () => {
    expect(links).not.toContain(ROUTES.employees);
  });
});

describe('E-SET HSE Team Lead', () => {
  const links = linksFor(hseApprover());

  it('gets the HSE queue and may also apply', () => {
    expect(links).toContain(ROUTES.hseQueue);
    expect(links).toContain(ROUTES.apply);
  });

  it('does not get the CRO queue', () => {
    expect(links).not.toContain(ROUTES.croQueue);
  });
});

describe('an E-SET Site Manager (the privileged role)', () => {
  const links = linksFor(siteManager());

  it('gets employee administration', () => {
    expect(links).toContain(ROUTES.employees);
  });

  it('does NOT get Site Manager administration - that is CEO-only', () => {
    expect(links).not.toContain(ROUTES.siteManagers);
  });

  it('gets no review queue: a privileged account holds no Team or Position, so no review capability', () => {
    expect(links).not.toContain(ROUTES.croQueue);
    expect(links).not.toContain(ROUTES.hseQueue);
  });

  it('may still apply for a permit', () => {
    expect(links).toContain(ROUTES.apply);
  });
});

describe('the CEO', () => {
  const links = linksFor(ceo());

  it('gets both employee and Site Manager administration', () => {
    expect(links).toContain(ROUTES.employees);
    expect(links).toContain(ROUTES.siteManagers);
  });

  it('gets no review queue either', () => {
    expect(links).not.toContain(ROUTES.croQueue);
    expect(links).not.toContain(ROUTES.hseQueue);
  });
});

describe('navigation groups', () => {
  it('omits an empty group rather than rendering an empty heading', () => {
    const groups = buildNavigation(deriveCapabilities(normalEmployee()));
    expect(groups.map((group) => group.label)).toEqual(['Work']);
    for (const group of groups) expect(group.items.length).toBeGreaterThan(0);
  });
});
