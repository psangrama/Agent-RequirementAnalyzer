// Creates approved issues on GitHub: labels, epics → stories → tasks, linked as sub-issues.
import path from 'node:path';
import pc from 'picocolors';
import { Octokit } from '@octokit/rest';
import { FILES, readJson, writeJson, writeText, fingerprint } from './runs.js';
import { orderItems, validateHierarchy } from './schema.js';
import { allLabels, issueBody } from './preview.js';
import { logEvent } from './history.js';

const LABEL_COLORS = {
  'type:epic': '6f42c1',
  'type:story': '0e8a16',
  'type:task': 'c5def5',
  'priority:high': 'b60205',
  'priority:medium': 'fbca04',
  'priority:low': '0e8a16',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function labelColor(name) {
  if (LABEL_COLORS[name]) return LABEL_COLORS[name];
  if (name.startsWith('size:')) return 'd4c5f9';
  return 'ededed';
}

function parseRepo(repo) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo || '');
  if (!m) throw new Error('Pass the repository as --repo owner/name (or set GITHUB_REPO in .env).');
  return { owner: m[1], repo: m[2] };
}

/** Retries on GitHub's rate limits, honouring retry-after. */
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

async function loadApproved(dir) {
  const approved = await readJson(dir, FILES.approved, null);
  if (!approved) {
    throw new Error(
      'Nothing has been approved for this run yet. Run "reqagent review" first — issues are only created after you approve them.',
    );
  }
  if (fingerprint(approved.items) !== approved.fingerprint) {
    throw new Error('approved.json was changed after approval. Run "reqagent review" again to re-approve.');
  }
  const problems = validateHierarchy(approved.items).filter((p) => !/does not exist/.test(p));
  if (problems.length) throw new Error(`approved.json has problems:\n- ${problems.join('\n- ')}`);
  return approved;
}

export async function push(dir, opts = {}) {
  try {
    return await pushRun(dir, opts);
  } catch (err) {
    if (!opts.dryRun) await logEvent('push-failed', path.basename(dir), `${opts.repo || process.env.GITHUB_REPO || ''} | ${err.message}`);
    throw err;
  }
}

async function linkSubIssue(gh, owner, repo, parentNumber, childId, label) {
  try {
    await withRetry(
      () =>
        gh.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
          owner,
          repo,
          issue_number: parentNumber,
          sub_issue_id: childId,
        }),
      label,
    );
    return null;
  } catch (err) {
    // Already linked (e.g. by hand on GitHub) counts as success.
    if (err.status === 422 && /already|duplicate|exists/i.test(err.message || '')) return null;
    return err.message || String(err);
  }
}

async function pushRun(dir, { repo: repoArg, dryRun = false, delayMs = 1000, showPlan = true } = {}) {
  const approved = await loadApproved(dir);
  const { owner, repo } = parseRepo(repoArg || process.env.GITHUB_REPO);
  const runName = path.basename(dir);
  const items = orderItems(approved.items);
  const pushed = await readJson(dir, FILES.pushed, {});
  const token = process.env.GITHUB_TOKEN;

  if (!token && !dryRun) throw new Error('GITHUB_TOKEN is not set. Add it to .env (see README).');
  const gh = token
    ? new Octokit({
        auth: token,
        userAgent: 'reqagent',
        log: { debug() {}, info() {}, warn: console.warn, error() {} }, // errors are reported by reqagent itself
        ...(process.env.GITHUB_API_URL && { baseUrl: process.env.GITHUB_API_URL }),
      })
    : null;

  // --- Read current state of the repo --------------------------------------
  const byMarker = new Map();
  const byTitle = new Map();
  let existingLabels = new Set();
  if (gh) {
    const { data: r } = await gh.repos.get({ owner, repo }).catch((err) => {
      throw new Error(err.status === 404 ? `Repository ${owner}/${repo} not found, or the token can't see it.` : err.message);
    });
    if (!r.has_issues) throw new Error(`Issues are turned off for ${owner}/${repo}. Enable them in the repo settings.`);
    if (r.permissions && !r.permissions.push && !r.permissions.triage) {
      console.log(pc.yellow('Warning: this token may not have write access to issues in this repo.'));
    }
    const issues = await gh.paginate(gh.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
    for (const is of issues) {
      if (is.pull_request) continue;
      const m = /<!-- reqagent:([^:]+):([^ ]+) -->/.exec(is.body || '');
      if (m && m[1] === runName) byMarker.set(m[2], is);
      if (!byTitle.has(norm(is.title))) byTitle.set(norm(is.title), is);
    }
    const labels = await gh.paginate(gh.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
    existingLabels = new Set(labels.map((l) => l.name.toLowerCase()));
  } else {
    console.log(pc.yellow("No GITHUB_TOKEN: dry run can't check the repo for existing issues or labels."));
  }

  // --- Plan ------------------------------------------------------------------
  const plan = items.map((it) => {
    if (pushed[it.id]) {
      // Created earlier but linking to its parent failed: try the link again.
      const action = pushed[it.id].linkError && it.parent ? 'relink' : 'done';
      return { it, action, ref: pushed[it.id] };
    }
    const marked = byMarker.get(it.id);
    if (marked) return { it, action: 'done', ref: toRef(marked) };
    const dup = byTitle.get(norm(it.title));
    if (dup) return { it, action: 'duplicate', ref: toRef(dup) };
    return { it, action: 'create' };
  });
  const neededLabels = [...new Set(items.flatMap(allLabels))].filter((l) => !existingLabels.has(l.toLowerCase()));
  const toCreate = plan.filter((p) => p.action === 'create');
  const toRelink = plan.filter((p) => p.action === 'relink');

  if (!showPlan) {
    console.log(`\n${pc.bold('Creating issues')} in ${pc.bold(`${owner}/${repo}`)}`);
  } else {
    console.log(`\n${pc.bold(dryRun ? 'DRY RUN — nothing will be created' : 'Creating issues')} in ${pc.bold(`${owner}/${repo}`)}`);
    if (neededLabels.length) console.log(`Labels to create: ${neededLabels.join(', ')}`);
    for (const p of plan) {
      const tag =
        p.action === 'create'
          ? pc.green('CREATE   ')
          : p.action === 'relink'
            ? pc.cyan(`RELINK #${p.ref.number}`.padEnd(9))
            : p.action === 'done'
              ? pc.dim(`EXISTS #${p.ref.number}`.padEnd(9))
              : pc.yellow(`DUP   #${p.ref.number}`.padEnd(9));
      const parent = p.it.parent ? pc.dim(` (sub-issue of ${p.it.parent})`) : '';
      console.log(`  ${tag} ${p.it.id.padEnd(10)} ${p.it.title}${parent}`);
    }
    const dups = plan.filter((p) => p.action === 'duplicate');
    if (dups.length)
      console.log(
        pc.yellow(
          `\n${dups.length} issue(s) already exist with the same title and will be skipped; their children will be linked under the existing issue.`,
        ),
      );
    if (toRelink.length)
      console.log(pc.cyan(`\n${toRelink.length} issue(s) were created earlier but not linked to their parent; the link will be retried.`));
    console.log(
      `\n${toCreate.length} to create, ${toRelink.length ? `${toRelink.length} to re-link, ` : ''}${plan.length - toCreate.length - toRelink.length} skipped.`,
    );
  }

  if (dryRun) return { created: 0, planned: toCreate.length + toRelink.length };
  if (!toCreate.length && !toRelink.length) {
    console.log('Nothing to create.');
    await writeReport(dir, owner, repo, plan, pushed);
    return { created: 0 };
  }
  await logEvent('push-start', runName, `${owner}/${repo} | ${toCreate.length} to create, ${toRelink.length} to re-link`);

  // --- Execute ---------------------------------------------------------------
  for (const name of neededLabels) {
    await withRetry(() => gh.issues.createLabel({ owner, repo, name, color: labelColor(name) }), `label ${name}`).catch((err) => {
      if (err.status !== 422) throw err; // 422 = already exists (race / case difference)
    });
  }
  for (const p of plan) if (p.action !== 'create' && !pushed[p.it.id]) pushed[p.it.id] = { ...p.ref, skipped: p.action };
  await writeJson(dir, FILES.pushed, pushed);

  let created = 0;
  for (const p of toCreate) {
    const it = p.it;
    const parent = it.parent ? pushed[it.parent] : null;
    const { data: issue } = await withRetry(
      () =>
        gh.issues.create({
          owner,
          repo,
          title: it.title,
          body: issueBody(it, { parentRef: parent ? `#${parent.number}` : null, runName }),
          labels: allLabels(it),
        }),
      it.id,
    );
    const ref = toRef(issue);
    created++;
    console.log(`  ${pc.green('✔')} #${issue.number} ${it.id} ${it.title}`);

    if (parent) {
      const linkError = await linkSubIssue(gh, owner, repo, parent.number, issue.id, `link ${it.id}`);
      if (linkError) {
        ref.linkError = linkError;
        console.log(pc.yellow(`    Could not link as sub-issue of #${parent.number}: ${linkError} (run push again to retry the link)`));
      } else ref.linked = true;
    }
    pushed[it.id] = ref;
    await writeJson(dir, FILES.pushed, pushed); // saved after every issue, so a re-run resumes safely
    await sleep(delayMs);
  }

  // Retry links that failed on an earlier push (parents now certainly exist).
  let relinked = 0;
  for (const p of toRelink) {
    const ref = pushed[p.it.id];
    const parent = pushed[p.it.parent];
    if (!parent) continue;
    const linkError = await linkSubIssue(gh, owner, repo, parent.number, ref.id, `link ${p.it.id}`);
    if (linkError) {
      ref.linkError = linkError;
      console.log(pc.yellow(`  ✘ #${ref.number} ${p.it.id} still not linked to #${parent.number}: ${linkError}`));
    } else {
      delete ref.linkError;
      ref.linked = true;
      relinked++;
      console.log(`  ${pc.green('✔')} #${ref.number} ${p.it.id} linked under #${parent.number}`);
    }
    await writeJson(dir, FILES.pushed, pushed);
  }

  const linkFailures = Object.values(pushed).filter((r) => r.linkError).length;
  const reportPath = await writeReport(dir, owner, repo, plan, pushed);
  await logEvent(
    'push-done',
    runName,
    `${owner}/${repo} | created ${created}, re-linked ${relinked}${linkFailures ? `, ${linkFailures} link(s) still failing` : ''}`,
  );
  console.log(pc.green(`\n✔ Created ${created} issue(s)${relinked ? `, re-linked ${relinked}` : ''}. Report: ${reportPath}`));
  if (linkFailures)
    console.log(pc.yellow(`${linkFailures} issue(s) are not linked to their parent yet. Run the same push command again to retry.`));
  return { created };
}

function toRef(issue) {
  return { number: issue.number, id: issue.id, url: issue.html_url };
}

async function writeReport(dir, owner, repo, plan, pushed) {
  const lines = [
    `# GitHub issues — ${owner}/${repo}`,
    '',
    `Updated ${new Date().toISOString()}`,
    '',
    '| Draft | Type | Issue | Title | Status |',
    '|---|---|---|---|---|',
  ];
  for (const p of plan) {
    const ref = pushed[p.it.id];
    const status = !ref
      ? 'not created'
      : ref.skipped === 'duplicate'
        ? 'skipped (duplicate)'
        : ref.skipped === 'done'
          ? 'already existed'
          : ref.linkError
            ? 'created (link failed)'
            : 'created';
    lines.push(
      `| ${p.it.id} | ${p.it.type} | ${ref ? `[#${ref.number}](${ref.url})` : '—'} | ${p.it.title.replace(/\|/g, '\\|')} | ${status} |`,
    );
  }
  await writeText(dir, FILES.report, lines.join('\n') + '\n');
  return path.join(dir, FILES.report);
}
