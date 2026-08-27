import { useEffect } from 'react';

/**
 * Protects unsaved work from being lost.
 *
 * TWO WAYS OUT, BOTH COVERED. `beforeunload` handles closing, reloading
 * and leaving the site. It does NOT fire for navigation inside a
 * single-page application, so a click on a sidebar link would silently
 * discard a half-filled safety document - which is exactly the loss worth
 * preventing on a form this long.
 *
 * WHY A CAPTURE-PHASE CLICK LISTENER rather than the router's own
 * blocker: `useBlocker` requires a data router (`createBrowserRouter`),
 * and this application mounts `BrowserRouter`. Converting the whole
 * router to gain one guard would be a large change to routing for a
 * narrow need. Every in-app destination is a `NavLink`, which renders a
 * real anchor, so intercepting anchor clicks before React Router sees
 * them covers the same ground without touching routing at all.
 *
 * Only genuinely unsaved work is challenged: when `dirty` is false
 * nothing is registered, so a saved document never nags.
 */
export function useUnsavedChangesGuard(
  dirty: boolean,
  message = 'You have unsaved changes to this permit. Leave without saving?',
): void {
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers show their own wording; a value is still required.
      event.returnValue = '';
    };

    const onClickCapture = (event: MouseEvent) => {
      // Leave modified clicks alone - they open a new tab, so nothing is lost.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      // Staying on the same page loses nothing.
      if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;

      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    // Capture phase, so this runs BEFORE React Router's own click handler.
    document.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [dirty, message]);
}
