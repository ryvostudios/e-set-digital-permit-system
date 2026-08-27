import {
  JSA_FORM_VERSION,
  PERMIT_FORM_VERSIONS,
  derivePermitFormProjection,
  deriveJsaFormProjection,
  parseJsaForm,
  parsePermitForm,
  type FormParseResult,
  type JsaFormProjection,
  type PermitFormProjection,
  type PermitType,
} from './forms.js';
import {
  JSA_FORM_VERSION_V2,
  PERMIT_FORM_VERSIONS_V2,
  parseJsaFormV2,
  parsePermitFormV2,
  type ConfinedSpaceEntryFormV2,
  type ColdWorkFormV2,
  type HotWorkFormV2,
  type JsaFormV2,
  type PermitFormV2,
  type WtgWorkFormV2,
} from './formsV2.js';

/**
 * WHICH FORM CONTRACT A GIVEN RECORD SPEAKS.
 *
 * Two generations coexist: V1, the original contract every stored permit
 * currently uses, and V2, the authoritative fixed-question contract built
 * from the transcribed operational forms.
 *
 * THE DISPATCH RULE, AND WHY IT IS THE ONLY SAFE ONE: a payload is always
 * parsed by the generation named on the STORED ROW, never by anything the
 * request supplies. A client cannot ask for its payload to be validated
 * as V1 in order to escape V2's fixed-key checking, because it does not
 * get a say - `permits.form_version` does. This mirrors how
 * `permit_type` already chooses the schema.
 *
 * READ COMPATIBILITY IS PERMANENT UNTIL EXPLICITLY RETIRED. V1 parsing is
 * not removed here. Existing V1 permits stay readable and editable as V1
 * for as long as they exist; nothing rewrites a stored payload into the
 * other generation.
 */

export type FormGeneration = 'V1' | 'V2';

/**
 * THE CUTOVER SWITCH: the generation NEW drafts are created with.
 *
 * Deliberately still 'V1'. Migration 0029 makes V2 storable and every
 * read/write path below understands it, but flipping this constant makes
 * `Apply for permit` start producing payloads the CURRENT frontend cannot
 * render - so the flip belongs with the frontend renderers, not before
 * them. Changing this one value is the whole cutover.
 */
export const ACTIVE_FORM_GENERATION: FormGeneration = 'V1';

const PERMIT_VERSION_GENERATIONS: ReadonlyMap<string, FormGeneration> = new Map([
  ...Object.values(PERMIT_FORM_VERSIONS).map((version) => [version, 'V1'] as const),
  ...Object.values(PERMIT_FORM_VERSIONS_V2).map((version) => [version, 'V2'] as const),
]);

/** The `form_version` a new permit of this type gets, for the given generation. */
export function permitFormVersionFor(permitType: PermitType, generation: FormGeneration): string {
  return generation === 'V2' ? PERMIT_FORM_VERSIONS_V2[permitType] : PERMIT_FORM_VERSIONS[permitType];
}

/** The JSA `form_version` that belongs with a permit of the given generation - they are one document. */
export function jsaFormVersionFor(generation: FormGeneration): string {
  return generation === 'V2' ? JSA_FORM_VERSION_V2 : JSA_FORM_VERSION;
}

/**
 * The generation a stored `form_version` belongs to, or null if the value
 * is not one this build knows. Null is a refusal, never a fallback: a row
 * carrying an unrecognised version must not be quietly parsed as V1.
 */
export function generationOfPermitFormVersion(formVersion: string | null): FormGeneration | null {
  if (!formVersion) return null;
  return PERMIT_VERSION_GENERATIONS.get(formVersion) ?? null;
}

export function generationOfJsaFormVersion(formVersion: string | null): FormGeneration | null {
  if (formVersion === JSA_FORM_VERSION) return 'V1';
  if (formVersion === JSA_FORM_VERSION_V2) return 'V2';
  return null;
}

export type AnyPermitForm = ReturnType<typeof parsePermitForm> extends FormParseResult<infer T>
  ? T | PermitFormV2
  : never;

/**
 * Validates a permit payload against the contract the STORED row names.
 * `formVersion` comes from `permits.form_version`; a request cannot
 * influence it.
 */
export function parsePermitFormForVersion(
  permitType: PermitType,
  formVersion: string | null,
  value: unknown,
): FormParseResult<AnyPermitForm> {
  const generation = generationOfPermitFormVersion(formVersion);
  if (generation === null) {
    return { ok: false, reason: 'invalid', issues: [] };
  }
  return (
    generation === 'V2' ? parsePermitFormV2(permitType, value) : parsePermitForm(permitType, value)
  ) as FormParseResult<AnyPermitForm>;
}

export function parseJsaFormForVersion(
  generation: FormGeneration,
  value: unknown,
): FormParseResult<ReturnType<typeof parseJsaForm> extends FormParseResult<infer T> ? T | JsaFormV2 : never> {
  return (generation === 'V2' ? parseJsaFormV2(value) : parseJsaForm(value)) as never;
}

/**
 * The relational projection, for either generation. These columns exist so
 * workflow and search queries never open the JSONB; they are written in
 * the same statement as the payload they came from, so the two cannot
 * drift, and they are never accepted from a client.
 */
export function derivePermitProjectionForVersion(
  permitType: PermitType,
  generation: FormGeneration,
  form: AnyPermitForm,
): PermitFormProjection {
  if (generation === 'V1') {
    return derivePermitFormProjection(permitType, form as Parameters<typeof derivePermitFormProjection>[1]);
  }
  if (permitType === 'WTG_WORK') {
    const wtg = form as WtgWorkFormV2;
    return {
      windFarm: wtg.permitIssue.windFarmName,
      wtgNumber: wtg.permitIssue.wtgNumber,
      workDescription: wtg.permitIssue.descriptionOfWork,
      lotoNumber: null,
    };
  }
  const other = form as ColdWorkFormV2 | HotWorkFormV2 | ConfinedSpaceEntryFormV2;
  return {
    windFarm: null,
    wtgNumber: null,
    workDescription: null,
    lotoNumber: other.lotoNumber ?? null,
  };
}

export function deriveJsaProjectionForVersion(
  generation: FormGeneration,
  form: unknown,
): JsaFormProjection {
  if (generation === 'V1') {
    return deriveJsaFormProjection(form as Parameters<typeof deriveJsaFormProjection>[0]);
  }
  const v2 = form as JsaFormV2;
  return { siteOrWtg: v2.page1.siteOrWtg, jobDescription: v2.page1.jobOrWork };
}
