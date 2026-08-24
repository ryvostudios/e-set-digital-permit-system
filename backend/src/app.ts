import express, { type Express } from 'express';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();

  app.use(express.json());
  app.use('/api/v1', healthRouter);

  return app;
}
