import type { JsaFormPayload } from '../../../api/types';
import { fromLocalInputValue, toLocalInputValue } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Checkbox, Input, Textarea } from '../../../ui/Field';
import { DocumentSection } from '../DocumentParts';
import { BooleanGroupEditor, ChecklistEditor, DescriptionRowsEditor, SelectionEditor } from './editors';
import '../paper.css';

/**
 * The editable Job Safety Analysis (JSA_V1) - the single shared form all
 * four permit templates use.
 *
 * A JSA is MANDATORY: a permit cannot leave DRAFT while its linked JSA
 * payload is still empty, and the database enforces that independently
 * of anything here.
 *
 * There is deliberately no "completed by" field. The JSA's completed-by
 * identity is the authenticated applicant who submits, recorded
 * server-side; a client that tried to supply one would be rejected.
 */
export function JsaFormFields({
  form,
  onChange,
  disabled,
}: {
  form: JsaFormPayload;
  onChange: (next: JsaFormPayload) => void;
  disabled: boolean;
}) {
  const patchPage1 = (changes: Partial<JsaFormPayload['page1']>): void =>
    onChange({ ...form, page1: { ...form.page1, ...changes } });
  const patchPage2 = (changes: Partial<JsaFormPayload['page2']>): void =>
    onChange({ ...form, page2: { ...form.page2, ...changes } });

  const groups = form.page1.hseChecklistGroups;

  return (
    <>
      <DocumentSection number="1" title="Job information">
        <div className="form-grid">
          <Input
            label="Site / WTG"
            required
            maxLength={200}
            value={form.page1.siteOrWtg}
            disabled={disabled}
            onChange={(event) => patchPage1({ siteOrWtg: event.target.value })}
          />
        </div>
        <Textarea
          label="Job or work"
          required
          rows={3}
          maxLength={2000}
          value={form.page1.jobOrWork}
          disabled={disabled}
          onChange={(event) => patchPage1({ jobOrWork: event.target.value })}
        />
        <BooleanGroupEditor
          label="Permits required for this job"
          disabled={disabled}
          values={form.page1.requiredPermits}
          entries={[
            { key: 'wtgWork', label: 'WTG work' },
            { key: 'coldWork', label: 'Cold work' },
            { key: 'hotWork', label: 'Hot work' },
            { key: 'confinedSpaceEntry', label: 'Confined space entry' },
          ]}
          onChange={(requiredPermits) => patchPage1({ requiredPermits })}
        />
      </DocumentSection>

      <DocumentSection
        number="2"
        title="HSE checklist"
        note="Transcribe each printed band and its items"
      >
        <ul className="repeat-list">
          {groups.map((group, index) => (
            <li key={index} className="repeat-row">
              <div className="repeat-row__head">
                <span>Checklist band {index + 1}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || groups.length <= 1}
                  onClick={() => patchPage1({ hseChecklistGroups: groups.filter((_, position) => position !== index) })}
                >
                  Remove band
                </Button>
              </div>
              <Input
                label="Band title as printed on the form"
                required
                maxLength={200}
                value={group.title}
                disabled={disabled}
                onChange={(event) =>
                  patchPage1({
                    hseChecklistGroups: groups.map((entry, position) =>
                      position === index ? { ...entry, title: event.target.value } : entry,
                    ),
                  })
                }
              />
              <ChecklistEditor
                label={group.title || `Band ${index + 1}`}
                items={group.items}
                disabled={disabled}
                itemNoun="question"
                onChange={(items) =>
                  patchPage1({
                    hseChecklistGroups: groups.map((entry, position) =>
                      position === index ? { ...entry, items } : entry,
                    ),
                  })
                }
              />
            </li>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || groups.length >= 30}
            onClick={() =>
              patchPage1({
                hseChecklistGroups: [...groups, { title: '', items: [{ label: '', response: 'NA' }] }],
              })
            }
          >
            Add checklist band
          </Button>
        </div>
      </DocumentSection>

      <DocumentSection number="3" title="Task analysis">
        <ul className="repeat-list">
          {form.page2.taskAnalysis.map((row, index) => (
            <li key={index} className="repeat-row">
              <div className="repeat-row__head">
                <span>Task {index + 1}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || form.page2.taskAnalysis.length <= 1}
                  onClick={() =>
                    patchPage2({ taskAnalysis: form.page2.taskAnalysis.filter((_, position) => position !== index) })
                  }
                >
                  Remove
                </Button>
              </div>
              <div className="form-grid">
                {(
                  [
                    ['sequenceOfTasks', 'Sequence of tasks'],
                    ['possibleHazardousEvents', 'Possible hazardous events'],
                    ['energyOrTriggeringSources', 'Energy or triggering sources'],
                    ['protectiveActionsOrMeasures', 'Protective actions or measures'],
                  ] as const
                ).map(([key, label]) => (
                  <Textarea
                    key={key}
                    label={label}
                    required
                    rows={2}
                    maxLength={1000}
                    value={row[key]}
                    disabled={disabled}
                    onChange={(event) =>
                      patchPage2({
                        taskAnalysis: form.page2.taskAnalysis.map((entry, position) =>
                          position === index ? { ...entry, [key]: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || form.page2.taskAnalysis.length >= 100}
            onClick={() =>
              patchPage2({
                taskAnalysis: [
                  ...form.page2.taskAnalysis,
                  {
                    sequenceOfTasks: '',
                    possibleHazardousEvents: '',
                    energyOrTriggeringSources: '',
                    protectiveActionsOrMeasures: '',
                  },
                ],
              })
            }
          >
            Add task
          </Button>
        </div>
      </DocumentSection>

      <DocumentSection number="4" title="Protective equipment, tools and materials">
        <SelectionEditor
          label="Personal protective equipment"
          options={form.page2.ppe}
          disabled={disabled}
          onChange={(ppe) => patchPage2({ ppe })}
        />
        <DescriptionRowsEditor
          label="Tools and materials"
          rows={form.page2.toolsAndMaterials}
          max={80}
          disabled={disabled}
          onChange={(toolsAndMaterials) => patchPage2({ toolsAndMaterials })}
        />
      </DocumentSection>

      <DocumentSection number="5" title="Crew" note="Crew on the job — not signers">
        <ul className="repeat-list">
          {form.page2.participants.map((participant, index) => (
            <li key={index} className="repeat-row">
              <div className="repeat-row__head">
                <span>Crew member {index + 1}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    patchPage2({ participants: form.page2.participants.filter((_, position) => position !== index) })
                  }
                >
                  Remove
                </Button>
              </div>
              <div className="form-grid">
                <Input
                  label="Name"
                  maxLength={200}
                  value={participant.name}
                  disabled={disabled}
                  onChange={(event) =>
                    patchPage2({
                      participants: form.page2.participants.map((entry, position) =>
                        position === index ? { ...entry, name: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <Input
                  label="Company"
                  maxLength={200}
                  value={participant.company ?? ''}
                  disabled={disabled}
                  onChange={(event) =>
                    patchPage2({
                      participants: form.page2.participants.map((entry, position) =>
                        position === index ? { ...entry, company: event.target.value } : entry,
                      ),
                    })
                  }
                />
              </div>
            </li>
          ))}
        </ul>
        <div className="row">
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || form.page2.participants.length >= 60}
            onClick={() => patchPage2({ participants: [...form.page2.participants, { name: '' }] })}
          >
            Add crew member
          </Button>
        </div>

        <ul className="repeat-list">
          {form.page2.participantAcknowledgements.map((entry, index) => (
            <li key={index} className="repeat-row">
              <div className="repeat-row__head">
                <span>Acknowledgement {index + 1}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    patchPage2({
                      participantAcknowledgements: form.page2.participantAcknowledgements.filter(
                        (_, position) => position !== index,
                      ),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
              <div className="form-grid">
                <Input
                  label="Name"
                  maxLength={200}
                  value={entry.name}
                  disabled={disabled}
                  onChange={(event) =>
                    patchPage2({
                      participantAcknowledgements: form.page2.participantAcknowledgements.map((row, position) =>
                        position === index ? { ...row, name: event.target.value } : row,
                      ),
                    })
                  }
                />
                <Input
                  label="Remarks"
                  maxLength={500}
                  value={entry.remarks ?? ''}
                  disabled={disabled}
                  onChange={(event) =>
                    patchPage2({
                      participantAcknowledgements: form.page2.participantAcknowledgements.map((row, position) =>
                        position === index ? { ...row, remarks: event.target.value } : row,
                      ),
                    })
                  }
                />
              </div>
              <Checkbox
                checked={entry.acknowledged}
                disabled={disabled}
                label="Acknowledged on the form"
                onChange={(event) =>
                  patchPage2({
                    participantAcknowledgements: form.page2.participantAcknowledgements.map((row, position) =>
                      position === index ? { ...row, acknowledged: event.target.checked } : row,
                    ),
                  })
                }
              />
            </li>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || form.page2.participantAcknowledgements.length >= 60}
            onClick={() =>
              patchPage2({
                participantAcknowledgements: [
                  ...form.page2.participantAcknowledgements,
                  { name: '', acknowledged: false },
                ],
              })
            }
          >
            Add acknowledgement
          </Button>
        </div>
        <p className="muted text-sm">
          The paper acknowledgement column is form content. Authoritative digital signatures appear on the permit.
        </p>
      </DocumentSection>

      <DocumentSection number="6" title="Emergency response, comments and close-out">
        <div className="form-grid form-grid--full">
          <Textarea
            label="Emergency response"
            rows={3}
            maxLength={4000}
            value={form.page2.emergencyResponse ?? ''}
            disabled={disabled}
            onChange={(event) => patchPage2({ emergencyResponse: event.target.value })}
          />
          <Textarea
            label="Comments"
            rows={3}
            maxLength={4000}
            value={form.page2.comments ?? ''}
            disabled={disabled}
            onChange={(event) => patchPage2({ comments: event.target.value })}
          />
        </div>
        <div className="form-grid">
          <Input
            label="Close-out completed"
            type="datetime-local"
            value={toLocalInputValue(form.page2.closeOut?.completedAt)}
            disabled={disabled}
            onChange={(event) =>
              patchPage2({
                closeOut: {
                  ...form.page2.closeOut,
                  completedAt: fromLocalInputValue(event.target.value) ?? '',
                },
              })
            }
          />
          <Input
            label="Close-out remarks"
            maxLength={2000}
            value={form.page2.closeOut?.remarks ?? ''}
            disabled={disabled}
            onChange={(event) =>
              patchPage2({ closeOut: { ...form.page2.closeOut, remarks: event.target.value } })
            }
          />
        </div>
      </DocumentSection>
    </>
  );
}
