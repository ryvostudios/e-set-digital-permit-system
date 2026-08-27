import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLD_WORK_CHECKLIST_SECTIONS,
  COLD_WORK_NATURE_OF_WORK,
  COLD_WORK_TYPE_OF_HAZARD,
  JSA_EMERGENCY_CONTACTS,
  JSA_EMERGENCY_QUESTIONS,
  JSA_APPROVAL_SIGNATORIES,
  JSA_HSE_CHECKLIST_CATEGORIES,
  JSA_PPE_REQUIRED,
  JSA_REQUIRED_PERMITS,
  WTG_ISOLATION_POINTS,
  WTG_PPE_REQUIRED,
  WTG_WORK_CHECKLIST_SECTIONS,
  type ChecklistSection,
  type SelectionSection,
} from './catalogue.js';
import {
  findUnansweredForSubmission,
  findUnansweredJsaAnswers,
  findUnansweredPermitAnswers,
} from './formCompleteness.js';
import { parseJsaFormV2, parsePermitFormV2 } from './formsV2.js';

/**
 * UNANSWERED IS NOT 'NA'.
 *
 * 'NA' is a judgement a person makes: "I considered this and it does not
 * apply". A blank draft that pre-supplies it would put a safety
 * judgement nobody made onto an issued permit. These tests pin that the
 * two states are distinct, that a draft may carry the unanswered one, and
 * that a submission may not.
 */

const unanswered = (section: ChecklistSection) =>
  Object.fromEntries(section.items.map((item) => [item.id, { response: null }]));

const answered = (section: ChecklistSection, response: string) =>
  Object.fromEntries(section.items.map((item) => [item.id, { response }]));

const ticks = (section: SelectionSection) =>
  Object.fromEntries(section.options.map((option) => [option.id, false]));

function blankWtg(): Record<string, unknown> {
  return {
    permitIssue: {
      windFarmName: 'Zephyr',
      wtgNumber: 'WTG-1',
      descriptionOfWork: 'Work',
      permitStartAt: '2026-01-01T08:00:00.000Z',
      permitExpiryAt: '2026-01-01T16:00:00.000Z',
    },
    sections: Object.fromEntries(WTG_WORK_CHECKLIST_SECTIONS.map((s) => [s.id, unanswered(s)])),
    isolationPoints: unanswered(WTG_ISOLATION_POINTS),
    ppe: ticks(WTG_PPE_REQUIRED),
  };
}

function answeredWtg(response = 'NA'): Record<string, unknown> {
  return {
    ...blankWtg(),
    sections: Object.fromEntries(WTG_WORK_CHECKLIST_SECTIONS.map((s) => [s.id, answered(s, response)])),
    // The isolation band prints Yes/No only.
    isolationPoints: answered(WTG_ISOLATION_POINTS, 'NO'),
  };
}

function blankJsa(): Record<string, unknown> {
  return {
    page1: {
      siteOrWtg: 'WTG-1',
      jobOrWork: 'Work',
      anyPermitsRequired: null,
      requiredPermits: ticks(JSA_REQUIRED_PERMITS),
      hseChecklist: Object.fromEntries(JSA_HSE_CHECKLIST_CATEGORIES.map((c) => [c.id, ticks(c)])),
    },
    page2: {
      emergencyContacts: Object.fromEntries(JSA_EMERGENCY_CONTACTS.map((c) => [c.id, '0300-0000000'])),
      emergencyQuestions: Object.fromEntries(JSA_EMERGENCY_QUESTIONS.map((q) => [q.id, null])),
      taskAnalysis: [
        {
          sequenceOfTasks: 'Isolate',
          possibleHazardousEvents: 'Stored energy',
          energySources: ['E'],
          triggeringEventsToStopWork: 'Movement',
          protectiveActionsOrMeasures: 'LOTO',
        },
      ],
      ppe: ticks(JSA_PPE_REQUIRED),
      participants: [],
      approvals: Object.fromEntries(
        JSA_APPROVAL_SIGNATORIES.map((signatory) => [signatory.id, { closedOut: false }]),
      ),
    },
  };
}

// ---------------------------------------------------------------------
// A DRAFT may be incomplete
// ---------------------------------------------------------------------

test('a wholly unanswered permit is a VALID draft payload', () => {
  // The applicant fills a long safety document over time. Requiring an
  // answer in order to save would push them into ticking something just
  // to get past it.
  assert.equal(parsePermitFormV2('WTG_WORK', blankWtg()).ok, true);
});

test('a wholly unanswered JSA is a VALID draft payload', () => {
  assert.equal(parseJsaFormV2(blankJsa()).ok, true);
});

test('null is a real stored state - the key still exists, so the question cannot vanish', () => {
  const form = blankWtg() as { sections: Record<string, Record<string, unknown>> };
  // Present, and explicitly unanswered.
  assert.deepEqual(form.sections.general_work!.a, { response: null });
  // Removing the question entirely is still rejected.
  delete form.sections.general_work!.a;
  assert.equal(parsePermitFormV2('WTG_WORK', form).ok, false);
});

// ---------------------------------------------------------------------
// A SUBMISSION may not
// ---------------------------------------------------------------------

test('every unanswered permit question is reported, in printed order, with its path', () => {
  const missing = findUnansweredPermitAnswers('WTG_WORK', blankWtg());
  const expected =
    WTG_WORK_CHECKLIST_SECTIONS.reduce((n, s) => n + s.items.length, 0) + WTG_ISOLATION_POINTS.items.length;
  assert.equal(missing.length, expected, 'all 32 printed WTG questions');

  const first = missing[0]!;
  assert.equal(first.sectionId, 'general_work');
  assert.equal(first.itemId, 'a');
  assert.equal(first.itemLabel, WTG_WORK_CHECKLIST_SECTIONS[0]!.items[0]!.label);
  assert.deepEqual(first.path, ['sections', 'general_work', 'a', 'response']);

  // The isolation band is reported too, and last - it prints last.
  assert.equal(missing[missing.length - 1]!.sectionId, 'isolation_points');
});

test('a fully answered permit reports nothing', () => {
  assert.deepEqual(findUnansweredPermitAnswers('WTG_WORK', answeredWtg()), []);
});

test("'NA' counts as answered - it is a judgement, not an absence", () => {
  assert.deepEqual(findUnansweredPermitAnswers('WTG_WORK', answeredWtg('NA')), []);
});

test('one unanswered question among many is still caught', () => {
  const form = answeredWtg() as { sections: Record<string, Record<string, unknown>> };
  form.sections.electrical_work!.b = { response: null };
  const missing = findUnansweredPermitAnswers('WTG_WORK', form);
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.sectionId, 'electrical_work');
  assert.equal(missing[0]!.itemId, 'b');
});

test('a missing key is treated exactly like an explicit null', () => {
  const form = answeredWtg() as { sections: Record<string, Record<string, unknown>> };
  delete form.sections.general_work!.c;
  const missing = findUnansweredPermitAnswers('WTG_WORK', form);
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.itemId, 'c');
});

test('the JSA reports its printed Yes/No questions - and NOT its tick bands', () => {
  const missing = findUnansweredJsaAnswers(blankJsa());
  // "Are any working permits required" plus the two emergency questions.
  assert.equal(missing.length, 1 + JSA_EMERGENCY_QUESTIONS.length);
  assert.deepEqual(missing[0]!.path, ['page1', 'anyPermitsRequired']);

  // An UNTICKED HSE box is a meaningful answer on the printed form
  // ("this hazard is not present"), so it is never reported as missing.
  assert.ok(!missing.some((entry) => entry.sectionId.startsWith('ergonomic')));
  assert.ok(!missing.some((entry) => entry.path.includes('hseChecklist')));
});

test('an answered JSA reports nothing', () => {
  const form = blankJsa() as { page1: Record<string, unknown>; page2: Record<string, unknown> };
  form.page1.anyPermitsRequired = 'YES';
  form.page2.emergencyQuestions = Object.fromEntries(JSA_EMERGENCY_QUESTIONS.map((q) => [q.id, 'NO']));
  assert.deepEqual(findUnansweredJsaAnswers(form), []);
});

test('the combined result orders the permit before the JSA', () => {
  const result = findUnansweredForSubmission('WTG_WORK', blankWtg(), blankJsa());
  assert.ok(result.permit.length > 0);
  assert.ok(result.jsa.length > 0);
  assert.equal(result.total, result.permit.length + result.jsa.length);
});

// ---------------------------------------------------------------------
// The distinction survives the contract
// ---------------------------------------------------------------------

test('a Yes/No-only band still refuses NA, answered or not', () => {
  const form = answeredWtg() as { isolationPoints: Record<string, unknown> };
  form.isolationPoints.a = { response: 'NA' };
  assert.equal(parsePermitFormV2('WTG_WORK', form).ok, false, 'the printed band has no N/A column');
});

test('nothing anywhere substitutes NA for an unanswered question', () => {
  const cold = {
    workWindow: { equipment: 'x' },
    natureOfWork: ticks(COLD_WORK_NATURE_OF_WORK),
    typeOfHazard: ticks(COLD_WORK_TYPE_OF_HAZARD),
    sections: Object.fromEntries(COLD_WORK_CHECKLIST_SECTIONS.map((s) => [s.id, unanswered(s)])),
    evacuation: {},
  };
  const parsed = parsePermitFormV2('COLD_WORK', cold);
  assert.equal(parsed.ok, true, 'a blank Cold Work draft is storable');

  const missing = findUnansweredPermitAnswers('COLD_WORK', cold);
  assert.equal(
    missing.length,
    COLD_WORK_CHECKLIST_SECTIONS.reduce((n, s) => n + s.items.length, 0),
    'every one of them is still owed an answer',
  );
});
