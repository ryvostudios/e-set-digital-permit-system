/**
 * Permit validity: "An issued permit is valid only until the next
 * midnight in the configured site timezone, regardless of what time it
 * was issued" (WORKFLOW.md). This module computes that boundary using an
 * authoritative instant (backend/database time, never client time) and
 * the site's configured IANA time zone - never client/browser/device
 * time or timezone (SECURITY.md "Time and Enforcement Integrity").
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getZonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some environments format midnight as "24" under hour12: false.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Finds the UTC instant at which the local wall-clock time in `timeZone`
 * reads the given year/month/day/hour/minute/second, accounting for that
 * zone's UTC offset (including DST) via iterative correction.
 */
function zonedWallClockToUtc(parts: ZonedParts, timeZone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = target;
  // Two passes are enough: the first corrects for the zone's offset, the
  // second corrects for any residual drift from a DST transition landing
  // between the first guess and the corrected one.
  for (let i = 0; i < 2; i += 1) {
    const guessedParts = getZonedParts(new Date(guess), timeZone);
    const guessedAsUtc = Date.UTC(
      guessedParts.year,
      guessedParts.month - 1,
      guessedParts.day,
      guessedParts.hour,
      guessedParts.minute,
      guessedParts.second,
    );
    guess -= guessedAsUtc - target;
  }
  return new Date(guess);
}

/**
 * Returns the UTC instant of the next local midnight in `timeZone`
 * strictly after `fromUtc` - i.e. the end of `fromUtc`'s local calendar
 * day. Matches DECISIONS.md's examples: issued 09:00 -> expires 00:00;
 * issued 23:50 -> expires 00:00 (same operational day boundary).
 */
export function computeNextMidnightUtc(fromUtc: Date, timeZone: string): Date {
  const local = getZonedParts(fromUtc, timeZone);
  const nextDayUtcDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return zonedWallClockToUtc(
    {
      year: nextDayUtcDate.getUTCFullYear(),
      month: nextDayUtcDate.getUTCMonth() + 1,
      day: nextDayUtcDate.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
}

/** True while `nowUtc` is still before the next local midnight after `issuedAtUtc`. */
export function isPermitValid(issuedAtUtc: Date, timeZone: string, nowUtc: Date): boolean {
  return nowUtc.getTime() < computeNextMidnightUtc(issuedAtUtc, timeZone).getTime();
}
