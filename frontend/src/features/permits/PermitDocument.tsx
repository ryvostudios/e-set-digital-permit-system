import type {
  PermitClosure as PermitClosureRecord,
  ColdWorkForm,
  ConfinedSpaceEntryForm,
  HotWorkForm,
  Permit,
  PermitSignature,
  PermitValidity,
  WtgWorkForm,
} from '../../api/types';
import { describePermitApplicant } from '../../auth/capabilities';
import { formatDateTime } from '../../lib/format';
import { StatusBadge } from '../../ui/Layout';
import {
  BooleanTickList,
  ChecklistTable,
  DescriptionTable,
  DocumentField,
  DocumentSection,
  FieldGrid,
  SignatureBlock,
  TickList,
} from './DocumentParts';
import { PermitClosure } from './PermitClosure';
import { PERMIT_TYPE_LABELS } from './labels';
import './paper.css';

/**
 * The Permit, rendered as the controlled document it is.
 *
 * IDENTITY IS READ, NEVER WRITTEN. The applicant line comes from the
 * permit's own server-frozen `applicant_*` columns (migration 0024), and
 * the signature block from `permit_signatures` - values copied at the
 * moment of the authenticated action. Neither is re-derived from a live
 * profile, and neither is editable anywhere in this application.
 *
 * A PRIVILEGED applicant is shown by personal name ALONE: no role, no
 * "E-SET", no Company/Team/Position, because a privileged system account
 * genuinely has none.
 */

function DocumentHeader({ permit }: { permit: Permit }) {
  return (
    <header className="doc__masthead">
      <div>
        <p className="doc__issuer">E-SET · Permit to Work</p>
        <p className="doc__title">{permit.permit_type ? PERMIT_TYPE_LABELS[permit.permit_type] : 'Permit'}</p>
      </div>
      <dl className="doc__refs">
        <dt>Permit No.</dt>
        <dd>{permit.permitDisplayNumber}</dd>
        <dt>Form</dt>
        <dd>{permit.form_version ?? '—'}</dd>
      </dl>
    </header>
  );
}

function WtgWorkBody({ form }: { form: WtgWorkForm }) {
  return (
    <>
      <DocumentSection number="3" title="Work information">
        <FieldGrid>
          <DocumentField label="Wind farm" value={form.windFarm} strong />
          <DocumentField label="WTG number" value={form.wtgNumber} strong />
          <DocumentField label="Declared start" value={formatDateTime(form.permitStartAt)} />
          <DocumentField label="Declared expiry" value={formatDateTime(form.permitExpiryAt)} />
          <DocumentField label="Description of work" value={form.descriptionOfWork} full />
        </FieldGrid>
      </DocumentSection>

      <DocumentSection number="4" title="Safety checklists">
        <ChecklistTable caption="General work" items={form.generalWork} />
        <ChecklistTable caption="Electrical work" items={form.electricalWork} />
        <ChecklistTable caption="Mechanical work" items={form.mechanicalWork} />
        <ChecklistTable caption="Hydraulic work" items={form.hydraulicWork} />
        <ChecklistTable caption="Work at heights" items={form.workAtHeights} />
        <ChecklistTable caption="Specific safety requirements" items={form.specificSafetyRequirements} />
      </DocumentSection>

      <DocumentSection number="5" title="Isolation and protective equipment">
        <DescriptionTable caption="Isolation points" rows={form.isolationPoints} />
        <TickList label="Personal protective equipment" options={form.ppe} />
      </DocumentSection>

      <DocumentSection number="6" title="Precautions and instructions">
        <FieldGrid>
          <DocumentField label="Special precautions" value={form.specialPrecautions ?? ''} full />
          <DocumentField label="Special instructions" value={form.specialInstructions ?? ''} full />
        </FieldGrid>
      </DocumentSection>
    </>
  );
}

function ColdWorkBody({ form }: { form: ColdWorkForm }) {
  return (
    <>
      <DocumentSection number="3" title="Nature of work and hazards">
        <BooleanTickList
          label="Nature of work"
          entries={[
            { label: 'Mechanical', value: form.natureOfWork.mechanical },
            { label: 'Electrical and instrumentation', value: form.natureOfWork.electricalAndInstrumentation },
            { label: 'Civil', value: form.natureOfWork.civil },
            { label: 'Chemical', value: form.natureOfWork.chemical },
            { label: 'Inspection', value: form.natureOfWork.inspection },
          ]}
        />
        <BooleanTickList
          label="Hazards"
          entries={[
            { label: 'Energized', value: form.hazards.energized },
            { label: 'Fall', value: form.hazards.fall },
            { label: 'Respiratory', value: form.hazards.respiratory },
            { label: 'Chemical', value: form.hazards.chemical },
          ]}
        />
      </DocumentSection>

      <DocumentSection number="4" title="Safety checklists">
        <ChecklistTable caption="General requirements" items={form.generalRequirements} />
        <ChecklistTable caption="Equipment condition" items={form.equipmentCondition} />
      </DocumentSection>

      <DocumentSection number="5" title="Protective equipment and references">
        <TickList label="Personal protective equipment" options={form.ppe} />
        <FieldGrid>
          <DocumentField label="LOTO number" value={form.lotoNumber ?? ''} />
          <DocumentField label="Confined space permit reference" value={form.confinedSpacePermitRef ?? ''} />
        </FieldGrid>
      </DocumentSection>

      <DocumentSection number="6" title="Precautions and instructions">
        <FieldGrid>
          <DocumentField label="Special precautions" value={form.specialPrecautions ?? ''} full />
          <DocumentField label="Special instructions" value={form.specialInstructions ?? ''} full />
        </FieldGrid>
      </DocumentSection>
    </>
  );
}

function HotWorkBody({ form }: { form: HotWorkForm }) {
  return (
    <>
      <DocumentSection number="3" title="Nature of work and hazards">
        <TickList label="Nature of work" options={form.natureOfWork} />
        <TickList label="Type of hazard" options={form.typeOfHazard} />
      </DocumentSection>

      <DocumentSection number="4" title="Safety checklists">
        <ChecklistTable caption="General requirements" items={form.generalRequirements} />
        <ChecklistTable caption="Equipment condition" items={form.equipmentCondition} />
      </DocumentSection>

      <DocumentSection number="5" title="Fire watch and protective equipment">
        <FieldGrid>
          <DocumentField label="Fire watch required" value={form.fireWatch.required ? 'Yes' : 'No'} strong />
          <DocumentField label="Fire watch attendant" value={form.fireWatch.attendant ?? ''} />
          <DocumentField label="Fire watch remarks" value={form.fireWatch.remarks ?? ''} full />
        </FieldGrid>
        <p className="muted text-sm">
          A named fire watch attendant is form content. It is not a digital signature.
        </p>
        <TickList label="Personal protective equipment" options={form.ppe} />
      </DocumentSection>

      <DocumentSection number="6" title="References, precautions and instructions">
        <FieldGrid>
          <DocumentField label="LOTO number" value={form.lotoNumber ?? ''} />
          <DocumentField label="Related permit reference" value={form.relatedPermitRef ?? ''} />
          <DocumentField label="Special precautions" value={form.specialPrecautions ?? ''} full />
          <DocumentField label="Special instructions" value={form.specialInstructions ?? ''} full />
          <DocumentField label="Evacuation details" value={form.evacuationDetails ?? ''} full />
          <DocumentField label="Remarks" value={form.remarks ?? ''} full />
        </FieldGrid>
      </DocumentSection>
    </>
  );
}

function ConfinedSpaceBody({ form }: { form: ConfinedSpaceEntryForm }) {
  return (
    <>
      <DocumentSection number="3" title="Nature of work and hazards">
        <TickList label="Nature of work" options={form.natureOfWork} />
        <TickList label="Type of hazard" options={form.typeOfHazard} />
      </DocumentSection>

      <DocumentSection number="4" title="Gas test">
        <FieldGrid>
          <DocumentField label="Instrument" value={form.gasTest.instrument ?? ''} />
          <DocumentField label="Instrument calibration" value={form.gasTest.instrumentCalibration ?? ''} />
          <DocumentField label="Retest required" value={form.gasTest.retestRequired ? 'Yes' : 'No'} />
          <DocumentField label="Continuous monitoring" value={form.gasTest.continuousMonitoring ? 'Yes' : 'No'} />
          <DocumentField label="Retest details" value={form.gasTest.retestDetails ?? ''} full />
        </FieldGrid>

        <table className="doc__grid">
          <caption className="sr-only">Gas test readings</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Oxygen %</th>
              <th scope="col">Result</th>
              <th scope="col">Tested by</th>
              <th scope="col">Remarks</th>
            </tr>
          </thead>
          <tbody>
            {form.gasTest.readings.map((reading, index) => (
              <tr key={`${reading.time}-${index}`}>
                <td data-label="Time">{formatDateTime(reading.time)}</td>
                <td data-label="Oxygen %">{reading.oxygenPercent.toFixed(1)}</td>
                <td data-label="Result">
                  <span className={`doc__response doc__response--${reading.result === 'PASS' ? 'YES' : 'NO'}`}>
                    {reading.result}
                  </span>
                </td>
                <td data-label="Tested by">{reading.testedBy ?? '—'}</td>
                <td data-label="Remarks">{reading.remarks ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentSection>

      <DocumentSection number="5" title="Safety checklist and protective equipment">
        <ChecklistTable caption="General requirements" items={form.generalRequirements} />
        <TickList label="Personal protective equipment" options={form.ppe} />
        <FieldGrid>
          <DocumentField label="Attendant" value={form.attendant ?? ''} />
          <DocumentField label="LOTO number" value={form.lotoNumber ?? ''} />
        </FieldGrid>
        <p className="muted text-sm">A named attendant is form content. It is not a digital signature.</p>
      </DocumentSection>

      <DocumentSection number="6" title="References, precautions and instructions">
        <FieldGrid>
          <DocumentField label="Related cold work permit" value={form.relatedColdWorkPermitRef ?? ''} />
          <DocumentField label="Related hot work permit" value={form.relatedHotWorkPermitRef ?? ''} />
          <DocumentField label="Special precautions" value={form.specialPrecautions ?? ''} full />
          <DocumentField label="Special instructions" value={form.specialInstructions ?? ''} full />
          <DocumentField label="Evacuation details" value={form.evacuationDetails ?? ''} full />
          <DocumentField label="Remarks" value={form.remarks ?? ''} full />
        </FieldGrid>
      </DocumentSection>
    </>
  );
}

export function PermitDocument({
  permit,
  validity,
  signatures,
  closure,
}: {
  permit: Permit;
  validity: PermitValidity | null;
  signatures: PermitSignature[];
  /** Present only for a CLOSED permit - who actually closed it. */
  closure?: PermitClosureRecord | null;
}) {
  const applicant = describePermitApplicant(permit);

  return (
    <article className="doc">
      <DocumentHeader permit={permit} />

      <DocumentSection number="1" title="Permit information">
        <FieldGrid>
          <DocumentField label="Status" value={<StatusBadge status={permit.status} />} strong />
          <DocumentField label="Permit type" value={permit.permit_type ? PERMIT_TYPE_LABELS[permit.permit_type] : ''} />
          <DocumentField label="Raised" value={formatDateTime(permit.created_at)} />
          <DocumentField label="Submitted" value={permit.submitted_at ? formatDateTime(permit.submitted_at) : ''} />
          <DocumentField label="Issued" value={permit.issued_at ? formatDateTime(permit.issued_at) : ''} />
          <DocumentField
            label="Valid until"
            value={validity ? formatDateTime(validity.expiresAt) : ''}
            strong={Boolean(validity?.isValid)}
          />
        </FieldGrid>
        {validity && !validity.isValid && permit.status === 'ISSUED' ? (
          <p className="muted text-sm">This permit has passed its validity window.</p>
        ) : null}
      </DocumentSection>

      <DocumentSection number="2" title="Applicant" note="Recorded by the system at submission">
        <FieldGrid>
          <DocumentField label="Applicant" value={applicant ?? ''} strong full />
        </FieldGrid>
        {!applicant ? (
          <p className="muted text-sm">
            The applicant identity is recorded by the system when the permit is submitted.
          </p>
        ) : null}
      </DocumentSection>

      {permit.form_payload && permit.permit_type === 'WTG_WORK' ? (
        <WtgWorkBody form={permit.form_payload as WtgWorkForm} />
      ) : null}
      {permit.form_payload && permit.permit_type === 'COLD_WORK' ? (
        <ColdWorkBody form={permit.form_payload as ColdWorkForm} />
      ) : null}
      {permit.form_payload && permit.permit_type === 'HOT_WORK' ? (
        <HotWorkBody form={permit.form_payload as HotWorkForm} />
      ) : null}
      {permit.form_payload && permit.permit_type === 'CONFINED_SPACE_ENTRY' ? (
        <ConfinedSpaceBody form={permit.form_payload as ConfinedSpaceEntryForm} />
      ) : null}

      {!permit.form_payload ? (
        <DocumentSection number="3" title="Work information">
          <p className="muted">This permit has not been filled in yet.</p>
        </DocumentSection>
      ) : null}

      <DocumentSection number="7" title="Authorizations" note="Digital signatures, frozen at the time of each action">
        <SignatureBlock signatures={signatures} />
      </DocumentSection>

      {permit.status === 'HELD' || permit.status === 'CANCELLED' || permit.status === 'CLOSED' ? (
        <DocumentSection number="8" title="Closure and control actions">
          <FieldGrid>
            {permit.held_at ? <DocumentField label="Held" value={formatDateTime(permit.held_at)} /> : null}
            {permit.hold_reason ? <DocumentField label="Hold reason" value={permit.hold_reason} full /> : null}
            {permit.cancelled_at ? <DocumentField label="Cancelled" value={formatDateTime(permit.cancelled_at)} /> : null}
            {permit.cancel_reason ? <DocumentField label="Cancellation reason" value={permit.cancel_reason} full /> : null}
            {/*
              Closure gets its own section below, because WHO closed the
              permit is a fact in its own right - not a footnote to the
              hold/cancel band.
            */}
            {permit.closed_at && !closure ? (
              <DocumentField label="Closed" value={formatDateTime(permit.closed_at)} />
            ) : null}
            {permit.closure_remarks && !closure ? (
              <DocumentField label="Closure remarks" value={permit.closure_remarks} full />
            ) : null}
          </FieldGrid>
        </DocumentSection>
      ) : null}

      {closure ? <PermitClosure closure={closure} /> : null}
    </article>
  );
}
