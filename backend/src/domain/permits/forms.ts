import { z } from 'zod';

/**
 * Strict, versioned Permit and JSA form schemas - the validation half of
 * migration 0016's hybrid relational + JSONB model. Nothing here is
 * stored until it has passed the exact schema named by the permit's own
 * `permit_type`/`form_version`, and every object is `.strict()`, so an
 * unknown property is REJECTED rather than silently dropped or stored.
 *
 * FAITHFULNESS RULE: these schemas reproduce the STRUCTURE of the real
 * supplied permit/JSA forms - their sections, their repeatable rows, and
 * the option lists that were actually supplied. Where the real form's
 * individual checklist QUESTIONS (or an option list's exact options)
 * were not supplied, they are deliberately NOT invented: the section is
 * modelled as repeatable labelled rows, so the real wording comes from
 * the rendered form itself rather than from a guess made here. The one
 * place option lists ARE hard-coded is Cold Work's Nature of Work and
 * Hazards, which were supplied verbatim.
 *
 * IDENTITY RULE: no form payload anywhere in this file carries a signer
 * name, designation or user id. The applicant, CRO, HSE and CRO-fallback
 * identities are produced solely by the authenticated action that
 * performs them (see `domain/permits/signatures.ts`), and the JSA's
 * "completed by" identity is likewise server-derived - a client that
 * tries to supply one is rejected by `.strict()`, not trusted.
 * Descriptive form content that names a person who is NOT a signer (a
 * fire watch attendant, a confined-space attendant, a gas tester, a JSA
 * participant) stays plain form text and is rendered as such - never as
 * an authoritative digital signature.
 */

/**
 * Hard ceiling on one stored form payload - bounds JSONB growth and
 * request cost long before any per-field limit could be abused in
 * aggregate. Deliberately BELOW the app's 100kb HTTP JSON body limit
 * (see app.ts), so this stays a meaningful second layer rather than a
 * number the transport layer would always reach first, and so it also
 * applies to any non-HTTP caller of `parsePermitForm`/`parseJsaForm`.
 */
export const MAX_FORM_PAYLOAD_BYTES = 64 * 1024;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * An ISO-8601 instant, normalized to canonical UTC on the way in. The
 * normalization matters beyond tidiness: the stored payload is hashed
 * into the immutable issued snapshot and re-verified after a JSONB round
 * trip, so a value's stored text form must be stable and canonical.
 */
const isoDateTime = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((value) => ISO_DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value)), {
    message: 'must be an ISO-8601 date-time',
  })
  .transform((value) => new Date(value).toISOString());

/**
 * One checklist line as it appears on the paper form: the question text
 * as printed, the tick that was made against it, and the optional
 * remarks column. `NA` is a real third state on these forms and is not
 * the same answer as `NO`.
 */
export const checklistResponseSchema = z.enum(['YES', 'NO', 'NA']);

export const checklistItemSchema = z
  .object({
    label: text(300),
    response: checklistResponseSchema,
    remarks: optionalText(500),
  })
  .strict();

/**
 * Two rows in the same printed section may not carry the same text. A
 * duplicate is always a data-entry fault - either the same question was
 * answered twice (possibly with conflicting answers, which the issued
 * document could then not reproduce unambiguously) or a row was pasted
 * in place of the item it was meant to replace. Compared trimmed and
 * case-insensitively, since the printed text is what identifies the item
 * until the authoritative catalogue is pinned.
 */
function rejectDuplicateLabels(rows: readonly { label: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const key = row.label.trim().toLocaleLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate entry "${row.label}" in this section`,
        path: [index, 'label'],
      });
      return;
    }
    seen.add(key);
  });
}

/**
 * A checklist section that is PRINTED ON THE FORM must carry its
 * content: a section may never be submitted empty, because an empty
 * section is indistinguishable from a section nobody filled in, and the
 * issued immutable document would then record a permit whose safety
 * checklist says nothing at all. `NA` exists precisely so an item that
 * does not apply is recorded as answered rather than omitted.
 *
 * This bounds WHETHER the printed items are answered. It cannot yet
 * bound WHICH items they are - the authoritative per-template item
 * catalogue is not supplied anywhere in this repository, and inventing
 * safety questions is forbidden. Uniqueness plus non-blank text is the
 * strongest guarantee available until that catalogue is pinned (see
 * DECISIONS.md open decision #4).
 */
const checklistGroup = z.array(checklistItemSchema).min(1).max(80).superRefine(rejectDuplicateLabels);

/**
 * One tick-box option in a "select all that apply" band (Nature of Work,
 * Type of Hazard, PPE). Used wherever the real form's exact option list
 * was not supplied - the printed option text travels with the tick
 * instead of being guessed here.
 */
export const selectionOptionSchema = z
  .object({
    label: text(200),
    selected: z.boolean(),
    remarks: optionalText(500),
  })
  .strict();

/** Same rule, and for the same reason, as `checklistGroup` above: a tick-box band printed on the form is never submitted empty, and never carries the same option twice. */
const selectionGroup = z.array(selectionOptionSchema).min(1).max(60).superRefine(rejectDuplicateLabels);

// ---------------------------------------------------------------------
// WTG_WORK_V1
// ---------------------------------------------------------------------
//
// `permitStartAt`/`permitExpiryAt` are the form's own declared work
// window. They are FORM CONTENT ONLY and never override the system's
// authoritative validity rule (valid until the next midnight in the site
// timezone, computed from `issued_at` - domain/permits/validity.ts),
// which is unchanged by this batch.
export const wtgWorkFormSchema = z
  .object({
    windFarm: text(200),
    wtgNumber: text(100),
    descriptionOfWork: text(4000),
    permitStartAt: isoDateTime,
    permitExpiryAt: isoDateTime,
    generalWork: checklistGroup,
    electricalWork: checklistGroup,
    mechanicalWork: checklistGroup,
    hydraulicWork: checklistGroup,
    workAtHeights: checklistGroup,
    specificSafetyRequirements: checklistGroup,
    isolationPoints: z
      .array(z.object({ description: text(300), remarks: optionalText(500) }).strict())
      .max(60),
    ppe: selectionGroup,
    specialPrecautions: optionalText(2000),
    specialInstructions: optionalText(2000),
  })
  .strict()
  .superRefine((form, ctx) => {
    if (Date.parse(form.permitExpiryAt) < Date.parse(form.permitStartAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'permitExpiryAt must not be before permitStartAt',
        path: ['permitExpiryAt'],
      });
    }
  });

// ---------------------------------------------------------------------
// COLD_WORK_V1
// ---------------------------------------------------------------------
//
// Nature of Work and Hazards are the two option lists the real Cold Work
// form supplied verbatim, so they are modelled as exact, named booleans
// rather than free-labelled rows - an unknown nature/hazard key is
// rejected.
//
// The JSA relationship is deliberately NOT a payload field: the linked
// JSA (and therefore its JSA Number) is the permit's own `jsa_id`
// foreign key, authoritative and server-held. A client can neither
// choose nor retype it.
export const coldWorkFormSchema = z
  .object({
    natureOfWork: z
      .object({
        mechanical: z.boolean(),
        electricalAndInstrumentation: z.boolean(),
        civil: z.boolean(),
        chemical: z.boolean(),
        inspection: z.boolean(),
      })
      .strict(),
    hazards: z
      .object({
        energized: z.boolean(),
        fall: z.boolean(),
        respiratory: z.boolean(),
        chemical: z.boolean(),
      })
      .strict(),
    generalRequirements: checklistGroup,
    equipmentCondition: checklistGroup,
    ppe: selectionGroup,
    specialPrecautions: optionalText(2000),
    specialInstructions: optionalText(2000),
    confinedSpacePermitRef: optionalText(100),
    lotoNumber: optionalText(100),
  })
  .strict();

// ---------------------------------------------------------------------
// HOT_WORK_V1
// ---------------------------------------------------------------------
//
// Implemented independently of Cold Work: the real Hot Work form has its
// own Nature of Work and Type of Hazard bands, whose option lists were
// not supplied, so they are labelled selection rows here rather than
// Cold Work's options reused under a different name.
export const hotWorkFormSchema = z
  .object({
    natureOfWork: selectionGroup,
    typeOfHazard: selectionGroup,
    generalRequirements: checklistGroup,
    equipmentCondition: checklistGroup,
    ppe: selectionGroup,
    fireWatch: z
      .object({
        required: z.boolean(),
        // Descriptive form content naming the person keeping fire watch -
        // never a digital signature identity.
        attendant: optionalText(200),
        remarks: optionalText(1000),
      })
      .strict(),
    relatedPermitRef: optionalText(100),
    lotoNumber: optionalText(100),
    specialPrecautions: optionalText(2000),
    specialInstructions: optionalText(2000),
    evacuationDetails: optionalText(2000),
    remarks: optionalText(2000),
  })
  .strict();

// ---------------------------------------------------------------------
// CONFINED_SPACE_ENTRY_V1
// ---------------------------------------------------------------------

/** One repeatable gas-test row: the reading that was taken, when, its verdict, and (where the form records it) who took it. */
export const gasTestReadingSchema = z
  .object({
    time: isoDateTime,
    // Normalized to one decimal place so the stored value's text form is
    // stable across the JSONB round trip the snapshot hash is verified
    // against.
    oxygenPercent: z
      .number()
      .min(0)
      .max(100)
      .transform((value) => Number(value.toFixed(1))),
    result: z.enum(['PASS', 'FAIL']),
    testedBy: optionalText(200),
    remarks: optionalText(500),
  })
  .strict();

export const confinedSpaceEntryFormSchema = z
  .object({
    natureOfWork: selectionGroup,
    typeOfHazard: selectionGroup,
    gasTest: z
      .object({
        instrument: optionalText(200),
        instrumentCalibration: optionalText(200),
        retestRequired: z.boolean(),
        retestDetails: optionalText(500),
        continuousMonitoring: z.boolean(),
        /**
         * The gas-test section is a printed section of the Confined
         * Space Entry form, so - exactly like every other printed
         * section - it must carry its content: an entry permit whose
         * gas-test band records no reading at all is an incomplete form,
         * and the issued immutable document would reproduce it as such.
         *
         * The band stays repeatable (retests and continuous-monitoring
         * spot records are additional rows), and no rule is invented
         * here about WHEN a retest must have happened - only that a row
         * may not be recorded twice identically, which is always a
         * data-entry fault rather than a second reading.
         */
        readings: z
          .array(gasTestReadingSchema)
          .min(1)
          .max(60)
          .superRefine((rows, ctx) => {
            const seen = new Set<string>();
            rows.forEach((row, index) => {
              const key = `${row.time}|${row.oxygenPercent}|${row.result}|${row.testedBy ?? ''}`;
              if (seen.has(key)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: 'duplicate gas-test reading',
                  path: [index, 'time'],
                });
                return;
              }
              seen.add(key);
            });
          }),
      })
      .strict(),
    generalRequirements: checklistGroup,
    ppe: selectionGroup,
    attendant: optionalText(200),
    relatedColdWorkPermitRef: optionalText(100),
    relatedHotWorkPermitRef: optionalText(100),
    lotoNumber: optionalText(100),
    specialPrecautions: optionalText(2000),
    specialInstructions: optionalText(2000),
    evacuationDetails: optionalText(2000),
    remarks: optionalText(2000),
  })
  .strict();

// ---------------------------------------------------------------------
// JSA_V1 (shared by all four permit templates)
// ---------------------------------------------------------------------
//
// Page 1 has no `completedBy` field on purpose: the JSA's completed-by
// identity is the authenticated applicant who submitted, frozen into the
// issued snapshot from `permit_signatures`. A client supplying one is
// rejected by `.strict()`.
export const jsaFormSchema = z
  .object({
    page1: z
      .object({
        siteOrWtg: text(200),
        jobOrWork: text(2000),
        requiredPermits: z
          .object({
            wtgWork: z.boolean(),
            coldWork: z.boolean(),
            hotWork: z.boolean(),
            confinedSpaceEntry: z.boolean(),
          })
          .strict(),
        /**
         * The supplied HSE checklist bands. At least one band must be
         * present, each band must carry at least one answered item (via
         * `checklistGroup`), and no two bands may share a title - a JSA
         * whose HSE checklist is empty documents no safety review at
         * all.
         */
        hseChecklistGroups: z
          .array(z.object({ title: text(200), items: checklistGroup }).strict())
          .min(1)
          .max(30)
          .superRefine((groups, ctx) => {
            const seen = new Set<string>();
            groups.forEach((group, index) => {
              const key = group.title.trim().toLocaleLowerCase();
              if (seen.has(key)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `duplicate HSE checklist group "${group.title}"`,
                  path: [index, 'title'],
                });
                return;
              }
              seen.add(key);
            });
          }),
      })
      .strict(),
    page2: z
      .object({
        emergencyResponse: optionalText(4000),
        taskAnalysis: z
          .array(
            z
              .object({
                sequenceOfTasks: text(1000),
                possibleHazardousEvents: text(1000),
                energyOrTriggeringSources: text(1000),
                protectiveActionsOrMeasures: text(1000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        ppe: selectionGroup,
        toolsAndMaterials: z
          .array(z.object({ description: text(300), remarks: optionalText(500) }).strict())
          .max(80),
        // Crew on the job as written on the form - not signers.
        participants: z
          .array(z.object({ name: text(200), company: optionalText(200) }).strict())
          .max(60),
        // The paper acknowledgement column. Rendered in its own clearly
        // labelled section, never in the authoritative digital signature
        // block, which uses snapshot signature data only.
        participantAcknowledgements: z
          .array(
            z.object({ name: text(200), acknowledged: z.boolean(), remarks: optionalText(500) }).strict(),
          )
          .max(60),
        comments: optionalText(4000),
        closeOut: z
          .object({ completedAt: isoDateTime.optional(), remarks: optionalText(2000) })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const PERMIT_TYPES = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] as const;
export type PermitType = (typeof PERMIT_TYPES)[number];
export const permitTypeSchema = z.enum(PERMIT_TYPES);

export const PERMIT_FORM_VERSIONS = {
  WTG_WORK: 'WTG_WORK_V1',
  COLD_WORK: 'COLD_WORK_V1',
  HOT_WORK: 'HOT_WORK_V1',
  CONFINED_SPACE_ENTRY: 'CONFINED_SPACE_ENTRY_V1',
} as const;
export type PermitFormVersion = (typeof PERMIT_FORM_VERSIONS)[PermitType];

export const JSA_FORM_VERSION = 'JSA_V1';
export type JsaFormVersion = typeof JSA_FORM_VERSION;

export type WtgWorkForm = z.infer<typeof wtgWorkFormSchema>;
export type ColdWorkForm = z.infer<typeof coldWorkFormSchema>;
export type HotWorkForm = z.infer<typeof hotWorkFormSchema>;
export type ConfinedSpaceEntryForm = z.infer<typeof confinedSpaceEntryFormSchema>;
export type PermitForm = WtgWorkForm | ColdWorkForm | HotWorkForm | ConfinedSpaceEntryForm;
export type JsaForm = z.infer<typeof jsaFormSchema>;

/**
 * The single mapping from a permit's authoritative `permit_type` to the
 * schema allowed to validate its payload. Cross-template submission is
 * impossible by construction: the type is read from the stored permit
 * row (never from the request body), and the payload is parsed by that
 * type's schema alone - a Hot Work payload sent to a Cold Work permit
 * fails on the very fields it does not share.
 */
const PERMIT_FORM_SCHEMAS = {
  WTG_WORK: wtgWorkFormSchema,
  COLD_WORK: coldWorkFormSchema,
  HOT_WORK: hotWorkFormSchema,
  CONFINED_SPACE_ENTRY: confinedSpaceEntryFormSchema,
} as const;

export type FormParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'too_large' }
  | { ok: false; reason: 'invalid'; issues: z.ZodIssue[] };

function withinSizeLimit(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return false;
  }
  return Buffer.byteLength(serialized, 'utf8') <= MAX_FORM_PAYLOAD_BYTES;
}

/** Validates a permit form payload against the schema for `permitType` - the permit's stored type, never a client-declared one. */
export function parsePermitForm(permitType: PermitType, value: unknown): FormParseResult<PermitForm> {
  if (!withinSizeLimit(value)) return { ok: false, reason: 'too_large' };
  const parsed = PERMIT_FORM_SCHEMAS[permitType].safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'invalid', issues: parsed.error.issues };
  return { ok: true, data: parsed.data };
}

export function parseJsaForm(value: unknown): FormParseResult<JsaForm> {
  if (!withinSizeLimit(value)) return { ok: false, reason: 'too_large' };
  const parsed = jsaFormSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'invalid', issues: parsed.error.issues };
  return { ok: true, data: parsed.data };
}

export interface PermitFormProjection {
  windFarm: string | null;
  wtgNumber: string | null;
  workDescription: string | null;
  lotoNumber: string | null;
}

/**
 * The server-derived relational projection of a validated permit
 * payload. These columns exist so workflow/search queries never have to
 * open the JSONB; they are written in the same statement as the payload
 * they were derived from, so the two can never drift, and they are never
 * accepted from a client independently of the payload.
 */
export function derivePermitFormProjection(permitType: PermitType, form: PermitForm): PermitFormProjection {
  if (permitType === 'WTG_WORK') {
    const wtg = form as WtgWorkForm;
    return {
      windFarm: wtg.windFarm,
      wtgNumber: wtg.wtgNumber,
      workDescription: wtg.descriptionOfWork,
      lotoNumber: null,
    };
  }
  const other = form as ColdWorkForm | HotWorkForm | ConfinedSpaceEntryForm;
  return {
    windFarm: null,
    wtgNumber: null,
    workDescription: null,
    lotoNumber: other.lotoNumber ?? null,
  };
}

export interface JsaFormProjection {
  siteOrWtg: string;
  jobDescription: string;
}

export function deriveJsaFormProjection(form: JsaForm): JsaFormProjection {
  return { siteOrWtg: form.page1.siteOrWtg, jobDescription: form.page1.jobOrWork };
}
