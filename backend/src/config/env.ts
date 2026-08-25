import 'dotenv/config';
import { z } from 'zod';

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

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),

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
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),

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
  })
  .superRefine((value, ctx) => {
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
