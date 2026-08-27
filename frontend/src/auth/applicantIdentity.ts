import type { Capabilities } from './capabilities';

/**
 * Who the signed-in person is, AS AN APPLICANT.
 *
 * This mirrors the server's `resolvePermitApplicantAuthority`, which is
 * the authority: it derives the identity frozen onto a permit at
 * submission from the append-only privileged grant log or from the
 * workforce assignment, and never from anything the client sends. What
 * is here is only what to DISPLAY while the applicant is filling the
 * form, so the screen shows the same thing the server will record.
 *
 * TWO KINDS OF APPLICANT, AND NEITHER BORROWS THE OTHER'S FIELDS.
 *
 * A privileged account - CEO or System Site Manager - is an internal
 * E-SET identity with no Company, Team or Position, because it has no
 * workforce profile and must never be given a fabricated one. Its
 * company is E-SET by definition of what the role is, and the role
 * itself is what stands in for a job title. "E-SET → Admin → CEO" is not
 * invented here or anywhere else.
 *
 * A normal employee carries their real frozen assignment: their name,
 * their company, and the team and position they actually hold.
 *
 * The privileged company is a constant rather than a lookup precisely
 * because there is nothing to look up - a privileged account has no
 * company row to read, and the server reaches the same conclusion the
 * same way.
 */

const PRIVILEGED_COMPANY_NAME = 'E-SET';

export interface ApplicantIdentity {
  kind: 'NORMAL' | 'PRIVILEGED';
  displayName: string;
  companyName: string;
  /** Privileged accounts only - the role that stands in for a job title. */
  role: 'CEO' | 'System Site Manager' | null;
  /** Normal employees only - a privileged account holds neither. */
  teamName: string | null;
  positionName: string | null;
}

export function applicantIdentityOf(capabilities: Capabilities): ApplicantIdentity {
  if (capabilities.isPrivileged) {
    return {
      kind: 'PRIVILEGED',
      displayName: capabilities.displayName,
      companyName: PRIVILEGED_COMPANY_NAME,
      // CEO outranks, and is checked first, so an account holding both
      // grants is described by the higher one rather than ambiguously.
      role: capabilities.isCeo ? 'CEO' : 'System Site Manager',
      teamName: null,
      positionName: null,
    };
  }

  return {
    kind: 'NORMAL',
    displayName: capabilities.displayName,
    companyName: capabilities.profile?.company.name ?? '',
    role: null,
    teamName: capabilities.profile?.teamName ?? null,
    positionName: capabilities.profile?.positionName ?? null,
  };
}
