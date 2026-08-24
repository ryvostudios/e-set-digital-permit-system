import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool, getPool, toSafeDbErrorMessage } from './db/pool.js';

async function main(): Promise<void> {
  try {
    await getPool().query('SELECT 1');
  } catch (err) {
    console.error('Failed to connect to the database on startup:', toSafeDbErrorMessage(err));
    await closePool();
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`backend listening on port ${env.PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);

    server.close((closeErr) => {
      let exitCode = 0;
      if (closeErr) {
        console.error('Error closing HTTP server:', closeErr.message);
        exitCode = 1;
      }
      closePool()
        .catch((poolErr: unknown) => {
          console.error('Error closing database pool:', toSafeDbErrorMessage(poolErr));
          exitCode = 1;
        })
        .finally(() => {
          process.exit(exitCode);
        });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', toSafeDbErrorMessage(err));
  process.exit(1);
});
