#!/usr/bin/env node
// conduct — hands the stories of one reqagent run to Quorum, one at a time, in creation order.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Command } from 'commander';
import pc from 'picocolors';
import Table from 'cli-table3';

// Same .env lookup as reqagent: current folder, then the tool's own folder.
dotenv.config({ quiet: true });
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

const { resolveRun } = await import('../src/runs.js');
const { loadRun } = await import('../src/conductor/stories.js');
const { createGithub } = await import('../src/conductor/github-state.js');
const { check, readStates } = await import('../src/conductor/dispatch.js');

// Exit codes: 0 every story completed · 1 error · 2 paused (blocked/dropped) · 3 still in progress (--once only)
const EXIT = { done: 0, error: 1, paused: 2, progress: 3 };

// Commander ignores action return values, so each action's result becomes the exit code here.
const exits = (fn) => async (opts) => {
  process.exitCode = await fn(opts);
};

const runOptions = (cmd) =>
  cmd
    .option('--run <name>', 'run folder under drafts/ (default: the latest run)')
    .option('--repo <owner/name>', 'GitHub repository (default: GITHUB_REPO)')
    .option('--include-duplicates', 'also dispatch stories that were skipped as duplicates of existing issues')
    .option('--ignore-link-errors', 'continue even if a story could not be linked to its parent epic');

async function open(opts) {
  const dir = await resolveRun(opts.run);
  const runName = path.basename(dir);
  const data = await loadRun(dir, { includeDuplicates: opts.includeDuplicates, ignoreLinkErrors: opts.ignoreLinkErrors });
  return { dir, runName, ...data };
}

const program = new Command();
program.name('conduct').description('Queue a reqagent run for Quorum, one story at a time, each only after the previous is merged.');

runOptions(program.command('run', { isDefault: true }))
  .description('Keep checking GitHub and queue the next story when the previous one is completed (default command)')
  .option('--interval <seconds>', 'seconds between checks', '120')
  .option('--once', 'run a single check and exit')
  .option('--dry-run', 'show what would happen without changing anything on GitHub')
  .option('--skip-dropped', 'move past stories that were closed as not planned')
  .action(exits(async (opts) => {
    const { runName, stories, excluded, epics } = await open(opts);
    const github = createGithub({ repo: opts.repo });
    if (!process.env.GITHUB_TOKEN && !opts.dryRun) throw new Error('GITHUB_TOKEN is not set. Add it to .env (see README).');
    const interval = Number(opts.interval);
    if (!(interval > 0)) throw new Error('--interval must be a positive number of seconds.');

    console.log(`${pc.bold('Conductor')} · run ${pc.bold(runName)} · ${github.owner}/${github.repo}${opts.dryRun ? pc.yellow(' · DRY RUN') : ''}`);
    console.log(`${stories.length} stor${stories.length === 1 ? 'y' : 'ies'} to dispatch${excluded.length ? `, ${excluded.length} skipped as duplicate(s)` : ''}.`);
    if (!stories.length) {
      console.log(pc.yellow('Nothing to dispatch.'));
      return EXIT.done;
    }

    let stopping = false;
    let wake = null;
    process.once('SIGINT', () => {
      stopping = true;
      wake?.();
      console.log(pc.dim('\nStopping after the current check…'));
    });
    const pause = (s) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, s * 1000);
        wake = () => (clearTimeout(t), resolve());
      });

    let lastKey = '';
    while (true) {
      const r = await check({ github, runName, stories, epics, opts, say: console.log });
      const key = `${r.outcome}:${r.story?.number}:${r.detail}`;
      const fresh = key !== lastKey; // don't repeat the same "waiting" line every interval
      lastKey = key;

      if (r.outcome === 'done') {
        console.log(pc.green(`✔ All ${stories.length} stories are completed.`));
        return EXIT.done;
      }
      if (r.outcome === 'dropped') {
        console.log(pc.red(`✘ Paused: ${r.detail}`));
        return EXIT.paused;
      }
      if (r.outcome === 'blocked' && fresh) console.log(pc.red(`✘ ${r.detail}`));
      else if (r.outcome === 'dispatched') console.log(pc.green(`${opts.dryRun ? '[dry run] would dispatch' : '→ Dispatched'} ${r.detail}`));
      else if (r.outcome === 'waiting' && fresh) console.log(pc.dim(`… waiting: ${r.detail}`));

      if (opts.once || (opts.dryRun && r.outcome === 'dispatched')) {
        return r.outcome === 'blocked' ? EXIT.paused : EXIT.progress;
      }
      if (stopping) return EXIT.progress;
      await pause(interval);
      if (stopping) return EXIT.progress;
    }
  }));

runOptions(program.command('status'))
  .description('Show every story with its issue, GitHub state and pull request')
  .action(exits(async (opts) => {
    const { runName, stories, excluded } = await open(opts);
    const repoArg = opts.repo || process.env.GITHUB_REPO;
    const github = repoArg ? createGithub({ repo: repoArg }) : null;
    const states = github ? await readStates(github, stories) : null;
    if (!github) console.log(pc.yellow('No repository given (--repo or GITHUB_REPO): showing the run only, without GitHub state.'));

    const table = new Table({ head: ['#', 'Story', 'Issue', 'State', 'PR'], wordWrap: true, colWidths: [4, 52, 8, 14, 12] });
    const color = { done: pc.green, 'in-flight': pc.cyan, blocked: pc.red, dropped: pc.yellow, pending: pc.dim };
    for (const [i, s] of stories.entries()) {
      let state = '—';
      let pr = '';
      if (states) {
        const { kind, issue } = states.get(s.number);
        state = color[kind](kind === 'in-flight' ? github.names(issue).find((n) => n.startsWith('quorum:')).slice(7) : kind);
        const prs = await github.linkedPrs(s.number);
        pr = prs.map((p) => `#${p.number}${p.merged ? '' : '?'}`).join(' ');
      }
      table.push([i + 1, s.title, `#${s.number}`, state, pr]);
    }
    for (const s of excluded) table.push(['', pc.dim(s.title), pc.dim(`#${s.number}`), pc.dim('skipped (dup)'), '']);
    console.log(`Run ${pc.bold(runName)}`);
    console.log(table.toString());
    return EXIT.done;
  }));

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(pc.red(`Error: ${err.message}`));
  process.exitCode = EXIT.error;
}
