/**
 * THE AUTHORITATIVE PERMIT / JSA CATALOGUE.
 *
 * Every fixed question, option, hazard and PPE choice printed on the four
 * operational permits and the two-page JSA, transcribed verbatim from the
 * forms supplied by the operator:
 *
 *   docs/reference-forms/wtg-work-permit.png
 *   docs/reference-forms/cold-work-permit.png            E-SET-ZPL-F-008A
 *   docs/reference-forms/hot-work-permit.png             E-SET-ZPL-F-008C
 *   docs/reference-forms/confined-space-entry-permit.png E-SET-ZPL-F-008B
 *   docs/reference-forms/jsa-v1.png                      E-SET-ZPL-F-009 Rev 0
 *
 * THIS FILE IS THE ONLY PLACE THIS WORDING LIVES. The Zod contract, the
 * read-only document renderer, the PDF renderer and the editor all read
 * it, so a safety question cannot say one thing on screen and another on
 * the issued document. Nothing here may be paraphrased, re-ordered,
 * "tidied", or modernised: `label` is the printed text, including its
 * original capitalisation and its typos (`LABEING`, `CONTINOUS`,
 * `equipment's`, `Are working are`), because the issued permit must
 * reproduce the operational form and not an improved version of it.
 *
 * Three readings were confirmed by the operator before transcription:
 *   - WTG 2(g) is "Has JSA been carried out for this activity?" (not 15A)
 *   - Hot Work Nature of Work has exactly FOUR options (no Inspection)
 *   - Hot Work General Requirements 2 is "METAL THICKNESS FOR WELDING"
 *
 * `id` is a stable machine key that is NEVER shown to anyone. It exists so
 * a stored answer keeps its meaning even if a future reprint corrects a
 * typo in the printed text; ids must not be renumbered or reused.
 */

/** The tick columns a printed band actually offers. */
export type ResponseDomain = 'YES_NO_NA' | 'YES_NO';

export interface CatalogueItem {
  /** Stable machine key. Never displayed. Never reused. */
  readonly id: string;
  /** The printed text, verbatim - typos and capitalisation included. */
  readonly label: string;
}

export interface ChecklistSection {
  readonly id: string;
  /** The printed section heading, verbatim. */
  readonly title: string;
  /** The printed section number where the form shows one ("2", "3", ...). */
  readonly printedNumber?: string;
  readonly responses: ResponseDomain;
  readonly items: readonly CatalogueItem[];
}

export interface SelectionSection {
  readonly id: string;
  readonly title: string;
  readonly printedNumber?: string;
  /** Whether the printed band ends with a free-text "Other(s)" line. */
  readonly hasOther: boolean;
  readonly options: readonly CatalogueItem[];
}

// =====================================================================
// WTG WORK PERMIT - "Permit to Work on WTG's / Wind Turbine Works"
// =====================================================================

export const WTG_WORK_CHECKLIST_SECTIONS: readonly ChecklistSection[] = [
  {
    id: 'general_work',
    printedNumber: '2',
    title: 'GENERAL WORK',
    responses: 'YES_NO_NA',
    items: [
      { id: 'a', label: 'Risk Assessment & safe system of work document & workers aware of/trained in findings?' },
      { id: 'b', label: 'Those undertaking the work have appropriate competence & experience?' },
      { id: 'c', label: 'Loss of service has been approved by site management?' },
      { id: 'd', label: 'Are safety warning signs clearly displayed at the work location?' },
      { id: 'e', label: 'Is suitable rescue equipment in place & certified for use?' },
      { id: 'f', label: 'Are radios required or communication strategy known?' },
      // Confirmed by the operator: JSA, not "15A".
      { id: 'g', label: 'Has JSA been carried out for this activity?' },
      { id: 'h', label: "Are tools and work equipment's suitable for the work activity?" },
      { id: 'i', label: 'Aware with "work in and around the WTG"?' },
    ],
  },
  {
    id: 'electrical_work',
    printedNumber: '3',
    title: 'ELECTRICAL WORK',
    responses: 'YES_NO_NA',
    items: [
      { id: 'a', label: 'Equipment isolated from all source of supply?' },
      { id: 'b', label: 'Has all stored energy been completely isolated?' },
      { id: 'c', label: 'Is Lock out Tag out (LOTO) required?' },
    ],
  },
  {
    id: 'mechanical_work',
    printedNumber: '4',
    title: 'MECHANICAL WORK',
    responses: 'YES_NO_NA',
    items: [
      { id: 'a', label: 'All rotating/equipment properly guarded?' },
      { id: 'b', label: 'Is Lock out Tag out (LOTO) Required?' },
    ],
  },
  {
    id: 'hydraulic_work',
    printedNumber: '5',
    title: 'HYDRAULIC WORK',
    responses: 'YES_NO_NA',
    items: [
      { id: 'a', label: 'Are warning signs displayed where parts of the system remain pressurized?' },
      { id: 'b', label: 'Has all stored energy been completely dissipated?' },
    ],
  },
  {
    id: 'work_at_heights',
    printedNumber: '6',
    title: 'WORK AT HEIGHTS',
    responses: 'YES_NO_NA',
    items: [
      { id: 'a', label: 'Are working are suitably trained and competent to use access equipment or fall arrest equipment involved?' },
      { id: 'b', label: "Are control measures and protective equipment's including PPE inspected for the work activity?" },
      { id: 'c', label: 'Is Hazard regarding high wind speed known according to task?' },
    ],
  },
  {
    id: 'specific_safety_requirements',
    title: 'Specific Safety requirement before commencing work',
    responses: 'YES_NO_NA',
    items: [
      { id: 'a', label: 'WTG needs to be stopped?' },
      { id: 'b', label: 'Is Man on Turbine (MOT) applied?' },
      { id: 'c', label: 'Is MV disconnection required?' },
    ],
  },
] as const;

/**
 * Detail of Isolation Points. Printed as two side-by-side columns (a-e,
 * f-j) with only Yes and No columns - this band has no N/A on the form.
 */
export const WTG_ISOLATION_POINTS: ChecklistSection = {
  id: 'isolation_points',
  title: 'Detail of Isolation Points',
  responses: 'YES_NO',
  items: [
    { id: 'a', label: 'Bottom box isolation' },
    { id: 'b', label: 'Top box isolation' },
    { id: 'c', label: 'Trafo box isolation' },
    { id: 'd', label: 'Hub isolation' },
    { id: 'e', label: 'Hydraulic Station isolation?' },
    { id: 'f', label: 'Gear oil filter isolation' },
    { id: 'g', label: 'Generator cooling system isolation' },
    { id: 'h', label: 'converter cooling system isolation' },
    { id: 'i', label: 'overhead crane isolation' },
    { id: 'j', label: 'transformer isolation' },
  ],
} as const;

/**
 * The PPE band, printed with an icon beside each choice. Shared verbatim
 * with JSA page 2's "PPE required for this job", which prints the same
 * eleven choices in the same order plus the same Other(s) line.
 */
const PPE_ICON_BAND: readonly CatalogueItem[] = [
  { id: 'fall_protection', label: 'Fall Protection' },
  { id: 'full_suit', label: 'Full Suit' },
  { id: 'electrical', label: 'Electrical' },
  { id: 'dust_respirator', label: 'Dust respirator' },
  { id: 'vapor_respirator', label: 'Vapor respirator' },
  { id: 'hardhat', label: 'Hardhat' },
  { id: 'safety_glasses', label: 'Safety glasses' },
  { id: 'face_shield', label: 'Face Shield' },
  { id: 'boots', label: 'Boots' },
  { id: 'ear_protection', label: 'Ear protection' },
  { id: 'gloves', label: 'Gloves' },
] as const;

export const WTG_PPE_REQUIRED: SelectionSection = {
  id: 'ppe',
  printedNumber: '7',
  title: 'PPE REQUIRED',
  hasOther: true,
  options: PPE_ICON_BAND,
} as const;

/** The signature bands printed at the foot of the WTG permit, in order. */
export const WTG_AUTHORIZATION_BANDS: readonly CatalogueItem[] = [
  { id: 'permit_issuer', label: 'PERMIT ISSUER' },
  { id: 'permit_receipt', label: 'PERMIT RECEIPT' },
  { id: 'extension_of_permit', label: 'EXTENSION OF PERMIT' },
  { id: 'permit_closed', label: 'PERMIT CLOSED' },
] as const;

// =====================================================================
// Bands shared verbatim by COLD WORK, HOT WORK and CONFINED SPACE ENTRY
// =====================================================================
//
// These three forms are the same printed family (E-SET-ZPL-F-008A/B/C).
// Where a band is genuinely identical across them it is defined once
// here; where it differs - and it often does - each permit declares its
// own below. Nothing is shared merely because it looks similar.

/** Printed identically on all three of 008A/B/C, Yes/No only. */
const SHARED_EQUIPMENT_CONDITION: readonly CatalogueItem[] = [
  { id: '1', label: 'EQUIPMENT OUT OF SERVICE' },
  { id: '2', label: 'LOCKOUT / TAGOUT COMPLETED' },
  { id: '3', label: 'ALL VALVES  BLOCKED / BLINDED' },
  { id: '4', label: 'EQUIPMENT DEPRESSURISED' },
  { id: '5', label: 'EQUIPMENT DRAINED' },
  { id: '6', label: 'EQUIPMENT EARTHED' },
  { id: '7', label: 'UNEXPECTED HAZARD' },
  { id: '8', label: 'MANUAL STOP OF WTG APPLIED' },
  { id: '9', label: 'EQUIPMENT LAST CONTAINED' },
  { id: '10', label: 'OTHERS' },
] as const;

/** Printed identically on all three of 008A/B/C, Yes/No only. */
const SHARED_PROTECTIVE_EQUIPMENT: readonly CatalogueItem[] = [
  { id: '1', label: 'FALL PROTECTION' },
  { id: '2', label: 'SAFETY GLASSES' },
  { id: '3', label: 'HARDHAT' },
  { id: '4', label: 'SAFETY SHOES' },
  { id: '5', label: 'HEARING PROTECTION' },
  { id: '6', label: 'CHEMICAL GLOVES' },
  { id: '7', label: 'CHEMICAL SUIT' },
  { id: '8', label: 'CHEMICAL BOOTS' },
  { id: '9', label: 'GLOVES' },
  { id: '10', label: 'DUST RESPIRATOR' },
  { id: '11', label: 'OTHERS' },
] as const;

/**
 * The "COMBUSTION & SPARK PRODUCING HAZARD" sub-ticks, printed inside the
 * Type of Hazard band on Hot Work and Confined Space Entry only. Cold
 * Work does not print this band at all.
 */
const COMBUSTION_SUB_TICKS: readonly CatalogueItem[] = [
  { id: 'welding', label: 'WELDING' },
  { id: 'cutting', label: 'CUTTING' },
  { id: 'brazing', label: 'BRAZING' },
  { id: 'grinding', label: 'GRINDING' },
  { id: 'drilling', label: 'DRILLING' },
] as const;

// =====================================================================
// COLD WORK PERMIT (E-SET-ZPL-F-008A)
// =====================================================================

export const COLD_WORK_NATURE_OF_WORK: SelectionSection = {
  id: 'nature_of_work',
  title: 'NATURE OF WORK',
  hasOther: false,
  options: [
    { id: 'mechanical', label: 'MECHANICAL WORK' },
    { id: 'e_and_i', label: 'E&I WORK' },
    { id: 'civil', label: 'CIVIL WORK' },
    { id: 'chemical', label: 'CHEMICAL WORK' },
    { id: 'inspection', label: 'INSPECTION' },
  ],
} as const;

export const COLD_WORK_TYPE_OF_HAZARD: SelectionSection = {
  id: 'type_of_hazard',
  title: 'TYPE OF HAZARD',
  hasOther: false,
  options: [
    { id: 'energized', label: 'ENERGIZED WORK' },
    { id: 'fall', label: 'FALL HAZARD' },
    { id: 'respiratory', label: 'RESPIRATORY HAZARD' },
    { id: 'chemical', label: 'CHEMICAL HAZARD' },
  ],
} as const;

export const COLD_WORK_CHECKLIST_SECTIONS: readonly ChecklistSection[] = [
  {
    id: 'general_requirements',
    title: 'GENERAL REQUIREMENTS',
    responses: 'YES_NO',
    items: [
      { id: '1', label: 'AREA/EQUIPMENT/LINE READY' },
      { id: '2', label: 'SITE SPECIFIC HAZARD EXPLAINED' },
      { id: '3', label: 'EMERGENCY EGRESS PLANNED' },
      // Printed spelling. Not corrected to "LABELLING".
      { id: '4', label: 'CONTAINERS LABEING O.K.' },
      { id: '5', label: 'MSDS INFORMATION AVAILABLE' },
      { id: '6', label: 'ANY SOURCE OF HEAT/SPARK INVOLVED' },
    ],
  },
  { id: 'equipment_condition', title: 'EQUIPMENT CONDITION', responses: 'YES_NO', items: SHARED_EQUIPMENT_CONDITION },
  { id: 'protective_equipment', title: 'PROTECTIVE EQUIPMENT REQUIRED', responses: 'YES_NO', items: SHARED_PROTECTIVE_EQUIPMENT },
] as const;

/** The slogan printed in the Cold Work General Requirements column. */
export const COLD_WORK_SLOGAN = 'PERMIT SAVE LIVE - GIVE THEM THE PROPER ATTENTION';

// =====================================================================
// HOT WORK PERMIT (E-SET-ZPL-F-008C)
// =====================================================================

/**
 * FOUR options - confirmed by the operator. Hot Work does NOT print the
 * INSPECTION option that Cold Work carries.
 */
export const HOT_WORK_NATURE_OF_WORK: SelectionSection = {
  id: 'nature_of_work',
  title: 'NATURE OF WORK',
  hasOther: false,
  options: [
    { id: 'mechanical', label: 'MECHANICAL WORK' },
    { id: 'e_and_i', label: 'E&I WORK' },
    { id: 'civil', label: 'CIVIL WORK' },
    { id: 'chemical', label: 'CHEMICAL WORK' },
  ],
} as const;

export const HOT_WORK_TYPE_OF_HAZARD: SelectionSection = {
  id: 'type_of_hazard',
  title: 'TYPE OF HAZARD',
  hasOther: false,
  options: [
    { id: 'combustion_and_spark', label: 'COMBUSTION & SPARK PRODUCING HAZARD' },
    { id: 'energised_eqpt', label: 'ENERGISED EQPT HAZARD' },
    { id: 'fall', label: 'FALL HAZARD' },
    { id: 'respiratory', label: 'RESPIRATORY HAZARD' },
    { id: 'chemical', label: 'CHEMICAL HAZARD' },
  ],
} as const;

export const HOT_WORK_COMBUSTION_SUB_TICKS = COMBUSTION_SUB_TICKS;

export const HOT_WORK_CHECKLIST_SECTIONS: readonly ChecklistSection[] = [
  {
    id: 'general_requirements',
    title: 'GENERAL REQUIREMENTS',
    responses: 'YES_NO',
    items: [
      { id: '1', label: 'AREA/EQUIPMENT/LINE READY' },
      // Confirmed by the operator.
      { id: '2', label: 'METAL THICKNESS FOR WELDING' },
      { id: '3', label: 'SEWERS COVERED' },
      { id: '4', label: 'SITE SPECIFIC HAZARD EXPLAINED' },
      { id: '5', label: 'EMERGENCY EGRESS PLANNED' },
      { id: '6', label: 'FIRE WATCH READY' },
      { id: '7', label: 'FIRE EXTINGUISHER NEARBY' },
      { id: '8', label: 'MSDS INFORMATION AVAILABLE' },
    ],
  },
  { id: 'equipment_condition', title: 'EQUIPMENT CONDITION', responses: 'YES_NO', items: SHARED_EQUIPMENT_CONDITION },
  { id: 'protective_equipment', title: 'PROTECTIVE EQUIPMENT REQUIRED', responses: 'YES_NO', items: SHARED_PROTECTIVE_EQUIPMENT },
] as const;

/** The banner printed in the Hot Work General Requirements column. */
export const HOT_WORK_SLOGAN = 'PERMIT VOID IF CONDITIONS CHANGED';

// =====================================================================
// CONFINED SPACE ENTRY PERMIT (E-SET-ZPL-F-008B)
// =====================================================================

/** SEVEN options - this form adds HOT WORK and COLD WORK ahead of the rest. */
export const CONFINED_SPACE_NATURE_OF_WORK: SelectionSection = {
  id: 'nature_of_work',
  title: 'NATURE OF WORK',
  hasOther: false,
  options: [
    { id: 'hot_work', label: 'HOT WORK' },
    { id: 'cold_work', label: 'COLD WORK' },
    { id: 'mechanical', label: 'MECHANICAL WORK' },
    { id: 'e_and_i', label: 'E&I WORK' },
    { id: 'civil', label: 'CIVIL WORK' },
    { id: 'chemical', label: 'CHEMICAL WORK' },
    { id: 'inspection', label: 'INSPECTION' },
  ],
} as const;

export const CONFINED_SPACE_TYPE_OF_HAZARD: SelectionSection = {
  id: 'type_of_hazard',
  title: 'TYPE OF HAZARD',
  hasOther: false,
  options: [
    { id: 'combustion_and_spark', label: 'COMBUSTION & SPARK PRODUCING HAZARD' },
    { id: 'energised_eqpt', label: 'ENERGISED EQPT HAZARD' },
    { id: 'fall', label: 'FALL HAZARD' },
    { id: 'respiratory', label: 'RESPIRATORY HAZARD' },
    { id: 'chemical', label: 'CHEMICAL HAZARD' },
  ],
} as const;

export const CONFINED_SPACE_COMBUSTION_SUB_TICKS = COMBUSTION_SUB_TICKS;

export const CONFINED_SPACE_CHECKLIST_SECTIONS: readonly ChecklistSection[] = [
  {
    id: 'gas_test',
    title: 'GAS TEST',
    responses: 'YES_NO',
    items: [
      { id: '1', label: 'GAS TEST CONDUCTED' },
      { id: '2', label: 'INSTRUMENT USED' },
      { id: '3', label: 'INSTRUMENT CALIBRATED' },
      { id: '4', label: 'GAS RETEST REQUIRED' },
      // Printed spelling. Not corrected to "CONTINUOUS".
      { id: '5', label: 'CONTINOUS MONITORING' },
    ],
  },
  {
    id: 'general_requirements',
    title: 'GENERAL REQUIREMENTS',
    responses: 'YES_NO',
    items: [
      { id: '1', label: 'PREPARATIONS SATISFACTORY' },
      { id: '2', label: 'ADEQUATE LIGHT' },
      { id: '3', label: 'PROPER VENTILATION' },
      { id: '4', label: 'TEMPERATURE NORMAL' },
      { id: '5', label: 'WARNING SIGNS POSTED' },
      { id: '6', label: 'SITE SPECIFIC HAZARD EXPLAINED' },
      { id: '7', label: 'EMERGENCY EGRESS PLANNED' },
      { id: '8', label: 'ATTENDANT READY' },
      { id: '9', label: 'ENTRANTS RECORD MAINTAINED' },
      { id: '10', label: 'COMMUNICATION' },
      { id: '11', label: 'OTHERS' },
    ],
  },
  { id: 'protective_equipment', title: 'PROTECTIVE EQUIPMENT REQUIRED', responses: 'YES_NO', items: SHARED_PROTECTIVE_EQUIPMENT },
] as const;

/**
 * The gas-test record printed beneath the GAS TEST band: three numbered
 * rows, each carrying a reading against the printed O2 range and a
 * signature.
 */
export const CONFINED_SPACE_GAS_TEST_TABLE = {
  columns: [
    { id: 'test_no', label: 'TEST NO.' },
    { id: 'o2_and_time', label: '02 (19.5-23.5%) & TIME' },
    { id: 'signature', label: 'SIGNATURE' },
  ],
  rows: ['1', '2', '3'],
} as const;

/** The banner printed beneath the Confined Space gas-test band. */
export const CONFINED_SPACE_SLOGAN = 'EVACUATE IMMEDIATELY IF CONDITIONS CHANGED';

/**
 * The three authorization bands printed at the foot of 008A/B/C, in the
 * order they appear, with the statement each one signs off.
 */
export const PERMIT_008_AUTHORIZATION_BANDS = [
  {
    id: 'inspected_safe_to_work',
    statement: 'INSPECTED/DISCUSSED WORK AREA, JOB PREPARATIONS ARE COMPLETE AND IT IS SAFE TO WORK',
    signatories: [
      { id: 'issuing_auth_person', label: 'ISSUING AUTH PERSON' },
      { id: 'extend_auth_person', label: 'EXTEND AUTH PERSON' },
    ],
  },
  {
    id: 'instructed_the_crew',
    statement: 'INSPECTED / DISCUSSED WORK AREA, UNDERSTOOD THE INSTRUCTIONS AND INSTRUCTED THE CREW',
    signatories: [{ id: 'maintenance_auth_person', label: 'MAINTENANCE AUTH PERSON' }],
  },
  {
    id: 'evacuation',
    statement: 'EVACUATION COMPLETED',
    signatories: [
      { id: 'maint_auth_person', label: 'MAINT. AUTH PERSON' },
      { id: 'issuing_auth_person_evacuation', label: 'ISSUING AUTH PERSON' },
    ],
  },
] as const;

// =====================================================================
// JSA PAGE 1 OF 2 (E-SET-ZPL-F-009 Rev 0)
// =====================================================================

/** "Are any working permits required for this job?" - the printed tick list. */
export const JSA_REQUIRED_PERMITS: SelectionSection = {
  id: 'required_permits',
  title: 'Are any working permits required for this job?',
  hasOther: true,
  options: [
    { id: 'eew', label: 'Energized Electrical Work (EEW)' },
    { id: 'switching_authorization', label: 'Switching Authorization' },
    { id: 'confined_space_entry', label: 'Confined Space Entry' },
    { id: 'ground_disturbance', label: 'Ground Disturbance' },
    { id: 'simops', label: 'Simultaneous Operations (SIMOPS)' },
    { id: 'major_equipment_movement', label: 'Major Equipment Movement' },
    { id: 'lifting_operations', label: 'Lifting Operations' },
    { id: 'hot_work', label: 'Hot Work' },
  ],
} as const;

/** The instruction printed directly beneath the HSE CHECKLIST heading. */
export const JSA_HSE_CHECKLIST_INSTRUCTION =
  'Discuss with your team the following list and tick the applicable items. Provide details in the section "Task Analysis".';

/**
 * THE HSE CHECKLIST: sixteen printed categories, in the order they appear
 * reading down the three printed columns (column 1 top-to-bottom, then
 * column 2, then column 3). Every item is a tick - the form offers no
 * Yes/No/N/A columns here.
 */
export const JSA_HSE_CHECKLIST_CATEGORIES: readonly SelectionSection[] = [
  {
    id: 'ergonomic',
    title: 'Ergonomic',
    hasOther: false,
    options: [
      { id: '1', label: 'Manual handling required' },
      { id: '2', label: 'Excessive twisting of back, neck, or wrist' },
      { id: '3', label: 'Working with hands above shoulders.' },
      { id: '4', label: 'Lifting, lowering or carrying heavy loads' },
      { id: '5', label: 'Carrying with one hand/side of the body' },
      { id: '6', label: 'Applying uneven, fast or irregular forces' },
      { id: '7', label: 'Squatting, kneeling, crawling required' },
      { id: '8', label: 'Fingers working close or wide apart' },
      { id: '9', label: 'Awkward grips - No secure gripping' },
    ],
  },
  {
    id: 'driving_motorized_equipment',
    title: 'Driving/Motorized Equipment',
    hasOther: false,
    options: [
      { id: '1', label: 'Discuss condition of the road or route' },
      { id: '2', label: 'Vehicle pre-use inspection needed?' },
      { id: '3', label: 'Spotter required?' },
      { id: '4', label: 'All loads secured?' },
      { id: '5', label: 'Driving over underground piping/lines' },
    ],
  },
  {
    id: 'electrical',
    title: 'Electrical',
    hasOther: false,
    options: [
      { id: '1', label: 'Contact with energized parts possible?' },
      { id: '2', label: 'Contact with overhead/underground lines' },
      { id: '3', label: 'Explosion or fire of electrical components' },
      { id: '4', label: 'Unauthorized access to electrical systems' },
      { id: '5', label: 'Non-isolated electrical components' },
      { id: '6', label: 'Induced static voltage potential' },
      { id: '7', label: 'Earthing/Grounding/bounding required?' },
      { id: '8', label: 'GFCI/RCD for electric power tools?' },
    ],
  },
  {
    id: 'hot_work_welding',
    title: 'Hot Work/Welding',
    hasOther: false,
    options: [
      { id: '1', label: 'Combustible/LEL monitored?' },
      { id: '2', label: 'Fire extinguisher/equipment at job site' },
      { id: '3', label: '02 detector needed?' },
      { id: '4', label: 'Ventilation concerns?' },
      { id: '5', label: 'Welding/X-ray (secured area off?)' },
      { id: '6', label: 'Hot work near drains, sumps(flammable)' },
      { id: '7', label: 'Cold cut, cutting torch, electric saw' },
      { id: '8', label: 'Ground rod for welding machine' },
      { id: '9', label: 'Hot tap, welding and pressure check' },
    ],
  },
  {
    id: 'environmental_biological_human',
    title: 'Environmental, Biological and Human',
    hasOther: false,
    options: [
      { id: '1', label: 'Spill mitigation or containment plan?' },
      { id: '2', label: 'Chemicals in use? MSDS reviewed?' },
      { id: '3', label: 'Odorless fumes present?' },
      { id: '4', label: 'Air borne contaminants (dust, fibers)' },
      { id: '5', label: 'Waste disposal permits/plan?' },
      { id: '6', label: 'Exposure to dangerous animals' },
      { id: '7', label: 'Exposure to toxic natural substances' },
      { id: '8', label: 'Exposure to infectious substances' },
      { id: '9', label: 'Assault by another person' },
    ],
  },
  {
    id: 'workplace_area_and_design',
    title: 'Workplace Area and Design',
    hasOther: false,
    options: [
      { id: '1', label: 'Poor housekeeping, spillages or wastes' },
      { id: '2', label: 'Uneven/slippery work surfaces or gaps' },
      { id: '3', label: 'Dropped/Falling objects possible' },
      { id: '4', label: 'Are others working overhead/below?' },
      { id: '5', label: 'Moving equipment, or vehicles around.' },
      { id: '6', label: 'Pinch points for fingers/hands/limbs' },
      { id: '7', label: 'Confusing/inadequate labeling of controls' },
      { id: '8', label: 'Exposure to continuous vibrations' },
      { id: '9', label: 'Lighting Too much/not enough' },
      { id: '10', label: 'Exposure to extreme cold/heat?' },
    ],
  },
  {
    id: 'organizational_arrangements',
    title: 'Organizational Arrangements',
    hasOther: false,
    options: [
      { id: '1', label: 'Chance of remote shutdown/restart?' },
      { id: '2', label: 'Chance of automatic shutdown/restart?' },
      { id: '3', label: 'Sufficient job rotation, breaks planned?' },
      { id: '4', label: 'No accompanied contractor' },
      { id: '5', label: 'New employee/Inexperienced workers' },
      { id: '6', label: 'Lack of clarity in work roles of employees' },
      { id: '7', label: 'Work related stress and burn out' },
      { id: '8', label: 'Are all workers fit for duty?(medication, sleep, distraction)' },
    ],
  },
  {
    id: 'energy_isolation',
    title: 'Energy Isolation',
    hasOther: false,
    options: [
      { id: '1', label: 'Is personnel trained to use LOTO?' },
      { id: '2', label: 'Walkthrough, discussion, LOTO verification' },
      { id: '3', label: 'Depressurized/drained (verification)' },
      { id: '4', label: 'Breaker open and locked?' },
      { id: '5', label: 'Mechanical energy released' },
      { id: '6', label: 'Purge/ventilation needed?' },
      { id: '7', label: 'LOTO checklist used and attached to JSA?' },
    ],
  },
  {
    id: 'heavy_lifting_equipment',
    title: 'Heavy Lifting Equipment',
    hasOther: false,
    options: [
      { id: '1', label: 'Is the operator certification updated?' },
      { id: '2', label: 'Daily inspection for lifting equipment' },
      { id: '3', label: 'Is the equipment swing radius clear?' },
      { id: '4', label: 'Overturn potential/restricted access area' },
      { id: '5', label: 'Banks man/spotter/signal man in place?' },
      { id: '6', label: 'Safe use of tag line for rigging' },
      { id: '7', label: 'Overhead power lines, poling' },
    ],
  },
  {
    id: 'chemical_and_toxicity',
    title: 'Chemical and Toxicity',
    hasOther: false,
    options: [
      { id: '1', label: 'Inert gas or asphyxiate gas/vaper' },
      { id: '2', label: 'Explosion or ignition of gas/vapors/liquids' },
      { id: '3', label: 'Exposure to toxic concentrations' },
      { id: '4', label: 'Atmospheres with low presence of oxygen' },
      { id: '5', label: 'Damage lines/cylinders, chemical storage' },
    ],
  },
  {
    id: 'weather_and_environmental_conditions',
    title: 'Weather and Environmental Conditions',
    hasOther: false,
    options: [
      { id: '1', label: 'Is high wind speed a concern?' },
      { id: '2', label: 'Extreme weather conditions(storm, snow)' },
      { id: '3', label: 'Fires possible? Dry grass or conditions' },
      { id: '4', label: 'Loose or unstable ground, ridges' },
      { id: '5', label: 'Flooding possible in low-lying land?' },
      { id: '6', label: 'Lightning possible with little/no notice?' },
    ],
  },
  {
    id: 'working_at_heights',
    title: 'Working at Heights',
    hasOther: false,
    options: [
      { id: '1', label: 'Adequate platform/stair/ladder/guardrail?' },
      { id: '2', label: 'Proper anchor/tie-off points identified' },
      { id: '3', label: 'Area secured (cordoned) below?' },
      { id: '4', label: 'Walking on wet, slippery, icy surfaces' },
      { id: '5', label: 'Scaffolding, inspected? Weight capacity?' },
      { id: '6', label: 'Man lift not inspected or certified' },
    ],
  },
  {
    id: 'mechanical',
    title: 'Mechanical',
    hasOther: false,
    options: [
      { id: '1', label: 'Poorly maintained/ unguarded equipment' },
      { id: '2', label: 'Entanglement in moving components?' },
      { id: '3', label: 'Unexpected movement of equipment/load' },
      { id: '4', label: 'Failure of machinery dropped loads' },
      { id: '5', label: 'Inability to slow/stop machines or vehicles' },
      { id: '6', label: 'Contact with moving, sharp or hot parts' },
      { id: '7', label: 'Persons pushed/thrown off structures' },
      { id: '8', label: 'Use of mechanical tightening tools' },
      { id: '9', label: 'Pressurized systems (chemical/air)' },
    ],
  },
  {
    id: 'ground_disturbance',
    title: 'Ground Disturbance',
    hasOther: false,
    options: [
      { id: '1', label: 'Notifications/locates completed' },
      { id: '2', label: 'Lines located/marked/drawings reviewed?' },
      { id: '3', label: 'Will this be an open excavation?' },
      { id: '4', label: 'Approved shoring/barricades' },
      { id: '5', label: 'Proper sloping defined' },
      { id: '6', label: 'Area/trench roped off (barricades)?' },
      { id: '7', label: 'Proper egress provided from trenches' },
    ],
  },
  {
    id: 'technical_processes',
    title: 'Technical/Processes',
    hasOther: false,
    options: [
      { id: '1', label: 'Has the MOC been approved for this job?' },
      { id: '2', label: 'Lacking of procedures/instructions' },
      { id: '3', label: 'Lacking or incorrect tooling' },
    ],
  },
  {
    id: 'emergency_and_communication',
    title: 'Emergency and Communication',
    hasOther: false,
    options: [
      { id: '1', label: 'Safety equipment locations known?' },
      { id: '2', label: 'Radios Supplied for use?' },
      { id: '3', label: 'Communication strategy known?' },
      { id: '4', label: 'Barricades or security required?' },
      { id: '5', label: 'Safety signs and color coding understood?' },
      { id: '6', label: 'Sufficient first-aid training/equipment?' },
      { id: '7', label: 'Sufficient emergency/rescue planning?' },
    ],
  },
] as const;

/** The reminder printed at the foot of JSA page 1. */
export const JSA_PAGE1_REMINDER =
  'REMEMBER... Everyone has the AUTHORITY to STOP any unsafe work. All injuries can be prevented.';

// =====================================================================
// JSA PAGE 2 OF 2 (E-SET-ZPL-F-009 Rev 0)
// =====================================================================

/** The two printed rows of the EMERGENCY RESPONSE contact table. */
export const JSA_EMERGENCY_CONTACTS: readonly CatalogueItem[] = [
  { id: 'radio_channel_cell_phone', label: 'Radio Channel / Cell phone' },
  { id: 'eset_emergency_response_unit', label: 'E-Set Emergency response unit' },
] as const;

/** The two Yes/No questions printed beside the emergency contact table. */
export const JSA_EMERGENCY_QUESTIONS: readonly CatalogueItem[] = [
  { id: 'erp_understood', label: 'Was the Emergency Response Plan understood and agreed prior start working?' },
  { id: 'language_concern', label: 'Is language a working team concern/behaviour?' },
] as const;

/** The five printed columns of the TASK ANALYSIS table, in order. */
export const JSA_TASK_ANALYSIS_COLUMNS: readonly CatalogueItem[] = [
  { id: 'sequence_of_tasks', label: 'Sequence of Tasks' },
  { id: 'possible_hazardous_events', label: 'Possible Hazardous Events' },
  { id: 'energy_sources', label: 'Energy Sources' },
  { id: 'triggering_events', label: 'Triggering Events to Stop the Work' },
  { id: 'protective_actions', label: 'Protective Actions/ Measures to Reduce Risk' },
] as const;

/** The energy-source legend printed beneath the Task Analysis table. */
export const JSA_ENERGY_SOURCE_LEGEND: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'M', label: 'mechanical' },
  { code: 'E', label: 'electrical' },
  { code: 'C', label: 'chemical' },
  { code: 'P', label: 'pressure' },
  { code: 'G', label: 'gravity' },
  { code: 'H', label: 'heat/cold' },
  { code: 'R', label: 'radiation' },
  { code: 'B', label: 'biological' },
] as const;

/** Printed identically to the WTG permit's PPE band, same order. */
export const JSA_PPE_REQUIRED: SelectionSection = {
  id: 'ppe',
  title: 'PPE required for this job',
  hasOther: true,
  options: PPE_ICON_BAND,
} as const;

/** The footnote printed under the Participants table. */
export const JSA_PARTICIPANT_SIGNATURE_NOTE =
  'Signature indicates that you understand and agree with JSA content';

/** The two approval signatory roles printed on page 2, in order. */
export const JSA_APPROVAL_SIGNATORIES: readonly CatalogueItem[] = [
  { id: 'job_lead', label: 'Job Lead' },
  { id: 'work_authorizer', label: 'Work Authorizer' },
] as const;

export const JSA_APPROVAL_NOTE =
  'indicates all parts involve in the work have completed, reviewed and understand the JSA';

export const JSA_CLOSE_OUT_NOTE =
  'Closure out signature indicates that the work has been completed, tools/materials are back in place and housekeeping is done.';

// =====================================================================
// Document identity, as printed in the footers
// =====================================================================

export const FORM_REFERENCES = {
  COLD_WORK: 'E-SET-ZPL-F-008A',
  CONFINED_SPACE_ENTRY: 'E-SET-ZPL-F-008B',
  HOT_WORK: 'E-SET-ZPL-F-008C',
  JSA: 'E-SET-ZPL-F-009',
} as const;

/** Printed on 008A/B/C. */
export const PERMIT_DISTRIBUTION_FOOTER =
  'DISTRIBUTION: WHITE - JOB EXECUTE: BLUE - ISSUER: YELLOW - BOOK COPY:';
