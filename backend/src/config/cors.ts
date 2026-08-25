import type { CorsOptions } from 'cors';
import { env } from './env.js';

const DEFAULT_DEV_ORIGIN = 'http://localhost:5173';

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter((origin) => origin.length > 0);
}

const configuredOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);

// Production requires CORS_ALLOWED_ORIGINS to be set (enforced in env.ts),
// so this only falls back to the local Vite dev origin outside production.
const allowedOrigins = new Set(
  configuredOrigins.length > 0 ? configuredOrigins : env.NODE_ENV === 'production' ? [] : [DEFAULT_DEV_ORIGIN],
);

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header means the request isn't a browser cross-origin
    // request (e.g. curl, server-to-server); nothing to allow/deny here.
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: false,
  allowedHeaders: ['Authorization', 'Content-Type'],
};
