import type { NextFunction, Request, Response } from 'express';
import { supabase, toSafeAuthErrorMessage } from '../lib/supabase.js';

/** Minimal, validated authentication identity attached to a request. Proves identity only — not authorization. */
export interface AuthIdentity {
  id: string;
  email: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthIdentity;
  }
}

function sendUnauthorized(res: Response): void {
  res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Verifies the caller's Supabase access token server-side and attaches the
 * resulting identity to `req.auth`. Rejects with 401 on any missing or
 * invalid token. Never trusts a client-supplied user/session object.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req.header('authorization'));
  if (!token) {
    sendUnauthorized(res);
    return;
  }

  try {
    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data) {
      sendUnauthorized(res);
      return;
    }

    const { claims } = data;
    req.auth = {
      id: claims.sub,
      email: claims.email ?? null,
    };
    next();
  } catch (err) {
    console.error('Authentication verification failed:', toSafeAuthErrorMessage(err));
    sendUnauthorized(res);
  }
}
