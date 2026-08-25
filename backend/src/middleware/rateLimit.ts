import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';

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

function sendRateLimited(_req: Request, res: Response): void {
  res.status(429).json({
    error: 'rate_limited',
    message: 'Too many requests. Please try again later.',
  });
}

/**
 * Keys by the authenticated actor's id when available (i.e. once
 * `requireAuth` has already run earlier in the chain), falling back to
 * the client IP otherwise. Using the authenticated identity - not just
 * IP - for anything mounted after `requireAuth` means a signed-in caller
 * can't reset their own budget by switching network/IP, and unrelated
 * users behind one shared IP (e.g. office NAT) don't share one bucket.
 * `req.ip` itself already reflects `TRUST_PROXY_CIDRS` (Express's `trust
 * proxy` setting, configured in `app.ts` from `config/trustProxy.ts`),
 * so this is safe behind a correctly configured reverse proxy and safe
 * (falls back to the direct socket address) when there is none.
 */
function keyByAuthOrIp(req: Request): string {
  // `ipKeyGenerator` (express-rate-limit's own helper) normalizes an
  // IPv6 address to a fixed-size subnet before it's used as a key -
  // required here because this is a custom keyGenerator; express-rate-limit
  // validates at request time that a raw, unnormalized IPv6 address is
  // never used directly as a key (a single client can otherwise obtain
  // effectively unlimited distinct keys by varying the low bits of its
  // own IPv6 address) and throws if it is.
  return req.auth?.id ?? ipKeyGenerator(req.ip ?? 'unknown');
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
    ...(options.keyed ? { keyGenerator: keyByAuthOrIp } : {}),
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
 * has no password login/signup endpoint of its own (authentication
 * happens directly against Supabase Auth from the frontend - see
 * `routes/auth.ts`), so there is no separate "login" route to rate-limit
 * the way SECURITY.md's "particularly on authentication... endpoints"
 * guidance usually implies; the closest equivalent, every
 * capability-gated mutation, is covered here instead.
 */
export const mutationLimiter = buildRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MUTATION_MAX,
  keyed: true,
});
