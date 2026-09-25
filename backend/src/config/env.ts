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

function isSecureUrlWithoutUserInfo(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function canonicalProductionOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    ) return null;
    return url.origin;
  } catch {
    return null;
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
    MIGRATION_DATABASE_URL: z.string().min(1).refine(isPostgresConnectionString, {
      message: 'MIGRATION_DATABASE_URL must be a postgresql:// or postgres:// connection string',
    }).optional(),
    /**
     * A SEPARATE, server-only login used for exactly one thing: appending
     * CEO-authorized SITE_MANAGER grant/revoke events. It must be the
     * dedicated `privileged_runtime` role, which holds only CONNECT,
     * schema USAGE, and EXECUTE on the one hardened grant function - no
     * table DML at all (DEPLOYMENT.md). It is never the migration owner,
     * never `postgres`, and never the ordinary runtime login.
     *
     * OPTIONAL by design: the backend starts and serves every ordinary
     * request without it. Only the CEO-only Site Manager endpoints depend
     * on it, and they fail closed with a sanitized 503 when it is absent -
     * the same posture the Auth Admin credential already uses. A
     * deployment that never performs privileged administration therefore
     * never has to hold this credential at all.
     */
    PRIVILEGED_DATABASE_URL: z
      .string()
      .min(1)
      .refine(isPostgresConnectionString, {
        message: 'PRIVILEGED_DATABASE_URL must be a postgresql:// or postgres:// connection string',
      })
      .optional(),
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

    // Authentication is Permit-owned (permit.users + server-side sessions,
    // domain/auth/). No Supabase Auth URL, publishable key or service-role
    // key is read by this backend.
    //
    // Supabase Storage S3-compatible server credentials, used only for
    // issued permit PDFs. Never exposed to the frontend. All are optional for ordinary API startup; the
    // document worker/download path fails closed until all are present.
    SUPABASE_STORAGE_ENDPOINT: z.string().url().optional(),
    SUPABASE_STORAGE_REGION: z.string().min(1).optional(),
    SUPABASE_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    SUPABASE_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    SUPABASE_DOCUMENT_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).default('issued-permit-documents'),
    // Permit-owned Dropbox App Folder. These are server-only; no browser
    // variable carries a token or client secret. The old S3 settings above
    // remain read-only for historical objects until offline migration.
    PERMIT_STORAGE_MASTER_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
    PERMIT_STORAGE_KEY_VERSION: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('1'),
    DROPBOX_CLIENT_ID: z.string().min(1).optional(),
    DROPBOX_CLIENT_SECRET: z.string().min(1).optional(),
    DROPBOX_OAUTH_ORIGIN: z.string().url().optional(),

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
    /**
     * THE ISSUED-DOCUMENT WORKER.
     *
     * Issuing a permit records an immutable snapshot and queues ONE
     * `permit_document_jobs` row; a worker then renders the PDF and
     * uploads it. That worker existed only as an operator-run script, so
     * on a single hosted Web Service nothing ever claimed a job: the row
     * sat PENDING with `attempt_count = 0` and `claimed_at = NULL`
     * forever, and `GET /permits/:id/pdf` answered 202 "still being
     * prepared" indefinitely.
     *
     * It now runs inside the API process by default, which is what a
     * one-service deployment needs. Set this to `false` ONLY where a
     * separate worker service runs `npm run documents:process` instead -
     * both are safe together (the claim uses `FOR UPDATE SKIP LOCKED`
     * and a per-run claim token), but there is no reason to pay for both.
     */
    DOCUMENT_WORKER_ENABLED: booleanFlag.default(true),
    /**
     * How often the worker looks for due jobs. A permit's PDF is wanted
     * within seconds of issuance, and an idle poll is one indexed query,
     * so this is deliberately short. The floor keeps a misconfiguration
     * from turning the poll into a busy loop against the database.
     */
    DOCUMENT_WORKER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15 * 60 * 1000),
    // Coarse per-IP DoS backstop, NOT the control on any specific action.
    // Keyed by IP and therefore shared by everyone behind one office NAT,
    // so it has to accommodate several people using the app at once: a
    // single admin session that provisions 60 employees is already 60
    // requests before any list refresh, detail view or notification poll.
    // 1200 per 15 minutes is ~1.3 requests/second sustained from one
    // address - still a hard ceiling on flooding, no longer a ceiling on
    // ordinary shared-office use.
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).max(10_000).default(1_200),
    RATE_LIMIT_MUTATION_MAX: z.coerce.number().int().min(1).max(1_000).default(30),
    // Account management (employee provisioning, manager password reset,
    // self-service password change) is deliberately far stricter than an
    // ordinary mutation: these are the endpoints where brute-force,
    // reset abuse, or scripted account creation would do the most
    // damage, and their legitimate human use is a handful of calls per
    // window, not dozens.
    RATE_LIMIT_ACCOUNT_MAX: z.coerce.number().int().min(1).max(200).default(10),
    // Sign-in attempts per client IP per window. Every attempt pays an
    // Argon2id verification, so this also bounds CPU spent on guessing.
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).max(200).default(10),
    // Manager WRITES (employee provisioning, password reset, permission
    // and lifecycle changes). There is no business quota on employee
    // creation, so this has to clear a realistic onboarding batch with
    // room to spare: 120 is double the 60-employee session the business
    // requires, while still stopping a scripted enumeration dead well
    // inside one window.
    //
    // The previous default of 3 came from keeping the burst under the DB
    // pool size (10) while an Auth outage held each request open for its
    // full timeout. That reasoning conflated RATE with CONCURRENCY: a
    // 15-minute window cap does not permit 120 simultaneous requests -
    // in-flight work is bounded by the client and by the pool itself,
    // both of which are unchanged here. Sequential provisioning never
    // held more than one connection at a time even under the old limit.
    RATE_LIMIT_MANAGER_ACCOUNT_MAX: z.coerce.number().int().min(1).max(1_000).default(120),
    // Manager READS (employee list, employee detail, System Site Manager
    // list, audit logs). Separate from the write budget on purpose:
    // reads are idempotent and cheap, they invoke no Auth Admin work, and
    // charging them to the provisioning budget is what made ordinary
    // browsing exhaust it - open the directory, view a few people, and
    // the next legitimate creation was refused.
    RATE_LIMIT_MANAGER_READ_MAX: z.coerce.number().int().min(1).max(5_000).default(300),
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

    const storageValues = [
      value.SUPABASE_STORAGE_ENDPOINT,
      value.SUPABASE_STORAGE_REGION,
      value.SUPABASE_STORAGE_ACCESS_KEY_ID,
      value.SUPABASE_STORAGE_SECRET_ACCESS_KEY,
    ];
    if (storageValues.some(Boolean) && !storageValues.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_STORAGE_ENDPOINT'],
        message: 'all Supabase Storage S3 credential settings must be configured together',
      });
    }
    if ((value.DROPBOX_CLIENT_ID || value.DROPBOX_CLIENT_SECRET) && !value.PERMIT_STORAGE_MASTER_KEY) {
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['PERMIT_STORAGE_MASTER_KEY'],message:'Permit storage encryption is required when Dropbox application credentials are configured'});
    }
    if (value.PERMIT_STORAGE_MASTER_KEY && Buffer.from(value.PERMIT_STORAGE_MASTER_KEY,'base64').length !== 32) {
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['PERMIT_STORAGE_MASTER_KEY'],message:'Permit storage key must decode to 32 bytes'});
    }
    if (value.DROPBOX_OAUTH_ORIGIN) {
      let origin: URL | null = null;
      try { origin = new URL(value.DROPBOX_OAUTH_ORIGIN); } catch { /* rejected below */ }
      if (!origin || origin.origin !== value.DROPBOX_OAUTH_ORIGIN || origin.username || origin.password ||
          (origin.protocol !== 'https:' && !(value.NODE_ENV !== 'production' && origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname)))) {
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['DROPBOX_OAUTH_ORIGIN'],message:'Dropbox callback origin must be a bare HTTPS origin (loopback HTTP is local only)'});
      }
    }

    if (value.NODE_ENV === 'production' && !value.DB_SSL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DB_SSL'],
        message: 'DB_SSL must not be disabled in production',
      });
    }

    if (value.NODE_ENV === 'production') {
      if (value.SUPABASE_STORAGE_ENDPOINT && !isSecureUrlWithoutUserInfo(value.SUPABASE_STORAGE_ENDPOINT)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SUPABASE_STORAGE_ENDPOINT'],
          message: 'SUPABASE_STORAGE_ENDPOINT must be an HTTPS URL without credentials in production',
        });
      }
      if (!value.CORS_ALLOWED_ORIGINS?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'CORS_ALLOWED_ORIGINS is required in production',
        });
      } else if (value.CORS_ALLOWED_ORIGINS.split(',').some((origin) => canonicalProductionOrigin(origin.trim()) === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'CORS_ALLOWED_ORIGINS must contain only canonical HTTPS origins without credentials, paths, query strings, or fragments in production',
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
