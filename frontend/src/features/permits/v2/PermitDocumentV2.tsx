import { isStatementBands, type PermitDefinition, type PermitTypeKey } from '../../../api/catalogue';
import {
  AuthorizationBand,
  ChecklistBand,
  DocField,
  DocSection,
  DocumentMasthead,
  FieldRow,
  SelectionBand,
  type DocumentMode,
} from './primitives';
import type { ChecklistAnswers, PermitValuesV2, SelectionValues } from './values';
import './paperV2.css';

/**
 * The authoritative permit document - all four templates.
 *
 * ONE RENDERER, NOT FOUR HAND-WRITTEN FORMS. The sections, their order,
 * their questions and their tick columns all come from the catalogue, so
 * WTG's Yes/No/N/A bands, its Yes/No-only Isolation Points, Hot Work's
 * own General Requirements and Cold Work's INSPECTION option are
 * differences in DATA, not in code. That is what makes them impossible to
 * accidentally alias to one another.
 *
 * What is NOT generic is the arrangement each printed form uses: WTG
 * leads with Permit Issue and ends with its four signature bands, while
 * 008A/B/C lead with the authorisation sentence and the Nature of Work /
 * Type of Hazard bands. Those are laid out per template below, because
 * flattening them into one uniform card list is exactly the redesign the
 * brief forbids.
 */

interface Props {
  permitType: PermitTypeKey;
  definition: PermitDefinition;
  values: PermitValuesV2;
  mode: DocumentMode;
  onChange?: (next: PermitValuesV2) => void;
  /** Server-derived, displayed but never editable. */
  authoritative?: {
    permitNumber?: string;
    applicantName?: string;
    applicantCompany?: string;
    jsaNumber?: string;
  };
}

const ISSUER = 'E-SET · Strategic Engineering Technologies (Pvt.) Limited';

export function PermitDocumentV2({ permitType, definition, values, mode, onChange, authoritative }: Props) {
  const set = (key: string, value: unknown) => onChange?.({ ...values, [key]: value });
  const nested = (key: string): Record<string, unknown> => (values[key] as Record<string, unknown>) ?? {};
  const setNested = (key: string, field: string, value: unknown) =>
    set(key, { ...nested(key), [field]: value });

  const sections = (values.sections as Record<string, ChecklistAnswers>) ?? {};
  const setSection = (id: string, answers: ChecklistAnswers) =>
    set('sections', { ...sections, [id]: answers });

  const text = (key: string): string => (typeof values[key] === 'string' ? (values[key] as string) : '');
  const nestedText = (key: string, field: string): string => {
    const value = nested(key)[field];
    return typeof value === 'string' ? value : '';
  };

  return (
    <article className="doc" data-testid={`permit-document-${permitType}`}>
      <DocumentMasthead issuer={ISSUER} title={definition.title} reference={definition.formReference} />

      {/* The authoritative identity band every printed form carries. Displayed, never editable. */}
      <DocSection title="Permit Issue" printedNumber={permitType === 'WTG_WORK' ? '1' : null}>
        <FieldRow>
          <DocField label="Permit No." value={authoritative?.permitNumber ?? ''} mode={mode} authoritative />
          <DocField label="Applicant" value={authoritative?.applicantName ?? ''} mode={mode} authoritative />
          <DocField label="Company" value={authoritative?.applicantCompany ?? ''} mode={mode} authoritative />
          <DocField label="JSA No." value={authoritative?.jsaNumber ?? ''} mode={mode} authoritative />
        </FieldRow>

        {permitType === 'WTG_WORK' ? (
          <FieldRow>
            <DocField
              label="Wind Farm Name"
              value={nestedText('permitIssue', 'windFarmName')}
              mode={mode}
              onChange={(next) => setNested('permitIssue', 'windFarmName', next)}
            />
            <DocField
              label="WTG Number"
              value={nestedText('permitIssue', 'wtgNumber')}
              mode={mode}
              onChange={(next) => setNested('permitIssue', 'wtgNumber', next)}
            />
            <DocField
              label="Description of Work"
              value={nestedText('permitIssue', 'descriptionOfWork')}
              mode={mode}
              multiline
              full
              onChange={(next) => setNested('permitIssue', 'descriptionOfWork', next)}
            />
            <DocField
              label="Permit Starts"
              value={nestedText('permitIssue', 'permitStartAt')}
              mode={mode}
              type="datetime-local"
              onChange={(next) => setNested('permitIssue', 'permitStartAt', next)}
            />
            <DocField
              label="Permit Expires"
              value={nestedText('permitIssue', 'permitExpiryAt')}
              mode={mode}
              type="datetime-local"
              onChange={(next) => setNested('permitIssue', 'permitExpiryAt', next)}
            />
          </FieldRow>
        ) : (
          <FieldRow>
            <DocField
              label="Equipment"
              value={nestedText('workWindow', 'equipment')}
              mode={mode}
              onChange={(next) => setNested('workWindow', 'equipment', next)}
            />
            <DocField
              label="Area"
              value={nestedText('workWindow', 'area')}
              mode={mode}
              onChange={(next) => setNested('workWindow', 'area', next)}
            />
            <DocField
              label="From (hours)"
              value={nestedText('workWindow', 'fromHours')}
              mode={mode}
              type="time"
              onChange={(next) => setNested('workWindow', 'fromHours', next)}
            />
            <DocField
              label="To (hours)"
              value={nestedText('workWindow', 'toHours')}
              mode={mode}
              type="time"
              onChange={(next) => setNested('workWindow', 'toHours', next)}
            />
            <DocField
              label="Extended to"
              value={nestedText('workWindow', 'extendedTo')}
              mode={mode}
              type="time"
              onChange={(next) => setNested('workWindow', 'extendedTo', next)}
            />
          </FieldRow>
        )}
      </DocSection>

      {/* 008A/B/C print these two bands before the checklists. */}
      {definition.natureOfWork ? (
        <DocSection title={definition.natureOfWork.title}>
          <SelectionBand
            section={definition.natureOfWork}
            values={(values.natureOfWork as SelectionValues) ?? {}}
            mode={mode}
            onChange={(next) => set('natureOfWork', next)}
            columns={3}
          />
        </DocSection>
      ) : null}

      {definition.typeOfHazard ? (
        <DocSection title={definition.typeOfHazard.title}>
          <SelectionBand
            section={definition.typeOfHazard}
            values={(values.typeOfHazard as SelectionValues) ?? {}}
            mode={mode}
            onChange={(next) => set('typeOfHazard', next)}
            columns={3}
          />
          {definition.combustionSubTicks ? (
            <SelectionBand
              section={{
                id: 'combustion_sub_ticks',
                title: 'Combustion & spark producing hazard',
                printedNumber: null,
                hasOther: false,
                options: definition.combustionSubTicks,
              }}
              values={(values.combustionSubTicks as SelectionValues) ?? {}}
              mode={mode}
              onChange={(next) => set('combustionSubTicks', next)}
              columns={5}
            />
          ) : null}
        </DocSection>
      ) : null}

      {/* Every printed checklist band, in catalogue order. */}
      {definition.checklistSections.map((section) => (
        <DocSection key={section.id} title={section.title} printedNumber={section.printedNumber}>
          <ChecklistBand
            section={section}
            answers={sections[section.id] ?? {}}
            mode={mode}
            onChange={(answers) => setSection(section.id, answers)}
          />
        </DocSection>
      ))}

      {/* WTG's Yes/No-only isolation band. */}
      {definition.isolationPoints ? (
        <DocSection title={definition.isolationPoints.title}>
          <ChecklistBand
            section={definition.isolationPoints}
            answers={(values.isolationPoints as ChecklistAnswers) ?? {}}
            mode={mode}
            onChange={(answers) => set('isolationPoints', answers)}
          />
        </DocSection>
      ) : null}

      {/* Confined Space's printed gas-test record. */}
      {definition.gasTestRecord ? (
        <DocSection title="Gas Test Record">
          <div className="doc__scroll">
            <table className="doc__table" data-testid="gas-test-record">
              <thead>
                <tr>
                  {definition.gasTestRecord.columns.map((column) => (
                    <th scope="col" key={column.id}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {definition.gasTestRecord.rows.map((row) => {
                  const record = (values.gasTestRecord as Record<string, Record<string, string>>) ?? {};
                  const cells = record[row] ?? {};
                  return (
                    <tr key={row}>
                      <th scope="row">{row}</th>
                      <td>
                        <DocField
                          label={`Test ${row} reading and time`}
                          value={cells.oxygenAndTime ?? ''}
                          mode={mode}
                          hideLabel
                          onChange={(next) =>
                            set('gasTestRecord', { ...record, [row]: { ...cells, oxygenAndTime: next } })
                          }
                        />
                      </td>
                      <td>
                        <DocField
                          label={`Test ${row} tested by`}
                          value={cells.testedBy ?? ''}
                          mode={mode}
                          hideLabel
                          onChange={(next) =>
                            set('gasTestRecord', { ...record, [row]: { ...cells, testedBy: next } })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DocSection>
      ) : null}

      {/* WTG prints PPE as its own numbered section. */}
      {definition.ppe ? (
        <DocSection title={definition.ppe.title} printedNumber={definition.ppe.printedNumber}>
          <SelectionBand
            section={definition.ppe}
            values={(values.ppe as SelectionValues) ?? {}}
            mode={mode}
            onChange={(next) => set('ppe', next)}
            columns={3}
          />
        </DocSection>
      ) : null}

      {definition.slogan ? <p className="doc__slogan">{definition.slogan}</p> : null}

      {/* The free-text bands the 008 forms print beneath the checklists. */}
      {permitType !== 'WTG_WORK' ? (
        <DocSection title="Precautions and References">
          <FieldRow>
            <DocField
              label="Special Precautions"
              value={text('specialPrecautions')}
              mode={mode}
              multiline
              full
              onChange={(next) => set('specialPrecautions', next)}
            />
            <DocField
              label="Special Instructions"
              value={text('specialInstructions')}
              mode={mode}
              multiline
              full
              onChange={(next) => set('specialInstructions', next)}
            />
            {permitType === 'HOT_WORK' ? (
              <DocField
                label="Fire Watch"
                value={text('fireWatch')}
                mode={mode}
                onChange={(next) => set('fireWatch', next)}
              />
            ) : null}
            {permitType === 'CONFINED_SPACE_ENTRY' ? (
              <>
                <DocField
                  label="Attendant"
                  value={text('attendant')}
                  mode={mode}
                  onChange={(next) => set('attendant', next)}
                />
                <DocField
                  label="Cold / Hot Permit No. (if any)"
                  value={text('relatedPermitRef')}
                  mode={mode}
                  onChange={(next) => set('relatedPermitRef', next)}
                />
              </>
            ) : (
              <DocField
                label="Confined Space Permit No. (if any)"
                value={text('confinedSpacePermitRef')}
                mode={mode}
                onChange={(next) => set('confinedSpacePermitRef', next)}
              />
            )}
            <DocField
              label="Lockout / Tagout No."
              value={text('lotoNumber')}
              mode={mode}
              onChange={(next) => set('lotoNumber', next)}
            />
          </FieldRow>
        </DocSection>
      ) : null}

      {/* Authorization. Always read-only: these identities are server-derived at action time. */}
      {isStatementBands(definition.authorizationBands) ? (
        definition.authorizationBands.map((band) => (
          <AuthorizationBand key={band.id} title={band.statement} signatories={band.signatories} />
        ))
      ) : (
        <AuthorizationBand title="Authorization" signatories={definition.authorizationBands} />
      )}

      {permitType !== 'WTG_WORK' ? (
        <DocSection title="Evacuation">
          <FieldRow>
            <DocField
              label="Evacuation completed — remarks"
              value={nestedText('evacuation', 'completedRemarks')}
              mode={mode}
              onChange={(next) => setNested('evacuation', 'completedRemarks', next)}
            />
            <DocField
              label="Evacuation acknowledged at (hours)"
              value={nestedText('evacuation', 'acknowledgedAtHours')}
              mode={mode}
              type="time"
              onChange={(next) => setNested('evacuation', 'acknowledgedAtHours', next)}
            />
            <DocField
              label="Evacuation acknowledged — remarks"
              value={nestedText('evacuation', 'acknowledgedRemarks')}
              mode={mode}
              onChange={(next) => setNested('evacuation', 'acknowledgedRemarks', next)}
            />
          </FieldRow>
        </DocSection>
      ) : null}

      <p className="doc__footer">{definition.distributionFooter}</p>
    </article>
  );
}
