import { isIP } from 'node:net';
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { logEvent } from './requestLog.js';

/**
 * Rate limiting is per-process, in-memory - `express-rate-limit`'s
 * default `MemoryStore`, deliberately: ARCHITECTURE.md says not to
 * introduce infrastructure (Redis, etc.) without an actual current
 * requirement, and this backend runs as a single instance today.
 *
 * PRODUCTION SCALING CONSTRAINT (documented, not silently assumed away):
 * an in-memory store is per-instance. If this backend is ever run as
 * more than one instance behind a load balancer, each instance enforces
 * these limits independently - a client that gets routed across N
 * instances can send up to roughly N times the configured limit, and a
 * client "counted" on one instance is not seen by another. This is safe
 * and correct for a single-instance deployment (the project's current
 * actual scale - ARCHITECTURE.md's "modular monolith, one deployable
 * backend application"); it is NOT horizontally-scalable rate limiting,
 * and must not be presented or relied on as such. Scaling to multiple
 * instances requires switching to a shared store (e.g. a Redis-backed
 * `express-rate-limit` store) at that time - see DEPLOYMENT.md.
 */

function sendRateLimited(req: Request, res: Response): void {
  logEvent('rate_limit_exceeded', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status: 429,
  });
  res.status(429).json({
    error: 'rate_limited',
    message: 'Too many requests. Please try again later.',
  });
}

/**
 * The client address a limiter keys on. `req.ip` reflects
 * `TRUST_PROXY_CIDRS` (Express's `trust proxy`, set in `app.ts`): behind a
 * trusted proxy it is the forwarded entry the proxy appended, otherwise
 * the socket peer. proxy-addr returns that forwarded entry verbatim, so a
 * value that is not an IP address (`X-Forwarded-For: anything`) would
 * otherwise become a fresh bucket per request. Only a real IP is used;
 * anything else falls back to the connecting peer, so malformed values
 * all share the peer's one bucket and never mint new identities.
 *
 * `ipKeyGenerator` (express-rate-limit's own helper) folds an IPv6
 * address to its /56 subnet, so one client cannot obtain unlimited keys
 * by varying the low bits of its own IPv6 address.
 */
export function clientAddressKey(req: Request): string {
  const candidate = req.ip && isIP(req.ip) ? req.ip : req.socket?.remoteAddress;
  return ipKeyGenerator(candidate && isIP(candidate) ? candidate : 'unknown');
}

/**
 * Keys by the authenticated actor's id when available (i.e. once
 * `requireAuth` has already run earlier in the chain), falling back to
 * the client address otherwise. Using the authenticated identity - not
 * just IP - for anything mounted after `requireAuth` means a signed-in
 * caller can't reset their own budget by switching network/IP, and
 * unrelated users behind one shared IP (e.g. office NAT) don't share one
 * bucket.
 */
function keyByAuthOrIp(req: Request): string {
  return req.auth?.id ?? clientAddressKey(req);
}

export interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  /**
   * When true, keys by authenticated actor id (falling back to IP) -
   * use only for limiters mounted AFTER `requireAuth` in the chain, so
   * authentication genuinely cannot be used to dodge the limit (an
   * unauthenticated request still falls back to IP-keying). When false
   * (default), keys purely by IP - the only option available for a
   * limiter mounted before authentication has been resolved.
   */
  keyed?: boolean;
}

/** Builds one rate limiter. Exported (not just the two configured instances below) so tests can exercise the real mechanism with a tiny window/limit instead of waiting out production-sized ones. */
export function buildRateLimiter(options: RateLimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: sendRateLimited,
    keyGenerator: options.keyed ? keyByAuthOrIp : clientAddressKey,
  });
}

/**
 * Applied to every /api/v1 request, before authentication is resolved -
 * so authenticating never exempts a client from this baseline limit
 * (SECURITY.md: "authenticated users must not be able to trivially
 * bypass limits" is satisfied here simply because auth state plays no
 * part in this limiter at all). Generous: this is a coarse abuse/DoS
 * backstop, not the primary control on any specific sensitive action.
 */
export const globalApiLimiter = buildRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_GLOBAL_MAX,
});

/**
 * Applied in addition to `globalApiLimiter`, only to state-changing
 * permit endpoints (POST/PATCH), after `requireAuth` - stricter, and
 * keyed by authenticated identity (see `keyByAuthOrIp`). This backend
 * has a separate login limiter on `routes/auth.ts`. Capability-gated
 * mutations carry this additional per-actor limit.
 */
export const mutationLimiter = buildRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MUTATION_MAX,
  keyed: true,
});

/**
 * Sign-in BURST control per client address (A05 lockout fix). Short-lived
 * and secondary: the process-wide KDF admission controller
 * (domain/auth/authWork.ts) is the resource boundary, and an edge/WAF
 * limit on /auth/login is the outer layer against distributed floods.
 *
 * - Keyed ONLY by client address. There is deliberately no per-email or
 *   per-account limiter: any failure counter keyed by an email lets
 *   anyone who knows the address keep its owner from signing in. A
 *   correct password must always be able to reach verification.
 * - Counts only unsuccessful attempts (any non-2xx, and requests that
 *   never finish). A successful sign-in costs nothing, so an office
 *   behind one NAT is not limited by its own logins.
 * - A short window (RATE_LIMIT_LOGIN_WINDOW_MS, default 60 s): a source
 *   that exceeds it waits at most that long, never a 15-minute lockout.
 */
export const loginLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_LOGIN_WINDOW_MS,
  limit: env.RATE_LIMIT_LOGIN_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req: Request, res: Response) => res.statusCode < 400,
  handler: sendRateLimited,
  keyGenerator: clientAddressKey,
});

/**
 * Applied to every account-management endpoint (employee provisioning,
 * Site Manager password reset, self-service password change), in
 * addition to `globalApiLimiter`, after `requireAuth`/
 * `requireAuthDuringPasswordChange` - so it keys by authenticated actor
 * (see `keyByAuthOrIp`) and a caller cannot reset their own budget by
 * changing network.
 *
 * Stricter than `mutationLimiter` on purpose: these are the closest
 * thing this backend has to authentication endpoints (SECURITY.md's
 * "particularly on authentication... endpoints"), and repeated calls are
 * exactly what password-reset abuse and scripted account creation look
 * like. Legitimate use is a few calls per window.
 */
export const accountLimiter = buildRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_ACCOUNT_MAX,
  keyed: true,
});

/**
 * Privileged account-management WRITES: employee provisioning, manager
 * password reset, permission and lifecycle changes.
 *
 * SIZED FOR REAL ONBOARDING. There is no business quota on employee
 * creation, and a CEO or System Site Manager provisioning a site is a
 * legitimate burst of dozens of writes in one sitting. The budget clears
 * a 60-employee session with room to spare rather than turning routine
 * administration into a refusal.
 *
 * STILL A REAL LIMIT. It is finite and per-actor, so scripted
 * enumeration or reset abuse still stops well inside one window, and it
 * sits underneath the coarse per-IP `globalApiLimiter`. What it is NOT
 * is a concurrency control: a 15-minute window cap says nothing about
 * how many requests are in flight at once, which is bounded by the
 * client and by the database pool - see the note on
 * RATE_LIMIT_MANAGER_ACCOUNT_MAX in config/env.ts.
 *
 * KEYED BY AUTHENTICATED ACTOR (`keyByAuthOrIp`), so two managers
 * working at the same time hold independent budgets and neither can
 * exhaust the other's - and neither can reset their own by changing
 * network.
 */
export const managerAccountLimiter = buildRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MANAGER_ACCOUNT_MAX,
  keyed: true,
});

/**
 * Privileged account-management READS: the employee directory, one
 * employee's detail and history, the System Site Manager list, and the
 * audit log.
 *
 * A SEPARATE BUDGET, because charging reads to the write budget is what
 * made ordinary administration fail: opening the directory and viewing a
 * few people used up the allowance, and the next legitimate employee
 * creation was refused for no reason a user could understand. Reads are
 * idempotent, cheap, and invoke no Auth Admin work, so they warrant a
 * more generous budget than the writes they precede - while still being
 * bounded, and still keyed per authenticated actor.
 */
export const managerReadLimiter = buildRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MANAGER_READ_MAX,
  keyed: true,
});
