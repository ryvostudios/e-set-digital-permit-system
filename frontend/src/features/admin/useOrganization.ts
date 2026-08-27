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
 *
 * The accessors below keep Company, Team and Position as the three
 * separate things they are in the database, instead of flattening them
 * into one "ESET-E_BOP-CRO" string. Nothing here decides WHICH companies
 * have teams worth choosing - that is read from the data (see
 * `hasTeamChoice`), so a company gaining or losing a team needs no
 * frontend change.
 */

export interface OrganizationPosition {
  teamPositionId: string;
  positionName: string;
}

export function useOrganization() {
  const resource = useApiResource<{ companies: OrganizationCompany[] }>((signal) => getOrganization(signal), []);

  const companies = useMemo(() => resource.data?.companies ?? [], [resource.data]);

  const byCode = useMemo(() => {
    const map = new Map<string, OrganizationCompany>();
    for (const company of companies) map.set(company.code, company);
    return map;
  }, [companies]);

  return useMemo(() => {
    const teamsFor = (companyCode: string): string[] =>
      (byCode.get(companyCode)?.teams ?? []).map((team) => team.teamName);

    /**
     * Whether this company's structure is worth asking about.
     *
     * ZPL and SGRE each have exactly one team, named after the company
     * itself, so making an administrator pick "ZPL → ZPL" is a question
     * with one answer. Their single team is resolved internally instead
     * (`soleTeamFor`) and only positions are offered. E-SET has five real
     * teams, so there the question is genuine.
     */
    const hasTeamChoice = (companyCode: string): boolean => teamsFor(companyCode).length > 1;

    const soleTeamFor = (companyCode: string): string | null => {
      const teams = teamsFor(companyCode);
      return teams.length === 1 ? teams[0]! : null;
    };

    /** The team a company's selection should use: the chosen one, or the only one. */
    const effectiveTeam = (companyCode: string, teamName: string): string | null =>
      hasTeamChoice(companyCode) ? (teamName || null) : soleTeamFor(companyCode);

    const positionsFor = (companyCode: string, teamName: string): OrganizationPosition[] => {
      const team = effectiveTeam(companyCode, teamName);
      if (!team) return [];
      return (byCode.get(companyCode)?.teams ?? []).find((entry) => entry.teamName === team)?.positions ?? [];
    };

    /**
     * The team that owns an already-assigned `teamPositionId` - so an
     * edit screen can show the right Team without storing one, and
     * without the caller reconstructing it from a label.
     */
    const teamOfAssignment = (companyCode: string, teamPositionId: string): string => {
      if (!teamPositionId) return '';
      const owner = (byCode.get(companyCode)?.teams ?? []).find((team) =>
        team.positions.some((position) => position.teamPositionId === teamPositionId),
      );
      return owner?.teamName ?? '';
    };

    /** Whether a position id genuinely belongs to this company + team, used to clear stale selections. */
    const isValidAssignment = (companyCode: string, teamName: string, teamPositionId: string): boolean =>
      positionsFor(companyCode, teamName).some((position) => position.teamPositionId === teamPositionId);

    return {
      ...resource,
      companies,
      teamsFor,
      hasTeamChoice,
      soleTeamFor,
      positionsFor,
      teamOfAssignment,
      isValidAssignment,
    };
  }, [resource, companies, byCode]);
}
