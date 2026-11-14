// Plain-text rendering of World Model records and query results.
//
// The renderer shows what is stored and how it is classified. It never adds a confidence value,
// never picks one side of a disagreement, and never presents a missing fact as a negative fact.
import { shortId, singleLine, truncate } from '../util.js';
import { containsSecret, SECRET_OMITTED } from '../security/secrets.js';
import { categoryLabel } from './vocabulary.js';

function storedText(value) {
  const text = String(value ?? '');
  return containsSecret(text) ? SECRET_OMITTED : text;
}

function dateText(value) {
  return value === null || value === undefined ? 'unknown' : String(value);
}

function rangeText(item) {
  const from = dateText(item.validFrom);
  const until = item.validUntil === null || item.validUntil === undefined ? 'open' : String(item.validUntil);
  if (item.validFrom === null || item.validFrom === undefined) return 'validity unknown (no valid-from time recorded)';
  return `valid ${from} to ${until}`;
}

function evidenceLine(evidence) {
  if (!evidence || evidence.length === 0) return 'no evidence recorded';
  return `evidence ${evidence.join(', ')}`;
}

function factLine(fact) {
  const direction = fact.direction === 'incoming' ? `incoming: ${fact.subjectName} ` : '';
  const value = fact.direction === 'incoming' ? '' : ` ${fact.objectLabel}`;
  const confidence = fact.confidence
    ? `  confidence ${fact.confidence.value}${fact.confidence.basis ? ` (${storedText(fact.confidence.basis)})` : ''}`
    : '';
  const superseded = fact.supersededBy ? `  superseded by ${shortId(fact.supersededBy)}` : '';
  const retracted = fact.retractedReason ? `  retracted: ${storedText(fact.retractedReason)}` : '';
  return `  ${shortId(fact.id)}  ${direction}${fact.predicate}${value}  [${fact.status}]  ${rangeText(fact)}${confidence}${superseded}${retracted}\n      ${evidenceLine(fact.evidence)}`;
}

function relationshipLine(relationship) {
  const text = relationship.direction === 'incoming'
    ? `${relationship.subjectName} ${relationship.label} this entity`
    : `${relationship.label} ${relationship.objectName}`;
  const properties = relationship.properties
    ? `  properties ${singleLine(JSON.stringify(relationship.properties), 120)}`
    : '';
  const superseded = relationship.supersededBy ? `  superseded by ${shortId(relationship.supersededBy)}` : '';
  return `  ${shortId(relationship.id)}  ${text}  [${relationship.status}]  ${rangeText(relationship)}${properties}${superseded}\n      ${evidenceLine(relationship.evidence)}`;
}

function eventLine(event) {
  const participants = event.participants.map((p) => `${p.name}`).join(', ');
  const affected = event.affected.length ? `; affected ${event.affected.map((a) => a.name).join(', ')}` : '';
  const properties = event.properties ? `  properties ${singleLine(JSON.stringify(event.properties), 120)}` : '';
  return `  ${shortId(event.id)}  ${event.eventType}  [${event.status}]  occurred ${dateText(event.occurredAt)}; learned ${dateText(event.observedAt)}; stored ${dateText(event.recordedAt)}  participants ${participants}${affected}${properties}\n      ${evidenceLine(event.evidence)}`;
}

export function renderEntity(view) {
  if (!view || view.problem) return `Cannot show the entity: ${view?.problem ?? 'unknown problem'}`;
  const entity = view.entity;
  const lines = [
    `${storedText(entity.name)}  ${shortId(entity.id)}  ${entity.categoryLabel}  status: ${entity.status}`,
    `Description: ${entity.description ? storedText(entity.description) : 'none recorded'}`,
    `Aliases: ${entity.aliases.length ? entity.aliases.map(storedText).join(', ') : 'none recorded'}`,
    `External ids: ${entity.externalIds.length ? entity.externalIds.map((e) => `${e.scheme}:${storedText(e.value)}`).join(', ') : 'none recorded'}`,
    `Observed: ${dateText(entity.observedAt)}  created: ${dateText(entity.createdAt)}  updated: ${dateText(entity.updatedAt)}`,
    `Evidence: ${entity.evidence.length ? entity.evidence.join(', ') : 'none recorded'}`,
  ];
  if (entity.status === 'merged') lines.push(`Merged into: ${shortId(entity.mergedInto ?? '')} (this record stays readable; queries resolve to the survivor)`);
  if (entity.mergedFrom.length) lines.push(`Absorbed entities: ${entity.mergedFrom.map(shortId).join(', ')}`);
  if (entity.retiredReason) lines.push(`Retired: ${storedText(entity.retiredReason)}`);

  lines.push('', `Facts (${view.facts.length}):`);
  if (view.facts.length === 0) lines.push('  none recorded; a missing fact is not a negative fact');
  for (const fact of view.facts) lines.push(factLine(fact));

  lines.push('', `Relationships (${view.relationships.length}):`);
  if (view.relationships.length === 0) lines.push('  none recorded');
  for (const relationship of view.relationships) lines.push(relationshipLine(relationship));

  lines.push('', `Events (${view.events.length}):`);
  if (view.events.length === 0) lines.push('  none recorded');
  for (const event of view.events) lines.push(eventLine(event));

  if (view.conflicts.length) {
    lines.push('', `Disagreements involving this entity (${view.conflicts.length}):`);
    for (const conflict of view.conflicts) {
      lines.push(`  ${conflict.kind} ${conflict.predicate ?? conflict.externalScheme ?? ''}  [${conflict.state}]  ${conflict.reason}`);
      for (const member of conflict.members) {
        lines.push(`    ${shortId(member.id)} ${storedText(member.value)}  ${rangeText(member)}  ${evidenceLine(member.evidence)}`);
      }
    }
    lines.push('  Both sides are shown as recorded; no side was chosen automatically.');
  }

  if (view.merges.length) {
    lines.push('', 'Merge history:');
    for (const merge of view.merges) {
      lines.push(`  ${shortId(merge.id)}  ${merge.fromName} -> ${merge.toName}  ${dateText(merge.at)}  ${storedText(merge.reason)}${merge.undoneAt ? `  (undone ${merge.undoneAt})` : ''}`);
    }
  }
  if (view.identityDecisions.length) {
    lines.push('', 'Identity decisions:');
    for (const decision of view.identityDecisions) {
      lines.push(`  ${decision.decision}  ${shortId(decision.leftId)} / ${shortId(decision.rightId)}  ${dateText(decision.at)}  ${storedText(decision.reason)}`);
    }
  }
  if (view.history?.length) {
    lines.push('', `History (${view.history.length} record(s)):`);
    for (const entry of view.history) lines.push(`  ${dateText(entry.at)}  ${entry.type}  ${storedText(entry.summary)}`);
  }
  if (view.resolved?.note) lines.push('', view.resolved.note);
  return lines.join('\n');
}

export function renderFacts(result) {
  if (result.problem) return `Cannot list facts: ${result.problem}`;
  const lines = [`Facts for ${storedText(result.entityName)} (${shortId(result.entityId)})${result.asOf ? ` as of ${result.asOf}` : ''}:`];
  if (result.facts.length === 0) lines.push('  none recorded; a missing fact is not a negative fact');
  for (const fact of result.facts) lines.push(factLine(fact));
  if (result.note) lines.push(result.note);
  return lines.join('\n');
}

export function renderRelationships(result) {
  if (result.problem) return `Cannot list relationships: ${result.problem}`;
  const lines = [`Relationships for ${storedText(result.entityName)} (${shortId(result.entityId)})${result.asOf ? ` as of ${result.asOf}` : ''}:`];
  if (result.relationships.length === 0) lines.push('  none recorded');
  for (const relationship of result.relationships) lines.push(relationshipLine(relationship));
  if (result.note) lines.push(result.note);
  return lines.join('\n');
}

export function renderEvents(result) {
  if (result.problem) return `Cannot list events: ${result.problem}`;
  const lines = [`Events involving ${storedText(result.entityName)} (${shortId(result.entityId)}):`];
  if (result.events.length === 0) lines.push('  none recorded');
  for (const event of result.events) lines.push(eventLine(event));
  if (result.truncated) lines.push(`Showing ${result.events.length} of ${result.total} event(s).`);
  if (result.note) lines.push(result.note);
  return lines.join('\n');
}

export function renderAttributes(result) {
  if (result.problem) return `Cannot list attributes: ${result.problem}`;
  const predicates = Object.keys(result.attributes ?? {});
  const lines = [`Current attributes of ${storedText(result.entityName)} (${shortId(result.entityId)})${result.asOf ? ` as of ${result.asOf}` : ''}:`];
  if (predicates.length === 0) lines.push('  no currently valid attribute is recorded');
  for (const predicate of predicates) {
    lines.push(`  ${predicate}:`);
    for (const fact of result.attributes[predicate]) {
      lines.push(`    ${shortId(fact.id)}  ${storedText(fact.objectLabel)}  [${fact.status}]  ${rangeText(fact)}  ${evidenceLine(fact.evidence)}`);
    }
  }
  lines.push('An attribute that is absent has no recorded current value; its absence is not a denial.');
  return lines.join('\n');
}

export function renderPair(result) {
  if (result.problem) return `Cannot assess the pair: ${result.problem}`;
  const verdict = result.allowed
    ? `merge permitted on ${result.basis}`
    : 'merge would be refused';
  const lines = [
    `Pair ${storedText(result.left.name)} (${shortId(result.left.id)}) / ${storedText(result.right.name)} (${shortId(result.right.id)}): ${verdict}.`,
  ];
  if (!result.allowed && result.reason) lines.push(`  ${storedText(result.reason)}`);
  for (const reason of result.reasons ?? []) lines.push(`  - ${storedText(reason)}`);
  if (result.note) lines.push(`  ${storedText(result.note)}`);
  lines.push('This assessment records nothing; a merge is a separate user-origin record.');
  return lines.join('\n');
}

export function renderIdentityDecisionRead(decision, left, right) {
  if (!decision) return `No identity decision is recorded for ${shortId(left)} and ${shortId(right)}.`;
  return [
    `Identity ${decision.decision}: ${shortId(decision.leftId)} and ${shortId(decision.rightId)}.`,
    `Recorded: ${dateText(decision.at)}  ${storedText(decision.reason)}`,
    `Evidence: ${evidenceLine(decision.evidence.map((e) => `${e.sourceType}:${e.sourceId}`))}`,
  ].join('\n');
}

export function renderEntityList(result) {
  if (result.entities.length === 0) return 'No entities are recorded. Add one with: node bin/apex.js world entity add --category <type> "<name>" --evidence user';
  const lines = result.entities.map((entity) => `${shortId(entity.id)}  ${entity.status.padEnd(7)}  ${categoryLabel(entity.category).padEnd(14)}  ${storedText(entity.name)}${entity.aliases.length ? `  (aliases: ${entity.aliases.map(storedText).join(', ')})` : ''}${entity.mergedInto ? `  -> ${shortId(entity.mergedInto)}` : ''}`);
  if (result.truncated) lines.push(`Showing ${result.entities.length} of ${result.total} entities.`);
  return lines.join('\n');
}

export function renderFind(result) {
  if (result.matches.length === 0) return `No active entity matches "${singleLine(result.text, 80)}".`;
  return result.matches
    .map((match) => `${shortId(match.id)}  ${storedText(match.name)}  ${categoryLabel(match.category)}  matched on ${match.matchedOn}`)
    .join('\n');
}

export function renderEntityCreated(record) {
  return [
    `Entity ${shortId(record.entityId)} created: ${storedText(record.name)} (${categoryLabel(record.category)}).`,
    `Evidence: ${record.evidence.map((e) => `${e.sourceType}:${e.sourceId}`).join(', ')}`,
    `Next: node bin/apex.js world entity show ${shortId(record.entityId)}`,
  ].join('\n');
}

export function renderFactRecorded(record) {
  const value = record.object.kind === 'entity' ? record.object.entityId : String(record.object.value);
  return [
    `Fact ${shortId(record.factId)} recorded: ${record.subjectId} ${record.predicate} ${value}.`,
    `Validity: ${record.validFrom ?? 'unknown (not treated as current until a valid-from time is recorded)'}${record.validUntil ? ` to ${record.validUntil}` : ''}`,
    `Evidence: ${record.evidence.map((e) => `${e.sourceType}:${e.sourceId}`).join(', ')}`,
  ].join('\n');
}

export function renderRelationshipRecorded(record) {
  return [
    `Relationship ${shortId(record.relationshipId)} recorded: ${record.subjectId} ${record.predicate} ${record.objectId} (${record.directionality}).`,
    `Validity: ${record.validFrom ?? 'unknown'}${record.validUntil ? ` to ${record.validUntil}` : ''}`,
    `Evidence: ${record.evidence.map((e) => `${e.sourceType}:${e.sourceId}`).join(', ')}`,
  ].join('\n');
}

export function renderEventRecorded(record) {
  return [
    `Event ${shortId(record.worldEventId)} recorded: ${record.eventType}.`,
    `Occurred: ${record.occurredAt ?? 'unknown'}; learned: ${record.observedAt ?? 'not recorded'}; stored: ${record.at}`,
    `Participants: ${record.participants.join(', ')}${record.affected?.length ? `; affected: ${record.affected.join(', ')}` : ''}`,
    `Evidence: ${record.evidence.map((e) => `${e.sourceType}:${e.sourceId}`).join(', ')}`,
  ].join('\n');
}

export function renderStatementLifecycle(record) {
  if (record.type === 'statement_retracted') {
    return `Retracted ${record.targetType} ${shortId(record.targetId)}: ${storedText(record.reason)}\nThe record and its history remain stored; it is no longer presented as supported.`;
  }
  return `Superseded ${record.targetType} ${shortId(record.targetId)} by ${shortId(record.byId)}: ${storedText(record.reason)}\nBoth records remain stored.`;
}

export function renderMerge(record) {
  return [
    `Merged ${shortId(record.fromId)} into ${shortId(record.toId)}: ${storedText(record.reason)}`,
    `Merge id: ${record.mergeId}`,
    'Historical references remain stored and resolve to the surviving entity. Undo it with: node bin/apex.js world entity unmerge ' + shortId(record.mergeId),
  ].join('\n');
}

export function renderIdentityDecision(record) {
  return [
    `Identity ${record.decision}: ${shortId(record.leftId)} and ${shortId(record.rightId)}.`,
    `Reason: ${storedText(record.reason)}`,
    record.decision === 'confirmed'
      ? 'The decision itself merged nothing. A merge is a separate record.'
      : 'The pair is kept out of the candidate list; the rejection stays visible.',
  ].join('\n');
}

export function renderCandidates(result) {
  if (result.problem) return `Cannot list identity candidates: ${result.problem}`;
  const lines = [`Identity candidates for ${storedText(result.entity.name)} (${shortId(result.entity.id)}):`];
  if (result.candidates.length === 0) lines.push('  none; no deterministic match or bounded similarity was found');
  for (const candidate of result.candidates) {
    lines.push(`  ${shortId(candidate.id)}  ${storedText(candidate.name)}  ${candidate.categoryLabel}  ${candidate.kind}  score ${candidate.score}${candidate.decision ? `  [decision: ${candidate.decision}]` : ''}`);
    for (const reason of candidate.reasons) lines.push(`      - ${storedText(reason)}`);
  }
  if (result.truncated) lines.push(`  Showing ${result.candidates.length} of ${result.total} candidates.`);
  if (result.rejectedTotal) lines.push(`  ${result.rejectedTotal} pair(s) were rejected by a recorded decision and are not offered.`);
  if (result.note) lines.push('', result.note);
  return lines.join('\n');
}

export function renderConflicts(result) {
  const lines = [
    `Disagreements: ${result.counts.groups} group(s) - ${result.counts.fact} fact, ${result.counts.relationship} relationship, ${result.counts.identity} identity; ${result.counts.active} active, ${result.counts.historical} historical; ${result.counts.contested} statement(s) carry contradicting evidence.`,
  ];
  if (result.groups.length === 0) lines.push('No disagreement meets the detection rule. A difference in time, an unknown value, or two multi-valued facts is not a disagreement.');
  result.groups.forEach((group, index) => {
    lines.push('', `${index + 1}. ${group.kind} ${group.predicate ?? group.externalScheme ?? ''}  [${group.state}]  ${group.reason}`);
    for (const member of group.members) {
      const label = member.value ?? member.subjectName ?? member.id;
      lines.push(`   ${shortId(member.id)}  ${storedText(label)}  ${member.validFrom !== undefined ? rangeText(member) : ''}  ${evidenceLine(member.evidence)}`);
    }
  });
  if (result.contested.length) {
    lines.push('', 'Statements carrying contradicting evidence:');
    for (const item of result.contested) {
      lines.push(`  ${item.targetType} ${shortId(item.id)}  ${item.predicate}  ${item.evidence.join(', ')}`);
    }
  }
  lines.push('', 'Both sides of every group remain stored. No source was ranked and no side was chosen automatically.');
  return lines.join('\n');
}

export function renderRelated(result) {
  if (result.problem) return `Cannot traverse: ${result.problem}`;
  const lines = [`Related to ${storedText(result.start.name)} (${shortId(result.start.id)}), depth ${result.depth}:`];
  for (const node of result.nodes) {
    lines.push(`  d${node.depth}  ${shortId(node.id)}  ${storedText(node.name)}${node.category ? `  ${node.categoryLabel}` : ''}${node.status !== 'active' ? `  (${node.status})` : ''}`);
  }
  if (result.edges.length) {
    lines.push('', 'Edges followed:');
    for (const edge of result.edges) {
      lines.push(`  d${edge.depth}  ${shortId(edge.fromId)} -${edge.label}-> ${shortId(edge.toId)}  (${edge.kind} ${shortId(edge.id)})`);
    }
  }
  if (result.cycles.length) {
    lines.push('', 'Repeated nodes (a cycle was not expanded again):');
    for (const cycle of result.cycles) lines.push(`  ${shortId(cycle.fromId)} -> ${shortId(cycle.toId)}  (${cycle.kind} ${shortId(cycle.id)})`);
  }
  if (result.note) lines.push('', result.note);
  return lines.join('\n');
}

export function renderHistory(result) {
  const lines = [`History for ${storedText(result.entity.name)} (${shortId(result.entity.id)}):`];
  if (result.entries.length === 0) lines.push('  no records name this entity');
  for (const entry of result.entries) lines.push(`  ${dateText(entry.at)}  ${entry.type}  ${storedText(entry.summary)}`);
  return lines.join('\n');
}

export function renderStatementHistory(result) {
  const lines = [`Lifecycle events for ${result.statement.type} ${shortId(result.statement.id)}:`];
  if (result.entries.length === 0) lines.push('  none recorded');
  for (const entry of result.entries) {
    lines.push(`  ${dateText(entry.at)}  ${entry.kind}  target ${shortId(entry.targetId)}${entry.byId ? ` by ${shortId(entry.byId)}` : ''}  ${storedText(entry.reason)}  ${evidenceLine(entry.evidence)}`);
  }
  return lines.join('\n');
}

export function renderEvidence(result) {
  if (result.problem) return `Cannot list evidence: ${result.problem}`;
  const lines = [`Evidence references (${result.refs.length}):`];
  if (result.refs.length === 0) lines.push('  none recorded');
  for (const ref of result.refs) {
    lines.push(`  ${ref.sourceType}:${ref.sourceId}  ${ref.relation}${ref.classification ? `  [${ref.classification}]` : ''}${ref.note ? `  ${storedText(ref.note)}` : ''}`);
    lines.push(`      cited by ${ref.from.join(', ')}`);
  }
  return lines.join('\n');
}

export function renderBeliefTrace(result) {
  const target = result?.target ?? {};
  const lines = [`Belief trace for ${target.type ?? 'record'} ${target.id ? shortId(target.id) : ''}${target.label ? `  ${storedText(target.label)}` : ''}`];
  if (!target.found) lines.push('  this record is not in its store');
  else lines.push(`  stored status: ${target.status}`);
  if (target.detail) lines.push(`  ${storedText(target.detail)}`);
  lines.push(`  disposition: ${result.disposition.state} - ${storedText(result.disposition.reason)}`);

  const sameStore = result.sameStore;
  if (sameStore) {
    lines.push('', 'Owning store:');
    if (sameStore.status !== undefined) {
      const replaced = (sameStore.replacedBy ?? []).length ? `  replaced by ${sameStore.replacedBy.map(shortId).join(', ')}` : '';
      lines.push(`  status ${sameStore.status}${replaced}`);
      if (sameStore.conflict) {
        lines.push(`  possible conflict on "${storedText(sameStore.conflict.subject)}" with ${sameStore.conflict.recordIds.map(shortId).join(', ')}; values ${sameStore.conflict.values.map(storedText).join(' | ')}`);
      }
    } else {
      const conflicts = (sameStore.conflictsWith ?? []).length
        ? `  conflicts with ${sameStore.conflictsWith.map(shortId).join(', ')}${sameStore.conflictState ? ` (${sameStore.conflictState})` : ''}`
        : '';
      lines.push(`  lifecycle ${sameStore.lifecycleState ?? 'unknown'}${conflicts}`);
      if (sameStore.resolution) {
        lines.push(`  resolution: ${sameStore.resolution.chosen ? 'this record was chosen' : 'this record was not chosen'}${sameStore.resolution.reason ? ` - ${storedText(sameStore.resolution.reason)}` : ''}`);
      }
      if (sameStore.retractedBy) lines.push(`  retracted by ${shortId(sameStore.retractedBy)}`);
      if ((sameStore.problems ?? []).length) lines.push(`  history problems: ${sameStore.problems.length}`);
    }
  }

  if (result.evidence.refs.length) {
    lines.push('', `Evidence references (${result.evidence.refs.length}):`);
    for (const ref of result.evidence.refs) {
      const state = ref.check === 'unavailable'
        ? 'UNREADABLE'
        : ref.check === 'no-store'
          ? 'NO STORE'
          : ref.missing
            ? 'MISSING'
            : ref.stale
              ? `NOT CURRENT${ref.state ? `: ${ref.state}` : ''}`
              : ref.check === 'ok' ? 'current' : 'not checked';
      lines.push(`  ${ref.sourceType}:${ref.sourceId}  ${ref.relation}  [${state}]${ref.detail ? `  ${storedText(ref.detail)}` : ''}`);
      lines.push(`      cited by ${ref.from.join(', ') || 'no stored statement'}`);
    }
    if (result.evidence.truncated) lines.push(`  Showing ${result.evidence.refs.length} of ${result.evidence.total}.`);
  }

  if (result.conflicts.length) {
    lines.push('', `Same-store disagreements (${result.conflicts.length}):`);
    for (const group of result.conflicts) {
      lines.push(`  ${group.kind} ${group.predicate ?? ''}  [${group.state}]  members ${group.memberIds.map(shortId).join(', ')}  ${storedText(group.reason)}`);
    }
  }

  if (result.citations.rows.length) {
    lines.push('', `World statements citing this record (${result.citations.total}):`);
    for (const row of result.citations.rows) {
      const when = row.validFrom
        ? `valid ${dateText(row.validFrom)} to ${dateText(row.validUntil ?? 'open')}`
        : row.occurredAt ? `occurred ${dateText(row.occurredAt)}` : null;
      lines.push(`  ${row.targetType} ${shortId(row.id)}  [${row.status}]  ${row.relations.join('+')}  ${storedText(row.label ?? '')}`);
      lines.push(`      ${when ? `${when}  ` : ''}${evidenceLine(row.evidence)}`);
    }
    if (result.citations.truncated) lines.push(`  Showing ${result.citations.rows.length} of ${result.citations.total}.`);
  } else if (target.type === 'memory' || target.type === 'knowledge') {
    lines.push('', 'No world statement cites this record.');
  }

  for (const note of result.notes ?? []) lines.push(`  note: ${storedText(note)}`);
  lines.push('', 'A trace is descriptive: it keeps both sides, decides nothing, and authorizes no action.');
  return lines.join('\n');
}

export function renderChanges(result) {
  if (result.problem) return `Cannot compare: ${result.problem}`;
  const lines = [`Changes between ${result.from} and ${result.to}:`];
  if (result.changes.length === 0) lines.push('  none; no statement became valid, stopped being valid, was recorded, or was withdrawn in this window');
  for (const change of result.changes) {
    lines.push(`  ${dateText(change.at)}  ${change.kind}  ${change.id ? shortId(change.id) : ''}  ${storedText(change.detail)}`);
  }
  lines.push('', 'Valid time and stored time are separate: a statement recorded inside the window may describe a different valid period.');
  return lines.join('\n');
}

export function renderStateAt(result) {
  const counts = { entities: result.state.entities.size, facts: result.state.facts.size, relationships: result.state.relationships.size, events: result.state.events.size };
  const lines = [
    `Historical state at ${result.cutoff}:`,
    result.note,
    `Derived from the log at that time: ${counts.entities} entity record(s), ${counts.facts} fact(s), ${counts.relationships} relationship(s), ${counts.events} event(s).`,
  ];
  if (result.problems.length) {
    lines.push(`${result.problems.length} record(s) stored at or before that time could not be applied; the state is incomplete.`);
  }
  lines.push('Later retractions, supersessions, and merges are not included in this view.');
  return lines.join('\n');
}

export function renderInspect(inspected) {
  const c = inspected.counts;
  const lines = [
    `World model store: ${inspected.path}`,
    `Records: ${inspected.records}  complete: ${inspected.complete ? 'yes' : 'no'}`,
    c ? `Entities: ${c.entities} (${c.activeEntities} active, ${c.mergedEntities} merged, ${c.retiredEntities} retired); facts: ${c.facts}; relationships: ${c.relationships}; events: ${c.events}; merges: ${c.merges}; identity decisions: ${c.identityDecisions}` : 'Counts unavailable.',
    c ? `Lifecycle records: ${c.retractions} retraction(s), ${c.supersessions} supersession(s); disagreement groups: ${c.conflictGroups}` : '',
  ];
  if (inspected.corrupt.length) {
    lines.push(`Corrupt lines: ${inspected.corrupt.length}. A damaged log is not an empty one; reads that present the world refuse until it is repaired.`);
    for (const line of inspected.corrupt.slice(0, 5)) lines.push(`  line ${line.line}: ${line.reason}${line.truncatedTail ? ' (truncated tail)' : ''}`);
    if (inspected.corrupt.length > 5) lines.push(`  (+${inspected.corrupt.length - 5} more)`);
  }
  if (inspected.problems.length) {
    lines.push(`Records that cannot be applied: ${inspected.problems.length}.`);
    for (const problem of inspected.problems.slice(0, 5)) lines.push(`  record ${problem.index}: ${problem.reason}`);
    if (inspected.problems.length > 5) lines.push(`  (+${inspected.problems.length - 5} more)`);
  }
  if (inspected.complete) lines.push('The log replayed cleanly. This view is read-only and wrote nothing.');
  return lines.filter((line) => line !== '').join('\n');
}

export function renderStatus(status) {
  if (!status.available) return `World model store unavailable: ${status.detail}`;
  return `World model: ${status.records} record(s), ${status.counts.activeEntities} active entities, ${status.counts.facts} facts, ${status.counts.relationships} relationships, ${status.counts.events} events${status.complete ? '' : '; DAMAGED'}`;
}

export function renderEntitySummaryLine(entity) {
  return `${shortId(entity.id)}  ${entity.status.padEnd(7)}  ${categoryLabel(entity.category)}  ${truncate(storedText(entity.name), 80)}`;
}
