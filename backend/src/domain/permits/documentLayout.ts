import type { IssuedPermitSnapshot } from './documents.js';
import type {
  ColdWorkForm,
  ConfinedSpaceEntryForm,
  HotWorkForm,
  JsaForm,
  PermitForm,
  WtgWorkForm,
} from './forms.js';
import { PERMIT_TYPE_LABELS } from './numbering.js';
import type { SnapshotSignature, SnapshotSignatureSet } from './signatures.js';
import { buildIssuedDocumentPagesV2, isV2Snapshot, usesAnyV2FormVersion } from './documentLayoutV2.js';

/**
 * The ordered, purely-derived page/section model of an issued document.
 *
 * Built from the IMMUTABLE SNAPSHOT ONLY - it never reads a live
 * permit/JSA row, a workforce profile, or the clock - so the same
 * snapshot always produces the same model, and therefore the same PDF
 * bytes. The page order is the confirmed immutable document order:
 *
 *     Permit page(s) -> JSA page 1 -> JSA page 2
 *
 * Signatures are rendered from `snapshot.signatures` alone. A role that
 * did not sign has no row at all - in particular a permit issued by CRO
 * fallback approval shows the real CRO under CRO FALLBACK APPROVAL and
 * has no HSE row whatsoever, fabricated or blank.
 */

export interface FieldRow {
  label: string;
  value: string;
  /**
   * PDFKIT_V3 only: a stored instant, to be printed as a human date-time
   * in the site's timezone rather than as the ISO string it is stored as.
   * The stored value is untouched - this only says how to show it.
   */
  format?: 'timestamp';
  /**
   * PDFKIT_V3 only: internal metadata that belongs in the record, not on
   * the printed document (a configuration value, an identifier nobody
   * reads). The older renderers still print it, so their bytes are
   * unchanged.
   */
  technical?: boolean;
}

/**
 * PRESENTATION HINTS, ADDED FOR THE PDFKIT_V3 RENDERER.
 *
 * Every field below is OPTIONAL and carries no content of its own - it
 * describes how content the model already holds is PRINTED. The older
 * renderers do not read any of them, so populating them cannot change a
 * byte of what PDFKIT_V1/V2 produce for a snapshot they already
 * rendered; V3 uses them to draw the response columns, section numbers
 * and mastheads the paper form actually has.
 *
 * They live on the shared model rather than in a parallel one so there
 * stays exactly ONE place that decides what an issued document contains.
 */

export type DocumentBlock =
  | { kind: 'fields'; rows: FieldRow[] }
  | {
      kind: 'checklist';
      items: Array<{ label: string; response: string; remarks: string | null }>;
      /** The tick columns this band actually prints, e.g. `['YES','NO']`. */
      columns?: readonly string[];
    }
  | {
      kind: 'selections';
      items: Array<{ label: string; selected: boolean; remarks: string | null }>;
      /** How many tick boxes the printed band puts on a row. */
      columns?: number;
    }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'paragraph'; text: string }
  | { kind: 'signatures'; entries: SignatureEntry[]; note: string | null };

export interface SignatureEntry {
  /** The heading printed above the signature, e.g. `CRO FALLBACK APPROVAL`. */
  caption: string;
  name: string;
  designation: string;
  signedAt: string;
}

export interface DocumentSection {
  title: string;
  blocks: DocumentBlock[];
  /** The number the paper form prints beside this heading, where it prints one. */
  number?: string | null;
}

/** The printed identity band: issuer, document title and form reference. */
export interface DocumentMasthead {
  issuer: string;
  title: string;
  reference: string | null;
  pageLabel: string | null;
}

export interface DocumentPage {
  title: string;
  sections: DocumentSection[];
  masthead?: DocumentMasthead;
  /** Server-authoritative identity printed under the masthead. */
  identity?: FieldRow[];
  /** The line the paper form prints at the foot of the page. */
  footerNote?: string | null;
}

/**
 * The same labels the notification prose uses. One copy, in
 * `numbering.ts` - the seam that owns how a permit is named to a person -
 * so a permit cannot be called one thing in a notification and another on
 * its own document.
 */
const PERMIT_TYPE_TITLES = PERMIT_TYPE_LABELS;

function textOrDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '-' : value;
}

function yesNo(value: boolean): string {
  return value ? 'YES' : 'NO';
}

function optionalParagraph(title: string, value: string | undefined): DocumentSection[] {
  if (!value) return [];
  return [{ title, blocks: [{ kind: 'paragraph', text: value }] }];
}

function checklistSection(title: string, items: WtgWorkForm['generalWork']): DocumentSection {
  return {
    title,
    blocks: [
      {
        kind: 'checklist',
        items: items.map((item) => ({ label: item.label, response: item.response, remarks: item.remarks ?? null })),
      },
    ],
  };
}

function selectionSection(title: string, items: WtgWorkForm['ppe']): DocumentSection {
  return {
    title,
    blocks: [
      {
        kind: 'selections',
        items: items.map((item) => ({ label: item.label, selected: item.selected, remarks: item.remarks ?? null })),
      },
    ],
  };
}

function wtgWorkSections(form: WtgWorkForm): DocumentSection[] {
  return [
    {
      title: 'Work Details',
      blocks: [
        {
          kind: 'fields',
          rows: [
            { label: 'Wind Farm', value: form.windFarm },
            { label: 'WTG Number', value: form.wtgNumber },
            { label: 'Description of Work', value: form.descriptionOfWork },
            { label: 'Permit Start', value: form.permitStartAt },
            { label: 'Permit Expiry (as stated on the form)', value: form.permitExpiryAt },
          ],
        },
      ],
    },
    checklistSection('General Work', form.generalWork),
    checklistSection('Electrical Work', form.electricalWork),
    checklistSection('Mechanical Work', form.mechanicalWork),
    checklistSection('Hydraulic Work', form.hydraulicWork),
    checklistSection('Work at Heights', form.workAtHeights),
    checklistSection('Specific Safety Requirements', form.specificSafetyRequirements),
    {
      title: 'Isolation Points',
      blocks: [
        {
          kind: 'table',
          columns: ['Isolation Point', 'Remarks'],
          rows: form.isolationPoints.map((point) => [point.description, textOrDash(point.remarks)]),
        },
      ],
    },
    selectionSection('PPE', form.ppe),
    ...optionalParagraph('Special Precautions', form.specialPrecautions),
    ...optionalParagraph('Special Instructions', form.specialInstructions),
  ];
}

function coldWorkSections(form: ColdWorkForm, jsaNumber: string): DocumentSection[] {
  return [
    {
      title: 'Nature of Work',
      blocks: [
        {
          kind: 'selections',
          items: [
            { label: 'Mechanical', selected: form.natureOfWork.mechanical, remarks: null },
            { label: 'E&I', selected: form.natureOfWork.electricalAndInstrumentation, remarks: null },
            { label: 'Civil', selected: form.natureOfWork.civil, remarks: null },
            { label: 'Chemical', selected: form.natureOfWork.chemical, remarks: null },
            { label: 'Inspection', selected: form.natureOfWork.inspection, remarks: null },
          ],
        },
      ],
    },
    {
      title: 'Hazards',
      blocks: [
        {
          kind: 'selections',
          items: [
            { label: 'Energized', selected: form.hazards.energized, remarks: null },
            { label: 'Fall', selected: form.hazards.fall, remarks: null },
            { label: 'Respiratory', selected: form.hazards.respiratory, remarks: null },
            { label: 'Chemical', selected: form.hazards.chemical, remarks: null },
          ],
        },
      ],
    },
    checklistSection('General Requirements', form.generalRequirements),
    checklistSection('Equipment Condition', form.equipmentCondition),
    selectionSection('PPE', form.ppe),
    {
      title: 'References',
      blocks: [
        {
          kind: 'fields',
          rows: [
            { label: 'Confined Space Permit', value: textOrDash(form.confinedSpacePermitRef) },
            { label: 'LOTO Number', value: textOrDash(form.lotoNumber) },
            // Authoritative, from the linked JSA - never typed onto the form.
            { label: 'JSA Number', value: jsaNumber },
          ],
        },
      ],
    },
    ...optionalParagraph('Special Precautions', form.specialPrecautions),
    ...optionalParagraph('Special Instructions', form.specialInstructions),
  ];
}

function hotWorkSections(form: HotWorkForm, jsaNumber: string): DocumentSection[] {
  return [
    selectionSection('Nature of Work', form.natureOfWork),
    selectionSection('Type of Hazard', form.typeOfHazard),
    checklistSection('General Requirements', form.generalRequirements),
    checklistSection('Equipment Condition', form.equipmentCondition),
    selectionSection('PPE', form.ppe),
    {
      title: 'Fire Watch',
      blocks: [
        {
          kind: 'fields',
          rows: [
            { label: 'Fire Watch Required', value: yesNo(form.fireWatch.required) },
            { label: 'Fire Watch Attendant', value: textOrDash(form.fireWatch.attendant) },
            { label: 'Remarks', value: textOrDash(form.fireWatch.remarks) },
          ],
        },
      ],
    },
    {
      title: 'References',
      blocks: [
        {
          kind: 'fields',
          rows: [
            { label: 'Related Permit', value: textOrDash(form.relatedPermitRef) },
            { label: 'LOTO Number', value: textOrDash(form.lotoNumber) },
            { label: 'JSA Number', value: jsaNumber },
          ],
        },
      ],
    },
    ...optionalParagraph('Special Precautions', form.specialPrecautions),
    ...optionalParagraph('Special Instructions', form.specialInstructions),
    ...optionalParagraph('Evacuation', form.evacuationDetails),
    ...optionalParagraph('Remarks', form.remarks),
  ];
}

function confinedSpaceSections(form: ConfinedSpaceEntryForm, jsaNumber: string): DocumentSection[] {
  return [
    selectionSection('Nature of Work', form.natureOfWork),
    selectionSection('Type of Hazard', form.typeOfHazard),
    {
      title: 'Gas Test',
      blocks: [
        {
          kind: 'fields',
          rows: [
            { label: 'Instrument', value: textOrDash(form.gasTest.instrument) },
            { label: 'Calibration', value: textOrDash(form.gasTest.instrumentCalibration) },
            { label: 'Retest Required', value: yesNo(form.gasTest.retestRequired) },
            { label: 'Retest Requirement', value: textOrDash(form.gasTest.retestDetails) },
            { label: 'Continuous Monitoring', value: yesNo(form.gasTest.continuousMonitoring) },
          ],
        },
        {
          kind: 'table',
          columns: ['Time', 'O2 %', 'Result', 'Tested By', 'Remarks'],
          rows: form.gasTest.readings.map((reading) => [
            reading.time,
            reading.oxygenPercent.toString(),
            reading.result,
            textOrDash(reading.testedBy),
            textOrDash(reading.remarks),
          ]),
        },
      ],
    },
    checklistSection('General Requirements', form.generalRequirements),
    selectionSection('PPE', form.ppe),
    {
      title: 'Attendant',
      blocks: [{ kind: 'fields', rows: [{ label: 'Attendant', value: textOrDash(form.attendant) }] }],
    },
    {
      title: 'References',
      blocks: [
        {
          kind: 'fields',
          rows: [
            { label: 'Related Cold Work Permit', value: textOrDash(form.relatedColdWorkPermitRef) },
            { label: 'Related Hot Work Permit', value: textOrDash(form.relatedHotWorkPermitRef) },
            { label: 'LOTO Number', value: textOrDash(form.lotoNumber) },
            { label: 'JSA Number', value: jsaNumber },
          ],
        },
      ],
    },
    ...optionalParagraph('Special Precautions', form.specialPrecautions),
    ...optionalParagraph('Special Instructions', form.specialInstructions),
    ...optionalParagraph('Evacuation', form.evacuationDetails),
    ...optionalParagraph('Remarks', form.remarks),
  ];
}

function permitFormSections(snapshot: IssuedPermitSnapshot): DocumentSection[] {
  const form = snapshot.permitForm as PermitForm;
  switch (snapshot.permitType) {
    case 'WTG_WORK':
      return wtgWorkSections(form as WtgWorkForm);
    case 'COLD_WORK':
      return coldWorkSections(form as ColdWorkForm, snapshot.jsaNumber);
    case 'HOT_WORK':
      return hotWorkSections(form as HotWorkForm, snapshot.jsaNumber);
    case 'CONFINED_SPACE_ENTRY':
      return confinedSpaceSections(form as ConfinedSpaceEntryForm, snapshot.jsaNumber);
  }
}

function signatureEntry(caption: string, signature: SnapshotSignature | null): SignatureEntry[] {
  if (!signature) return [];
  return [
    {
      caption,
      name: signature.displayName,
      designation: signature.designation,
      signedAt: signature.signedAt,
    },
  ];
}

/**
 * The digital signature block. Every entry comes from a real
 * authenticated action recorded at the time it happened; a role that
 * never signed is simply absent. When a permit was issued by CRO
 * fallback approval, the block says so factually rather than implying an
 * HSE approval that never occurred.
 */
export function buildSignatureBlock(signatures: SnapshotSignatureSet): DocumentBlock {
  const entries = [
    ...signatureEntry('APPLICANT', signatures.applicant),
    ...signatureEntry('CRO AUTHORIZATION', signatures.cro),
    ...signatureEntry('HSE APPROVAL', signatures.hse),
    ...signatureEntry('CRO FALLBACK APPROVAL', signatures.croFallback),
    ...signatureEntry('RENEWAL AUTHORIZED BY (CRO)', signatures.renewal),
  ];
  const note = signatures.croFallback && !signatures.hse
    ? 'Issued under CRO fallback approval after the HSE review window expired. No HSE approval was performed.'
    : null;
  return { kind: 'signatures', entries, note };
}

function jsaPage1(snapshot: IssuedPermitSnapshot): DocumentPage {
  const jsa = snapshot.jsaForm as JsaForm;
  const applicant = snapshot.signatures.applicant;
  return {
    title: 'Job Safety Analysis - Page 1',
    sections: [
      {
        title: 'JSA Details',
        blocks: [
          {
            kind: 'fields',
            rows: [
              { label: 'JSA Number', value: snapshot.jsaNumber },
              { label: 'Permit Number', value: snapshot.permitNumber },
              { label: 'Site / WTG', value: jsa.page1.siteOrWtg },
              { label: 'Job / Work', value: jsa.page1.jobOrWork },
              // The authenticated identity that completed and submitted
              // the JSA - taken from the frozen applicant signature, never
              // from a name typed into the form.
              { label: 'Completed By', value: applicant ? applicant.displayName : '-' },
              { label: 'Designation', value: applicant ? applicant.designation : '-' },
              { label: 'Completed At', value: applicant ? applicant.signedAt : '-' },
            ],
          },
        ],
      },
      {
        title: 'Required Permits',
        blocks: [
          {
            kind: 'selections',
            items: [
              { label: 'WTG Work', selected: jsa.page1.requiredPermits.wtgWork, remarks: null },
              { label: 'Cold Work', selected: jsa.page1.requiredPermits.coldWork, remarks: null },
              { label: 'Hot Work', selected: jsa.page1.requiredPermits.hotWork, remarks: null },
              {
                label: 'Confined Space Entry',
                selected: jsa.page1.requiredPermits.confinedSpaceEntry,
                remarks: null,
              },
            ],
          },
        ],
      },
      ...jsa.page1.hseChecklistGroups.map((group) => checklistSection(group.title, group.items)),
    ],
  };
}

function jsaPage2(snapshot: IssuedPermitSnapshot): DocumentPage {
  const jsa = snapshot.jsaForm as JsaForm;
  const closeOut = jsa.page2.closeOut;
  return {
    title: 'Job Safety Analysis - Page 2',
    sections: [
      ...optionalParagraph('Emergency Response', jsa.page2.emergencyResponse),
      {
        title: 'Task Analysis',
        blocks: [
          {
            kind: 'table',
            columns: [
              'Sequence of Tasks',
              'Possible Hazardous Events',
              'Energy / Triggering Sources',
              'Protective Actions / Measures',
            ],
            rows: jsa.page2.taskAnalysis.map((row) => [
              row.sequenceOfTasks,
              row.possibleHazardousEvents,
              row.energyOrTriggeringSources,
              row.protectiveActionsOrMeasures,
            ]),
          },
        ],
      },
      selectionSection('PPE', jsa.page2.ppe),
      {
        title: 'Tools / Material',
        blocks: [
          {
            kind: 'table',
            columns: ['Tool / Material', 'Remarks'],
            rows: jsa.page2.toolsAndMaterials.map((tool) => [tool.description, textOrDash(tool.remarks)]),
          },
        ],
      },
      {
        title: 'Participants',
        blocks: [
          {
            kind: 'table',
            columns: ['Name', 'Company'],
            rows: jsa.page2.participants.map((participant) => [
              participant.name,
              textOrDash(participant.company),
            ]),
          },
        ],
      },
      {
        // Deliberately NOT part of the digital signature block: these are
        // the paper acknowledgement entries as written on the JSA form.
        title: 'Participant Acknowledgements (as recorded on the JSA form)',
        blocks: [
          {
            kind: 'table',
            columns: ['Name', 'Acknowledged', 'Remarks'],
            rows: jsa.page2.participantAcknowledgements.map((entry) => [
              entry.name,
              yesNo(entry.acknowledged),
              textOrDash(entry.remarks),
            ]),
          },
        ],
      },
      ...optionalParagraph('Comments', jsa.page2.comments),
      ...(closeOut
        ? [
            {
              title: 'Close-Out',
              blocks: [
                {
                  kind: 'fields' as const,
                  rows: [
                    { label: 'Completed At', value: textOrDash(closeOut.completedAt) },
                    { label: 'Remarks', value: textOrDash(closeOut.remarks) },
                  ],
                },
              ],
            },
          ]
        : []),
    ],
  };
}

/** The complete issued document: Permit page(s), then JSA page 1, then JSA page 2 - always in that order. */
export function buildIssuedDocumentPages(snapshot: IssuedPermitSnapshot): DocumentPage[] {
  // The immutable, server-stored form versions are the sole renderer
  // selector. There is no request/browser parameter capable of choosing
  // this path. Historical V1 snapshots continue through the layout below.
  if (isV2Snapshot(snapshot)) return buildIssuedDocumentPagesV2(snapshot);
  if (usesAnyV2FormVersion(snapshot)) {
    throw new Error('Issued snapshot has incompatible V2 Permit/JSA form versions');
  }
  const applicantLine = snapshot.applicantIdentity
    ? snapshot.applicantIdentity.kind === 'NORMAL'
      ? `Mr. ${snapshot.applicantIdentity.displayName} of Company ${snapshot.applicantIdentity.companyName}`
      : snapshot.applicantIdentity.displayName
    : null;
  const permitPage: DocumentPage = {
    title: PERMIT_TYPE_TITLES[snapshot.permitType],
    sections: [
      {
        title: 'Permit',
        blocks: [
          {
            kind: 'fields',
            rows: [
              { label: 'Permit Number', value: snapshot.permitNumber },
              { label: 'JSA Number', value: snapshot.jsaNumber },
              { label: 'Permit Type', value: snapshot.permitType },
              { label: 'Form Version', value: snapshot.permitFormVersion },
              { label: 'Status at Issuance', value: snapshot.status },
              ...(applicantLine
                ? [{ label: 'Applicant', value: applicantLine }]
                : [{
                    label: 'Company',
                    value: `${textOrDash(snapshot.company)}${snapshot.companyOther ? ` (${snapshot.companyOther})` : ''}`,
                  }]),
              { label: 'Submitted At', value: textOrDash(snapshot.submittedAt) },
              { label: 'Issued At', value: snapshot.issuedAt },
              { label: 'Issuance Decision', value: snapshot.issuanceEventType },
              { label: 'Approval Recorded At', value: snapshot.issuanceOccurredAt },
              { label: 'Valid Until (next midnight, site time)', value: snapshot.expiresAt },
              { label: 'Site Timezone', value: snapshot.siteTimezone },
              { label: 'Renewed From Permit Number', value: textOrDash(snapshot.previousPermitNumber) },
            ],
          },
        ],
      },
      ...permitFormSections(snapshot),
      { title: 'Digital Signatures', blocks: [buildSignatureBlock(snapshot.signatures)] },
    ],
  };

  return [permitPage, jsaPage1(snapshot), jsaPage2(snapshot)];
}
