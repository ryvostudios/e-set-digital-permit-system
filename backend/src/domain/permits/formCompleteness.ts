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
 * WHAT STILL HAS TO BE ANSWERED BEFORE A PERMIT MAY BE SUBMITTED.
 *
 * A DRAFT is deliberately allowed to be incomplete: a person fills a long
 * safety document over time, and forcing an answer to save would push them
 * into ticking something just to get past it. Submission is the moment
 * that stops being acceptable - an issued permit records safety
 * judgements, so every printed question must carry one a person actually
 * made.
 *
 * `null` IS NOT `'NA'`. `'NA'` means "considered, does not apply"; null
 * means nobody has looked yet. Treating them as the same is exactly the
 * defect this module exists to prevent, so nothing here ever substitutes
 * one for the other or fills a blank in on the applicant's behalf.
 *
 * JSA HSE checklist items are TICKS, not responses. An unticked box is a
 * meaningful answer on that form ("this hazard is not present"), so they
 * are not required here - converting them into a third state would be
 * inventing a control the printed form does not have.
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
