import type { ReactNode } from 'react';
import { ROUTES } from '../app/routes';
import type { Capabilities } from '../auth/capabilities';

export interface NavItem {
  to: string;
  label: string;
  icon: 'home' | 'plus' | 'document' | 'review' | 'shield' | 'people' | 'key';
  /** Matches nested paths (a permit detail keeps "Records" highlighted). */
  matchPrefix?: string;
  end?: boolean;
  description?: ReactNode;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The navigation a given identity sees.
 *
 * Built ENTIRELY from capabilities and privileged roles that `/auth/me`
 * returned - never from a Position name, never from an email address.
 * ZPL's "Site Manager" Position is an ordinary employee here and reaches
 * no administration link, because `isSiteManager` reads
 * `privilegedRoles`, which that Position does not affect.
 *
 * Hiding a link is a courtesy, not a control: every route behind these
 * links re-checks with the server, and the server refuses independently.
 */
export function buildNavigation(capabilities: Capabilities): NavGroup[] {
  const groups: NavGroup[] = [];

  const work: NavItem[] = [{ to: ROUTES.home, label: 'Home', icon: 'home', end: true }];
  if (capabilities.canApplyForPermits) {
    work.push({ to: ROUTES.apply, label: 'Apply for permit', icon: 'plus' });
  }
  work.push({
    to: ROUTES.records,
    label: capabilities.canViewAllPermits ? 'Permit records' : 'My permits',
    icon: 'document',
    matchPrefix: '/permits',
  });
  groups.push({ label: 'Work', items: work });

  const review: NavItem[] = [];
  if (capabilities.canReviewAsCro) {
    review.push({ to: ROUTES.croQueue, label: 'CRO review', icon: 'review' });
  }
  if (capabilities.canReviewAsHse) {
    review.push({ to: ROUTES.hseQueue, label: 'HSE review', icon: 'shield' });
  }
  if (review.length > 0) groups.push({ label: 'Review', items: review });

  const administration: NavItem[] = [];
  if (capabilities.canManageEmployees) {
    administration.push({ to: ROUTES.employees, label: 'Employees', icon: 'people', matchPrefix: ROUTES.employees });
  }
  if (capabilities.canManageSiteManagers) {
    administration.push({ to: ROUTES.siteManagers, label: 'Site Managers', icon: 'key' });
  }
  if (administration.length > 0) groups.push({ label: 'Administration', items: administration });

  return groups;
}
