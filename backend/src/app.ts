import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { corsOptions } from './config/cors.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();

  app.use(cors(corsOptions));
  app.use(express.json());
  app.use('/api/v1', healthRouter);
  app.use('/api/v1', authRouter);

  // Turns a disallowed-origin rejection from `cors` into a clean 403
  // instead of falling through to Express's default error handler (which
  // can include a stack trace in its response).
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof Error && err.message === 'Not allowed by CORS') {
      res.status(403).json({ error: 'forbidden', message: 'Origin not allowed' });
      return;
    }
    next(err);
  });

  return app;
}
