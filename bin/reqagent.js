#!/usr/bin/env node
// reqagent — requirements file → reviewed drafts → GitHub issues (only after you approve).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Command } from 'commander';
import pc from 'picocolors';

// Load .env from the current folder, then from the tool's own folder.
dotenv.config({ quiet: true });
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

const { parseFile } = await import('../src/parsers.js');
const runs = await import('../src/runs.js');

const program = new Command();
program.name('reqagent').description('Turn a requirements file into GitHub issues — after you review and approve them.').version('0.3.0');

program
  .command('parse <file>')
  .description('Show the text extracted from a file (no API calls). Useful to check a PDF or DOCX reads correctly.')
  .action(async (file) => {
    const { text, format, chars } = await parseFile(file);
    console.log(text);
    console.error(pc.dim(`\n[${format}, ${chars} characters]`));
  });

program
  .command('analyze <file>')
  .description('Read a requirements file (.md .docx .pdf .html) and draft Epic/Story/Task issues. Creates nothing on GitHub.')
  .option('-i, --instructions <text>', 'extra guidance for the breakdown, e.g. "tasks should be backend-only"')
  .option(
    '-m, --model <model>',
    'Claude model: a full ID, a shortcut (opus, sonnet, haiku, fable), or "pick" for a menu. Default: CLAUDE_MODEL in .env, else the built-in default (see "reqagent models")',
  )
  .option('--no-review', 'stop after drafting instead of going straight to review')
  .action(async (file, opts) => {
    const { analyze, makeClient } = await import('../src/analyzer.js');
    const { resolveModel } = await import('../src/models.js');
    const { previewMarkdown, counts } = await import('../src/preview.js');
    const { text, format, chars } = await parseFile(file);
    console.log(`Read ${path.basename(file)} (${format}, ${chars.toLocaleString()} characters).`);
    const model = await resolveModel(makeClient(), opts.model);
    const { logEvent, saveVersion } = await import('../src/history.js');
    const dir = await runs.createRun(file);
    const runName = path.basename(dir);
    await runs.writeText(dir, runs.FILES.source, text);
    await logEvent('analyze-start', runName, `${path.resolve(file)} | model=${model}`);

    try {
      process.stdout.write(`Analyzing with ${pc.bold(model)}`);
      let last = 0;
      const started = Date.now();
      const { draft, usage } = await analyze(text, {
        model,
        extraInstructions: opts.instructions,
        onProgress: (c) => {
          if (c - last > 2000) {
            process.stdout.write('.');
            last = c;
          }
        },
        log: (m) => console.log('\n' + pc.yellow(m)),
      });
      console.log(
        pc.dim(` done in ${Math.round((Date.now() - started) / 1000)}s (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`),
      );

      const meta = {
        runName,
        sourceFile: path.resolve(file),
        sourceName: path.basename(file),
        format,
        model,
        createdAt: new Date().toISOString(),
      };
      await runs.writeJson(dir, runs.FILES.meta, meta);
      await runs.writeJson(dir, runs.FILES.issues, draft);
      await runs.writeText(dir, runs.FILES.preview, previewMarkdown(draft, meta));
      await saveVersion(dir, runs.FILES.issues);
      await logEvent('analyze-done', runName, `${counts(draft.items)} | ${usage.input_tokens} in / ${usage.output_tokens} out tokens`);
      console.log(pc.green(`✔ Drafted ${counts(draft.items)}`) + ` → ${dir}`);
    } catch (err) {
      console.log('');
      await runs.writeText(dir, 'error.txt', `${new Date().toISOString()}\nmodel: ${model}\n\n${err.stack || err.message}\n`);
      await logEvent('analyze-failed', runName, err.message);
      throw new Error(
        `${err.message}\nThe extracted text is kept in ${dir}. Run analyze again to retry; "reqagent runs --clean" removes failed runs.`,
      );
    }

    if (opts.review && process.stdin.isTTY) {
      const { reviewInteractive } = await import('../src/review.js');
      await reviewInteractive(dir, { model });
    } else {
      console.log(`\nNext: ${pc.bold('reqagent review')}  (nothing is created until you approve)`);
    }
  });

program
  .command('review')
  .description('Look through the drafts and approve all, some, or none.')
  .option('-r, --run <name>', 'which run (default: the latest)')
  .option('--approve <ids>', 'approve without prompts: "all" or IDs like E1,E2.S3 (children included)')
  .option('-m, --model <model>', 'model for "rewrite an issue" (default: the model that made the drafts); accepts shortcuts or "pick"')
  .action(async (opts) => {
    const { reviewInteractive, reviewNonInteractive } = await import('../src/review.js');
    const dir = await runs.resolveRun(opts.run);
    console.log(pc.dim(`Run: ${path.basename(dir)}`));
    if (opts.approve) return void (await reviewNonInteractive(dir, opts.approve));
    let model;
    if (opts.model) {
      const { makeClient } = await import('../src/analyzer.js');
      const { resolveModel } = await import('../src/models.js');
      model = await resolveModel(makeClient(), opts.model);
    }
    await reviewInteractive(dir, { model });
  });

program
  .command('models')
  .description('List the Claude models your API key can use, and show the current default.')
  .action(async () => {
    const { makeClient } = await import('../src/analyzer.js');
    const { printModels } = await import('../src/models.js');
    await printModels(makeClient());
  });

program
  .command('push')
  .description('Create the APPROVED issues on GitHub. Use --dry-run first to see what will happen.')
  .option('--repo <owner/name>', 'target repository (default: GITHUB_REPO from .env)')
  .option('-r, --run <name>', 'which run (default: the latest)')
  .option('--dry-run', 'show what would be created without creating anything')
  .option('-y, --yes', 'skip the final "create now?" question')
  .option('--delay <ms>', 'pause between issues to respect GitHub limits', (v) => parseInt(v, 10), 1000)
  .action(async (opts) => {
    const { push } = await import('../src/github.js');
    const dir = await runs.resolveRun(opts.run);
    console.log(pc.dim(`Run: ${path.basename(dir)}`));
    if (opts.dryRun) return void (await push(dir, { repo: opts.repo, dryRun: true }));

    // Always show the plan first, then ask once more before writing to GitHub.
    const { planned } = await push(dir, { repo: opts.repo, dryRun: true });
    if (!planned) return void (await push(dir, { repo: opts.repo, delayMs: opts.delay }));
    if (!opts.yes) {
      const { confirm } = await import('@inquirer/prompts');
      const ok = await confirm({ message: `Create ${planned} issue(s) on GitHub now?`, default: false });
      if (!ok) return void console.log('Cancelled. Nothing was created.');
    }
    await push(dir, { repo: opts.repo, delayMs: opts.delay, showPlan: false });
  });

program
  .command('runs')
  .description('List previous runs and their status.')
  .option('--clean', 'delete runs that never finished drafting (failed or interrupted analyses)')
  .option('-y, --yes', 'with --clean: delete without asking')
  .action(async (opts) => {
    const list = await runs.listRuns();
    if (!list.length) return void console.log('No runs yet.');
    const rows = [];
    for (const name of list) {
      const dir = path.join(runs.DRAFTS_DIR, name);
      const has = async (f) => runs.exists(dir, f);
      const status = (await has(runs.FILES.report))
        ? 'pushed'
        : (await has(runs.FILES.approved))
          ? 'approved'
          : (await has(runs.FILES.issues))
            ? 'drafted'
            : (await has('error.txt'))
              ? 'failed'
              : 'incomplete';
      const meta = await runs.readJson(dir, runs.FILES.meta, null).catch(() => null);
      rows.push({ name, dir, status, model: meta?.model || '' });
    }
    const color = { pushed: pc.green, approved: pc.cyan, drafted: pc.yellow, failed: pc.red, incomplete: pc.dim };

    if (!opts.clean) {
      for (const r of rows) console.log(`${color[r.status](r.status.padEnd(11))} ${r.name}  ${pc.dim(r.model)}`);
      const stale = rows.filter((r) => r.status === 'failed' || r.status === 'incomplete').length;
      if (stale) console.log(pc.dim(`\n${stale} unfinished run(s). Remove them with: reqagent runs --clean`));
      return;
    }

    const stale = rows.filter((r) => r.status === 'failed' || r.status === 'incomplete');
    if (!stale.length) return void console.log('Nothing to clean. Every run finished drafting.');
    console.log('These runs never finished drafting and will be deleted:');
    for (const r of stale) console.log(`  ${color[r.status](r.status.padEnd(11))} ${r.name}`);
    if (!opts.yes) {
      const { confirm } = await import('@inquirer/prompts');
      if (!(await confirm({ message: `Delete ${stale.length} folder(s)?`, default: false }))) return void console.log('Nothing deleted.');
    }
    const fs = await import('node:fs/promises');
    const { logEvent } = await import('../src/history.js');
    for (const r of stale) {
      await fs.rm(r.dir, { recursive: true, force: true });
      await logEvent('clean', r.name, `deleted ${r.status} run`);
    }
    console.log(pc.green(`✔ Deleted ${stale.length} unfinished run(s).`));
  });

program
  .command('history')
  .description('Show what happened: analyses, rewrites, approvals, pushes and failures.')
  .option('-r, --run <name>', 'only this run (also lists its saved versions)')
  .option('-n, --limit <n>', 'how many entries to show (0 = all)', (v) => parseInt(v, 10), 50)
  .action(async (opts) => {
    const { readLog, listVersions, LOG_FILE } = await import('../src/history.js');
    const runName = opts.run ? path.basename(await runs.resolveRun(opts.run)) : undefined;
    const lines = await readLog({ run: runName, limit: opts.limit });
    if (!lines.length) console.log(runName ? `No history for ${runName}.` : 'No history yet.');
    for (const l of lines) {
      const [ts, event, run, ...rest] = l.split(' | ');
      const details = rest.join(' | ');
      const ev = event.trim();
      const tint = /failed/.test(ev) ? pc.red : /done|approve|pushed/.test(ev) ? pc.green : /clean|cancel/.test(ev) ? pc.dim : (x) => x;
      console.log(
        `${pc.dim(ts.replace('T', ' ').slice(0, 19))}  ${tint(ev.padEnd(14))} ${runName ? '' : pc.dim(run) + '  '}${details || ''}`,
      );
    }
    if (runName) {
      const dir = path.join(runs.DRAFTS_DIR, runName);
      for (const f of [runs.FILES.issues, runs.FILES.approved]) {
        const v = await listVersions(dir, f);
        if (v.length) console.log(pc.dim(`\n${f}: ${v.length} saved version(s) in ${path.join(dir, 'history')}`));
      }
    }
    console.log(pc.dim(`\nFull log: ${LOG_FILE}`));
  });

program.parseAsync().catch((err) => {
  if (err?.name === 'ExitPromptError') {
    console.log('\nCancelled.');
    process.exit(130);
  }
  console.error(pc.red(`\nError: ${err.message}`));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
