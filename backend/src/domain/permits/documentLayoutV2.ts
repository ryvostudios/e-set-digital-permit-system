import {
  COLD_WORK_CHECKLIST_SECTIONS,
  COLD_WORK_NATURE_OF_WORK,
  COLD_WORK_TYPE_OF_HAZARD,
  CONFINED_SPACE_CHECKLIST_SECTIONS,
  CONFINED_SPACE_COMBUSTION_SUB_TICKS,
  CONFINED_SPACE_GAS_TEST_TABLE,
  CONFINED_SPACE_NATURE_OF_WORK,
  CONFINED_SPACE_SLOGAN,
  CONFINED_SPACE_TYPE_OF_HAZARD,
  FORM_REFERENCES,
  HOT_WORK_CHECKLIST_SECTIONS,
  HOT_WORK_COMBUSTION_SUB_TICKS,
  HOT_WORK_NATURE_OF_WORK,
  HOT_WORK_TYPE_OF_HAZARD,
  JSA_APPROVAL_NOTE,
  JSA_APPROVAL_SIGNATORIES,
  JSA_CLOSE_OUT_NOTE,
  JSA_EMERGENCY_CONTACTS,
  JSA_EMERGENCY_QUESTIONS,
  JSA_ENERGY_SOURCE_LEGEND,
  JSA_HSE_CHECKLIST_CATEGORIES,
  JSA_HSE_CHECKLIST_INSTRUCTION,
  JSA_PAGE1_REMINDER,
  JSA_PARTICIPANT_SIGNATURE_NOTE,
  JSA_PPE_REQUIRED,
  JSA_REQUIRED_PERMITS,
  JSA_TASK_ANALYSIS_COLUMNS,
  PERMIT_008_AUTHORIZATION_BANDS,
  PERMIT_DISTRIBUTION_FOOTER,
  WTG_ISOLATION_POINTS,
  WTG_AUTHORIZATION_BANDS,
  WTG_PPE_REQUIRED,
  WTG_WORK_CHECKLIST_SECTIONS,
  type ChecklistSection,
  type SelectionSection,
} from './catalogue.js';
import type { IssuedPermitSnapshot } from './documents.js';
import type { DocumentBlock, DocumentPage, DocumentSection } from './documentLayout.js';
import {
  JSA_FORM_VERSION_V2,
  PERMIT_FORM_VERSIONS_V2,
  type ColdWorkFormV2,
  type ConfinedSpaceEntryFormV2,
  type HotWorkFormV2,
  type JsaFormV2,
  type PermitFormV2,
  type PermitFormVersionV2,
  type WtgWorkFormV2,
} from './formsV2.js';

export type IssuedPermitSnapshotV2 = IssuedPermitSnapshot & {
  permitFormVersion: PermitFormVersionV2;
  permitForm: PermitFormV2;
  jsaFormVersion: typeof JSA_FORM_VERSION_V2;
  jsaForm: JsaFormV2;
};

export function isV2Snapshot(snapshot: IssuedPermitSnapshot): snapshot is IssuedPermitSnapshotV2 {
  return snapshot.jsaFormVersion === JSA_FORM_VERSION_V2 &&
    PERMIT_FORM_VERSIONS_V2[snapshot.permitType] === snapshot.permitFormVersion;
}

export function usesAnyV2FormVersion(snapshot: IssuedPermitSnapshot): boolean {
  return snapshot.jsaFormVersion === JSA_FORM_VERSION_V2 ||
    Object.values(PERMIT_FORM_VERSIONS_V2).includes(snapshot.permitFormVersion as PermitFormVersionV2);
}

const dash = (value: string | null | undefined): string => value?.trim() || '-';
const response = (answer: { response: string; remarks?: string }): { response: string; remarks: string | null } =>
  ({ response: answer.response, remarks: answer.remarks ?? null });

function fields(rows: Array<[string, string | null | undefined]>): DocumentBlock {
  return { kind: 'fields', rows: rows.map(([label, value]) => ({ label, value: dash(value) })) };
}

function checklist(section: ChecklistSection, rawAnswers: unknown): DocumentSection {
  const answers = rawAnswers as Record<string, { response: string; remarks?: string }>;
  return {
    title: section.title,
    blocks: [{ kind: 'checklist', items: section.items.map((item) => ({ label: item.label, ...response(answers[item.id]!) })) }],
  };
}

function selections(section: SelectionSection, rawAnswers: unknown): DocumentSection {
  const answers = rawAnswers as Record<string, boolean | string | undefined>;
  const items = section.options.map((item) => ({ label: item.label, selected: answers[item.id] === true, remarks: null as string | null }));
  if (section.hasOther) items.push({ label: 'Other', selected: Boolean(answers.other), remarks: typeof answers.other === 'string' ? answers.other : null });
  return { title: section.title, blocks: [{ kind: 'selections', items }] };
}

function workWindow(form: { workWindow: { equipment?: string | undefined; area?: string | undefined; fromHours?: string | undefined; toHours?: string | undefined; extendedTo?: string | undefined } }): DocumentSection {
  return { title: 'WORK LOCATION / VALIDITY', blocks: [fields([
    ['EQUIPMENT', form.workWindow.equipment], ['AREA', form.workWindow.area], ['FROM HOURS', form.workWindow.fromHours],
    ['TO HOURS', form.workWindow.toHours], ['EXTENDED TO', form.workWindow.extendedTo],
  ])] };
}

function authorizationSections(form: { evacuation: { completedRemarks?: string | undefined; acknowledgedAtHours?: string | undefined; acknowledgedRemarks?: string | undefined } }): DocumentSection[] {
  return PERMIT_008_AUTHORIZATION_BANDS.map((band, index) => ({
    title: band.statement,
    blocks: [
      { kind: 'paragraph', text: `Authorization roles: ${band.signatories.map((s) => s.label).join(' / ')}. Digital authorization details are recorded in the frozen signature band below.` },
      ...(index === 2 ? [fields([['COMPLETED REMARKS', form.evacuation.completedRemarks], ['ACKNOWLEDGED AT HOURS', form.evacuation.acknowledgedAtHours], ['ACKNOWLEDGED REMARKS', form.evacuation.acknowledgedRemarks]])] : []),
    ],
  }));
}

function permitHeader(snapshot: IssuedPermitSnapshotV2, title: string, reference?: string): DocumentSection[] {
  const applicant = snapshot.applicantIdentity
    ? `${snapshot.applicantIdentity.displayName} — ${snapshot.applicantIdentity.companyName}`
    : snapshot.signatures.applicant?.displayName ?? '-';
  return [{ title: 'AUTHORITATIVE PERMIT', blocks: [fields([
    ['FORM', reference ? `${reference} Rev 0` : title], ['PERMIT NUMBER', snapshot.permitNumber], ['JSA NUMBER', snapshot.jsaNumber],
    ['APPLICANT', applicant], ['APPLICANT COMPANY', snapshot.applicantIdentity?.companyName ?? snapshot.company],
    ['ISSUED AT', snapshot.issuedAt], ['VALID UNTIL', snapshot.expiresAt], ['SITE TIMEZONE', snapshot.siteTimezone],
  ])] }];
}

function common008(snapshot: IssuedPermitSnapshotV2, form: ColdWorkFormV2 | HotWorkFormV2 | ConfinedSpaceEntryFormV2, nature: SelectionSection, hazards: SelectionSection, checklists: readonly ChecklistSection[], extra: DocumentSection[] = []): DocumentSection[] {
  return [
    workWindow(form), selections(nature, form.natureOfWork), selections(hazards, form.typeOfHazard), ...extra,
    ...checklists.map((section) => checklist(section, form.sections[section.id]!)),
    { title: 'SPECIAL PRECAUTIONS / INSTRUCTIONS', blocks: [fields([['SPECIAL PRECAUTIONS', form.specialPrecautions], ['SPECIAL INSTRUCTIONS', form.specialInstructions], ['LOTO NUMBER', form.lotoNumber], ['JSA NUMBER', snapshot.jsaNumber]])] },
  ];
}

function permitSections(snapshot: IssuedPermitSnapshotV2): { title: string; sections: DocumentSection[] } {
  switch (snapshot.permitType) {
    case 'WTG_WORK': {
      const form = snapshot.permitForm as WtgWorkFormV2;
      return { title: 'WTG WORK PERMIT', sections: [
        ...permitHeader(snapshot, 'WTG WORK PERMIT'),
        { title: '1. PERMIT ISSUE', blocks: [fields([['WIND FARM NAME', form.permitIssue.windFarmName], ['WTG NUMBER', form.permitIssue.wtgNumber], ['DESCRIPTION OF WORK', form.permitIssue.descriptionOfWork], ['PERMIT START', form.permitIssue.permitStartAt], ['PERMIT EXPIRY', form.permitIssue.permitExpiryAt]])] },
        ...WTG_WORK_CHECKLIST_SECTIONS.map((section) => checklist(section, form.sections[section.id]!)),
        checklist(WTG_ISOLATION_POINTS, form.isolationPoints), selections(WTG_PPE_REQUIRED, form.ppe),
        { title: 'AUTHORIZATION BANDS', blocks: [{ kind: 'paragraph', text: `${WTG_AUTHORIZATION_BANDS.map((band) => band.label).join(' / ')}. Digital authorization details are recorded in the frozen signature band below.` }] },
      ] };
    }
    case 'COLD_WORK': {
      const form = snapshot.permitForm as ColdWorkFormV2;
      return { title: 'COLD WORK PERMIT', sections: [...permitHeader(snapshot, 'COLD WORK PERMIT', FORM_REFERENCES.COLD_WORK), ...common008(snapshot, form, COLD_WORK_NATURE_OF_WORK, COLD_WORK_TYPE_OF_HAZARD, COLD_WORK_CHECKLIST_SECTIONS), { title: 'REFERENCES', blocks: [fields([['CONFINED SPACE PERMIT NO.', form.confinedSpacePermitRef]])] }, ...authorizationSections(form), { title: 'DOCUMENT CONTROL', blocks: [{ kind: 'paragraph', text: PERMIT_DISTRIBUTION_FOOTER }] }] };
    }
    case 'HOT_WORK': {
      const form = snapshot.permitForm as HotWorkFormV2;
      return { title: 'HOT WORK PERMIT', sections: [...permitHeader(snapshot, 'HOT WORK PERMIT', FORM_REFERENCES.HOT_WORK), ...common008(snapshot, form, HOT_WORK_NATURE_OF_WORK, HOT_WORK_TYPE_OF_HAZARD, HOT_WORK_CHECKLIST_SECTIONS, [selections({ id: 'combustion_sub_ticks', title: 'COMBUSTION & SPARK PRODUCING HAZARD — WORK METHOD', hasOther: false, options: HOT_WORK_COMBUSTION_SUB_TICKS }, form.combustionSubTicks), { title: 'FIRE WATCH', blocks: [fields([['FIRE WATCH', form.fireWatch]])] }]), { title: 'REFERENCES', blocks: [fields([['CONFINED SPACE PERMIT NO.', form.confinedSpacePermitRef]])] }, ...authorizationSections(form), { title: 'DOCUMENT CONTROL', blocks: [{ kind: 'paragraph', text: PERMIT_DISTRIBUTION_FOOTER }] }] };
    }
    case 'CONFINED_SPACE_ENTRY': {
      const form = snapshot.permitForm as ConfinedSpaceEntryFormV2;
      const gasRecord = form.gasTestRecord as Record<string, { oxygenAndTime?: string; testedBy?: string }>;
      const gasRows = CONFINED_SPACE_GAS_TEST_TABLE.rows.map((row) => [row, dash(gasRecord[row]?.oxygenAndTime), dash(gasRecord[row]?.testedBy)]);
      return { title: 'CONFINED SPACE ENTRY PERMIT', sections: [...permitHeader(snapshot, 'CONFINED SPACE ENTRY PERMIT', FORM_REFERENCES.CONFINED_SPACE_ENTRY), ...common008(snapshot, form, CONFINED_SPACE_NATURE_OF_WORK, CONFINED_SPACE_TYPE_OF_HAZARD, CONFINED_SPACE_CHECKLIST_SECTIONS, [selections({ id: 'combustion_sub_ticks', title: 'COMBUSTION & SPARK PRODUCING HAZARD — WORK METHOD', hasOther: false, options: CONFINED_SPACE_COMBUSTION_SUB_TICKS }, form.combustionSubTicks), { title: 'GAS TEST RECORD', blocks: [{ kind: 'table', columns: CONFINED_SPACE_GAS_TEST_TABLE.columns.map((c) => c.label), rows: gasRows }, { kind: 'paragraph', text: CONFINED_SPACE_SLOGAN }] }, { title: 'ATTENDANT', blocks: [fields([['ATTENDANT', form.attendant]])] }]), { title: 'REFERENCES', blocks: [fields([['COLD / HOT PERMIT NO. (IF ANY)', form.relatedPermitRef]])] }, ...authorizationSections(form), { title: 'DOCUMENT CONTROL', blocks: [{ kind: 'paragraph', text: PERMIT_DISTRIBUTION_FOOTER }] }] };
    }
  }
}

function digitalAuthorization(snapshot: IssuedPermitSnapshotV2): DocumentSection {
  const entries = [
    ['APPLICANT', snapshot.signatures.applicant], ['CRO AUTHORIZATION', snapshot.signatures.cro],
    ['HSE APPROVAL', snapshot.signatures.hse], ['CRO FALLBACK APPROVAL', snapshot.signatures.croFallback],
    ['RENEWAL AUTHORIZED BY (CRO)', snapshot.signatures.renewal],
  ].flatMap(([caption, signature]) => typeof caption === 'string' && signature && typeof signature !== 'string' ? [{ caption, name: signature.displayName, designation: signature.designation, signedAt: signature.signedAt }] : []);
  return { title: 'DIGITAL AUTHORIZATION / SIGNATURE INFORMATION', blocks: [{ kind: 'signatures', entries, note: 'These authorizations were digitally recorded from authenticated server-side actions and frozen at issuance. No handwritten signature is represented or fabricated.' }] };
}

function jsaPage1(snapshot: IssuedPermitSnapshotV2): DocumentPage {
  const form = snapshot.jsaForm.page1;
  const applicant = snapshot.signatures.applicant;
  return { title: `JOB SAFETY ANALYSIS — PAGE 1 OF 2 — ${FORM_REFERENCES.JSA} Rev 0`, sections: [
    { title: 'JOB INFORMATION', blocks: [fields([['JSA NUMBER', snapshot.jsaNumber], ['PERMIT NUMBER', snapshot.permitNumber], ['SITE / WTG', form.siteOrWtg], ['DATE / TIME', form.dateTime], ['S. NO.', form.serialNo], ['JOB / WORK', form.jobOrWork], ['JSA COMPLETED BY', applicant ? `${applicant.displayName}, ${applicant.designation}` : '-']])] },
    { title: 'REQUIRED PERMITS', blocks: [fields([['ANY WORKING PERMITS REQUIRED?', form.anyPermitsRequired]]), ...selections(JSA_REQUIRED_PERMITS, form.requiredPermits).blocks] },
    { title: 'HSE CHECKLIST', blocks: [{ kind: 'paragraph', text: JSA_HSE_CHECKLIST_INSTRUCTION }] },
    ...JSA_HSE_CHECKLIST_CATEGORIES.map((category) => selections(category, form.hseChecklist[category.id]!)),
    { title: 'STOP-WORK REMINDER', blocks: [{ kind: 'paragraph', text: JSA_PAGE1_REMINDER }] },
  ] };
}

function jsaPage2(snapshot: IssuedPermitSnapshotV2): DocumentPage {
  const form = snapshot.jsaForm.page2;
  return { title: `JOB SAFETY ANALYSIS — PAGE 2 OF 2 — ${FORM_REFERENCES.JSA} Rev 0`, sections: [
    { title: 'EMERGENCY RESPONSE', blocks: [fields([
      ...JSA_EMERGENCY_CONTACTS.map((entry) => [entry.label, form.emergencyContacts[entry.id]] as [string, string | undefined]),
      ...JSA_EMERGENCY_QUESTIONS.map((entry) => [entry.label, form.emergencyQuestions[entry.id]] as [string, string]),
    ])] },
    { title: 'TASK ANALYSIS', blocks: [{ kind: 'table', columns: JSA_TASK_ANALYSIS_COLUMNS.map((c) => c.label), rows: form.taskAnalysis.map((row) => [dash(row.sequenceOfTasks), dash(row.possibleHazardousEvents), row.energySources.join('/'), dash(row.triggeringEventsToStopWork), dash(row.protectiveActionsOrMeasures)]) }] },
    { title: 'ENERGY SOURCE LEGEND', blocks: [{ kind: 'paragraph', text: JSA_ENERGY_SOURCE_LEGEND.map((entry) => `${entry.code} = ${entry.label}`).join('  |  ') }] },
    selections(JSA_PPE_REQUIRED, form.ppe),
    { title: 'TOOLS / MATERIAL', blocks: [{ kind: 'paragraph', text: dash(form.toolsAndMaterials) }] },
    { title: 'PARTICIPANTS', blocks: [{ kind: 'table', columns: ['NAME AND POSITION', 'COMPANY', 'ACKNOWLEDGED'], rows: form.participants.map((p) => [dash(p.nameAndPosition), dash(p.company), p.acknowledged ? 'YES' : 'NO']) }, { kind: 'paragraph', text: JSA_PARTICIPANT_SIGNATURE_NOTE }] },
    { title: 'APPROVALS', blocks: [{ kind: 'table', columns: ['ROLE', 'NAME AND POSITION', 'CONTACT NUMBER', 'CLOSED OUT'], rows: JSA_APPROVAL_SIGNATORIES.map((s) => { const a = (form.approvals as Record<string, { nameAndPosition?: string; contactNumber?: string; closedOut: boolean }>)[s.id]!; return [s.label, dash(a.nameAndPosition), dash(a.contactNumber), a.closedOut ? 'YES' : 'NO']; }) }, { kind: 'paragraph', text: JSA_APPROVAL_NOTE }] },
    { title: 'CLOSE-OUT', blocks: [{ kind: 'paragraph', text: JSA_CLOSE_OUT_NOTE }] },
    { title: 'COMMENTS', blocks: [{ kind: 'paragraph', text: dash(form.comments) }] },
    digitalAuthorization(snapshot),
  ] };
}

export function buildIssuedDocumentPagesV2(snapshot: IssuedPermitSnapshotV2): DocumentPage[] {
  const permit = permitSections(snapshot);
  return [{ title: `AUTHORITATIVE ${permit.title}`, sections: [...permit.sections, digitalAuthorization(snapshot)] }, jsaPage1(snapshot), jsaPage2(snapshot)];
}
