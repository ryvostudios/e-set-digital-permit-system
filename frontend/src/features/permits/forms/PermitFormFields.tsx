import type {
  ColdWorkForm,
  ConfinedSpaceEntryForm,
  GasTestReading,
  HotWorkForm,
  PermitFormPayload,
  PermitType,
  WtgWorkForm,
} from '../../../api/types';
import { fromLocalInputValue, toLocalInputValue } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Checkbox, Input, Select, Textarea } from '../../../ui/Field';
import { DocumentSection } from '../DocumentParts';
import {
  BooleanGroupEditor,
  ChecklistEditor,
  DescriptionRowsEditor,
  NotesSection,
  SelectionEditor,
} from './editors';
import '../paper.css';

/**
 * The editable half of the permit document - the same sections, in the
 * same order and under the same numbering as the read-only rendering, so
 * a person filling the form in and a person reading it back are looking
 * at the same piece of paperwork.
 *
 * Only fields the backend's schema for this permit type actually accepts
 * appear here. There is no applicant name, company, designation, permit
 * number, JSA number, or status field anywhere: every one of those is
 * server-derived, and the backend's `.strict()` schemas reject an attempt
 * to supply one.
 */

interface FieldsProps<T> {
  form: T;
  onChange: (next: T) => void;
  disabled: boolean;
}

function WtgWorkFields({ form, onChange, disabled }: FieldsProps<WtgWorkForm>) {
  const patch = (changes: Partial<WtgWorkForm>): void => onChange({ ...form, ...changes });

  return (
    <>
      <DocumentSection number="3" title="Work information">
        <div className="form-grid">
          <Input
            label="Wind farm"
            required
            maxLength={200}
            value={form.windFarm}
            disabled={disabled}
            onChange={(event) => patch({ windFarm: event.target.value })}
          />
          <Input
            label="WTG number"
            required
            maxLength={100}
            value={form.wtgNumber}
            disabled={disabled}
            onChange={(event) => patch({ wtgNumber: event.target.value })}
          />
          <Input
            label="Declared start"
            type="datetime-local"
            required
            value={toLocalInputValue(form.permitStartAt)}
            disabled={disabled}
            onChange={(event) => patch({ permitStartAt: fromLocalInputValue(event.target.value) ?? '' })}
          />
          <Input
            label="Declared expiry"
            type="datetime-local"
            required
            hint="The system's own validity rule still applies once the permit is issued."
            value={toLocalInputValue(form.permitExpiryAt)}
            disabled={disabled}
            onChange={(event) => patch({ permitExpiryAt: fromLocalInputValue(event.target.value) ?? '' })}
          />
        </div>
        <Textarea
          label="Description of work"
          required
          maxLength={4000}
          rows={4}
          value={form.descriptionOfWork}
          disabled={disabled}
          onChange={(event) => patch({ descriptionOfWork: event.target.value })}
        />
      </DocumentSection>

      <DocumentSection number="4" title="Safety checklists" note="Transcribe each printed item and its answer">
        <ChecklistEditor
          label="General work"
          items={form.generalWork}
          disabled={disabled}
          onChange={(generalWork) => patch({ generalWork })}
        />
        <ChecklistEditor
          label="Electrical work"
          items={form.electricalWork}
          disabled={disabled}
          onChange={(electricalWork) => patch({ electricalWork })}
        />
        <ChecklistEditor
          label="Mechanical work"
          items={form.mechanicalWork}
          disabled={disabled}
          onChange={(mechanicalWork) => patch({ mechanicalWork })}
        />
        <ChecklistEditor
          label="Hydraulic work"
          items={form.hydraulicWork}
          disabled={disabled}
          onChange={(hydraulicWork) => patch({ hydraulicWork })}
        />
        <ChecklistEditor
          label="Work at heights"
          items={form.workAtHeights}
          disabled={disabled}
          onChange={(workAtHeights) => patch({ workAtHeights })}
        />
        <ChecklistEditor
          label="Specific safety requirements"
          items={form.specificSafetyRequirements}
          disabled={disabled}
          onChange={(specificSafetyRequirements) => patch({ specificSafetyRequirements })}
        />
      </DocumentSection>

      <DocumentSection number="5" title="Isolation and protective equipment">
        <DescriptionRowsEditor
          label="Isolation points"
          rows={form.isolationPoints}
          disabled={disabled}
          onChange={(isolationPoints) => patch({ isolationPoints })}
        />
        <SelectionEditor
          label="Personal protective equipment"
          options={form.ppe}
          disabled={disabled}
          onChange={(ppe) => patch({ ppe })}
        />
      </DocumentSection>

      <NotesSection
        number="6"
        title="Precautions and instructions"
        disabled={disabled}
        fields={[
          {
            label: 'Special precautions',
            value: form.specialPrecautions ?? '',
            maxLength: 2000,
            onChange: (specialPrecautions) => patch({ specialPrecautions }),
          },
          {
            label: 'Special instructions',
            value: form.specialInstructions ?? '',
            maxLength: 2000,
            onChange: (specialInstructions) => patch({ specialInstructions }),
          },
        ]}
      />
    </>
  );
}

function ColdWorkFields({ form, onChange, disabled }: FieldsProps<ColdWorkForm>) {
  const patch = (changes: Partial<ColdWorkForm>): void => onChange({ ...form, ...changes });

  return (
    <>
      {/*
        The one place option text is fixed rather than typed: the real
        Cold Work form supplied these two lists verbatim, so the backend
        models them as named booleans and an unknown key is rejected.
      */}
      <DocumentSection number="3" title="Nature of work and hazards">
        <BooleanGroupEditor
          label="Nature of work"
          disabled={disabled}
          values={form.natureOfWork}
          entries={[
            { key: 'mechanical', label: 'Mechanical' },
            { key: 'electricalAndInstrumentation', label: 'Electrical and instrumentation' },
            { key: 'civil', label: 'Civil' },
            { key: 'chemical', label: 'Chemical' },
            { key: 'inspection', label: 'Inspection' },
          ]}
          onChange={(natureOfWork) => patch({ natureOfWork })}
        />
        <BooleanGroupEditor
          label="Hazards"
          disabled={disabled}
          values={form.hazards}
          entries={[
            { key: 'energized', label: 'Energized' },
            { key: 'fall', label: 'Fall' },
            { key: 'respiratory', label: 'Respiratory' },
            { key: 'chemical', label: 'Chemical' },
          ]}
          onChange={(hazards) => patch({ hazards })}
        />
      </DocumentSection>

      <DocumentSection number="4" title="Safety checklists" note="Transcribe each printed item and its answer">
        <ChecklistEditor
          label="General requirements"
          items={form.generalRequirements}
          disabled={disabled}
          onChange={(generalRequirements) => patch({ generalRequirements })}
        />
        <ChecklistEditor
          label="Equipment condition"
          items={form.equipmentCondition}
          disabled={disabled}
          onChange={(equipmentCondition) => patch({ equipmentCondition })}
        />
      </DocumentSection>

      <DocumentSection number="5" title="Protective equipment and references">
        <SelectionEditor
          label="Personal protective equipment"
          options={form.ppe}
          disabled={disabled}
          onChange={(ppe) => patch({ ppe })}
        />
        <div className="form-grid">
          <Input
            label="LOTO number"
            maxLength={100}
            value={form.lotoNumber ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ lotoNumber: event.target.value })}
          />
          <Input
            label="Confined space permit reference"
            maxLength={100}
            value={form.confinedSpacePermitRef ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ confinedSpacePermitRef: event.target.value })}
          />
        </div>
      </DocumentSection>

      <NotesSection
        number="6"
        title="Precautions and instructions"
        disabled={disabled}
        fields={[
          {
            label: 'Special precautions',
            value: form.specialPrecautions ?? '',
            maxLength: 2000,
            onChange: (specialPrecautions) => patch({ specialPrecautions }),
          },
          {
            label: 'Special instructions',
            value: form.specialInstructions ?? '',
            maxLength: 2000,
            onChange: (specialInstructions) => patch({ specialInstructions }),
          },
        ]}
      />
    </>
  );
}

function HotWorkFields({ form, onChange, disabled }: FieldsProps<HotWorkForm>) {
  const patch = (changes: Partial<HotWorkForm>): void => onChange({ ...form, ...changes });

  return (
    <>
      <DocumentSection number="3" title="Nature of work and hazards">
        <SelectionEditor
          label="Nature of work"
          options={form.natureOfWork}
          disabled={disabled}
          onChange={(natureOfWork) => patch({ natureOfWork })}
        />
        <SelectionEditor
          label="Type of hazard"
          options={form.typeOfHazard}
          disabled={disabled}
          onChange={(typeOfHazard) => patch({ typeOfHazard })}
        />
      </DocumentSection>

      <DocumentSection number="4" title="Safety checklists" note="Transcribe each printed item and its answer">
        <ChecklistEditor
          label="General requirements"
          items={form.generalRequirements}
          disabled={disabled}
          onChange={(generalRequirements) => patch({ generalRequirements })}
        />
        <ChecklistEditor
          label="Equipment condition"
          items={form.equipmentCondition}
          disabled={disabled}
          onChange={(equipmentCondition) => patch({ equipmentCondition })}
        />
      </DocumentSection>

      <DocumentSection number="5" title="Fire watch and protective equipment">
        <Checkbox
          checked={form.fireWatch.required}
          disabled={disabled}
          label="Fire watch required"
          onChange={(event) => patch({ fireWatch: { ...form.fireWatch, required: event.target.checked } })}
        />
        <div className="form-grid">
          <Input
            label="Fire watch attendant"
            maxLength={200}
            hint="Form content only. This is not a digital signature."
            value={form.fireWatch.attendant ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ fireWatch: { ...form.fireWatch, attendant: event.target.value } })}
          />
          <Input
            label="Fire watch remarks"
            maxLength={1000}
            value={form.fireWatch.remarks ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ fireWatch: { ...form.fireWatch, remarks: event.target.value } })}
          />
        </div>
        <SelectionEditor
          label="Personal protective equipment"
          options={form.ppe}
          disabled={disabled}
          onChange={(ppe) => patch({ ppe })}
        />
      </DocumentSection>

      <DocumentSection number="6" title="References, precautions and instructions">
        <div className="form-grid">
          <Input
            label="LOTO number"
            maxLength={100}
            value={form.lotoNumber ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ lotoNumber: event.target.value })}
          />
          <Input
            label="Related permit reference"
            maxLength={100}
            value={form.relatedPermitRef ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ relatedPermitRef: event.target.value })}
          />
        </div>
        <div className="form-grid form-grid--full">
          <Textarea
            label="Special precautions"
            maxLength={2000}
            value={form.specialPrecautions ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ specialPrecautions: event.target.value })}
          />
          <Textarea
            label="Special instructions"
            maxLength={2000}
            value={form.specialInstructions ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ specialInstructions: event.target.value })}
          />
          <Textarea
            label="Evacuation details"
            maxLength={2000}
            value={form.evacuationDetails ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ evacuationDetails: event.target.value })}
          />
          <Textarea
            label="Remarks"
            maxLength={2000}
            value={form.remarks ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ remarks: event.target.value })}
          />
        </div>
      </DocumentSection>
    </>
  );
}

function GasTestEditor({
  readings,
  onChange,
  disabled,
}: {
  readings: GasTestReading[];
  onChange: (next: GasTestReading[]) => void;
  disabled: boolean;
}) {
  function update(index: number, patch: Partial<GasTestReading>): void {
    onChange(readings.map((reading, position) => (position === index ? { ...reading, ...patch } : reading)));
  }

  return (
    <div className="stack stack--tight">
      <p className="doc__field-label">Gas test readings</p>
      <ul className="repeat-list">
        {readings.map((reading, index) => (
          <li key={index} className="repeat-row">
            <div className="repeat-row__head">
              <span>Reading {index + 1}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || readings.length <= 1}
                onClick={() => onChange(readings.filter((_, position) => position !== index))}
              >
                Remove
              </Button>
            </div>
            <div className="form-grid">
              <Input
                label="Time taken"
                type="datetime-local"
                required
                value={toLocalInputValue(reading.time)}
                disabled={disabled}
                onChange={(event) => update(index, { time: fromLocalInputValue(event.target.value) ?? '' })}
              />
              <Input
                label="Oxygen %"
                type="number"
                min={0}
                max={100}
                step={0.1}
                required
                value={String(reading.oxygenPercent)}
                disabled={disabled}
                onChange={(event) => update(index, { oxygenPercent: Number(event.target.value) })}
              />
              <Select
                label="Result"
                required
                value={reading.result}
                disabled={disabled}
                onChange={(event) => update(index, { result: event.target.value as GasTestReading['result'] })}
              >
                <option value="PASS">Pass</option>
                <option value="FAIL">Fail</option>
              </Select>
              <Input
                label="Tested by"
                maxLength={200}
                hint="Form content only. This is not a digital signature."
                value={reading.testedBy ?? ''}
                disabled={disabled}
                onChange={(event) => update(index, { testedBy: event.target.value })}
              />
              <Input
                label="Remarks"
                maxLength={500}
                value={reading.remarks ?? ''}
                disabled={disabled}
                onChange={(event) => update(index, { remarks: event.target.value })}
              />
            </div>
          </li>
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || readings.length >= 60}
          onClick={() => onChange([...readings, { time: '', oxygenPercent: 20.9, result: 'PASS' }])}
        >
          Add reading
        </Button>
      </div>
    </div>
  );
}

function ConfinedSpaceFields({ form, onChange, disabled }: FieldsProps<ConfinedSpaceEntryForm>) {
  const patch = (changes: Partial<ConfinedSpaceEntryForm>): void => onChange({ ...form, ...changes });
  const patchGasTest = (changes: Partial<ConfinedSpaceEntryForm['gasTest']>): void =>
    onChange({ ...form, gasTest: { ...form.gasTest, ...changes } });

  return (
    <>
      <DocumentSection number="3" title="Nature of work and hazards">
        <SelectionEditor
          label="Nature of work"
          options={form.natureOfWork}
          disabled={disabled}
          onChange={(natureOfWork) => patch({ natureOfWork })}
        />
        <SelectionEditor
          label="Type of hazard"
          options={form.typeOfHazard}
          disabled={disabled}
          onChange={(typeOfHazard) => patch({ typeOfHazard })}
        />
      </DocumentSection>

      <DocumentSection number="4" title="Gas test">
        <div className="form-grid">
          <Input
            label="Instrument"
            maxLength={200}
            value={form.gasTest.instrument ?? ''}
            disabled={disabled}
            onChange={(event) => patchGasTest({ instrument: event.target.value })}
          />
          <Input
            label="Instrument calibration"
            maxLength={200}
            value={form.gasTest.instrumentCalibration ?? ''}
            disabled={disabled}
            onChange={(event) => patchGasTest({ instrumentCalibration: event.target.value })}
          />
        </div>
        <Checkbox
          checked={form.gasTest.retestRequired}
          disabled={disabled}
          label="Retest required"
          onChange={(event) => patchGasTest({ retestRequired: event.target.checked })}
        />
        <Checkbox
          checked={form.gasTest.continuousMonitoring}
          disabled={disabled}
          label="Continuous monitoring in place"
          onChange={(event) => patchGasTest({ continuousMonitoring: event.target.checked })}
        />
        <Input
          label="Retest details"
          maxLength={500}
          value={form.gasTest.retestDetails ?? ''}
          disabled={disabled}
          onChange={(event) => patchGasTest({ retestDetails: event.target.value })}
        />
        <GasTestEditor
          readings={form.gasTest.readings}
          disabled={disabled}
          onChange={(readings) => patchGasTest({ readings })}
        />
      </DocumentSection>

      <DocumentSection number="5" title="Safety checklist and protective equipment">
        <ChecklistEditor
          label="General requirements"
          items={form.generalRequirements}
          disabled={disabled}
          onChange={(generalRequirements) => patch({ generalRequirements })}
        />
        <SelectionEditor
          label="Personal protective equipment"
          options={form.ppe}
          disabled={disabled}
          onChange={(ppe) => patch({ ppe })}
        />
        <div className="form-grid">
          <Input
            label="Attendant"
            maxLength={200}
            hint="Form content only. This is not a digital signature."
            value={form.attendant ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ attendant: event.target.value })}
          />
          <Input
            label="LOTO number"
            maxLength={100}
            value={form.lotoNumber ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ lotoNumber: event.target.value })}
          />
        </div>
      </DocumentSection>

      <DocumentSection number="6" title="References, precautions and instructions">
        <div className="form-grid">
          <Input
            label="Related cold work permit"
            maxLength={100}
            value={form.relatedColdWorkPermitRef ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ relatedColdWorkPermitRef: event.target.value })}
          />
          <Input
            label="Related hot work permit"
            maxLength={100}
            value={form.relatedHotWorkPermitRef ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ relatedHotWorkPermitRef: event.target.value })}
          />
        </div>
        <div className="form-grid form-grid--full">
          <Textarea
            label="Special precautions"
            maxLength={2000}
            value={form.specialPrecautions ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ specialPrecautions: event.target.value })}
          />
          <Textarea
            label="Special instructions"
            maxLength={2000}
            value={form.specialInstructions ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ specialInstructions: event.target.value })}
          />
          <Textarea
            label="Evacuation details"
            maxLength={2000}
            value={form.evacuationDetails ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ evacuationDetails: event.target.value })}
          />
          <Textarea
            label="Remarks"
            maxLength={2000}
            value={form.remarks ?? ''}
            disabled={disabled}
            onChange={(event) => patch({ remarks: event.target.value })}
          />
        </div>
      </DocumentSection>
    </>
  );
}

/** Dispatches to the fields for the permit's own stored type. The type is never chosen here. */
export function PermitFormFields({
  permitType,
  form,
  onChange,
  disabled,
}: {
  permitType: PermitType;
  form: PermitFormPayload;
  onChange: (next: PermitFormPayload) => void;
  disabled: boolean;
}) {
  switch (permitType) {
    case 'WTG_WORK':
      return <WtgWorkFields form={form as WtgWorkForm} onChange={onChange} disabled={disabled} />;
    case 'COLD_WORK':
      return <ColdWorkFields form={form as ColdWorkForm} onChange={onChange} disabled={disabled} />;
    case 'HOT_WORK':
      return <HotWorkFields form={form as HotWorkForm} onChange={onChange} disabled={disabled} />;
    case 'CONFINED_SPACE_ENTRY':
      return <ConfinedSpaceFields form={form as ConfinedSpaceEntryForm} onChange={onChange} disabled={disabled} />;
  }
}
