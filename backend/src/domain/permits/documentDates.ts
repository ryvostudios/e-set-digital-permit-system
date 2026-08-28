/**
 * HOW A STORED INSTANT IS PRINTED ON THE ISSUED DOCUMENT.
 *
 * Every timestamp in a snapshot is stored as a UTC ISO-8601 string, which
 * is the right thing to store and the wrong thing to print: a permit is
 * read on site by people who need to know when it was issued and when it
 * stops being valid, in their own clock, not
 * `2026-08-28T14:06:31.482Z`.
 *
 * NOTHING STORED CHANGES. This is presentation only - the snapshot, its
 * hash, and every stored timestamp are untouched, and this module is
 * never used to compute a validity boundary or any other decision. It
 * exists so the PDF reads like a document instead of a database row.
 *
 * ONE FORMATTER, USED EVERYWHERE THE DOCUMENT SHOWS A TIME, so an issue
 * time, a validity time and a signature time cannot end up in three
 * different formats on one page.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Anything that is plainly not an instant is passed through untouched (a dash, a blank, free text). */
function isInstant(value: string): boolean {
  return value.trim() !== '' && value.trim() !== '-' && Number.isFinite(Date.parse(value));
}

/**
 * `28 Aug 2026, 7:06 PM` in the site's own timezone.
 *
 * Deliberately assembled from `formatToParts` rather than taking a locale
 * string wholesale: the output must not drift with the host's locale, and
 * every part that appears is chosen here. Seconds and milliseconds are
 * never shown - a permit is not accurate to the second and printing one
 * implies it is.
 *
 * A value that is not an instant is returned exactly as given, so a
 * blank field stays blank and free text stays free text.
 */
export function formatDocumentDateTime(value: string, timeZone: string): string {
  if (!isInstant(value)) return value;
  const instant = new Date(value);
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
        .formatToParts(instant)
        .map((part) => [part.type, part.value]),
    );
    const month = MONTHS[Number(parts.month) - 1];
    if (!month || !parts.day || !parts.year || !parts.hour || !parts.minute) return value;
    const meridiem = (parts.dayPeriod ?? '').toUpperCase().replace(/[^AP M]/g, '').trim() || 'AM';
    return `${Number(parts.day)} ${month} ${parts.year}, ${Number(parts.hour)}:${parts.minute} ${meridiem}`;
  } catch {
    // An unusable timezone must not take the document down; the stored
    // value is still the truth and is printed as it is.
    return value;
  }
}

/**
 * The one line of timezone context the document carries, e.g.
 * `Pakistan Standard Time (UTC+5)`.
 *
 * Printed ONCE, and only as context for the times above it - never as a
 * technical `Asia/Karachi` row, which is a configuration value and means
 * nothing to the person holding the permit.
 */
export function describeDocumentTimeZone(timeZone: string, at: string): string | null {
  if (!Number.isFinite(Date.parse(at))) return null;
  const instant = new Date(at);
  try {
    const named = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'long' })
      .formatToParts(instant)
      .find((part) => part.type === 'timeZoneName')?.value;
    const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(instant)
      .find((part) => part.type === 'timeZoneName')?.value;
    // `GMT+05:00` reads as `UTC+5` on a printed form.
    const tidyOffset = offset
      ? offset.replace(/^GMT/, 'UTC').replace(/([+-]\d+):00$/, '$1').replace(/([+-])0(\d)/, '$1$2')
      : null;
    if (!named) return tidyOffset;
    return tidyOffset ? `${named} (${tidyOffset})` : named;
  } catch {
    return null;
  }
}
