import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * THE HSE APPROVAL PRIORITY WINDOW.
 *
 * A CRO forwarding a permit to HSE starts a five-minute window in which
 * HSE alone may act. Once it expires an authorized CRO may also approve,
 * as a fallback - and both CRO and HSE need to see the same clock, or
 * they cannot tell whose turn it is.
 *
 * WHAT THIS IS NOT. It is not a permission, and it decides nothing. The
 * deadline is set by the database when the forward commits, every action
 * is authorized against the database's own `now()` when it is attempted,
 * and the buttons on screen come from the server's `availableActions`.
 * This draws a number; the server decides what may be done.
 *
 * WHY IT DOES NOT TRUST THE DEVICE CLOCK. Remaining time is measured as
 * `(deadline - serverTime) - elapsed since the response arrived`, using
 * a monotonic local elapsed count. A device whose wall clock is ten
 * minutes out therefore shows the same countdown as everyone else. A
 * skewed clock cannot make the window look expired when it is not.
 *
 * NOTHING HERE SAYS HSE MAY NOT APPROVE AFTER EXPIRY - because HSE may.
 * The window is a PRIORITY, not a deadline for HSE: when it runs out,
 * HSE keeps its ordinary approval and CRO merely becomes eligible too.
 * The first successful approval wins, and the server settles that.
 */

const SECOND = 1000;

export interface HseReviewWindowProps {
  /** The authoritative deadline, from the permit. */
  deadlineAt: string;
  /** The server's clock at the moment this state was fetched. */
  serverTime: string;
  /**
   * Called once when the window runs out, so the screen can re-read the
   * record and pick up the actions the server now offers. Without it a
   * CRO would have to reload the page to see the fallback appear.
   */
  onExpired?: () => void;
}

/** `04:32`. Seconds are what a person watching a five-minute window reads. */
function formatRemaining(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / SECOND));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function HseReviewWindow({ deadlineAt, serverTime, onExpired }: HseReviewWindowProps) {
  /*
    How long was left when the server answered. Everything after this is
    measured locally against that, never against the device's idea of the
    current wall-clock time.
  */
  const remainingAtFetch = useMemo(() => {
    const deadline = Date.parse(deadlineAt);
    const server = Date.parse(serverTime);
    if (!Number.isFinite(deadline) || !Number.isFinite(server)) return null;
    return deadline - server;
  }, [deadlineAt, serverTime]);

  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const notified = useRef(false);

  // A fresh fetch restarts the local measurement from the new anchor.
  useEffect(() => {
    startedAt.current = Date.now();
    notified.current = false;
    setElapsed(0);
  }, [deadlineAt, serverTime]);

  const remaining = remainingAtFetch === null ? null : remainingAtFetch - elapsed;
  const expired = remaining !== null && remaining <= 0;

  useEffect(() => {
    if (remainingAtFetch === null) return undefined;
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
    }, SECOND);
    return () => window.clearInterval(timer);
  }, [remainingAtFetch]);

  useEffect(() => {
    if (!expired || notified.current) return;
    notified.current = true;
    // Let the screen re-read the record: the fallback action becomes
    // available on the SERVER's terms, not because a timer hit zero here.
    onExpired?.();
  }, [expired, onExpired]);

  if (remainingAtFetch === null) return null;

  return (
    <div className="card" data-testid="hse-review-window" data-expired={expired ? 'true' : 'false'}>
      <p className="doc__field-label">HSE approval priority</p>
      {expired ? (
        <>
          <p data-testid="hse-review-window-state">
            <strong>Priority window ended</strong>
          </p>
          {/*
            Deliberately not "HSE can no longer approve". HSE still can -
            the window only stops HSE being the ONLY one who can.
          */}
          <p className="muted text-sm">
            HSE may still approve. An authorized CRO may now approve as a fallback instead. Whichever happens
            first issues the permit.
          </p>
        </>
      ) : (
        <>
          <p data-testid="hse-review-window-state">
            <strong>{formatRemaining(remaining ?? 0)}</strong> remaining
          </p>
          <p className="muted text-sm">
            Fallback approval becomes available to an authorized CRO after this window.
          </p>
        </>
      )}
    </div>
  );
}
