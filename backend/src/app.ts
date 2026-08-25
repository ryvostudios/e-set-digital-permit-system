import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { corsOptions } from './config/cors.js';
import { toSafeDbErrorMessage } from './db/pool.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { permitsRouter } from './routes/permits.js';

export function createApp(): Express {
  const app = express();

  app.use(cors(corsOptions));
  app.use(express.json());
  app.use('/api/v1', healthRouter);
  app.use('/api/v1', authRouter);
  app.use('/api/v1', permitsRouter);

  // Turns a disallowed-origin rejection from `cors` into a clean 403
  // instead of falling through to Express's default error handler (which
  // can include a stack trace in its response). Express 5 forwards a
  // rejected async route handler here automatically.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof Error && err.message === 'Not allowed by CORS') {
      res.status(403).json({ error: 'forbidden', message: 'Origin not allowed' });
      return;
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error('Unhandled request error:', toSafeDbErrorMessage(err));
    res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred' });
  });

  return app;
}
