/**
 * ADMISSION CONTROL FOR PASSWORD WORK (A05-P1, pre-production re-audit).
 *
 * Every password KDF operation in this process - Argon2id hash/verify and
 * the legacy bcrypt comparison - runs through one of these, so attacker-
 * controlled sign-in traffic can never schedule unbounded simultaneous KDF
 * work. At most `concurrency` operations run; at most `maxQueue` more wait,
 * each for at most `queueTimeoutMs`; anything beyond that is refused at once
 * with AuthWorkBusy (the route answers a generic 429). A waiter whose
 * client has gone away (AbortSignal) is removed from the queue immediately.
 * The queue holds only resolve/reject callbacks - never a password.
 *
 * A finished operation hands its slot directly to the next waiter, so the
 * running count never dips and re-rises between them.
 */
export class AuthWorkBusy extends Error {
  constructor(message = 'Password work capacity exhausted') { super(message); }
}

interface Waiter { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout; signal?: AbortSignal | undefined; onAbort?: () => void }

export class AuthWorkLimiter {
  private active = 0;
  private closed = false;
  private readonly queue: Waiter[] = [];

  constructor(readonly concurrency: number, readonly maxQueue: number, readonly queueTimeoutMs: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
    if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new Error('maxQueue must be a non-negative integer');
  }

  stats(): { active: number; queued: number } { return { active: this.active, queued: this.queue.length }; }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  /** Refuses new and queued work; running work finishes normally. */
  close(): void {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) this.settle(waiter, new AuthWorkBusy('Password work is shutting down'));
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new AuthWorkBusy('Password work is shutting down'));
    if (signal?.aborted) return Promise.reject(new AuthWorkBusy('Request aborted'));
    if (this.active < this.concurrency) { this.active += 1; return Promise.resolve(); }
    if (this.queue.length >= this.maxQueue) return Promise.reject(new AuthWorkBusy());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject, signal,
        timer: setTimeout(() => this.drop(waiter, new AuthWorkBusy('Timed out waiting for password work')), this.queueTimeoutMs),
      };
      if (signal) { waiter.onAbort = () => this.drop(waiter, new AuthWorkBusy('Request aborted')); signal.addEventListener('abort', waiter.onAbort, { once: true }); }
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) { this.settle(next); return; }   // hand the slot over: `active` is unchanged
    this.active -= 1;
  }

  private drop(waiter: Waiter, error: Error): void {
    const index = this.queue.indexOf(waiter);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.settle(waiter, error);
  }

  private settle(waiter: Waiter, error?: Error): void {
    clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    if (error) waiter.reject(error); else waiter.resolve();
  }
}
