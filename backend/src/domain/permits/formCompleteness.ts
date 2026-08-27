import {
  CONFINED_SPACE_CHECKLIST_SECTIONS,
  COLD_WORK_CHECKLIST_SECTIONS,
  HOT_WORK_CHECKLIST_SECTIONS,
  JSA_EMERGENCY_QUESTIONS,
  WTG_ISOLATION_POINTS,
  WTG_WORK_CHECKLIST_SECTIONS,
  type ChecklistSection,
} from './catalogue.js';
import type { PermitType } from './forms.js';

/**
 * WHAT A PERMIT MUST CARRY BEFORE IT MAY BE SUBMITTED.
 *
 * NOT COMPLETENESS. The authoritative forms are printed to cover every
 * job the company does, so a great many of their questions do not apply
 * to any particular one. Requiring an answer to all of them before
 * submission did not produce safer permits - it produced pressure to tick
 * something, anything, to get past the gate, which is the opposite of
 * what a safety document is for. Blank means "not applicable here" or
 * "the CRO should look at this", and the CRO reviews what was actually
 * supplied and can send the permit back for correction.
 *
 * SO THE BAR IS DELIBERATELY LOW, AND EXISTS ONLY TO CATCH AN ACCIDENT:
 * a permit must carry at least one thing a person actually entered. That
 * stops an empty document being submitted by a mis-click; it does not ask
 * which fields were filled, or how many.
 *
 * `null` IS STILL NOT `'NA'`. `'NA'` means "considered, does not apply"
 * and counts as content because a person made that judgement; null means
 * nobody has looked. Nothing here ever substitutes one for the other, and
 * nothing fills a blank in on the applicant's behalf - a field left empty
 * is stored, submitted and printed empty.
 *
 * WHAT COUNTS AS CONTENT is anything in the stored payload that a person
 * had to do something to produce: text they typed, a box they ticked, a
 * Yes/No/N-A they chose. A blank draft is empty strings, false ticks and
 * null responses throughout, so it contributes nothing. The payload holds
 * only applicant-entered content - permit number, permit type, applicant
 * identity and every timestamp are columns, never payload - so scanning
 * it cannot mistake system-generated data for a person's work.
 *
 * The `findUnanswered*` functions below still report which printed
 * questions are blank. They no longer BLOCK anything; they exist so a
 * screen can offer guidance, and so the distinction between null and
 * 'NA' stays tested.
 */
export interface UnansweredAnswer {
  /** Catalogue section id, e.g. `general_work`. */
  sectionId: string;
  /** The printed section heading, for a message a person can act on. */
  sectionTitle: string;
  /** Catalogue item id, e.g. `g`. */
  itemId: string;
  /** The printed question, verbatim. */
  itemLabel: string;
  /** Path into the payload, so the editor can focus the exact control. */
  path: string[];
}

const PERMIT_SECTIONS: Record<PermitType, readonly ChecklistSection[]> = {
  WTG_WORK: WTG_WORK_CHECKLIST_SECTIONS,
  COLD_WORK: COLD_WORK_CHECKLIST_SECTIONS,
  HOT_WORK: HOT_WORK_CHECKLIST_SECTIONS,
  CONFINED_SPACE_ENTRY: CONFINED_SPACE_CHECKLIST_SECTIONS,
};

function readAnswer(container: unknown, itemId: string): unknown {
  if (!container || typeof container !== 'object') return undefined;
  const entry = (container as Record<string, unknown>)[itemId];
  if (!entry || typeof entry !== 'object') return undefined;
  return (entry as Record<string, unknown>).response;
}

function collectBand(
  band: unknown,
  section: ChecklistSection,
  pathPrefix: string[],
  into: UnansweredAnswer[],
): void {
  for (const item of section.items) {
    const response = readAnswer(band, item.id);
    // Missing and explicitly-null are the same thing: nobody answered.
    if (response === null || response === undefined) {
      into.push({
        sectionId: section.id,
        sectionTitle: section.title,
        itemId: item.id,
        itemLabel: item.label,
        path: [...pathPrefix, item.id, 'response'],
      });
    }
  }
}

/**
 * Every printed permit question still unanswered, in printed order - so
 * the editor can take the caller to the FIRST one rather than making
 * them hunt through a long document.
 */
export function findUnansweredPermitAnswers(permitType: PermitType, form: unknown): UnansweredAnswer[] {
  const unanswered: UnansweredAnswer[] = [];
  const payload = (form ?? {}) as Record<string, unknown>;
  const sections = (payload.sections ?? {}) as Record<string, unknown>;

  for (const section of PERMIT_SECTIONS[permitType]) {
    collectBand(sections[section.id], section, ['sections', section.id], unanswered);
  }

  // WTG's isolation band sits outside `sections` and prints Yes/No only.
  if (permitType === 'WTG_WORK') {
    collectBand(payload.isolationPoints, WTG_ISOLATION_POINTS, ['isolationPoints'], unanswered);
  }

  return unanswered;
}

/** The JSA's printed Yes/No questions - its tick bands are deliberately not included. */
export function findUnansweredJsaAnswers(form: unknown): UnansweredAnswer[] {
  const unanswered: UnansweredAnswer[] = [];
  const payload = (form ?? {}) as { page1?: Record<string, unknown>; page2?: Record<string, unknown> };

  if (payload.page1?.anyPermitsRequired === null || payload.page1?.anyPermitsRequired === undefined) {
    unanswered.push({
      sectionId: 'required_permits',
      sectionTitle: 'Are any working permits required for this job?',
      itemId: 'anyPermitsRequired',
      itemLabel: 'Are any working permits required for this job?',
      path: ['page1', 'anyPermitsRequired'],
    });
  }

  const questions = (payload.page2?.emergencyQuestions ?? {}) as Record<string, unknown>;
  for (const question of JSA_EMERGENCY_QUESTIONS) {
    const value = questions[question.id];
    if (value === null || value === undefined) {
      unanswered.push({
        sectionId: 'emergency_response',
        sectionTitle: 'Emergency Response',
        itemId: question.id,
        itemLabel: question.label,
        path: ['page2', 'emergencyQuestions', question.id],
      });
    }
  }

  return unanswered;
}

/** Both documents together, permit first - the order the editor presents them in. */
export function findUnansweredForSubmission(
  permitType: PermitType,
  permitForm: unknown,
  jsaForm: unknown,
): { permit: UnansweredAnswer[]; jsa: UnansweredAnswer[]; total: number } {
  const permit = findUnansweredPermitAnswers(permitType, permitForm);
  const jsa = findUnansweredJsaAnswers(jsaForm);
  return { permit, jsa, total: permit.length + jsa.length };
}


/**
 * Anything a person had to do something to produce.
 *
 * `false` is not content: an unticked box is the state every blank draft
 * starts in, so counting it would make every empty permit submittable.
 * An empty or whitespace-only string is not content either. A response of
 * 'NA' IS content, because choosing it is a judgement.
 */
function hasApplicantContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.some(hasApplicantContent);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasApplicantContent);
  return false;
}

/**
 * Whether this submission carries anything at all.
 *
 * Permit AND JSA are considered together: they are one document to the
 * person filling them, and a permit whose JSA describes the job is
 * plainly not an accidental blank. The only submission refused here is
 * one where neither document contains a single entered value.
 */
export function hasMeaningfulSubmissionContent(permitForm: unknown, jsaForm: unknown): boolean {
  return hasApplicantContent(permitForm) || hasApplicantContent(jsaForm);
}
