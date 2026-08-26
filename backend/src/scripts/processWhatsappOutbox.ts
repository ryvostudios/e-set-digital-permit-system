import { closePool, query, toSafeDbErrorMessage } from '../db/pool.js';
import { disabledWhatsappProvider, processPendingWhatsappOutbox } from '../domain/notifications/whatsappOutbox.js';
import { pathToFileURL } from 'node:url';

/**
 * Operator-run WhatsApp outbox sender - `npm run outbox:whatsapp:process`.
 * Not invoked automatically by this backend (no cron/scheduler exists in
 * this codebase - ARCHITECTURE.md's "no infrastructure without an
 * actual current requirement"); an operator schedules this externally
 * (cron, a hosting platform's scheduled job, etc.) once a real WhatsApp
 * provider is selected and wired into `WhatsappProvider` (see
 * domain/notifications/whatsappOutbox.ts). Until then, running this
 * command is safe (it simply reports every pending message as failed
 * with a clear "not configured" reason) and never fakes delivery.
 */
export async function runWhatsappOutboxCli(deps: {
  process?: typeof processPendingWhatsappOutbox;
  log?: (message: string) => void;
  error?: (message: string) => void;
} = {}): Promise<boolean> {
  try {
    const result = await (deps.process ?? processPendingWhatsappOutbox)({ query }, disabledWhatsappProvider);
    (deps.log ?? console.log)(
    `outbox:whatsapp:process: processed ${result.processed} message(s) - ${result.sent} sent, ${result.failed} failed/pending.`,
    );
    return true;
  } catch (error) {
    (deps.error ?? console.error)(JSON.stringify({ event: 'whatsapp_worker_failed', detail: toSafeDbErrorMessage(error) }));
    return false;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runWhatsappOutboxCli()
    .then((ok) => { if (!ok) process.exitCode = 1; })
    .finally(() => { void closePool(); });
}
