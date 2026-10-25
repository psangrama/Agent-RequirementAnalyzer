// The shape every draft must have, plus hierarchy checks.
import { z } from 'zod';

export const ItemSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9.\-]*$/)
    .describe('Stable draft ID: epics E1, E2…; stories E1.S1; tasks E1.S1.T1'),
  type: z.enum(['epic', 'story', 'task']),
  parent: z.string().nullable().describe('ID of the parent item; null for epics'),
  title: z.string().min(5).max(200).describe('Short, action-oriented issue title'),
  description: z.string().min(1).describe('Markdown body. Stories use "As a … I want … so that …" where it fits'),
  acceptance_criteria: z.array(z.string().min(1)).describe('Testable criteria; empty only for epics if none apply'),
  labels: z
    .array(z.string().min(1).max(50))
    .describe(
      'Domain labels such as frontend, backend, api, security, infra, docs. Do NOT include type/priority/size labels; those are added automatically',
    ),
  priority: z.enum(['high', 'medium', 'low']),
  estimate: z.enum(['XS', 'S', 'M', 'L', 'XL']),
  source_refs: z
    .array(z.string())
    .describe('Where in the requirements doc this came from: requirement IDs (e.g. FR-3) or section headings'),
});

export const FlagSchema = z.object({
  source_ref: z.string().describe('Requirement ID or section heading'),
  problem: z.string().describe('What is vague, missing, conflicting or untestable'),
  suggestion: z.string().describe('A concrete question or rewording to resolve it'),
});

export const DraftSchema = z.object({
  summary: z.string().describe('2-4 sentence summary of what the requirements describe'),
  items: z.array(ItemSchema).min(1),
  flags: z.array(FlagSchema).describe('Ambiguous, missing or conflicting requirements the user should look at'),
});

export function draftJsonSchema() {
  const schema = z.toJSONSchema(DraftSchema);
  delete schema.$schema;
  return schema;
}

export function itemJsonSchema() {
  const schema = z.toJSONSchema(ItemSchema);
  delete schema.$schema;
  return schema;
}

const PARENT_TYPE = { epic: null, story: 'epic', task: 'story' };

/** Returns a list of human-readable problems; empty when the draft is valid. */
export function validateDraft(data) {
  const parsed = DraftSchema.safeParse(data);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  }
  return validateHierarchy(parsed.data.items);
}

export function validateHierarchy(items) {
  const problems = [];
  const byId = new Map();
  for (const it of items) {
    if (byId.has(it.id)) problems.push(`Duplicate id ${it.id}`);
    byId.set(it.id, it);
  }
  for (const it of items) {
    const expected = PARENT_TYPE[it.type];
    if (expected === null) {
      if (it.parent) problems.push(`${it.id}: epics must not have a parent`);
      continue;
    }
    if (!it.parent) {
      problems.push(`${it.id}: a ${it.type} needs a parent ${expected}`);
      continue;
    }
    const p = byId.get(it.parent);
    if (!p) problems.push(`${it.id}: parent ${it.parent} does not exist`);
    else if (p.type !== expected) problems.push(`${it.id}: a ${it.type}'s parent must be a ${expected}, but ${p.id} is a ${p.type}`);
  }
  return problems;
}

/**
 * Parent-first, depth-first ordering: epic, story 1, story 1's tasks, story 2, story 2's tasks…
 * Items whose parent is missing (orphans) go at the end.
 */
export function orderItems(items) {
  const rank = { epic: 0, story: 1, task: 2 };
  const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
  const sorted = [...items].sort((a, b) => rank[a.type] - rank[b.type] || byId(a, b));
  const children = new Map();
  for (const it of sorted) {
    if (!it.parent) continue;
    if (!children.has(it.parent)) children.set(it.parent, []);
    children.get(it.parent).push(it);
  }
  const out = [];
  const seen = new Set();
  const visit = (it) => {
    if (seen.has(it)) return;
    seen.add(it);
    out.push(it);
    for (const child of children.get(it.id) || []) visit(child);
  };
  for (const it of sorted) if (!it.parent) visit(it);
  for (const it of sorted) visit(it); // orphans / anything unreachable
  return out;
}

/** Items whose parent is not in the list (after the user drops some). */
export function orphans(items) {
  const ids = new Set(items.map((i) => i.id));
  return items.filter((i) => i.parent && !ids.has(i.parent));
}
