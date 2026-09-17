import { Select } from '../../ui/Field';
import type { useOrganization } from './useOrganization';

/**
 * Company → Team → Position, as three dependent choices.
 *
 * WHY NOT ONE LIST. The previous control offered one flattened option per
 * combination - "ESET-E_BOP-CRO", "ESET-WTG-Team Lead" - which read like
 * a database key rather than an organization, and grew unusable as teams
 * were added. Company, Team and Position are three separate things in the
 * data and are now three separate questions.
 *
 * ONLY QUESTIONS WORTH ASKING. A company with exactly one team (ZPL,
 * SGRE - each has a single team named after itself) never shows a Team
 * control; its team is resolved internally and only positions are
 * offered. That decision is read from the organization data, not
 * hard-coded here, so nothing needs changing if a company gains a team.
 *
 * THE VALUE SENT TO THE BACKEND IS UNCHANGED: the normalized
 * `teamPositionId`. `teamName` is local UI state used to narrow the
 * position list; it is never submitted, and the backend independently
 * re-checks that the combination is assignable.
 *
 * A ZPL "Site Manager" chosen here is an ordinary workforce position. It
 * is not, and can never become, the privileged System Site Manager role -
 * that lives in the append-only privileged grant log and is not reachable
 * from employee administration at all.
 */

export interface AssignmentSelection {
  companyCode: string;
  /** Local narrowing state only - never submitted. */
  teamName: string;
  teamPositionId: string;
}

interface Props {
  /**
   * The authoritative organization, from GET /admin/organization.
   *
   * The Company options come from THIS and nothing else. There is
   * deliberately no `companies` prop: a caller-supplied list was how
   * a hardcoded three-company array reached this control, which made
   * companies created at runtime invisible to employee
   * administration even though the API already returned them.
   */
  organization: ReturnType<typeof useOrganization>;
  value: AssignmentSelection;
  onChange: (next: AssignmentSelection) => void;
  disabled?: boolean;
  issues?: Record<string, string>;
}

export function OrganizationAssignmentFields({
  organization,
  value,
  onChange,
  disabled = false,
  issues = {},
}: Props) {
  // Every ACTIVE, assignable company the server returned - including
  // any created since this build shipped.
  const companies = organization.companies;
  const showTeam = value.companyCode ? organization.hasTeamChoice(value.companyCode) : false;
  const teams = value.companyCode ? organization.teamsFor(value.companyCode) : [];
  const positions = value.companyCode ? organization.positionsFor(value.companyCode, value.teamName) : [];

  return (
    <>
      <Select
        label="Company"
        required
        value={value.companyCode}
        error={issues.companyCode}
        disabled={disabled}
        onChange={(event) => {
          // A team belongs to one company and a position to one team, so
          // changing company invalidates both of the choices below it.
          onChange({ companyCode: event.target.value, teamName: '', teamPositionId: '' });
        }}
      >
        <option value="">Choose a company</option>
        {companies.map((company) => (
          <option key={company.code} value={company.code}>
            {company.name}
          </option>
        ))}
      </Select>

      {showTeam ? (
        <Select
          label="Team"
          required
          value={value.teamName}
          disabled={disabled || !value.companyCode}
          hint={value.companyCode ? undefined : 'Choose a company first.'}
          onChange={(event) => {
            // The position belonged to the previous team.
            onChange({ ...value, teamName: event.target.value, teamPositionId: '' });
          }}
        >
          <option value="">Choose a team</option>
          {teams.map((team) => (
            <option key={team} value={team}>
              {team}
            </option>
          ))}
        </Select>
      ) : null}

      <Select
        label="Position"
        required
        value={value.teamPositionId}
        error={issues.teamPositionId}
        disabled={disabled || !value.companyCode || (showTeam && !value.teamName)}
        hint={
          !value.companyCode
            ? 'Choose a company first.'
            : showTeam && !value.teamName
              ? 'Choose a team first.'
              : undefined
        }
        onChange={(event) => onChange({ ...value, teamPositionId: event.target.value })}
      >
        <option value="">Choose a position</option>
        {positions.map((position) => (
          <option key={position.teamPositionId} value={position.teamPositionId}>
            {position.positionName}
          </option>
        ))}
      </Select>
    </>
  );
}
