/**
 * Wraps fetch with a real cancellation deadline. The wrapper preserves an
 * upstream AbortSignal (including one carried by a Request) and aborts the
 * underlying HTTP operation when either that signal or the hard timeout
 * fires. A Promise.race would only stop awaiting and would leave the socket
 * active, so it is deliberately not used here.
 */
export function createTimeoutFetch(baseFetch: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const upstreamSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

    const abortFromUpstream = (): void => {
      controller.abort(upstreamSignal?.reason);
    };
    if (upstreamSignal?.aborted) {
      abortFromUpstream();
    } else {
      upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    }

    const timeout = setTimeout(() => {
      controller.abort(new DOMException('Auth Admin request timed out', 'TimeoutError'));
    }, timeoutMs);

    try {
      return await baseFetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    }
  };
}
