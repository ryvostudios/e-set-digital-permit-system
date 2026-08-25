import { Router, type Request, type Response } from 'express';
import { query, toSafeDbErrorMessage } from '../db/pool.js';

export const healthRouter = Router();

/**
 * Liveness: "is this process still running and able to respond at
 * all" - deliberately does no dangerous or expensive work (no database
 * call, no dependency check). An orchestrator restarting the process
 * because THIS failed would be restarting a process that was never the
 * problem; that judgment belongs to `/ready` below, not here.
 */
healthRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'backend',
    timestamp: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
  });
});

/**
 * Readiness: "can this instance actually serve requests right now" -
 * checks the one critical dependency this backend cannot function
 * without (the database), with a cheap `SELECT 1`. Never reveals
 * connection strings, hostnames, or raw driver error detail - just
 * up/down, matching `toSafeDbErrorMessage`'s existing sanitization used
 * everywhere else a database error might otherwise leak internals.
 */
healthRouter.get('/ready', async (_req: Request, res: Response) => {
  try {
    await query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    console.error('Readiness check failed:', toSafeDbErrorMessage(err));
    res.status(503).json({ status: 'not_ready' });
  }
});
