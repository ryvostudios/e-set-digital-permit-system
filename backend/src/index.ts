import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool, getPool, toSafeDbErrorMessage } from './db/pool.js';
import { logEvent } from './middleware/requestLog.js';

// A safety net, not the primary shutdown mechanism: `server.close()`
// normally completes as soon as in-flight requests finish and idle
// keep-alive sockets are closed (below), but if something unexpected
// keeps a connection open indefinitely, the process must still exit
// rather than hang forever during a deploy/restart.
const FORCE_SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  try {
    await getPool().query('SELECT 1');
  } catch (err) {
    logEvent('startup_failed', { reason: 'database_unreachable', detail: toSafeDbErrorMessage(err) });
    await closePool();
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logEvent('startup', { port: env.PORT, nodeEnv: env.NODE_ENV });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('shutdown_started', { signal });

    const forceExitTimer = setTimeout(() => {
      logEvent('shutdown_forced', { reason: 'timeout' });
      process.exit(1);
    }, FORCE_SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    server.close((closeErr) => {
      let exitCode = 0;
      if (closeErr) {
        logEvent('shutdown_error', { stage: 'http_server', detail: closeErr.message });
        exitCode = 1;
      }
      closePool()
        .catch((poolErr: unknown) => {
          logEvent('shutdown_error', { stage: 'database_pool', detail: toSafeDbErrorMessage(poolErr) });
          exitCode = 1;
        })
        .finally(() => {
          clearTimeout(forceExitTimer);
          logEvent('shutdown_complete', { exitCode });
          process.exit(exitCode);
        });
    });

    // Idle keep-alive connections have no in-flight request, so
    // `server.close()` alone waits for them to time out on their own
    // (which can take a while) before its callback ever fires - closing
    // them immediately lets an orderly shutdown proceed right away.
    // Deliberately `closeIdleConnections`, NOT `closeAllConnections`:
    // the latter would also cut off in-flight requests mid-response,
    // which is exactly what a graceful shutdown must not do.
    server.closeIdleConnections?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logEvent('startup_failed', { reason: 'fatal', detail: toSafeDbErrorMessage(err) });
  process.exit(1);
});
