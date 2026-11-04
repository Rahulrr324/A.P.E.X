// Controlled vocabularies for the World Model. A vocabulary is a naming contract, not a
// permission: every write is still user-origin and goes through the action registry.
//
// Predicates and relationship types may be extended, but only through a validated name
// (lowercase letters, digits, underscores). An unknown name is accepted as a multi-valued,
// directed relation. It is never silently treated as single-valued, because a single-valued
// claim is what the contradiction engine uses to say two assertions cannot both hold.
export const ENTITY_CATEGORIES = Object.freeze([
  'person', 'organization', 'project', 'product', 'place',
  'device', 'software', 'document', 'event', 'concept', 'custom',
]);

export const ENTITY_CATEGORY_LABELS = Object.freeze({
  person: 'Person',
  organization: 'Organization',
  project: 'Project',
  product: 'Product',
  place: 'Place',
  device: 'Device',
  software: 'Software',
  document: 'File or document',
  event: 'Event',
  concept: 'Concept',
  custom: 'Custom',
});

export const ENTITY_STATUSES = Object.freeze(['active', 'merged', 'retired']);

export const EVIDENCE_RELATIONS = Object.freeze([
  'supports', 'contradicts', 'qualifies', 'supersedes', 'retracts',
]);

// Only sources whose records APEX can re-open at read time are accepted. A document or a
// model statement is not a source: the user's own action is represented by `user`, and a
// supplied document must first become a memory or knowledge record that can be cited.
export const EVIDENCE_SOURCE_TYPES = Object.freeze([
  'user', 'memory', 'knowledge', 'experience', 'task', 'operation', 'prediction',
]);

export const EVIDENCE_CLASSES = Object.freeze([
  'user_statement', 'recorded_claim', 'recorded_outcome', 'verified_record',
  'recorded_expectation', 'model_generated',
]);

export const STATEMENT_STATUSES = Object.freeze([
  'supported', 'contested', 'conflicting', 'historical', 'superseded', 'retracted',
  'validity_unknown',
]);

export const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const CATEGORY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9._-]{0,31}$/;
export const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// Fact predicates with a recorded cardinality. `single` means two different values whose
// valid-time intervals overlap are a contradiction candidate; `multi` means several values
// may legitimately hold at once. Custom predicates default to `multi` and are therefore never
// used to declare a contradiction on their own.
export const FACT_PREDICATES = Object.freeze({
  has_status: { cardinality: 'single', description: 'the lifecycle status of an entity' },
  has_name: { cardinality: 'single', description: 'the preferred display name' },
  located_in: { cardinality: 'single', description: 'the place an entity is at' },
  manufactured_by: { cardinality: 'single', description: 'the organization that made a device' },
  owned_by: { cardinality: 'single', description: 'the current owner of an entity' },
  date_of_birth: { cardinality: 'single', description: 'a person\'s date of birth' },
  has_identifier: { cardinality: 'multi', description: 'an external identifier' },
  uses_technology: { cardinality: 'multi', description: 'a technology an entity uses' },
  associated_with: { cardinality: 'multi', description: 'a general association' },
  described_as: { cardinality: 'multi', description: 'a description supplied as a fact' },
});

// Relationship predicates and their inverse names. An inverse is presented by a query; it is
// never stored twice. `symmetric` means the edge reads the same in both directions. Only a
// `single` cardinality takes part in contradiction detection.
export const RELATIONSHIP_TYPES = Object.freeze({
  associated_with: { inverse: 'associated_with', symmetric: true, cardinality: 'multi' },
  employed_by: { inverse: 'employs', symmetric: false, cardinality: 'single' },
  employs: { inverse: 'employed_by', symmetric: false, cardinality: 'multi' },
  member_of: { inverse: 'has_member', symmetric: false, cardinality: 'multi' },
  has_member: { inverse: 'member_of', symmetric: false, cardinality: 'multi' },
  part_of: { inverse: 'has_part', symmetric: false, cardinality: 'multi' },
  has_part: { inverse: 'part_of', symmetric: false, cardinality: 'multi' },
  uses: { inverse: 'used_by', symmetric: false, cardinality: 'multi' },
  used_by: { inverse: 'uses', symmetric: false, cardinality: 'multi' },
  depends_on: { inverse: 'dependency_of', symmetric: false, cardinality: 'multi' },
  dependency_of: { inverse: 'depends_on', symmetric: false, cardinality: 'multi' },
  references: { inverse: 'referenced_by', symmetric: false, cardinality: 'multi' },
  referenced_by: { inverse: 'references', symmetric: false, cardinality: 'multi' },
  located_in: { inverse: 'contains', symmetric: false, cardinality: 'single' },
  contains: { inverse: 'located_in', symmetric: false, cardinality: 'multi' },
  manufactured_by: { inverse: 'manufactures', symmetric: false, cardinality: 'single' },
  manufactures: { inverse: 'manufactured_by', symmetric: false, cardinality: 'multi' },
  owns: { inverse: 'owned_by', symmetric: false, cardinality: 'multi' },
  owned_by: { inverse: 'owns', symmetric: false, cardinality: 'single' },
  created_by: { inverse: 'created', symmetric: false, cardinality: 'multi' },
  created: { inverse: 'created_by', symmetric: false, cardinality: 'multi' },
});

export function factPredicate(name) {
  return FACT_PREDICATES[name] ?? { cardinality: 'multi', description: 'custom predicate' };
}

export function relationshipType(name) {
  return RELATIONSHIP_TYPES[name] ?? {
    inverse: null, symmetric: false, cardinality: 'multi', custom: true,
  };
}

export function isKnownFactPredicate(name) {
  return Object.prototype.hasOwnProperty.call(FACT_PREDICATES, name);
}

export function isKnownRelationshipType(name) {
  return Object.prototype.hasOwnProperty.call(RELATIONSHIP_TYPES, name);
}

export function categoryLabel(category) {
  return ENTITY_CATEGORY_LABELS[category] ?? category;
}
