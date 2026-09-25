import { apiDownload, apiRequest, apiUpload } from './client';
import type {
  AuditLogsResponse,
  AppNotification,
  CurrentUser,
  EmployeeDetail,
  EmployeeHistoryResponse,
  EmployeeListResponse,
  Jsa,
  JsaFormPayload,
  LifecycleEvent,
  NotificationListResponse,
  OrganizationCompany,
  OrganizationAdminCompany,
  OrganizationLevel,
  CreatedCompany,
  CreatedTeam,
  CreatedTeamPosition,
  Permit,
  PermitDetailResponse,
  PermitFormPayload,
  PermitListResponse,
  PermitStatus,
  PermitType,
  SiteManagerListItem,
} from './types';

/**
 * Every backend endpoint this application uses, as a typed function.
 *
 * Each one names the exact backend route it calls. There is no dynamic
 * URL building anywhere else in the app, and no component composes a
 * path of its own - so the set of endpoints the frontend can reach is
 * exactly the set written here.
 *
 * REQUEST BODIES ARE BUILT FIELD BY FIELD. No function below serializes
 * a whole domain object into a PATCH/POST: each takes the specific
 * arguments its endpoint accepts and constructs the exact body the
 * backend's `.strict()` schema allows. That is what makes accidental
 * mass assignment impossible from this side, on top of the backend's own
 * rejection of unknown keys.
 */

// ---------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------

/** GET /api/v1/auth/me - the authoritative current user. Reachable during a forced password change. */
export function getCurrentUser(signal?: AbortSignal): Promise<CurrentUser> {
  return apiRequest<CurrentUser>('/auth/me', { allowDuringPasswordChange: true, ...(signal ? { signal } : {}) });
}

/**
 * POST /api/v1/auth/change-password - the ONLY password-change endpoint
 * in the system, and it exists solely to satisfy an outstanding forced
 * change (the backend answers 409 otherwise). The body carries the new
 * password and nothing else; it is never logged, stored, or echoed.
 */
export function changeOwnPassword(newPassword: string): Promise<{ status: string; mustChangePassword: boolean }> {
  return apiRequest('/auth/change-password', {
    method: 'POST',
    body: { newPassword },
    allowDuringPasswordChange: true,
  });
}

// ---------------------------------------------------------------------
// Permits
// ---------------------------------------------------------------------

/** POST /api/v1/permits - creates a DRAFT of one of the four templates. */
export function createPermit(permitType: PermitType): Promise<{ permit: Permit; jsa: Jsa }> {
  return apiRequest('/permits', { method: 'POST', body: { permitType } });
}

/** GET /api/v1/permits/mine - the caller's own permits (or all of them, if the backend grants `permit.view_all`). */
export function listMyPermits(
  params: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<PermitListResponse> {
  return apiRequest('/permits/mine', { query: { ...params }, ...(signal ? { signal } : {}) });
}

/** GET /api/v1/permits/queue - one capability-gated review queue. */
export function listPermitQueue(
  params: { status: 'PENDING_CRO' | 'PENDING_HSE' | 'ISSUED'; page?: number; pageSize?: number },
  signal?: AbortSignal,
): Promise<PermitListResponse> {
  return apiRequest('/permits/queue', { query: { ...params }, ...(signal ? { signal } : {}) });
}

export interface PermitSearchParams {
  permitNumber?: number;
  jsaNumber?: number;
  status?: PermitStatus;
  company?: 'ESET' | 'SGRE' | 'ZPL' | 'OTHER';
  permitType?: PermitType;
  createdBy?: string;
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  pageSize?: number;
}

/** GET /api/v1/permits/search - scoped by exactly the same access model as every other permit read. */
export function searchPermits(params: PermitSearchParams, signal?: AbortSignal): Promise<PermitListResponse> {
  return apiRequest('/permits/search', { query: { ...params }, ...(signal ? { signal } : {}) });
}

/** GET /api/v1/permits/:id - permit, JSA, validity, action hints, history, signatures, document status. */
export function getPermit(id: string, signal?: AbortSignal): Promise<PermitDetailResponse> {
  return apiRequest(`/permits/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) });
}

/** GET /api/v1/permits/:id/history - the unfiltered append-only lifecycle history. */
export function getPermitHistory(id: string, signal?: AbortSignal): Promise<{ events: LifecycleEvent[] }> {
  return apiRequest(`/permits/${encodeURIComponent(id)}/history`, { ...(signal ? { signal } : {}) });
}

/**
 * GET /api/v1/permits/my-drafts - the caller's OWN unfinished drafts.
 *
 * Scoped server-side by `created_by` with no parameter that could widen
 * it, so broad record visibility never surfaces another person's
 * half-finished safety document here.
 */
export function listMyDrafts(params: { page?: number; pageSize?: number } = {}, signal?: AbortSignal): Promise<PermitListResponse> {
  return apiRequest('/permits/my-drafts', { query: { ...params }, ...(signal ? { signal } : {}) });
}

/** PATCH /api/v1/permits/:id - saves draft permit form content under the permit's optimistic-concurrency version. */
export function updatePermitForm(id: string, version: number, form: PermitFormPayload): Promise<{ permit: Permit }> {
  return apiRequest(`/permits/${encodeURIComponent(id)}`, { method: 'PATCH', body: { version, form } });
}

/** PATCH /api/v1/permits/:id/jsa - `version` is the PERMIT's version; permit and JSA are one document. */
export function updateJsaForm(
  id: string,
  version: number,
  form: JsaFormPayload,
): Promise<{ permit: Permit; jsa: Jsa }> {
  return apiRequest(`/permits/${encodeURIComponent(id)}/jsa`, { method: 'PATCH', body: { version, form } });
}

/**
 * The V2 equivalents. Same endpoints and the same optimistic-concurrency
 * token - only the payload shape differs, and the SERVER decides which
 * contract applies from the permit's stored `form_version`. The client
 * never selects a generation.
 */
export function saveV2PermitDraft(
  id: string,
  version: number,
  form: unknown,
): Promise<{ permit: Permit }> {
  return apiRequest(`/permits/${encodeURIComponent(id)}`, { method: 'PATCH', body: { version, form } });
}

export function saveV2JsaDraft(
  id: string,
  version: number,
  form: unknown,
): Promise<{ permit: Permit; jsa: Jsa }> {
  return apiRequest(`/permits/${encodeURIComponent(id)}/jsa`, { method: 'PATCH', body: { version, form } });
}

type PermitMutation = Promise<{ permit: Permit }>;

/** POST /api/v1/permits/:id/submit - DRAFT -> PENDING_CRO. */
export function submitPermit(id: string, version: number): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/submit`, { method: 'POST', body: { version } });
}

/** POST /api/v1/permits/:id/resubmit - PENDING_CORRECTION -> PENDING_CRO. */
export function resubmitPermit(id: string, version: number): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/resubmit`, { method: 'POST', body: { version } });
}

/** POST /api/v1/permits/:id/forward-hse - CRO forwards for HSE review. */
export function forwardToHse(id: string, version: number): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/forward-hse`, { method: 'POST', body: { version } });
}

/** POST /api/v1/permits/:id/send-back - CRO returns the permit to the applicant. `reason` is optional. */
export function sendBackToApplicant(id: string, version: number, reason?: string): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/send-back`, {
    method: 'POST',
    body: { version, ...(reason ? { reason } : {}) },
  });
}

/** POST /api/v1/permits/:id/hse-approve - HSE approval, which issues the permit. */
export function hseApprove(id: string, version: number): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/hse-approve`, { method: 'POST', body: { version } });
}

/** POST /api/v1/permits/:id/hse-send-back - HSE returns the permit to CRO (never to the applicant). */
export function hseSendBack(id: string, version: number, reason?: string): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/hse-send-back`, {
    method: 'POST',
    body: { version, ...(reason ? { reason } : {}) },
  });
}

/** POST /api/v1/permits/:id/fallback-approve - CRO fallback, allowed only after the backend's own review window expires. */
export function fallbackApprove(id: string, version: number): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/fallback-approve`, { method: 'POST', body: { version } });
}

/** POST /api/v1/permits/:id/hold - ISSUED -> HELD. The reason is mandatory. */
export function holdPermit(id: string, version: number, reason: string): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/hold`, { method: 'POST', body: { version, reason } });
}

/** POST /api/v1/permits/:id/resume - HELD -> ISSUED, only before the permit's own midnight expiry. */
export function resumePermit(id: string, version: number): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/resume`, { method: 'POST', body: { version } });
}

/** POST /api/v1/permits/:id/cancel - ISSUED or HELD -> CANCELLED, permanently. */
export function cancelPermit(id: string, version: number, reason?: string): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: { version, ...(reason ? { reason } : {}) },
  });
}

/** POST /api/v1/permits/:id/close - CRO closure. `closureRemarks` is optional. */
export function closePermit(id: string, version: number, closureRemarks?: string): PermitMutation {
  return apiRequest(`/permits/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    body: { version, ...(closureRemarks ? { closureRemarks } : {}) },
  });
}

/** POST /api/v1/permits/:id/renew - creates a NEW permit from a CLOSED one. The body is empty by contract. */
export function renewPermit(id: string): Promise<{ permit: Permit; jsa: Jsa }> {
  return apiRequest(`/permits/${encodeURIComponent(id)}/renew`, { method: 'POST', body: {} });
}

/**
 * GET /api/v1/permits/:id/pdf - the immutable combined Permit + JSA
 * document, served by the backend after it authorizes the permit. The
 * browser never constructs a storage URL, never sees a bucket path, and
 * never assumes the document is publicly reachable.
 */
export function downloadPermitPdf(id: string): Promise<{ blob: Blob; fileName: string | null }> {
  return apiDownload(`/permits/${encodeURIComponent(id)}/pdf`);
}

// ---------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------

/** GET /api/v1/notifications - the caller's own notifications only. */
export function listNotifications(
  params: { page?: number; pageSize?: number; unread?: 'true' | 'false' } = {},
  signal?: AbortSignal,
): Promise<NotificationListResponse> {
  return apiRequest('/notifications', { query: { ...params }, ...(signal ? { signal } : {}) });
}

/** POST /api/v1/notifications/:id/read */
export function markNotificationRead(id: string): Promise<{ notification: AppNotification }> {
  return apiRequest(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} });
}

// ---------------------------------------------------------------------
// Employee administration (CEO / E-SET SITE_MANAGER)
// ---------------------------------------------------------------------

/** GET /api/v1/admin/employees */
export function listEmployees(
  params: { page?: number; pageSize?: number; search?: string; state?: string; companyCode?: string } = {},
  signal?: AbortSignal,
): Promise<EmployeeListResponse> {
  return apiRequest('/admin/employees', { query: { ...params }, ...(signal ? { signal } : {}) });
}

/** GET /api/v1/admin/organization - the authoritative Company/Team/Position choices. */
export function getOrganization(signal?: AbortSignal): Promise<{ companies: OrganizationCompany[] }> {
  return apiRequest('/admin/organization', { ...(signal ? { signal } : {}) });
}

/** GET /api/v1/admin/employees/:id */
export function getEmployee(id: string, signal?: AbortSignal): Promise<{ employee: EmployeeDetail }> {
  return apiRequest(`/admin/employees/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) });
}

/**
 * GET /api/v1/admin/audit-logs - the organization-wide administrative
 * audit. Paging is the only input; the server refuses anything else.
 */
export function listAuditLogs(
  params: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<AuditLogsResponse> {
  return apiRequest('/admin/audit-logs', {
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}

/** GET /api/v1/admin/employees/:id/history */
export function getEmployeeHistory(
  id: string,
  params: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<EmployeeHistoryResponse> {
  return apiRequest(`/admin/employees/${encodeURIComponent(id)}/history`, {
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}

export interface CreateEmployeeInput {
  email: string;
  temporaryPassword: string;
  displayName: string;
  companyCode: string;
  teamPositionId: string;
}

/** POST /api/v1/admin/employees - the temporary password is never echoed back by the backend. */
export function createEmployee(
  input: CreateEmployeeInput,
): Promise<{ employee: { userId: string; mustChangePassword: boolean } }> {
  return apiRequest('/admin/employees', {
    method: 'POST',
    body: {
      email: input.email,
      temporaryPassword: input.temporaryPassword,
      displayName: input.displayName,
      companyCode: input.companyCode,
      teamPositionId: input.teamPositionId,
    },
  });
}

/**
 * PATCH /api/v1/admin/employees/:id - rename and/or organizational
 * transfer. Company and Team + Position must move together (the backend
 * refuses one without the other), so this signature makes that pairing
 * structural rather than a convention a caller could forget.
 */
export function updateEmployee(
  id: string,
  changes: { displayName?: string; transfer?: { companyCode: string; teamPositionId: string } },
): Promise<{ status: string; employee: { userId: string } }> {
  return apiRequest(`/admin/employees/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: {
      ...(changes.displayName !== undefined ? { displayName: changes.displayName } : {}),
      ...(changes.transfer
        ? { companyCode: changes.transfer.companyCode, teamPositionId: changes.transfer.teamPositionId }
        : {}),
    },
  });
}

/** POST /api/v1/admin/employees/:id/change-email - a new temporary password is mandatory. */
export function changeEmployeeEmail(
  id: string,
  newEmail: string,
  temporaryPassword: string,
): Promise<{ status: string; employee: { userId: string; mustChangePassword: boolean } }> {
  return apiRequest(`/admin/employees/${encodeURIComponent(id)}/change-email`, {
    method: 'POST',
    body: { newEmail, temporaryPassword },
  });
}

/** POST /api/v1/admin/employees/:id/reset-password */
export function resetEmployeePassword(
  id: string,
  temporaryPassword: string,
): Promise<{ status: string; employee: { userId: string; mustChangePassword: boolean } }> {
  return apiRequest(`/admin/employees/${encodeURIComponent(id)}/reset-password`, {
    method: 'POST',
    body: { temporaryPassword },
  });
}

/** POST /api/v1/admin/employees/:id/disable */
export function disableEmployee(id: string): Promise<{ status: string; employee: { userId: string; state: string } }> {
  return apiRequest(`/admin/employees/${encodeURIComponent(id)}/disable`, { method: 'POST', body: {} });
}

/** POST /api/v1/admin/employees/:id/enable */
export function enableEmployee(id: string): Promise<{ status: string; employee: { userId: string; state: string } }> {
  return apiRequest(`/admin/employees/${encodeURIComponent(id)}/enable`, { method: 'POST', body: {} });
}

/** DELETE /api/v1/admin/employees/:id - CEO only. Tombstones the login; history is preserved. */
export function deleteEmployee(id: string): Promise<{ status: string; employee: { userId: string; state: string } }> {
  return apiRequest(`/admin/employees/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * POST/DELETE /api/v1/admin/employees/:id/permissions - the ONE
 * individually grantable permission. The capability name is fixed here,
 * not chosen by a caller, so this can never become a general capability
 * assignment surface.
 */
export const VIEW_ALL_PERMITS_CAPABILITY = 'permit.view_all';

export function setViewAllPermits(
  id: string,
  granted: boolean,
): Promise<{ status: string; employee: { userId: string; capability: string; active: boolean } }> {
  return apiRequest(`/admin/employees/${encodeURIComponent(id)}/permissions`, {
    method: granted ? 'POST' : 'DELETE',
    body: { capability: VIEW_ALL_PERMITS_CAPABILITY },
  });
}

// ---------------------------------------------------------------------
// Site Manager administration (CEO only)
// ---------------------------------------------------------------------

/** GET /api/v1/admin/site-managers */
export function listSiteManagers(signal?: AbortSignal): Promise<{ siteManagers: SiteManagerListItem[] }> {
  return apiRequest('/admin/site-managers', { ...(signal ? { signal } : {}) });
}

/**
 * POST /api/v1/admin/site-managers - establishes a privileged identity.
 * Deliberately carries NO company, team, or position: a privileged
 * system account has none, and the backend rejects any attempt to send
 * one.
 */
export function createSiteManager(input: {
  email: string;
  temporaryPassword: string;
  displayName: string;
}): Promise<{ siteManager: { userId: string; mustChangePassword: boolean } }> {
  return apiRequest('/admin/site-managers', {
    method: 'POST',
    body: {
      email: input.email,
      temporaryPassword: input.temporaryPassword,
      displayName: input.displayName,
    },
  });
}

/** POST /api/v1/admin/site-managers/:id/grant | /revoke - the role is fixed by the endpoint, never by the body. */
export function setSiteManagerGrant(
  id: string,
  active: boolean,
): Promise<{ status: string; siteManager: { userId: string; active: boolean } }> {
  const action = active ? 'grant' : 'revoke';
  return apiRequest(`/admin/site-managers/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
}


/* ------------------------------------------------------------------ */
/* Organization Management                                             */
/* ------------------------------------------------------------------ */

/**
 * Every request below carries the MINIMUM the backend's `.strict()`
 * schema accepts - a display name, and nothing else.
 *
 * There is deliberately no field here for a company `code` (the server
 * generates and freezes it), for a capability, for
 * `siteManagerAssignable`, or for any privileged marker. The backend
 * rejects an unexpected key with a 400 rather than ignoring it, so these
 * signatures are not merely a convention: sending more would fail.
 *
 * There is also no delete function of any kind. Retiring a record is a
 * PATCH to its `deactivate` route, which preserves history.
 */

/** GET /api/v1/admin/organization/structure - every company, team and association, by id. */
export function getOrganizationStructure(
  signal?: AbortSignal,
): Promise<{ companies: OrganizationAdminCompany[] }> {
  return apiRequest('/admin/organization/structure', { ...(signal ? { signal } : {}) });
}

/** POST /api/v1/admin/organization/companies */
export function createCompany(name: string): Promise<{ company: CreatedCompany }> {
  return apiRequest('/admin/organization/companies', { method: 'POST', body: { name } });
}

/** POST /api/v1/admin/organization/companies/:companyId/teams */
export function createTeam(companyId: string, name: string): Promise<{ team: CreatedTeam }> {
  return apiRequest(`/admin/organization/companies/${encodeURIComponent(companyId)}/teams`, {
    method: 'POST',
    body: { name },
  });
}

/**
 * POST /api/v1/admin/organization/companies/:companyId/teams/:teamId/positions
 *
 * Nested under the company because the server resolves the team WITHIN
 * it - a team id belonging to another company reads as "not found"
 * rather than being accepted.
 *
 * The server reuses the existing global position row when that name
 * already exists and mints one otherwise; the client never chooses a
 * position id, and never learns which path was taken beyond the
 * `positionId` it gets back.
 */
export function createTeamPosition(
  companyId: string,
  teamId: string,
  positionName: string,
): Promise<{ association: CreatedTeamPosition }> {
  return apiRequest(
    `/admin/organization/companies/${encodeURIComponent(companyId)}/teams/${encodeURIComponent(teamId)}/positions`,
    { method: 'POST', body: { positionName } },
  );
}

/**
 * PATCH .../deactivate - the only removal this application performs.
 *
 * The body is empty: the target is the validated route parameter, so a
 * stale value in a form can never redirect the action at something else.
 */
export function deactivateOrganizationRecord(
  level: OrganizationLevel,
  id: string,
): Promise<{ status: string }> {
  const segment =
    level === 'company' ? 'companies' : level === 'team' ? 'teams' : 'team-positions';
  return apiRequest(`/admin/organization/${segment}/${encodeURIComponent(id)}/deactivate`, {
    method: 'PATCH',
    body: {},
  });
}

// ---------------------------------------------------------------------
// Permit CMS (CEO, or an explicit individual permit.cms.manage grant)
// ---------------------------------------------------------------------

export type CmsAssetPurpose = 'PDF_LOGO' | 'WEB_LOGO' | 'PWA_ICON';

export interface CmsAsset {
  id: string;
  label: string;
  purpose: CmsAssetPurpose;
  active: boolean;
  displayOrder: number;
  documentTypes: string[];
  createdAt: string;
}

export interface CmsState {
  revision: number;
  organizationName: string;
  signInNotice: string;
  webLogoAssetId: string | null;
  pwaIconAssetId: string | null;
  maxPdfLogos: number;
  assets: CmsAsset[];
}

export interface CmsAuditEvent {
  id: string;
  actorUserId: string;
  eventType: string;
  assetId: string | null;
  occurredAt: string;
}

export function getCmsState(signal?: AbortSignal): Promise<CmsState> {
  return apiRequest('/cms/state', signal ? { signal } : {});
}

export function updateCmsIdentity(body: { revision: number; organizationName: string; signInNotice: string }): Promise<{ revision: number }> {
  return apiRequest('/cms/identity', { method: 'PATCH', body });
}

export function uploadCmsAsset(file: File, purpose: CmsAssetPurpose, label: string): Promise<{ id: string }> {
  return apiUpload('/cms/assets', file, { purpose, label });
}

export function downloadCmsAsset(id: string): Promise<{ blob: Blob; fileName: string | null }> {
  return apiDownload(`/cms/assets/${encodeURIComponent(id)}/image`);
}

export function setCmsPdfLogos(revision: number, assetIds: string[]): Promise<{ revision: number }> {
  return apiRequest('/cms/pdf-logos', {
    method: 'PUT',
    body: { revision, logos: assetIds.map((assetId) => ({ assetId, documentTypes: ['ISSUED_PERMIT'] })) },
  });
}

export function setCmsWebArtwork(kind: 'web-logo' | 'pwa-icon', revision: number, assetId: string | null): Promise<{ revision: number }> {
  return apiRequest(`/cms/${kind}`, { method: 'PUT', body: { revision, assetId } });
}

export function listCmsAudit(signal?: AbortSignal): Promise<{ events: CmsAuditEvent[] }> {
  return apiRequest('/cms/audit', { query: { limit: 100 }, ...(signal ? { signal } : {}) });
}

// Permit Dropbox integration (CEO only)

export interface DropboxConnectionView {
  id: string;
  status: 'disconnected' | 'connected' | 'error' | 'disconnecting';
  accountLabel: string | null;
  revision: number;
  dependentFiles: number;
  healthVerified: boolean;
}

export interface DropboxStatus {
  setupComplete: boolean;
  selectionRevision: number;
  activeConnectionId: string | null;
  connections: DropboxConnectionView[];
}

export function getDropboxStatus(signal?: AbortSignal): Promise<DropboxStatus> {
  return apiRequest('/cms/dropbox/status', signal ? { signal } : {});
}

export function startDropboxConnect(): Promise<{ authorizationUrl: string }> {
  return apiRequest('/cms/dropbox/connect', { method: 'POST' });
}

export function testDropboxConnection(connectionId: string): Promise<{ ok: boolean }> {
  return apiRequest('/cms/dropbox/test', { method: 'POST', body: { connectionId } });
}

export function activateDropbox(revision: number, connectionId: string): Promise<{ active: boolean }> {
  return apiRequest('/cms/dropbox/activate', { method: 'POST', body: { revision, connectionId } });
}

export function deactivateDropbox(revision: number): Promise<{ active: boolean }> {
  return apiRequest('/cms/dropbox/deactivate', { method: 'POST', body: { revision } });
}

export function disconnectDropbox(revision: number, connectionId: string): Promise<{ disconnected: boolean }> {
  return apiRequest('/cms/dropbox/disconnect', { method: 'POST', body: { revision, connectionId } });
}
