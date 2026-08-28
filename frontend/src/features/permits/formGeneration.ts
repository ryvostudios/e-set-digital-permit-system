import type { Permit } from '../../api/types';

/**
 * WHICH GENERATION A RECORD IS.
 *
 * Read from the SERVER's stored `form_version` and nowhere else. The
 * browser never chooses a generation: the permit was created under one
 * contract, its payload was written under that contract, and this only
 * reports which one so the right renderer is used.
 *
 * It exists as one exported predicate because the answer is needed in
 * several places on the record screen - which document to draw, which
 * editor may be offered - and a second copy of `endsWith('_V2')` written
 * out somewhere else is exactly how a V2 payload ends up in a V1
 * renderer. That is not a cosmetic failure: the V1 document reads
 * `form.generalWork.length` on a payload that has no such key, and the
 * whole record screen goes blank.
 *
 * The PERMIT's version is the answer for its JSA too. The two are one
 * document sharing one concurrency token, and the backend picks the JSA
 * contract from the permit's `form_version` (`formGeneration.ts` there);
 * keying off the JSA's own column here could disagree with it.
 */
export function isV2FormVersion(formVersion: string | null | undefined): boolean {
  return formVersion?.endsWith('_V2') ?? false;
}

/** The same, for a permit record. */
export function isV2Permit(permit: Pick<Permit, 'form_version'>): boolean {
  return isV2FormVersion(permit.form_version);
}
