import { useMemo } from 'react';
import { getOrganization } from '../../api/endpoints';
import type { OrganizationCompany } from '../../api/types';
import { useApiResource } from '../../lib/useApiResource';

/**
 * The authoritative Company / Team / Position choices.
 *
 * THE FRONTEND HOLDS NO ORGANIZATION MAP. Teams, positions, and the
 * `teamPositionId` that identifies a combination are operator-owned data
 * seeded by migration, and this loads them from
 * `GET /admin/organization` every time a management screen needs them.
 * There is no hard-coded list here to drift from the database, and no way
 * for a manager to pick a combination the backend has not approved for
 * provisioning - it returns only combinations already flagged
 * `site_manager_assignable`, which the mutating endpoints independently
 * re-check.
 */
export function useOrganization() {
  const resource = useApiResource<{ companies: OrganizationCompany[] }>((signal) => getOrganization(signal), []);

  const companies = useMemo(() => resource.data?.companies ?? [], [resource.data]);

  /** Every assignable combination as one flat, selectable list per company. */
  const optionsByCompany = useMemo(() => {
    const map = new Map<string, { teamPositionId: string; label: string }[]>();
    for (const company of companies) {
      map.set(
        company.code,
        company.teams.flatMap((team) =>
          team.positions.map((position) => ({
            teamPositionId: position.teamPositionId,
            label: `${team.teamName} — ${position.positionName}`,
          })),
        ),
      );
    }
    return map;
  }, [companies]);

  return { ...resource, companies, optionsByCompany };
}
