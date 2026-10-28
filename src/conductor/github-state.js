// GitHub side of the Conductor: reads issue state, classifies it, and makes the few writes it needs.
import pc from 'picocolors';
import { Octokit } from '@octokit/rest';

export const LABELS = {
  queued: 'quorum:queued',
  working: 'quorum:working',
  awaiting: 'quorum:awaiting-approval',
  review: 'quorum:in-review',
  blocked: 'quorum:blocked',
  ui: 'area:ui',
};
export const LABEL_COLORS = {
  [LABELS.queued]: 'fbca04',
  [LABELS.working]: '1d76db',
  [LABELS.awaiting]: 'd93f0b',
  [LABELS.review]: '5319e7',
  [LABELS.blocked]: 'b60205',
  [LABELS.ui]: 'bfd4f2',
};
const IN_FLIGHT = [LABELS.queued, LABELS.working, LABELS.awaiting, LABELS.review];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseRepo(repo) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo || '');
  if (!m) throw new Error('Pass the repository as --repo owner/name (or set GITHUB_REPO in .env).');
  return { owner: m[1], repo: m[2] };
}

/** Copy of the retry logic in src/github.js (kept separate so that file stays untouched). */
async function withRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const limited = (err.status === 403 || err.status === 429) && /rate limit|abuse|secondary/i.test(err.message || '');
      if (!limited || attempt >= 4) throw err;
      const wait = Number(err.response?.headers?.['retry-after'] || 0) * 1000 || 60_000 * (attempt + 1);
      console.log(pc.yellow(`  Rate limited on ${label}; waiting ${Math.round(wait / 1000)}s…`));
      await sleep(wait);
    }
  }
}

const names = (issue) => (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

/** pending | in-flight | blocked | done | dropped — from state, state_reason and labels. */
export function classify(issue) {
  if (issue.state === 'closed') return issue.state_reason === 'not_planned' ? 'dropped' : 'done';
  const labels = names(issue);
  if (labels.includes(LABELS.blocked)) return 'blocked';
  if (labels.some((l) => IN_FLIGHT.includes(l))) return 'in-flight';
  return 'pending';
}

export function createGithub({ repo: repoArg, token = process.env.GITHUB_TOKEN, baseUrl = process.env.GITHUB_API_URL } = {}) {
  const { owner, repo } = parseRepo(repoArg || process.env.GITHUB_REPO);
  const gh = new Octokit({
    auth: token || undefined,
    userAgent: 'reqagent-conductor',
    log: { debug() {}, info() {}, warn: console.warn, error() {} },
    ...(baseUrl && { baseUrl }),
  });
  const base = { owner, repo };

  return {
    owner,
    repo,
    classify,
    names,

    async getIssue(number) {
      const { data } = await withRetry(() => gh.issues.get({ ...base, issue_number: number }), `issue #${number}`).catch((err) => {
        throw new Error(err.status === 404 ? `Issue #${number} not found in ${owner}/${repo}.` : err.message);
      });
      return data;
    },

    /** Open issues (not PRs) carrying a quorum status label, optionally leaving one out. */
    async inProgress(exceptNumber) {
      const found = new Map();
      for (const label of IN_FLIGHT) {
        const issues = await withRetry(
          () => gh.paginate(gh.issues.listForRepo, { ...base, state: 'open', labels: label, per_page: 100 }),
          `list ${label}`,
        );
        for (const is of issues) if (!is.pull_request && is.number !== exceptNumber) found.set(is.number, is);
      }
      return [...found.values()];
    },

    async ensureLabels() {
      const existing = await withRetry(() => gh.paginate(gh.issues.listLabelsForRepo, { ...base, per_page: 100 }), 'list labels');
      const have = new Set(existing.map((l) => l.name.toLowerCase()));
      const created = [];
      for (const name of Object.keys(LABEL_COLORS)) {
        if (have.has(name.toLowerCase())) continue;
        await withRetry(() => gh.issues.createLabel({ ...base, name, color: LABEL_COLORS[name] }), `label ${name}`).catch((err) => {
          if (err.status !== 422) throw err; // already exists (race / case difference)
        });
        created.push(name);
      }
      return created;
    },

    async addLabels(number, labels) {
      await withRetry(() => gh.issues.addLabels({ ...base, issue_number: number, labels }), `label #${number}`);
    },

    async comment(number, body) {
      await withRetry(() => gh.issues.createComment({ ...base, issue_number: number, body }), `comment #${number}`);
    },

    async close(number) {
      await withRetry(() => gh.issues.update({ ...base, issue_number: number, state: 'closed', state_reason: 'completed' }), `close #${number}`);
    },

    /** Pull requests that reference the issue (merged ones first). Best effort: returns [] if the timeline isn't readable. */
    async linkedPrs(number) {
      try {
        const events = await withRetry(
          () => gh.paginate(gh.issues.listEventsForTimeline, { ...base, issue_number: number, per_page: 100 }),
          `timeline #${number}`,
        );
        const prs = new Map();
        for (const e of events) {
          const pr = e.event === 'cross-referenced' && e.source?.issue?.pull_request ? e.source.issue : null;
          if (pr) prs.set(pr.number, { number: pr.number, merged: Boolean(pr.pull_request.merged_at) });
        }
        return [...prs.values()].sort((a, b) => Number(b.merged) - Number(a.merged) || a.number - b.number);
      } catch {
        return [];
      }
    },
  };
}
