import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
// A client- or proxy-supplied request id is only ever used for
// correlation display, never trusted as anything authoritative - bound
// to a conservative shape/length so it can't be used to inject
// unbounded or malformed data into log lines.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Structured, single-line JSON log write. Never called with request/authorization headers, tokens, or permit/JSA body content - see the module doc below for what this deliberately never logs. */
function logLine(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/**
 * Minimal, production-useful structured logging: a correlation id per
 * request (reusing an inbound `X-Request-Id` when it looks safe to,
 * otherwise generating one), and one JSON line per completed request
 * with method/path/status/duration. Echoes the id back on
 * `X-Request-Id` so a client/proxy can correlate its own logs.
 *
 * Deliberately never logs: the Authorization header or any bearer
 * token, cookies, request/response bodies (so no permit/JSA content,
 * closure remarks, etc.), or query strings (a validation error response
 * already carries the relevant detail without needing the raw query
 * logged too). Route handlers must not add their own logging of request
 * bodies for the same reason.
 *
 * A 401/403 response is additionally logged as `event: "auth_failure"` /
 * `"authz_failure"` (still with no header/token content) - the
 * information SECURITY.md's authorization requirements call for being
 * observable, without duplicating a general-purpose audit log.
 */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const inboundId = req.header(REQUEST_ID_HEADER);
  req.requestId = inboundId && SAFE_REQUEST_ID.test(inboundId) ? inboundId : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  const startedAtMs = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAtMs;
    logLine({
      event: 'request',
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
    });
    if (res.statusCode === 401) {
      logLine({ event: 'auth_failure', requestId: req.requestId, method: req.method, path: req.path });
    } else if (res.statusCode === 403) {
      logLine({ event: 'authz_failure', requestId: req.requestId, method: req.method, path: req.path });
    } else if (res.statusCode >= 500) {
      logLine({ event: 'server_error', requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode });
    }
  });

  next();
}

/** Startup/shutdown lifecycle events, in the same structured shape as request logs. */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  logLine({ event, ...fields });
}
