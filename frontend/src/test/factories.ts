import type {
  CurrentUser,
  EmployeeDetail,
  Jsa,
  Permit,
  PermitDetailResponse,
  PermitStatus,
  PermitSummary,
  PermitType,
} from '../api/types';

/**
 * Test fixtures shaped exactly like the backend's real responses.
 *
 * These are TEST data, never shipped: nothing in `src` outside this
 * directory imports them, and no screen has a fallback that would render
 * a fixture in production.
 *
 * The identities below are deliberately chosen to exercise the two
 * collisions that matter: ZPL's "Site Manager" POSITION (an ordinary
 * employee) against the privileged SITE_MANAGER ROLE, and ZPL's "HSE"
 * POSITION against genuine HSE approval authority.
 */

export function normalEmployee(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    auth: { id: 'user-normal', email: 'ali.khan@example.com' },
    accessState: 'ACTIVE',
    mustChangePassword: false,
    profile: {
      displayName: 'Ali Khan',
      company: { code: 'ZPL', name: 'ZPL' },
      teamName: 'ZPL',
      positionName: 'Engineer',
    },
    privilegedRoles: [],
    privilegedDisplayName: null,
    capabilities: ['permit.create', 'permit.submit'],
    ...overrides,
  };
}

/**
 * ZPL's ordinary "Site Manager" job title. This is a NORMAL employee and
 * must never be treated as the privileged SITE_MANAGER system role.
 */
export function zplSiteManagerEmployee(): CurrentUser {
  return normalEmployee({
    auth: { id: 'user-zpl-site-manager', email: 'sm@zpl.example.com' },
    profile: {
      displayName: 'Imran Sheikh',
      company: { code: 'ZPL', name: 'ZPL' },
      teamName: 'ZPL',
      positionName: 'Site Manager',
    },
  });
}

/** ZPL's "HSE" job title - a permit applicant, never an HSE approver. */
export function zplHseEmployee(): CurrentUser {
  return normalEmployee({
    auth: { id: 'user-zpl-hse', email: 'hse@zpl.example.com' },
    profile: {
      displayName: 'Nadia Iqbal',
      company: { code: 'ZPL', name: 'ZPL' },
      teamName: 'ZPL',
      positionName: 'HSE',
    },
  });
}

/** E-SET / E-BOP / CRO - full CRO workflow authority, and NO application authority. */
export function croEmployee(): CurrentUser {
  return normalEmployee({
    auth: { id: 'user-cro', email: 'cro@eset.example.com' },
    profile: {
      displayName: 'Hamza Tariq',
      company: { code: 'E_SET', name: 'E-SET' },
      teamName: 'E-BOP',
      positionName: 'CRO',
    },
    capabilities: [
      'permit.cro_review',
      'permit.send_back',
      'permit.forward_hse',
      'permit.fallback_approve',
      'permit.hold',
      'permit.resume',
      'permit.cancel',
      'permit.close',
      'permit.renew',
    ],
  });
}

/** E-SET / HSE / Team Lead - genuine HSE approval authority. */
export function hseApprover(): CurrentUser {
  return normalEmployee({
    auth: { id: 'user-hse', email: 'hse@eset.example.com' },
    profile: {
      displayName: 'Sana Malik',
      company: { code: 'E_SET', name: 'E-SET' },
      teamName: 'HSE',
      positionName: 'Team Lead',
    },
    capabilities: ['permit.create', 'permit.submit', 'permit.hse_review'],
  });
}

/** A privileged system account: profile is null, and the personal name lives in `privilegedDisplayName`. */
export function ceo(): CurrentUser {
  return {
    auth: { id: 'user-ceo', email: 'ceo@eset.example.com' },
    accessState: 'ACTIVE',
    mustChangePassword: false,
    profile: null,
    privilegedRoles: ['CEO'],
    privilegedDisplayName: 'Farhan Aziz',
    capabilities: [],
  };
}

export function siteManager(): CurrentUser {
  return {
    auth: { id: 'user-site-manager', email: 'sitemanager@eset.example.com' },
    accessState: 'ACTIVE',
    mustChangePassword: false,
    profile: null,
    privilegedRoles: ['SITE_MANAGER'],
    privilegedDisplayName: 'Sara Ahmed',
    capabilities: [],
  };
}

export function permitSummary(overrides: Partial<PermitSummary> = {}): PermitSummary {
  return {
    id: 'permit-1',
    permit_sequence: '1',
    permitDisplayNumber: '000001',
    jsa_id: 'jsa-1',
    status: 'DRAFT' as PermitStatus,
    version: 1,
    created_by: 'user-normal',
    previous_permit_id: null,
    site_timezone: 'Asia/Karachi',
    company: null,
    company_other: null,
    applicant_identity_kind: null,
    applicant_display_name: null,
    applicant_company_code: null,
    applicant_company_name: null,
    submitted_at: null,
    hse_review_started_at: null,
    hse_review_deadline_at: null,
    issued_at: null,
    closed_by: null,
    closed_at: null,
    closure_remarks: null,
    held_by: null,
    held_at: null,
    hold_reason: null,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
    permit_type: 'WTG_WORK' as PermitType,
    form_version: 'WTG_WORK_V1',
    wind_farm: 'North Farm',
    wtg_number: 'WTG-14',
    work_description: 'Gearbox inspection',
    loto_number: null,
    created_at: '2026-08-20T08:00:00.000Z',
    updated_at: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

export function permit(overrides: Partial<Permit> = {}): Permit {
  return { ...permitSummary(), form_payload: null, ...overrides };
}

export function jsa(overrides: Partial<Jsa> = {}): Jsa {
  return {
    id: 'jsa-1',
    jsa_sequence: '1',
    jsaDisplayNumber: '000001',
    created_by: 'user-normal',
    form_version: null,
    form_payload: null,
    site_or_wtg: null,
    job_description: null,
    created_at: '2026-08-20T08:00:00.000Z',
    updated_at: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

export function permitDetail(overrides: Partial<PermitDetailResponse> = {}): PermitDetailResponse {
  return {
    permit: permit(),
    jsa: jsa(),
    validity: null,
    availableActions: [],
    history: [],
    signatures: [],
    document: null,
    ...overrides,
  };
}

export function employeeDetail(overrides: Partial<EmployeeDetail> = {}): EmployeeDetail {
  return {
    userId: 'employee-1',
    state: 'ACTIVE',
    mustChangePassword: false,
    displayName: 'Ali Khan',
    company: { code: 'ZPL', name: 'ZPL' },
    teamName: 'ZPL',
    positionName: 'Engineer',
    teamPositionId: 'tp-zpl-engineer',
    individualPermissions: [],
    ...overrides,
  };
}

export const ORGANIZATION = {
  companies: [
    {
      code: 'E_SET',
      name: 'E-SET',
      teams: [
        {
          teamName: 'E-BOP',
          positions: [
            { teamPositionId: 'tp-ebop-cro', positionName: 'CRO' },
            { teamPositionId: 'tp-ebop-lead', positionName: 'Team Lead' },
          ],
        },
        { teamName: 'HSE', positions: [{ teamPositionId: 'tp-hse-lead', positionName: 'Team Lead' }] },
        {
          teamName: 'WTG',
          positions: [
            { teamPositionId: 'tp-wtg-technician', positionName: 'Technician' },
            { teamPositionId: 'tp-wtg-engineer', positionName: 'Engineer' },
          ],
        },
      ],
    },
    {
      code: 'ZPL',
      name: 'ZPL',
      teams: [
        {
          teamName: 'ZPL',
          positions: [
            { teamPositionId: 'tp-zpl-engineer', positionName: 'Engineer' },
            { teamPositionId: 'tp-zpl-site-manager', positionName: 'Site Manager' },
          ],
        },
      ],
    },
    {
      code: 'SGRE',
      name: 'SGRE',
      teams: [
        { teamName: 'SGRE', positions: [{ teamPositionId: 'tp-sgre-lead', positionName: 'Team Lead' }] },
      ],
    },
  ],
};

export function emptyPagination(overrides: Record<string, number | boolean> = {}) {
  return {
    page: 1,
    pageSize: 20,
    totalCount: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPreviousPage: false,
    ...overrides,
  };
}
