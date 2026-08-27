import { z } from 'zod';
import {
  COLD_WORK_CHECKLIST_SECTIONS,
  COLD_WORK_NATURE_OF_WORK,
  COLD_WORK_TYPE_OF_HAZARD,
  CONFINED_SPACE_CHECKLIST_SECTIONS,
  CONFINED_SPACE_COMBUSTION_SUB_TICKS,
  CONFINED_SPACE_GAS_TEST_TABLE,
  CONFINED_SPACE_NATURE_OF_WORK,
  CONFINED_SPACE_TYPE_OF_HAZARD,
  HOT_WORK_CHECKLIST_SECTIONS,
  HOT_WORK_COMBUSTION_SUB_TICKS,
  HOT_WORK_NATURE_OF_WORK,
  HOT_WORK_TYPE_OF_HAZARD,
  JSA_APPROVAL_SIGNATORIES,
  JSA_EMERGENCY_CONTACTS,
  JSA_EMERGENCY_QUESTIONS,
  JSA_ENERGY_SOURCE_LEGEND,
  JSA_HSE_CHECKLIST_CATEGORIES,
  JSA_PPE_REQUIRED,
  JSA_REQUIRED_PERMITS,
  WTG_ISOLATION_POINTS,
  WTG_PPE_REQUIRED,
  WTG_WORK_CHECKLIST_SECTIONS,
  type ChecklistSection,
  type SelectionSection,
} from './catalogue.js';
import { MAX_FORM_PAYLOAD_BYTES, type FormParseResult, type PermitType } from './forms.js';

/**
 * THE AUTHORITATIVE FIXED FORM CONTRACT (V2).
 *
 * Every schema in this file is BUILT FROM `catalogue.ts` rather than
 * written out beside it. That is the whole point: the set of questions,
 * their keys, and which tick columns each band offers are derived from
 * the transcribed forms, so the contract cannot drift from the printed
 * wording. Adding a question to the catalogue changes what the API
 * accepts; nothing here has to be remembered and updated separately.
 *
 * WHAT CHANGED FROM V1, AND WHY IT MATTERS. V1 stored each safety answer
 * as a client-supplied `{ label, response }` row, so the browser decided
 * what question it was answering. A client could rename, reorder, drop or
 * invent a safety question and the server would store it. V2 stores
 * answers keyed by stable server-defined catalogue ids:
 *
 *     { general_work: { a: { response: 'YES' }, b: { ... }, ... } }
 *
 * The wording never travels in the payload at all. Every object is
 * `.strict()` and every catalogue key is required, so an unknown key is
 * rejected and a missing answer is rejected - a permit can no longer be
 * stored with a safety section the applicant simply skipped.
 *
 * IDENTITY RULE, UNCHANGED FROM V1. No payload here carries a signer
 * identity. The applicant ("MR ___ OF ___ COMPANY" on the printed 008
 * forms), the JSA's "completed by", and the CRO/HSE authorities are
 * server-derived from the authenticated action and the permit's own
 * relational identity columns - never from the browser. The permit and
 * JSA numbers are likewise the server's `permit_sequence`/`jsa_id`, so
 * they are absent here too. Descriptive form content that names a
 * non-signer (a fire-watch attendant, a confined-space attendant, a JSA
 * participant) stays plain text and is rendered as such, exactly as V1
 * documented.
 *
 * COEXISTENCE. V1 remains live and untouched in `forms.ts`. This module
 * adds a parallel contract for the frontend rewrite (stage B) and the PDF
 * rewrite (stage C); nothing writes a V2 payload yet.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const isoDateTime = z
  .string()
  .trim()
  .regex(ISO_DATE_TIME_PATTERN, { message: 'must be an ISO-8601 date-time' })
  .refine((value) => Number.isFinite(Date.parse(value)), { message: 'must be a real date-time' })
  .transform((value) => new Date(value).toISOString());

// =====================================================================
// Builders - the only place a catalogue section becomes a schema
// =====================================================================

/** The tick columns a band offers, as a Zod enum. A Yes/No band REJECTS 'NA'. */
function responseEnum(section: ChecklistSection) {
  return section.responses === 'YES_NO_NA'
    ? z.enum(['YES', 'NO', 'NA'])
    : z.enum(['YES', 'NO']);
}

/**
 * One checklist band: every printed item is a REQUIRED key, so a section
 * cannot be part-answered, and no other key is accepted. `NA` exists on
 * the bands that print it precisely so "does not apply" is a recorded
 * answer rather than an omission.
 */
function checklistBandSchema(section: ChecklistSection) {
  const response = responseEnum(section);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const item of section.items) {
    shape[item.id] = z.object({ response, remarks: optionalText(500) }).strict();
  }
  return z.object(shape).strict();
}

/** Several checklist bands, keyed by their catalogue section id. */
function checklistSectionsSchema(sections: readonly ChecklistSection[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const section of sections) shape[section.id] = checklistBandSchema(section);
  return z.object(shape).strict();
}

/**
 * One tick-box band. Every printed option is a required boolean; the
 * free-text `other` line exists only on the bands that actually print one.
 */
function selectionBandSchema(section: SelectionSection) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const option of section.options) shape[option.id] = z.boolean();
  if (section.hasOther) shape.other = optionalText(200);
  return z.object(shape).strict();
}

/** A band of plain ticks with no per-item remarks - the JSA HSE checklist. */
function tickBandSchema(section: SelectionSection) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const option of section.options) shape[option.id] = z.boolean();
  if (section.hasOther) shape.other = optionalText(200);
  return z.object(shape).strict();
}

/** The printed work window shared by the 008A/B/C header band. */
const workWindowSchema = z
  .object({
    equipment: optionalText(300),
    area: optionalText(300),
    fromHours: optionalText(20),
    toHours: optionalText(20),
    extendedTo: optionalText(20),
  })
  .strict();

/** The three printed authorization statements on 008A/B/C. */
const evacuationSchema = z
  .object({
    completedRemarks: optionalText(1000),
    acknowledgedAtHours: optionalText(20),
    acknowledgedRemarks: optionalText(1000),
  })
  .strict();

// =====================================================================
// WTG WORK PERMIT V2
// =====================================================================

export const wtgWorkFormV2Schema = z
  .object({
    // Section 1 PERMIT ISSUE. The Permit Number is deliberately absent:
    // it is the server's `permit_sequence`.
    permitIssue: z
      .object({
        windFarmName: text(200),
        wtgNumber: text(100),
        descriptionOfWork: text(4000),
        permitStartAt: isoDateTime,
        permitExpiryAt: isoDateTime,
      })
      .strict(),
    sections: checklistSectionsSchema(WTG_WORK_CHECKLIST_SECTIONS),
    isolationPoints: checklistBandSchema(WTG_ISOLATION_POINTS),
    ppe: selectionBandSchema(WTG_PPE_REQUIRED),
  })
  .strict()
  .superRefine((form, ctx) => {
    if (Date.parse(form.permitIssue.permitExpiryAt) < Date.parse(form.permitIssue.permitStartAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'permitExpiryAt must not be before permitStartAt',
        path: ['permitIssue', 'permitExpiryAt'],
      });
    }
  });

// =====================================================================
// COLD WORK PERMIT V2 (008A)
// =====================================================================

export const coldWorkFormV2Schema = z
  .object({
    workWindow: workWindowSchema,
    natureOfWork: selectionBandSchema(COLD_WORK_NATURE_OF_WORK),
    typeOfHazard: selectionBandSchema(COLD_WORK_TYPE_OF_HAZARD),
    sections: checklistSectionsSchema(COLD_WORK_CHECKLIST_SECTIONS),
    specialPrecautions: optionalText(2000),
    specialInstructions: optionalText(2000),
    // The JSA number is NOT here: it is the permit's own `jsa_id`.
    confinedSpacePermitRef: optionalText(100),
    lotoNumber: optionalText(100),
    evacuation: evacuationSchema,
  })
  .strict();

// =====================================================================
// HOT WORK PERMIT V2 (008C) - its own catalogue, never Cold Work's
// =====================================================================

export const hotWorkFormV2Schema = z
  .object({
    workWindow: workWindowSchema,
    natureOfWork: selectionBandSchema(HOT_WORK_NATURE_OF_WORK),
    typeOfHazard: selectionBandSchema(HOT_WORK_TYPE_OF_HAZARD),
    /** The WELDING/CUTTING/BRAZING/GRINDING/DRILLING ticks printed inside the hazard band. */
    combustionSubTicks: selectionBandSchema({
      id: 'combustion_sub_ticks',
      title: 'COMBUSTION & SPARK PRODUCING HAZARD',
      hasOther: false,
      options: HOT_WORK_COMBUSTION_SUB_TICKS,
    }),
    sections: checklistSectionsSchema(HOT_WORK_CHECKLIST_SECTIONS),
    /** The printed "FIRE WATCH:" line. Descriptive content, never a signer. */
    fireWatch: optionalText(200),
    specialPrecautions: optionalText(2000),
    specialInstructions: optionalText(2000),
    confinedSpacePermitRef: optionalText(100),
    lotoNumber: optionalText(100),
    evacuation: evacuationSchema,
  })
  .strict();

// =====================================================================
// CONFINED SPACE ENTRY PERMIT V2 (008B)
// =====================================================================

/** One row of the printed three-row gas-test record. */
const gasTestRecordRowSchema = z
  .object({
    /** The printed "02 (19.5-23.5%) & TIME" cell. */
    oxygenAndTime: optionalText(120),
    /** Descriptive content naming who took the reading - never a digital signature. */
    testedBy: optionalText(200),
  })
  .strict();

const gasTestRecordSchema = z
  .object(
    Object.fromEntries(
      CONFINED_SPACE_GAS_TEST_TABLE.rows.map((row) => [row, gasTestRecordRowSchema]),
    ) as Record<string, z.ZodTypeAny>,
  )
  .strict();

export const confinedSpaceEntryFormV2Schema = z
  .object({
    workWindow: workWindowSchema,
    natureOfWork: selectionBandSchema(CONFINED_SPACE_NATURE_OF_WORK),
    typeOfHazard: selectionBandSchema(CONFINED_SPACE_TYPE_OF_HAZARD),
    combustionSubTicks: selectionBandSchema({
      id: 'combustion_sub_ticks',
      title: 'COMBUSTION & SPARK PRODUCING HAZARD',
      hasOther: false,
      options: CONFINED_SPACE_COMBUSTION_SUB_TICKS,
    }),
    sections: checklistSectionsSchema(CONFINED_SPACE_CHECKLIST_SECTIONS),
    gasTestRecord: gasTestRecordSchema,
    /** Printed "ATTENDANT:" line. Descriptive content, never a signer. */
    attendant: optionalText(200),
    specialPrecautions: optionalText(2000),
    specialInstructions: optionalText(2000),
    /** The printed "COLD / HOT PERMIT NO:(IF ANY)" line. */
    relatedPermitRef: optionalText(100),
    lotoNumber: optionalText(100),
    evacuation: evacuationSchema,
  })
  .strict();

// =====================================================================
// JSA V2 - TWO PAGES, kept structurally separate
// =====================================================================

/**
 * Page 1's HSE checklist: all sixteen printed categories, each carrying
 * all of its printed items as required ticks. 115 items in total, keyed
 * by catalogue id.
 */
const hseChecklistSchema = z
  .object(
    Object.fromEntries(
      JSA_HSE_CHECKLIST_CATEGORIES.map((category) => [category.id, tickBandSchema(category)]),
    ) as Record<string, z.ZodTypeAny>,
  )
  .strict();

const jsaPage1Schema = z
  .object({
    siteOrWtg: text(200),
    /** The printed "Date/Time" header cell. */
    dateTime: isoDateTime.optional(),
    /** The printed "S. No." header cell. */
    serialNo: optionalText(60),
    jobOrWork: text(2000),
    // "JSA completed by (name and position)" is NOT here: it is the
    // authenticated applicant, frozen server-side into the snapshot.
    /** The printed Yes/No above the permit tick list. */
    anyPermitsRequired: z.enum(['YES', 'NO']),
    requiredPermits: selectionBandSchema(JSA_REQUIRED_PERMITS),
    hseChecklist: hseChecklistSchema,
  })
  .strict();

/**
 * The printed Task Analysis table has FIVE columns. V1 collapsed
 * "Energy Sources" and "Triggering Events to Stop the Work" into one
 * field, which cannot reproduce the form; they are separate here.
 */
const ENERGY_SOURCE_CODES = JSA_ENERGY_SOURCE_LEGEND.map((entry) => entry.code) as [string, ...string[]];

const taskAnalysisRowSchema = z
  .object({
    sequenceOfTasks: text(1000),
    possibleHazardousEvents: text(1000),
    /** Constrained to the printed legend: M/E/C/P/G/H/R/B. */
    energySources: z
      .array(z.enum(ENERGY_SOURCE_CODES))
      .max(ENERGY_SOURCE_CODES.length)
      .superRefine((codes, ctx) => {
        if (new Set(codes).size !== codes.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate energy source code' });
        }
      }),
    triggeringEventsToStopWork: text(1000),
    protectiveActionsOrMeasures: text(1000),
  })
  .strict();

/** Paper acknowledgement content. Never an authoritative digital signature. */
const participantSchema = z
  .object({
    nameAndPosition: text(200),
    company: optionalText(200),
    acknowledged: z.boolean(),
  })
  .strict();

/** The printed approval band. Descriptive content; the digital signatures come from `permit_signatures`. */
const approvalSchema = z
  .object({
    nameAndPosition: optionalText(200),
    contactNumber: optionalText(60),
    closedOut: z.boolean(),
  })
  .strict();

const jsaPage2Schema = z
  .object({
    emergencyContacts: z
      .object(
        Object.fromEntries(
          JSA_EMERGENCY_CONTACTS.map((contact) => [contact.id, optionalText(200)]),
        ) as Record<string, z.ZodTypeAny>,
      )
      .strict(),
    emergencyQuestions: z
      .object(
        Object.fromEntries(
          JSA_EMERGENCY_QUESTIONS.map((question) => [question.id, z.enum(['YES', 'NO'])]),
        ) as Record<string, z.ZodTypeAny>,
      )
      .strict(),
    taskAnalysis: z.array(taskAnalysisRowSchema).min(1).max(100),
    ppe: selectionBandSchema(JSA_PPE_REQUIRED),
    toolsAndMaterials: optionalText(4000),
    participants: z.array(participantSchema).max(60),
    approvals: z
      .object(
        Object.fromEntries(
          JSA_APPROVAL_SIGNATORIES.map((signatory) => [signatory.id, approvalSchema]),
        ) as Record<string, z.ZodTypeAny>,
      )
      .strict(),
    comments: optionalText(4000),
  })
  .strict();

export const jsaFormV2Schema = z.object({ page1: jsaPage1Schema, page2: jsaPage2Schema }).strict();

// =====================================================================
// Versions, types and parsing
// =====================================================================

export const PERMIT_FORM_VERSIONS_V2 = {
  WTG_WORK: 'WTG_WORK_V2',
  COLD_WORK: 'COLD_WORK_V2',
  HOT_WORK: 'HOT_WORK_V2',
  CONFINED_SPACE_ENTRY: 'CONFINED_SPACE_ENTRY_V2',
} as const;
export type PermitFormVersionV2 = (typeof PERMIT_FORM_VERSIONS_V2)[PermitType];

export const JSA_FORM_VERSION_V2 = 'JSA_V2';
export type JsaFormVersionV2 = typeof JSA_FORM_VERSION_V2;

export type WtgWorkFormV2 = z.infer<typeof wtgWorkFormV2Schema>;
export type ColdWorkFormV2 = z.infer<typeof coldWorkFormV2Schema>;
export type HotWorkFormV2 = z.infer<typeof hotWorkFormV2Schema>;
export type ConfinedSpaceEntryFormV2 = z.infer<typeof confinedSpaceEntryFormV2Schema>;
export type PermitFormV2 = WtgWorkFormV2 | ColdWorkFormV2 | HotWorkFormV2 | ConfinedSpaceEntryFormV2;
export type JsaFormV2 = z.infer<typeof jsaFormV2Schema>;

/** Same discipline as V1: the permit's STORED type chooses the schema, never a client-declared one. */
const PERMIT_FORM_V2_SCHEMAS = {
  WTG_WORK: wtgWorkFormV2Schema,
  COLD_WORK: coldWorkFormV2Schema,
  HOT_WORK: hotWorkFormV2Schema,
  CONFINED_SPACE_ENTRY: confinedSpaceEntryFormV2Schema,
} as const;

function withinSizeLimit(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return false;
  }
  return Buffer.byteLength(serialized, 'utf8') <= MAX_FORM_PAYLOAD_BYTES;
}

export function parsePermitFormV2(permitType: PermitType, value: unknown): FormParseResult<PermitFormV2> {
  if (!withinSizeLimit(value)) return { ok: false, reason: 'too_large' };
  const parsed = PERMIT_FORM_V2_SCHEMAS[permitType].safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'invalid', issues: parsed.error.issues };
  return { ok: true, data: parsed.data };
}

export function parseJsaFormV2(value: unknown): FormParseResult<JsaFormV2> {
  if (!withinSizeLimit(value)) return { ok: false, reason: 'too_large' };
  const parsed = jsaFormV2Schema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'invalid', issues: parsed.error.issues };
  return { ok: true, data: parsed.data };
}
