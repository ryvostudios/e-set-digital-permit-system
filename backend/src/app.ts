import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { corsOptions } from './config/cors.js';
import { env } from './config/env.js';
import { parseTrustProxyCidrs } from './config/trustProxy.js';
import { toSafeDbErrorMessage } from './db/pool.js';
import { globalApiLimiter } from './middleware/rateLimit.js';
import { requestId, requestLog } from './middleware/requestLog.js';
import { accountsRouter } from './routes/accounts.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { notificationsRouter } from './routes/notifications.js';
import { permitsRouter } from './routes/permits.js';

// Request bodies here are small, structured JSON (permit/JSA form
// fields) - there is no file upload or bulk-import endpoint in this
// API - so a generous-but-bounded limit rejects abusive oversized
// payloads without ever needing to be raised for a legitimate request.
const JSON_BODY_LIMIT = '100kb';

export function createApp(): Express {
  const app = express();

  // Express's own `trust proxy` setting - governs what `req.ip` (and so
  // IP-keyed rate limiting/logging) trusts from X-Forwarded-For. Given
  // an explicit address/network list (rather than a boolean or hop
  // count), Express/proxy-addr trusts X-Forwarded-For ONLY when the
  // immediate connecting peer matches one of these entries, walking
  // backwards through the chain until it reaches an address that
  // doesn't - so a direct client, or an intermediary not in this list,
  // can never inject an arbitrary req.ip via a forged header. An empty
  // list (the default - TRUST_PROXY_CIDRS unset) leaves Express's own
  // default (trust nothing): req.ip is always the direct socket address.
  // See env.ts's doc comment on TRUST_PROXY_CIDRS and DEPLOYMENT.md for
  // the full production requirement.
  const trustedProxies = parseTrustProxyCidrs(env.TRUST_PROXY_CIDRS);
  if (trustedProxies.length > 0) {
    app.set('trust proxy', trustedProxies);
  }
  // No framework fingerprinting/unnecessary response headers.
  app.disable('x-powered-by');

  // Assign correlation identity before anything can terminate a response,
  // then reject abusive floods before attaching full per-response completion
  // listeners. Limiter rejections emit one lightweight sanitized event.
  app.use(requestId);
  app.use(globalApiLimiter);
  app.use(requestLog);
  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use('/api/v1', healthRouter);
  app.use('/api/v1', authRouter);
  app.use('/api/v1', accountsRouter);
  app.use('/api/v1', permitsRouter);
  app.use('/api/v1', notificationsRouter);

  // Any request that reached here matched no route above - an unknown
  // path, or a known path with a method it doesn't support. A generic,
  // sanitized 404 either way; never Express's default HTML/stack-bearing
  // fallback.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', message: 'Not found' });
  });

  // Central error handler - every branch below returns a sanitized,
  // generic body; none ever include a stack trace, raw error message,
  // SQL, or other internal detail (SECURITY.md / this batch's HTTP
  // hardening requirement). Express 5 forwards a rejected async route
  // handler here automatically, so this also covers async handler
  // throws, not just synchronous ones.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof Error && err.message === 'Not allowed by CORS') {
      res.status(403).json({ error: 'forbidden', message: 'Origin not allowed' });
      return;
    }
    // body-parser's JSON middleware throws a SyntaxError carrying the raw
    // `body` text for malformed JSON - Express's own documented pattern
    // for recognizing it - so it gets the same sanitized shape as every
    // other validation failure, not a generic 500 (and never echoes the
    // raw body back).
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'invalid_request', message: 'Malformed JSON body' });
      return;
    }
    // A body over JSON_BODY_LIMIT is rejected by body-parser as a 413
    // (PayloadTooLargeError) before it ever reaches a route handler.
    if (err && typeof err === 'object' && 'type' in err && (err as { type?: unknown }).type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large', message: 'Request body too large' });
      return;
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'unhandled_error',
        requestId: req.requestId,
        detail: toSafeDbErrorMessage(err),
      }),
    );
    res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred' });
  });

  return app;
}
