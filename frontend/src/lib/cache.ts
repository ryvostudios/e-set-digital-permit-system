/**
 * Cross-account cache safety.
 *
 * This application deliberately holds NO long-lived client cache of
 * permit, employee, or notification data: every screen fetches what it
 * needs when it mounts, and re-fetches after any mutation. That is the
 * simplest defence against showing one person data resolved under
 * another person's authorization.
 *
 * What does exist is a set of in-flight requests and mounted screens.
 * `clearCaches` is the single signal that says "the account has
 * changed - discard everything": it bumps a generation counter that
 * every `useApiResource` reads, so any response that arrives after a
 * sign-out is dropped instead of being rendered, and every subscribed
 * screen re-fetches under the NEW identity.
 */

let generation = 0;
const listeners = new Set<() => void>();

/** The current identity generation. A response from an older one is never rendered. */
export function currentGeneration(): number {
  return generation;
}

/**
 * Invalidates every cached and in-flight result. Called on sign-in,
 * sign-out, and whenever the backend ends a session.
 */
export function clearCaches(): void {
  generation += 1;
  for (const listener of listeners) listener();
}

/**
 * Invalidates authorization-sensitive data WITHOUT ending the session -
 * used after a permission grant/revoke, so a screen can never keep
 * rendering a list produced under the old permission set.
 */
export function invalidateAll(): void {
  for (const listener of listeners) listener();
}

export function subscribeToInvalidation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
