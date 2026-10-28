// One Conductor check: read GitHub, decide, dispatch the next story, close finished epics.
import pc from 'picocolors';
import { logEvent } from '../history.js';
import { LABELS } from './github-state.js';
import { isUiStory } from './stories.js';

/** Reads the state of every story from GitHub: Map(issue number → { issue, kind }). */
export async function readStates(github, stories) {
  const states = new Map();
  for (const s of stories) {
    const issue = await github.getIssue(s.number);
    states.set(s.number, { issue, kind: github.classify(issue) });
  }
  return states;
}

/** Walks the stories in order and stops at the first one that isn't done. Pure: no I/O. */
export function decide(stories, states, { skipDropped = false } = {}) {
  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    const kind = states.get(story.number).kind;
    if (kind === 'done') continue;
    if (kind === 'dropped' && skipDropped) continue;
    return { action: { pending: 'dispatch', 'in-flight': 'wait', blocked: 'blocked', dropped: 'dropped' }[kind], story, index: i };
  }
  return { action: 'done' };
}

/**
 * Runs one check. Returns { outcome, story? } where outcome is one of:
 * done · dispatched · waiting · blocked · dropped
 */
export async function check({ github, runName, stories, epics, opts = {}, say = console.log }) {
  const dry = Boolean(opts.dryRun);
  const log = (event, details) => (dry ? Promise.resolve() : logEvent(event, runName, details));
  const states = await readStates(github, stories);
  const decision = decide(stories, states, opts);
  const label = (s) => `#${s.number} ${s.title}`;
  let result;

  switch (decision.action) {
    case 'done':
      result = { outcome: 'done' };
      break;

    case 'wait': {
      const { story } = decision;
      result = { outcome: 'waiting', story, detail: `${label(story)} is ${github.names(states.get(story.number).issue).filter((n) => n.startsWith('quorum:')).join(', ')}` };
      break;
    }

    case 'blocked':
      result = { outcome: 'blocked', story: decision.story, detail: `${label(decision.story)} is blocked. Read Quorum's comment on the issue, fix the problem, then add the quorum:queued label back.` };
      break;

    case 'dropped':
      result = {
        outcome: 'dropped',
        story: decision.story,
        detail: `${label(decision.story)} was closed as not planned. Reopen it to continue with it, or run again with --skip-dropped to move on without it.`,
      };
      break;

    case 'dispatch': {
      const { story, index } = decision;
      const busy = await github.inProgress(story.number);
      if (busy.length) {
        result = {
          outcome: 'waiting',
          story,
          detail: `${label(story)} is next, but ${busy.map((b) => `#${b.number}`).join(', ')} already carries a quorum status label (one story at a time per repo)`,
        };
        break;
      }
      const labels = [LABELS.queued, ...(isUiStory(story) ? [LABELS.ui] : [])];
      if (!dry) {
        await github.ensureLabels();
        await github.addLabels(story.number, labels);
        await github.comment(story.number, `Dispatched by reqagent conductor — run \`${runName}\`, story ${index + 1} of ${stories.length}.`);
      }
      await log('conduct-dispatch', `${github.owner}/${github.repo} | #${story.number} ${story.draftId} | story ${index + 1} of ${stories.length} | ${labels.join(', ')}`);
      result = { outcome: 'dispatched', story, detail: `${label(story)} → ${labels.join(', ')} (story ${index + 1} of ${stories.length})` };
      break;
    }
  }

  await rollUp({ github, epics, states, runName, dry, say, log });

  if (result.outcome === 'done') await log('conduct-done', `${github.owner}/${github.repo} | all ${stories.length} stories completed`);
  else if (result.outcome === 'blocked' || result.outcome === 'dropped') await log('conduct-paused', `${result.outcome} | ${result.detail}`);
  else if (result.outcome === 'waiting') await log('conduct-wait', result.detail);
  return result;
}

/** Closes every open epic whose stories are all completed. */
async function rollUp({ github, epics, states, dry, say, log }) {
  for (const epic of epics) {
    if (!epic.stories.every((s) => states.get(s.number)?.kind === 'done')) continue;
    const issue = await github.getIssue(epic.number);
    if (issue.state === 'closed') continue;
    const lines = [];
    for (const s of epic.stories) {
      const prs = (await github.linkedPrs(s.number)).filter((p) => p.merged);
      lines.push(`- #${s.number} ${s.title}${prs.length ? ` — ${prs.map((p) => `#${p.number}`).join(', ')}` : ''}`);
    }
    if (!dry) await github.close(epic.number);
    if (!dry) await github.comment(epic.number, `All stories in this epic are completed (merged):\n\n${lines.join('\n')}`);
    say(pc.green(`${dry ? '[dry run] would close' : 'Closed'} epic #${epic.number} ${epic.title}`));
    await log('conduct-epic-closed', `${github.owner}/${github.repo} | #${epic.number} ${epic.draftId}`);
  }
}
