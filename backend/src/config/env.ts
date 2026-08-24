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
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && !value.DB_SSL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DB_SSL'],
        message: 'DB_SSL must not be disabled in production',
      });
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
