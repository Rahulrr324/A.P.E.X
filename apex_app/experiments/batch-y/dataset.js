// Batch Y offline A/B: the synthetic evaluation dataset.
//
// Pure data, deliberately free of any import from either application tree, so the same
// scenario definitions seed the current build (condition B) and the isolated pre-Batch-X
// tree (condition A) byte-identically. Everything in here is invented for the experiment:
// no real user memory, no private information, no credentials.
//
// A step is applied through the tree's own authorized controller API with user origin,
// exactly as the CLI does; the experiment never writes a store file directly.

export const FIXED_NOW_ISO = '2026-04-04T00:00:00.000Z';

// Filler records that match a query term without answering it, used to push a real record
// outside the retrieval window.
const gateFiller = (count) => Array.from({ length: count }, (_, i) => (
  `The access code for Bay ${i + 1} dock is recorded in the Bay ${i + 1} logbook.`
));

export const SCENARIOS = [
  {
    id: '01-supported-fact',
    title: 'a supported user fact',
    question: 'who is the shift lead for warehouse 7?',
    retrievalLimit: 6,
    maxContextChars: 6000,
    steps: [
      { alias: 'lead', op: 'memory', content: 'The shift lead for Warehouse 7 is Dana Whitfield.' },
      { alias: 'unrelated', op: 'memory', content: 'The coffee machine in the Warehouse 7 break room descales monthly.' },
    ],
    stubReply: 'The shift lead for Warehouse 7 is Dana Whitfield.',
    applies: ['factPreservation', 'contextIntegrity'],
    mustShowIds: ['lead'],
    expectedDisclosure: 'none',
  },
  {
    id: '02-unevidenced-claim',
    title: 'an unevidenced claim',
    question: 'what is the vendor contract number for project meridian?',
    retrievalLimit: 6,
    maxContextChars: 6000,
    steps: [
      {
        alias: 'contract',
        op: 'knowledge',
        subject: 'Project Meridian',
        relationship: 'vendor_contract_number',
        object: 'MRD-99120',
        evidence: null,
      },
    ],
    stubReply: 'The vendor contract number for Project Meridian is MRD-99120, which is fully verified.',
    applies: ['factPreservation', 'evidenceDistinction'],
    mustShowIds: ['contract'],
    expectedDisclosure: 'missing-evidence',
  },
  {
    id: '03-conflicting-claims',
    title: 'two conflicting claims, both retrievable',
    question: 'who owns project atlas?',
    retrievalLimit: 6,
    maxContextChars: 6000,
    steps: [
      {
        alias: 'atlasNadia', op: 'knowledge', subject: 'Project Atlas', relationship: 'owner', object: 'Dana Whitfield', evidence: 'signed handover memo',
      },
      {
        alias: 'atlasBruno', op: 'knowledge', subject: 'Project Atlas', relationship: 'owner', object: 'Leo Marchetti', evidence: null,
      },
    ],
    stubReply: 'Project Atlas is owned by Dana Whitfield and there is no disagreement in the stored records.',
    applies: ['conflictDisclosure', 'evidenceDistinction'],
    mustShowIds: ['atlasNadia', 'atlasBruno'],
    expectedDisclosure: 'unresolved-conflict',
  },
  {
    id: '04-resolved-conflict',
    title: 'a conflict with a recorded user resolution',
    question: 'who owns project beacon?',
    retrievalLimit: 6,
    maxContextChars: 6000,
    steps: [
      {
        alias: 'beaconOld', op: 'knowledge', subject: 'Project Beacon', relationship: 'owner', object: 'Leo Marchetti', evidence: 'old org chart',
      },
      {
        alias: 'beaconNew', op: 'knowledge', subject: 'Project Beacon', relationship: 'owner', object: 'Priya Raman', evidence: 'current staffing sheet',
      },
      { op: 'resolve', target: 'beaconOld', choose: 'beaconNew', reason: 'the user confirmed the staffing sheet' },
    ],
    stubReply: 'Project Beacon is owned by Priya Raman, which is an objectively verified fact.',
    applies: ['userDecisions', 'conflictDisclosure'],
    mustShowIds: ['beaconNew'],
    expectedDisclosure: 'recorded-decision',
  },
  {
    id: '05-superseded-claim',
    title: 'a superseded claim',
    question: 'what is the emergency exit route for warehouse 7?',
    retrievalLimit: 6,
    maxContextChars: 6000,
    steps: [
      {
        alias: 'exitOld', op: 'knowledge', subject: 'Warehouse 7', relationship: 'emergency_exit_route', object: 'west stairwell', evidence: '2024 floor plan',
      },
      {
        alias: 'exitNew',
        op: 'knowledge',
        subject: 'Warehouse 7',
        relationship: 'emergency_exit_route',
        object: 'east stairwell',
        evidence: '2026 fire inspection',
        supersedesAlias: 'exitOld',
      },
    ],
    stubReply: 'The emergency exit route for Warehouse 7 is the west stairwell, and also the east stairwell.',
    applies: ['retractionHandling', 'factPreservation'],
    mustShowIds: ['exitNew'],
    mustNotShowText: ['west stairwell'],
    expectedDisclosure: 'history-counted',
  },
  {
    id: '06-retracted-claim',
    title: 'a retracted claim',
    question: 'what is the calibration interval for pump 12?',
    retrievalLimit: 6,
    maxContextChars: 6000,
    steps: [
      {
        alias: 'pumpOld', op: 'knowledge', subject: 'Pump 12', relationship: 'calibration_interval', object: 'every 30 days', evidence: 'vendor leaflet',
      },
      { op: 'retract', target: 'pumpOld', reason: 'the leaflet was for a different model' },
    ],
    stubReply: 'Pump 12 must be calibrated every 30 days.',
    applies: ['retractionHandling', 'unknownHandling'],
    mustNotShowText: ['every 30 days'],
    expectedDisclosure: 'retraction-counted',
  },
  {
    id: '07-outside-retrieval-window',
    title: 'a conflicting record outside the retrieval window, one of them private',
    question: 'what is the access code for gate 4?',
    // One member of a genuine disagreement is pushed out of the retrieval window and a
    // third is private, so the assembled context on its own is both one-sided and blind to
    // the private value. The disclosure must not carry the private content.
    retrievalLimit: 1,
    maxContextChars: 6000,
    steps: [
      { alias: 'gateA', op: 'memory', content: 'The access code for Gate 4 is 8123.' },
      ...gateFiller(8).map((content, i) => ({ alias: `filler${i}`, op: 'memory', content })),
      { alias: 'gateB', op: 'memory', content: 'The access code for Gate 4 is 5566.' },
      {
        alias: 'gatePrivate',
        op: 'memory',
        content: 'The access code for Gate 4 is 4417, kept on the safe door tag.',
        sensitivity: 'private',
      },
    ],
    stubReply: 'The access code for Gate 4 is 8123. There is no conflicting record.',
    applies: ['conflictDisclosure', 'factPreservation', 'contextIntegrity', 'privacy'],
    privateAliases: ['gatePrivate'],
    expectedDisclosure: 'conflict-beyond-window',
  },
  {
    id: '08-genuinely-unknown',
    title: 'a question the stores cannot answer',
    question: 'when is node 12 scheduled to be retired?',
    retrievalLimit: 6,
    maxContextChars: 6000,
    steps: [
      { alias: 'noise', op: 'memory', content: 'Node 9 was moved to rack 3 during the March maintenance window.' },
    ],
    stubReply: 'Node 12 is scheduled to be retired on 2027-01-15.',
    applies: ['unknownHandling'],
    mustNotShowText: ['2027-01-15'],
    expectedDisclosure: 'none',
  },
  {
    id: '09-incomplete-retrieval',
    title: 'a retrieved record that is truncated',
    question: 'what does the warehouse 7 evacuation checklist say about the loading dock?',
    retrievalLimit: 3,
    maxContextChars: 6000,
    steps: [
      {
        alias: 'longChecklist',
        op: 'memory',
        // Long enough to be clamped by the per-item context limit, so the record that is
        // shown cannot carry the whole stored sentence.
        content: `The Warehouse 7 evacuation checklist for the loading dock says: assemble at pole 4, `
          + 'notify the dock supervisor, and release the magnetic hold. '
          + 'Additional internal procedure text that fills the record so it is longer than one context item. '.repeat(9),
      },
    ],
    stubReply: 'The checklist is complete and every part of it has been read.',
    applies: ['contextIntegrity', 'unknownHandling'],
    mustShowIds: ['longChecklist'],
    expectedDisclosure: 'truncation',
  },
  {
    id: '10-clean-store',
    title: 'a clean store',
    question: 'what is the roof load rating for warehouse 7?',
    retrievalLimit: 6,
    maxContextChars: 6000,
    steps: [],
    // A stub that turns "nothing stored" into "nothing to worry about" is what the
    // clean-store case exists to expose: the assembled context must not claim certainty.
    stubReply: 'There are no stored records, so the roof load rating is certainly not a concern.',
    applies: ['unknownHandling', 'contextIntegrity', 'damageDisclosure'],
    expectedDisclosure: 'none',
  },
];

export const SCENARIO_IDS = SCENARIOS.map((s) => s.id);

// Rubric criteria referenced by the scenarios. Names are fixed by the rubric file, which
// was written before the first scenario ran.
export const CRITERIA = [
  'factPreservation',
  'conflictDisclosure',
  'evidenceDistinction',
  'userDecisions',
  'retractionHandling',
  'unknownHandling',
  'damageDisclosure',
  'privacy',
  'contextIntegrity',
];
