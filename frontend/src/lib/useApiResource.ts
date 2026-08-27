import { useCallback, useEffect, useRef, useState } from 'react';
import { asApiError, type ApiError } from '../api/errors';
import { currentGeneration, subscribeToInvalidation } from './cache';

export interface ApiResource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True only for the very first load, so a refresh doesn't blank the screen. */
  initialLoading: boolean;
  reload: () => void;
}

/**
 * Loads one server resource for the lifetime of a screen.
 *
 * Three properties matter more than convenience here:
 *
 *  1. AUTHORIZATION IS RE-CHECKED BY THE SERVER, ALWAYS. Nothing is
 *     cached across mounts, so a screen can never show data resolved
 *     under permissions the person no longer has. If a permission was
 *     revoked, the next load returns 403/404 and the UI says so.
 *
 *  2. A RESPONSE FROM A PREVIOUS ACCOUNT IS NEVER RENDERED. Every result
 *     is stamped with the identity generation it was requested under and
 *     dropped if that generation has since changed (sign-out, session
 *     end).
 *
 *  3. IN-FLIGHT REQUESTS ARE ABORTED on unmount and on reload, so a slow
 *     response cannot overwrite a newer one.
 */
export function useApiResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean } = {},
): ApiResource<T> {
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const requestedAt = currentGeneration();
    let active = true;
    setLoading(true);

    void (async () => {
      try {
        const result = await fetcherRef.current(controller.signal);
        if (!active || currentGeneration() !== requestedAt) return;
        setData(result);
        setError(null);
      } catch (caught) {
        if (!active || controller.signal.aborted) return;
        if (currentGeneration() !== requestedAt) return;
        setData(null);
        setError(asApiError(caught));
      } finally {
        if (active) {
          setLoading(false);
          setHasLoaded(true);
        }
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
    // `fetcher` is held in a ref so an inline arrow doesn't retrigger
    // the effect; the caller's own `deps` decide when to re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  // Re-fetch whenever authorization-sensitive state may have changed.
  useEffect(() => subscribeToInvalidation(reload), [reload]);

  return { data, error, loading, initialLoading: loading && !hasLoaded, reload };
}
