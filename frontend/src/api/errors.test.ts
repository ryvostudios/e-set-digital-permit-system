import { describe, expect, it } from 'vitest';
import { ApiError, asApiError, errorMessage, fieldErrors, toApiError, toNetworkError } from './errors';

/**
 * The centralized error model.
 *
 * Two things matter here: that every backend failure lands on the right
 * code so the UI can act on it, and that NOTHING technical ever reaches
 * a person - no SQL, no stack trace, no Postgres internals, no token, no
 * environment variable name.
 */

describe('status mapping', () => {
  const cases: [number, unknown, string][] = [
    [401, { error: 'unauthorized' }, 'unauthorized'],
    [403, { error: 'forbidden' }, 'forbidden'],
    [404, { error: 'not_found' }, 'not_found'],
    [400, { error: 'invalid_request' }, 'invalid_request'],
    [409, { error: 'conflict' }, 'conflict'],
    [413, { error: 'payload_too_large' }, 'payload_too_large'],
    [422, { error: 'invalid_state' }, 'invalid_state'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [500, { error: 'internal_error' }, 'server_error'],
    [502, null, 'server_error'],
  ];

  it.each(cases)('maps %i onto the right code', (status, body, expected) => {
    expect(toApiError(status, body, null).code).toBe(expected);
  });
});

describe('backend error codes that need their own handling', () => {
  it('recognizes a forced password change', () => {
    const error = toApiError(403, { error: 'password_change_required', reason: 'PASSWORD_CHANGE_REQUIRED' }, null);
    expect(error.code).toBe('password_change_required');
  });

  it('recognizes unavailable document storage', () => {
    expect(toApiError(503, { error: 'storage_unavailable' }, null).code).toBe('storage_unavailable');
  });

  it('recognizes unavailable privileged administration', () => {
    expect(toApiError(503, { error: 'privileged_management_unavailable' }, null).code).toBe(
      'privileged_management_unavailable',
    );
    expect(toApiError(503, { error: 'privileged_change_failed', reason: 'x' }, null).code).toBe(
      'privileged_management_unavailable',
    );
  });

  it('recognizes unavailable account management', () => {
    for (const backendError of [
      'account_management_unavailable',
      'provisioning_failed',
      'password_reset_failed',
      'employee_update_failed',
    ]) {
      expect(toApiError(503, { error: backendError }, null).code).toBe('account_management_unavailable');
    }
  });
});

describe('messages shown to people', () => {
  it('prefers the backend’s own wording for a conflict, because it names the business reason', () => {
    const error = toApiError(
      409,
      { error: 'conflict', message: "The permit's midnight expiry has already passed", reason: 'expired' },
      null,
    );
    expect(error.message).toContain('midnight expiry');
    expect(error.reason).toBe('expired');
  });

  it('uses our own wording elsewhere, never the raw server string', () => {
    const error = toApiError(500, { error: 'internal_error', message: 'relation "permits" does not exist' }, null);
    expect(error.message).toBe('Something went wrong. Please try again.');
    expect(error.message).not.toContain('relation');
  });

  it('never surfaces SQL, a stack trace, or an environment variable name', () => {
    const hostile = {
      error: 'internal_error',
      message: 'SELECT * FROM permits; at Object.<anonymous> (/srv/app.js:12)',
      detail: 'SUPABASE_SERVICE_ROLE_KEY=abc',
      stack: 'Error: boom\n  at db.query',
    };
    const rendered = errorMessage(toApiError(500, hostile, null));
    for (const forbidden of ['SELECT', 'SUPABASE_SERVICE_ROLE_KEY', 'at Object', '/srv/app.js', 'Error: boom']) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});

describe('request correlation', () => {
  it('carries a returned request id so a person can quote a reference', () => {
    expect(toApiError(500, null, 'req-123').requestId).toBe('req-123');
  });
});

describe('validation issues', () => {
  it('are exposed per field for inline display', () => {
    const error = toApiError(
      400,
      {
        error: 'invalid_request',
        issues: [
          { path: ['displayName'], message: 'Too short' },
          { path: ['email'], message: 'Invalid email' },
        ],
      },
      null,
    );
    expect(fieldErrors(error)).toEqual({ displayName: 'Too short', email: 'Invalid email' });
  });

  it('tolerate a malformed issues payload rather than throwing', () => {
    expect(fieldErrors(toApiError(400, { error: 'invalid_request', issues: 'not-an-array' }, null))).toEqual({});
  });
});

describe('transport failures and unknown throws', () => {
  it('become a network error, not a crash', () => {
    const error = toNetworkError();
    expect(error.code).toBe('network_error');
    expect(error.status).toBe(0);
  });

  it('normalize anything thrown into an ApiError', () => {
    expect(asApiError(new Error('boom'))).toBeInstanceOf(ApiError);
    expect(asApiError('boom').code).toBe('server_error');
    expect(asApiError(new Error('boom')).message).not.toContain('boom');
  });
});

describe('session detection', () => {
  it('flags only 401 as an ended session', () => {
    expect(toApiError(401, { error: 'unauthorized' }, null).isSessionEnded).toBe(true);
    expect(toApiError(403, { error: 'forbidden' }, null).isSessionEnded).toBe(false);
  });
});
