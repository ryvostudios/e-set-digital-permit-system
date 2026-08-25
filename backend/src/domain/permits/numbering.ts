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
