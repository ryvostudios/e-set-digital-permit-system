import 'dotenv/config';
import { z } from 'zod';
import { findInvalidTrustProxyTokens, parseTrustProxyCidrs } from './trustProxy.js';

const ALLOWED_DATABASE_URL_SCHEMES = new Set(['postgres:', 'postgresql:']);

function isPostgresConnectionString(value: string): boolean {
  try {
    return ALLOWED_DATABASE_URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isValidTimeZone(value: string): boolean {
  try {
    // Constructing is the validation; it throws RangeError for an unknown zone.
    void new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort guard against pasting a privileged Supabase key into
 * SUPABASE_PUBLISHABLE_KEY (ARCHITECTURE.md: "Privileged/service-role
 * credentials must never be exposed to the frontend or committed to the
 * repository" - this key is read by the frontend too, via its own env,
 * so a service-role key here would be a real exposure, not just a
 * backend misconfiguration). Covers both known Supabase key shapes:
 * the new prefixed format (`sb_secret_...`) and the legacy JWT format,
 * where the payload carries a `role` claim. This does not verify the
 * JWT signature - it only inspects the unsigned payload to catch an
 * obvious copy-paste mistake, not to authenticate anything.
 */
function looksLikeServiceRoleKey(value: string): boolean {
  if (value.startsWith('sb_secret_')) return true;

  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    const payloadBase64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
    return typeof payload === 'object' && payload !== null && (payload as { role?: unknown }).role === 'service_role';
  } catch {
    return false;
  }
}

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

// Exported for env.test.ts, which validates the schema/fail-fast rules
// directly (safeParse against a constructed env object) rather than
// exercising the `env` singleton below, which reads real `process.env`
// once at import time and calls `process.exit` on failure - not
// something a unit test should trigger.
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // 65535 is the highest possible TCP port - an unbounded value here
    // is meaningless input, not just an unlikely one.
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),

    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(isPostgresConnectionString, {
        message: 'DATABASE_URL must be a postgresql:// or postgres:// connection string',
      }),
    DB_SSL: booleanFlag.default(true),
    // Path to a PEM-encoded CA certificate to trust for the database TLS
    // connection (e.g. Supabase's CA). Optional; when unset and DB_SSL is
    // true, the platform's default trusted CA store is used instead.
    DB_CA_CERT_PATH: z.string().optional(),
    // 100 is far beyond what a single backend instance legitimately
    // needs against one Supabase/Postgres project (whose own total
    // connection ceiling is a shared, finite resource) - an unbounded
    // value here would let a misconfiguration silently starve the
    // database of connections for every other client.
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    // Both of the below are millisecond delays `pg` hands to Node
    // timers internally - the same "must stay far under the ~24.8-day
    // 32-bit setTimeout/setInterval ceiling" concern as
    // RATE_LIMIT_WINDOW_MS (see its doc comment below); 0 is `pg`'s own
    // documented "disabled" value for each (no idle auto-disconnect / no
    // connect timeout) and is intentionally still allowed.
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),

    SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1, 'SUPABASE_PUBLISHABLE_KEY is required'),

    // The IANA time zone permit validity is evaluated in (next-midnight
    // expiry). No default - the site's actual timezone must be configured
    // explicitly rather than assumed.
    SITE_TIMEZONE: z
      .string()
      .min(1, 'SITE_TIMEZONE is required')
      .refine(isValidTimeZone, { message: 'SITE_TIMEZONE must be a valid IANA time zone name' }),

    // Comma-separated list of allowed frontend origins for CORS (e.g.
    // "https://permits.example.com"). Required in production; in
    // development, falls back to the local Vite dev origin if unset.
    CORS_ALLOWED_ORIGINS: z.string().optional(),

    // Comma-separated allowlist of the SPECIFIC reverse-proxy addresses/
    // networks in front of this backend (IPs, CIDR blocks, and/or the
    // proxy-addr preset names "loopback"/"linklocal"/"uniquelocal" - see
    // config/trustProxy.ts). Controls Express's `trust proxy` setting,
    // which in turn controls what `req.ip` (and so IP-keyed rate
    // limiting/logging) actually trusts from X-Forwarded-For. Defaults to
    // unset/empty - no proxy trusted, `req.ip` is the direct socket
    // address - which is safe but WRONG behind a real reverse proxy/load
    // balancer: every request would appear to come from the proxy's
    // single IP.
    //
    // Deliberately a specific address/network allowlist, NOT a hop
    // count: a hop count (an earlier design of this setting) trusts ANY
    // address at that many hops back, which cannot distinguish the real
    // proxy from an attacker directly connecting and forging that many
    // X-Forwarded-For entries themselves - only an explicit allowlist of
    // addresses that are actually the deployment's real proxy/load
    // balancer prevents that. See DEPLOYMENT.md for the full production
    // requirement (the backend must additionally not be reachable except
    // through that proxy - this allowlist is not a substitute for that).
    TRUST_PROXY_CIDRS: z.string().optional(),

    // Rate limiting (backend-wide, in-memory - see
    // src/middleware/rateLimit.ts for the documented per-instance/
    // horizontal-scaling constraint this implies). Sensible defaults
    // apply if unset; override per-environment only if actually needed.
    //
    // Every bound below is a documented, practical operational range,
    // not just "must be a positive integer" - an unbounded value here is
    // itself a footgun: an extreme window is a Node `setTimeout`/
    // `setInterval` delay internally (32-bit signed int - values much
    // above ~24.8 days silently misbehave), and an extreme request-count
    // max defeats the point of a limit at all. 1_000..3_600_000ms (1
    // second to 1 hour) and the request-count ranges below are all far
    // inside the 32-bit timer range and Number.MAX_SAFE_INTEGER, so
    // `.int()` + these bounds together are sufficient - no separate
    // "unsafe integer" check is needed the way pagination's OFFSET
    // needed one (see validation.ts), because nothing here multiplies
    // two client-influenced values together.
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15 * 60 * 1000),
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).max(10_000).default(300),
    RATE_LIMIT_MUTATION_MAX: z.coerce.number().int().min(1).max(1_000).default(30),
  })
  .superRefine((value, ctx) => {
    const invalidProxyTokens = findInvalidTrustProxyTokens(parseTrustProxyCidrs(value.TRUST_PROXY_CIDRS));
    if (invalidProxyTokens.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_PROXY_CIDRS'],
        message: `TRUST_PROXY_CIDRS contains invalid entries (must be specific IP addresses, CIDR blocks, or loopback/linklocal/uniquelocal - never "*" or a full-range 0.0.0.0/0 / ::/0 wildcard): ${invalidProxyTokens.join(', ')}`,
      });
    }

    if (looksLikeServiceRoleKey(value.SUPABASE_PUBLISHABLE_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_PUBLISHABLE_KEY'],
        message:
          'SUPABASE_PUBLISHABLE_KEY looks like a privileged service-role key, not the publishable/anon key - refusing to start with a service-role credential in a value read by frontend-facing config',
      });
    }

    if (value.NODE_ENV === 'production' && !value.DB_SSL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DB_SSL'],
        message: 'DB_SSL must not be disabled in production',
      });
    }

    if (value.NODE_ENV === 'production') {
      if (!value.CORS_ALLOWED_ORIGINS?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'CORS_ALLOWED_ORIGINS is required in production',
        });
      } else if (
        value.CORS_ALLOWED_ORIGINS.split(',').some((origin) => origin.trim() === '*')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'CORS_ALLOWED_ORIGINS must not contain "*" in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();
