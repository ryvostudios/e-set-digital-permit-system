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
export function toPermitLabel(permitType: PermitType | null, sequenceValue: bigint): string {
  const number = toDisplayNumber(sequenceValue);
  return permitType ? `${PERMIT_TYPE_LABELS[permitType]} ${number}` : `Permit ${number}`;
}
