// Reads one ReqAnalyzer run folder: which stories exist, which GitHub issue each became, in creation order.
import { FILES, readJson, fingerprint } from '../runs.js';
import { orderItems } from '../schema.js';

/**
 * Joins approved.json with pushed.json and returns the stories to hand to Quorum.
 * Returns { stories, excluded, epics }: stories sorted by issue number (= creation order).
 */
export async function loadRun(dir, { includeDuplicates = false, ignoreLinkErrors = false } = {}) {
  const approved = await readJson(dir, FILES.approved, null);
  if (!approved) throw new Error('Nothing has been approved for this run yet. Run "reqagent review" and "reqagent push" first.');
  if (fingerprint(approved.items) !== approved.fingerprint) {
    throw new Error('approved.json was changed after approval. Run "reqagent review" again, then "reqagent push".');
  }
  const pushed = await readJson(dir, FILES.pushed, null);
  if (!pushed) throw new Error('This run has not been pushed to GitHub yet. Run "reqagent push" first.');

  const items = orderItems(approved.items);
  const missing = items.filter((it) => it.type !== 'task' && !pushed[it.id]);
  if (missing.length) {
    throw new Error(`Not pushed yet: ${missing.map((m) => m.id).join(', ')}. Run "reqagent push" again.`);
  }

  const all = items
    .filter((it) => it.type === 'story')
    .map((it) => ({ ...it, ...pushed[it.id], draftId: it.id }))
    .sort((a, b) => a.number - b.number);

  const stories = [];
  const excluded = [];
  for (const s of all) {
    if (s.skipped === 'duplicate' && !includeDuplicates) excluded.push(s);
    else stories.push(s);
  }

  const linkErrors = stories.filter((s) => s.linkError);
  if (linkErrors.length && !ignoreLinkErrors) {
    throw new Error(
      `Story ${linkErrors.map((s) => `#${s.number}`).join(', ')} could not be linked to its parent, so Quorum may not find its tasks. ` +
        'Run "reqagent push" again to retry the link, or pass --ignore-link-errors.',
    );
  }

  // Epics created by this run (a pre-existing duplicate epic is not ours to close).
  const epics = items
    .filter((it) => it.type === 'epic' && pushed[it.id] && pushed[it.id].skipped !== 'duplicate')
    .map((it) => ({ ...it, ...pushed[it.id], draftId: it.id, stories: stories.filter((s) => s.parent === it.id) }))
    .filter((e) => e.stories.length);

  return { stories, excluded, epics };
}

/** Domain labels that mean the story has UI work, so Quorum must write Playwright tests. */
export const isUiStory = (story) => (story.labels || []).some((l) => ['frontend', 'ux', 'ui'].includes(l.toLowerCase()));
