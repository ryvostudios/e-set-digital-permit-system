import type { PermitType } from './forms.js';

/**
 * The human-visible Permit/JSA number FORMAT is not confirmed by the
 * authoritative docs - DECISIONS.md's "CW-1045" example illustrates the
 * numbering *rule* (same number through review/resubmission/hold/resume,
 * a new Permit number only on renewal, same JSA number across renewal),
 * not a finalized business display format (DATABASE.md explicitly defers
 * "the exact numbering/generation mechanism" to implementation).
 *
 * The authoritative, concurrency-safe numbering data is the raw sequence
 * value from `permit_number_seq` / `jsa_number_seq` (see migration
 * 0006_permits_jsa_schema.sql), stored on `permits.permit_sequence` /
 * `jsas.jsa_sequence`. This function is the single seam where a
 * confirmed display format gets applied - until that format is
 * confirmed, it deliberately does not guess a business-visible prefix
 * and just renders the raw sequence number. Changing the real format
 * later means changing only this function, not the numbering/renewal
 * model or any stored data.
 */
export function toDisplayNumber(sequenceValue: bigint): string {
  return sequenceValue.toString();
}

/**
 * The permit types, as a person reads them.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE NUMBER. Since migration 0033 each
 * permit type is numbered in its own series, so "Permit 1" now names four
 * different permits. The AUTHORITATIVE permit number is still the bare
 * per-type sequence - `permitDisplayNumber`, the PDF's Permit No., the
 * issued snapshot and the record screen all print exactly what is stored,
 * and none of them gains a prefix. Only prose meant for a human to read
 * needs the type beside the number, and this is where that pairing is
 * made.
 */
export const PERMIT_TYPE_LABELS = {
  WTG_WORK: 'WTG Work Permit',
  COLD_WORK: 'Cold Work Permit',
  HOT_WORK: 'Hot Work Permit',
  CONFINED_SPACE_ENTRY: 'Confined Space Entry Permit',
} as const;

/**
 * A permit named for a human: "Cold Work Permit 1".
 *
 * FOR PROSE ONLY - notification titles and messages. It is never an
 * identifier, never stored, and never the authoritative Permit No. A
 * pre-form permit has no type to name, so it reads "Permit 1" as before.
 */
export function toPermitLabel(
  permitType: PermitType | null,
  sequenceValue: bigint | number | string | null | undefined,
): string {
  const number = toPermitNumber(permitType, sequenceValue);
  return permitType ? `${PERMIT_TYPE_LABELS[permitType]} ${number}` : `Permit ${number}`;
}

// =====================================================================
// THE AUTHORITATIVE PERMIT NUMBER, AS PEOPLE READ IT
// =====================================================================

/**
 * The printed prefix for each permit type.
 *
 * DERIVED, NEVER STORED. The database keeps the type and a number -
 * `HOT_WORK` and `12` - and the prefix is produced from the type here.
 * Storing "HW" beside `HOT_WORK` would be the same fact twice, and two
 * copies of a fact are two things that can disagree.
 */
export const PERMIT_NUMBER_PREFIXES = {
  WTG_WORK: 'WTG',
  COLD_WORK: 'CW',
  HOT_WORK: 'HW',
  CONFINED_SPACE_ENTRY: 'CS',
} as const;

/**
 * What a permit with no number yet is called.
 *
 * A DRAFT has not entered the register, so it has nothing to be called.
 * It is not `0`, not `-`, and above all not the number it would get if
 * it were submitted right now - someone else may submit first.
 */
export const UNASSIGNED_PERMIT_NUMBER = 'Not assigned';

/**
 * THE ONE PLACE A PERMIT NUMBER BECOMES TEXT: `HW-12`, or
 * `Not assigned` while it is still a draft.
 *
 * Every surface reads this - the register, the queues, the record,
 * notifications, the issued PDF, the download filename - because a
 * permit that is called one thing on screen and another on its document
 * is not one permit.
 */
export function toPermitNumber(
  permitType: PermitType | null | undefined,
  sequenceValue: bigint | number | string | null | undefined,
): string {
  if (sequenceValue === null || sequenceValue === undefined) return UNASSIGNED_PERMIT_NUMBER;
  const number = toDisplayNumber(BigInt(sequenceValue));
  const prefix = permitType ? PERMIT_NUMBER_PREFIXES[permitType] : undefined;
  // A pre-form permit has no type and therefore no prefix; its number is
  // still its number.
  return prefix ? `${prefix}-${number}` : number;
}

/** Whether a permit has been entered in the register yet. */
export function hasPermitNumber(sequenceValue: bigint | number | string | null | undefined): boolean {
  return sequenceValue !== null && sequenceValue !== undefined;
}
