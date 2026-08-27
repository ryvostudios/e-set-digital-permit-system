/**
 * ONE error model for every backend call.
 *
 * The backend answers with a small, closed set of sanitized error codes
 * (see backend/src/app.ts and each route module). This module turns any
 * response - or any transport failure - into a single `ApiError` with a
 * code the UI can branch on and a message that is safe to show a person.
 *
 * NOTHING TECHNICAL IS EVER SURFACED. The backend already refuses to
 * return SQL, stack traces, Postgres internals, tokens, or environment
 * variable names; this layer additionally never invents such detail, and
 * never echoes a raw server string for the codes where a written message
 * exists. Where the backend returns a request id, it is carried on the
 * error so a person can quote it to an operator - that is the only
 * diagnostic detail a user ever sees.
 */

export type ApiErrorCode =
  | 'unauthorized'
  | 'password_change_required'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'invalid_state'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'storage_unavailable'
  | 'document_processing'
  | 'account_management_unavailable'
  | 'privileged_management_unavailable'
  | 'service_unavailable'
  | 'server_error'
  | 'network_error';

/** One field-level validation issue, as Zod reports it through the API. */
export interface ApiIssue {
  path: (string | number)[];
  message: string;
}

/**
 * One printed safety question the SERVER says is still unanswered.
 *
 * The completeness rule lives on the server and only there; this is the
 * server's answer travelling to the editor so it can point at the right
 * control. The frontend never decides what "complete" means.
 */
export interface UnansweredAnswer {
  sectionId: string;
  sectionTitle: string;
  itemId: string;
  /** The printed question, verbatim. */
  itemLabel: string;
  /** Location in the payload, which the editor turns into an element id. */
  path: string[];
}

export interface UnansweredQuestions {
  permit: UnansweredAnswer[];
  jsa: UnansweredAnswer[];
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** The backend's machine-readable `reason`, where one was returned (e.g. `version_mismatch`). */
  readonly reason: string | null;
  readonly issues: ApiIssue[];
  /** Present only on a 422 `unanswered_questions` refusal. */
  readonly unanswered: UnansweredQuestions | null;
  readonly requestId: string | null;

  constructor(init: {
    code: ApiErrorCode;
    status: number;
    message: string;
    reason?: string | null;
    issues?: ApiIssue[];
    unanswered?: UnansweredQuestions | null;
    requestId?: string | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.reason = init.reason ?? null;
    this.issues = init.issues ?? [];
    this.unanswered = init.unanswered ?? null;
    this.requestId = init.requestId ?? null;
  }

  /** True when the caller's session is no longer usable and they must return to login. */
  get isSessionEnded(): boolean {
    return this.code === 'unauthorized';
  }
}

/**
 * The written message for each code. A backend `message` is preferred
 * only where the backend genuinely writes something more specific than
 * these (conflicts and validation), because those carry the actual
 * business reason.
 */
const MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: 'Your session has ended. Please sign in again.',
  password_change_required: 'You must change your password before continuing.',
  forbidden: 'You do not have permission to do this.',
  not_found: 'That record is not available.',
  invalid_request: 'Some details are not valid. Please check the form and try again.',
  invalid_state: 'This record is not in a state that allows that action.',
  conflict: 'This record changed since you opened it. Reload and try again.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  payload_too_large: 'That form is too large to save. Please shorten the longer entries.',
  storage_unavailable: 'Document storage is not available right now.',
  document_processing: 'The permit document is still being prepared.',
  account_management_unavailable: 'Account management is not available in this environment.',
  privileged_management_unavailable: 'Site Manager administration is not available in this environment.',
  service_unavailable: 'That service is temporarily unavailable. Please try again.',
  server_error: 'Something went wrong. Please try again.',
  network_error: 'Cannot reach the server. Check your connection and try again.',
};

/** Maps an HTTP status plus the backend's `error` field onto one of our codes. */
function resolveCode(status: number, backendError: string | undefined): ApiErrorCode {
  switch (backendError) {
    case 'password_change_required':
      return 'password_change_required';
    case 'storage_unavailable':
      return 'storage_unavailable';
    case 'account_management_unavailable':
    case 'provisioning_failed':
    case 'password_reset_failed':
    case 'password_change_failed':
    case 'employee_update_failed':
    case 'deletion_incomplete':
      return 'account_management_unavailable';
    case 'privileged_management_unavailable':
    case 'privileged_change_failed':
    case 'privileged_grant_failed':
      return 'privileged_management_unavailable';
    case 'payload_too_large':
      return 'payload_too_large';
    case 'invalid_state':
      return 'invalid_state';
    default:
      break;
  }

  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'invalid_state';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'invalid_request';
  if (status === 503) return 'service_unavailable';
  if (status >= 500) return 'server_error';
  return 'server_error';
}

function readIssues(body: unknown): ApiIssue[] {
  if (typeof body !== 'object' || body === null || !('issues' in body)) return [];
  const raw = (body as { issues: unknown }).issues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((issue) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const path = 'path' in issue && Array.isArray((issue as { path: unknown }).path)
      ? ((issue as { path: (string | number)[] }).path)
      : [];
    const message = 'message' in issue && typeof (issue as { message: unknown }).message === 'string'
      ? (issue as { message: string }).message
      : 'This value is not valid.';
    return [{ path, message }];
  });
}

/**
 * Reads the itemised unanswered-question list, when the backend sent one.
 * Shape-checked rather than trusted: a malformed entry is dropped instead
 * of reaching the editor and producing a broken focus target.
 */
function readUnanswered(body: unknown): UnansweredQuestions | null {
  if (typeof body !== 'object' || body === null || !('unanswered' in body)) return null;
  const raw = (body as { unanswered: unknown }).unanswered;
  if (typeof raw !== 'object' || raw === null) return null;

  const list = (value: unknown): UnansweredAnswer[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const e = entry as Record<string, unknown>;
      if (typeof e.itemLabel !== 'string' || !Array.isArray(e.path)) return [];
      if (!e.path.every((segment) => typeof segment === 'string')) return [];
      return [{
        sectionId: typeof e.sectionId === 'string' ? e.sectionId : '',
        sectionTitle: typeof e.sectionTitle === 'string' ? e.sectionTitle : '',
        itemId: typeof e.itemId === 'string' ? e.itemId : '',
        itemLabel: e.itemLabel,
        path: e.path as string[],
      }];
    });
  };

  const value = raw as { permit?: unknown; jsa?: unknown };
  const permit = list(value.permit);
  const jsa = list(value.jsa);
  return permit.length === 0 && jsa.length === 0 ? null : { permit, jsa };
}

/** Builds an `ApiError` from a non-OK response body. */
export function toApiError(status: number, body: unknown, requestId: string | null): ApiError {
  const backendError =
    typeof body === 'object' && body !== null && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : undefined;
  const backendMessage =
    typeof body === 'object' && body !== null && 'message' in body && typeof (body as { message: unknown }).message === 'string'
      ? (body as { message: string }).message
      : undefined;
  const reason =
    typeof body === 'object' && body !== null && 'reason' in body && typeof (body as { reason: unknown }).reason === 'string'
      ? (body as { reason: string }).reason
      : null;

  const code = resolveCode(status, backendError);
  // A conflict or a state refusal is the one place the backend's own
  // wording is more useful than ours: it names the actual business
  // reason ("The permit's midnight expiry has already passed").
  const preferBackendMessage = code === 'conflict' || code === 'invalid_state';
  const message = preferBackendMessage && backendMessage ? backendMessage : MESSAGES[code];

  return new ApiError({
    code,
    status,
    message,
    reason,
    issues: readIssues(body),
    unanswered: readUnanswered(body),
    requestId,
  });
}

/** A transport-level failure - the request never produced an HTTP response. */
export function toNetworkError(): ApiError {
  return new ApiError({ code: 'network_error', status: 0, message: MESSAGES.network_error });
}

/** Normalizes anything thrown by an API call into an `ApiError`. */
export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError({ code: 'server_error', status: 0, message: MESSAGES.server_error });
}

/** The safe, human-readable text for any thrown value. */
export function errorMessage(error: unknown): string {
  return asApiError(error).message;
}

/**
 * Field-level messages keyed by the first path segment, for rendering
 * validation issues next to the input that produced them.
 */
export function fieldErrors(error: unknown): Record<string, string> {
  const apiError = asApiError(error);
  const result: Record<string, string> = {};
  for (const issue of apiError.issues) {
    const key = issue.path.map(String).join('.');
    if (key && !(key in result)) result[key] = issue.message;
  }
  return result;
}
