#!/usr/bin/env node
// revise — change drafts before approval, without the interactive review menu:
//   regenerate: ask Claude to rewrite chosen items using your feedback
//   edit:       apply your own changes to one item
// Both keep every earlier version in the run's history folder and log the change.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Command } from 'commander';
import pc from 'picocolors';

dotenv.config({ quiet: true });
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

const { resolveRun, readJson, writeJson, writeText, FILES } = await import('../src/runs.js');
const { ItemSchema, validateDraft, orderItems } = await import('../src/schema.js');
const { previewMarkdown } = await import('../src/preview.js');
const { logEvent, saveVersion, listVersions } = await import('../src/history.js');
const { loadAnswers, saveAnswers, answered, answersFeedback, affectedItems } = await import('../src/answers.js');
const { itemChanges } = await import('../src/diff.js');

const EDITABLE = ['title', 'description', 'acceptance_criteria', 'labels', 'priority', 'estimate'];

async function load(runName) {
  const dir = await resolveRun(runName);
  const meta = await readJson(dir, FILES.meta);
  const draft = await readJson(dir, FILES.issues);
  const problems = validateDraft(draft);
  if (problems.length) throw new Error(`issues.json has problems:\n- ${problems.join('\n- ')}`);
  if (await readJson(dir, FILES.pushed, null)) throw new Error('This run was already pushed to GitHub. Changing the drafts now would not change the issues.');
  return { dir, meta, draft, runName: path.basename(dir) };
}

async function save({ dir, meta, draft }, event, runName, details) {
  await writeJson(dir, FILES.issues, draft);
  await writeText(dir, FILES.preview, previewMarkdown(draft, meta));
  const v = await saveVersion(dir, FILES.issues);
  await logEvent(event, runName, `${details} (saved as v${v})`);
  return v;
}

const program = new Command();
program.name('revise').description('Regenerate or edit drafted issues before you approve them.');

program
  .command('regenerate')
  .description('Ask Claude to rewrite the chosen items using your feedback')
  .requiredOption('--run <name>', 'run folder')
  .option('--ids <ids>', '"all" or a comma-separated list such as E1,E1.S2 (with --use-answers: defaults to the items that cite answered requirements)')
  .option('--feedback <text>', 'what should change (optional with --use-answers)')
  .option('--use-answers', 'include your saved answers to the "requirements to clarify" questions as feedback (see: reqagent-revise answers)')
  .option('-m, --model <model>', 'model (default: the one that made the drafts)')
  .action(async (opts) => {
    const ctx = await load(opts.run);
    const { draft, dir, meta, runName } = ctx;
    let feedback = (opts.feedback || '').trim();
    let wantedSpec = opts.ids;
    if (opts.useAnswers) {
      const list = answered(draft.flags, await loadAnswers(dir));
      if (!list.length) throw new Error('No answers saved yet. Add some with: reqagent-revise answers --run <run> --set 0="Yes"');
      feedback = [answersFeedback(list), feedback].filter(Boolean).join('\n\n');
      if (!wantedSpec) {
        const hit = affectedItems(draft.items, list);
        if (!hit.length) throw new Error('No epic or story cites the answered requirements by ID. Pass --ids to choose what to rewrite.');
        wantedSpec = hit.map((i) => i.id).join(',');
      }
    }
    if (!feedback) throw new Error('Say what should change (--feedback), or use --use-answers.');
    if (!wantedSpec) throw new Error('Choose what to rewrite with --ids (an ID list or "all").');
    if (feedback.length > 4000) throw new Error('Feedback is too long (4000 characters at most). Shorten the answers.');
    const all = wantedSpec.trim().toLowerCase() === 'all';
    const wanted = all ? draft.items.map((i) => i.id) : wantedSpec.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = wanted.filter((w) => !draft.items.some((i) => i.id === w));
    if (unknown.length) throw new Error(`Unknown IDs: ${unknown.join(', ')}`);

    const { regenerateItem, makeClient } = await import('../src/analyzer.js');
    const { resolveModel } = await import('../src/models.js');
    const model = opts.model ? await resolveModel(makeClient(), opts.model) : meta.model;
    const source = await fs.readFile(path.join(dir, FILES.source), 'utf8').catch(() => '');
    const targets = orderItems(draft.items).filter((i) => wanted.includes(i.id));
    console.log(`Regenerating ${targets.length} item(s) with ${pc.bold(model)}`);
    console.log(pc.dim(`Feedback: ${feedback}`));

    let failed = 0;
    for (const [n, item] of targets.entries()) {
      try {
        const siblings = draft.items.filter((i) => i.parent === item.parent && i.id !== item.id);
        const updated = await regenerateItem(item, feedback, { model, sourceText: source, siblings });
        draft.items = draft.items.map((i) => (i.id === item.id ? updated : i));
        const v = await save(ctx, 'rewrite', runName, `${item.id}: "${item.title}" → "${updated.title}" | feedback: ${feedback} | model=${model}`);
        console.log(`${pc.green('✔')} [${n + 1}/${targets.length}] ${item.id}: ${item.title} → ${updated.title} (v${v})`);
      } catch (err) {
        failed++;
        console.log(`${pc.red('✘')} [${n + 1}/${targets.length}] ${item.id}: ${err.message}`);
      }
    }
    console.log(failed ? pc.yellow(`\n${failed} item(s) could not be rewritten and were left as they were.`) : pc.green('\n✔ Done. Review the changes, then approve again.'));
    if (failed) process.exitCode = 1;
  });

program
  .command('edit')
  .description('Apply your own changes to one item (a JSON file with any of: ' + EDITABLE.join(', ') + ')')
  .requiredOption('--run <name>', 'run folder')
  .requiredOption('--id <id>', 'item to change, e.g. E1.S2')
  .requiredOption('--file <path>', 'JSON file with the new values')
  .action(async (opts) => {
    const ctx = await load(opts.run);
    const { draft, runName } = ctx;
    const item = draft.items.find((i) => i.id === opts.id);
    if (!item) throw new Error(`Unknown ID: ${opts.id}`);
    const patch = JSON.parse(await fs.readFile(opts.file, 'utf8'));
    const keys = Object.keys(patch);
    const bad = keys.filter((k) => !EDITABLE.includes(k));
    if (bad.length) throw new Error(`These fields can't be edited: ${bad.join(', ')}`);
    const parsed = ItemSchema.safeParse({ ...item, ...patch });
    if (!parsed.success) throw new Error('Invalid change: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const changed = keys.filter((k) => JSON.stringify(item[k]) !== JSON.stringify(parsed.data[k]));
    if (!changed.length) return void console.log('No changes.');
    draft.items = draft.items.map((i) => (i.id === item.id ? parsed.data : i));
    const v = await save(ctx, 'manual-edit', runName, `${item.id} edited: ${changed.join(', ')}`);
    console.log(`${pc.green('✔')} ${item.id} updated (${changed.join(', ')}); saved as version ${v}.\n${pc.dim('Approve again to include this change.')}`);
  });

program
  .command('answers')
  .description('Show the "requirements to clarify" questions, or save your answers to them')
  .requiredOption('--run <name>', 'run folder')
  .option('--set <n=answer>', 'answer question n, e.g. --set 0="Yes, mobile is in scope" (repeatable)', (v, prev) => [...prev, v], [])
  .option('--clear <n>', 'remove the answer to question n (repeatable)', (v, prev) => [...prev, v], [])
  .action(async (opts) => {
    const dir = await resolveRun(opts.run);
    const draft = await readJson(dir, FILES.issues);
    const answers = await loadAnswers(dir);
    let changed = false;
    for (const spec of opts.set) {
      const m = /^(\d+)=([\s\S]*)$/.exec(spec);
      if (!m || !draft.flags[Number(m[1])]) throw new Error(`Can't use "${spec}". Use --set <n>=<answer> with n from 0 to ${draft.flags.length - 1}.`);
      if (m[2].length > 1000) throw new Error('An answer is too long (1000 characters at most).');
      if (m[2].trim()) answers[m[1]] = m[2].trim();
      else delete answers[m[1]];
      changed = true;
    }
    for (const n of opts.clear) {
      if (answers[n] !== undefined) {
        delete answers[n];
        changed = true;
      }
    }
    if (changed) {
      await saveAnswers(dir, answers);
      await logEvent('clarify', path.basename(dir), `${Object.keys(answers).length} answer(s) saved`);
    }
    if (!draft.flags.length) return void console.log('Nothing to clarify: Claude flagged no requirements for this run.');
    draft.flags.forEach((f, n) => {
      const a = answers[String(n)];
      console.log(`${pc.bold(String(n))}  [${f.source_ref}] ${f.problem}\n   ${pc.dim('Q:')} ${f.suggestion}\n   ${pc.dim('A:')} ${a ? pc.green(a) : pc.yellow('(unanswered)')}`);
    });
    if (changed) console.log(pc.dim('\nSaved. Rewrite the affected items with: reqagent-revise regenerate --run <run> --use-answers'));
  });

program
  .command('rename')
  .description('Give a run a readable name (shown by "reqagent runs" and in the web page)')
  .requiredOption('--run <name>', 'run folder')
  .requiredOption('--title <text>', 'new name, 1 to 80 characters')
  .action(async (opts) => {
    const title = opts.title.trim();
    if (!title || title.length > 80) throw new Error('Enter a name of 1 to 80 characters.');
    const dir = await resolveRun(opts.run);
    const meta = await readJson(dir, FILES.meta);
    await writeJson(dir, FILES.meta, { ...meta, title });
    console.log(`${pc.green('✔')} Renamed to "${title}".`);
  });

program
  .command('diff')
  .description('Show what changed in the drafts between two saved versions (all items, or one with --id)')
  .requiredOption('--run <name>', 'run folder')
  .option('--id <id>', 'show the field-by-field changes of this item')
  .option('--from <n>', "older version number (default: the first, Claude's original draft)", (v) => parseInt(v, 10))
  .option('--to <n>', 'newer version number (default: the latest)', (v) => parseInt(v, 10))
  .action(async (opts) => {
    const dir = await resolveRun(opts.run);
    const versions = await listVersions(dir, FILES.issues);
    if (versions.length < 2) return void console.log("No changes yet: there is only one saved version (Claude's original draft).");
    const pick = (n, fallback) => {
      const v = n === undefined ? fallback : versions.find((x) => x.version === n);
      if (!v) throw new Error(`No version ${n}. Saved versions: ${versions.map((x) => x.version).join(', ')}`);
      return v;
    };
    const from = pick(opts.from, versions[0]);
    const to = pick(opts.to, versions.at(-1));
    const load = async (v) => new Map(JSON.parse(await fs.readFile(v.path, 'utf8')).items.map((i) => [i.id, i]));
    const [a, b] = [await load(from), await load(to)];
    console.log(pc.dim(`v${from.version} → v${to.version}`));
    if (opts.id) {
      if (!a.has(opts.id) && !b.has(opts.id)) throw new Error(`Unknown ID: ${opts.id}`);
      const changes = itemChanges(a.get(opts.id) || {}, b.get(opts.id) || {});
      for (const c of changes) {
        console.log(pc.bold(`  ${c.label}`));
        for (const [t, line] of c.diff) console.log(t === 'add' ? pc.green(`    + ${line}`) : t === 'del' ? pc.red(`    - ${line}`) : pc.dim(`      ${line}`));
      }
      if (!changes.length) console.log(`No difference between these versions for ${opts.id}.`);
      return;
    }
    let n = 0;
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      if (!a.has(id)) { console.log(pc.green(`+ ${id} added: ${b.get(id).title}`)); n++; continue; }
      if (!b.has(id)) { console.log(pc.red(`- ${id} removed: ${a.get(id).title}`)); n++; continue; }
      const fields = itemChanges(a.get(id), b.get(id)).map((c) => c.label.toLowerCase());
      if (fields.length) {
        console.log(`~ ${id} ${a.get(id).title}\n    ${pc.dim('changed: ' + fields.join(', '))}`);
        n++;
      }
    }
    console.log(n ? pc.dim(`\n${n} item(s) changed. Details: reqagent-revise diff --run <run> --id <id>`) : 'No difference between these versions.');
  });

program
  .command('apply-edits')
  .description('Apply changes to several items in one step (a JSON file mapping each ID to its changes; same fields as "edit")')
  .requiredOption('--run <name>', 'run folder')
  .requiredOption('--file <path>', 'JSON file such as {"E1.S1": {"priority": "low"}, "E1.S2": {"estimate": "M"}}')
  .action(async (opts) => {
    const ctx = await load(opts.run);
    const { draft, runName } = ctx;
    const edits = JSON.parse(await fs.readFile(opts.file, 'utf8'));
    const ids = Object.keys(edits);
    if (!ids.length) throw new Error('Nothing to change.');
    const unknown = ids.filter((w) => !draft.items.some((i) => i.id === w));
    if (unknown.length) throw new Error(`Unknown IDs: ${unknown.join(', ')}`);
    let changedItems = 0;
    const touched = new Set();
    const next = draft.items.map((item) => {
      const patch = edits[item.id];
      if (!patch) return item;
      const bad = Object.keys(patch).filter((k) => !EDITABLE.includes(k));
      if (bad.length) throw new Error(`${item.id}: these fields can't be edited: ${bad.join(', ')}`);
      const parsed = ItemSchema.safeParse({ ...item, ...patch });
      if (!parsed.success) throw new Error(`Invalid change for ${item.id}: ` + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const changed = Object.keys(patch).filter((k) => JSON.stringify(item[k]) !== JSON.stringify(parsed.data[k]));
      if (changed.length) {
        changedItems++;
        changed.forEach((k) => touched.add(k));
      }
      return parsed.data;
    });
    if (!changedItems) return void console.log('No changes.');
    draft.items = next;
    const v = await save(ctx, 'manual-edit', runName, `${changedItems} item(s) edited: ${[...touched].join(', ')}`);
    console.log(`${pc.green('✔')} ${changedItems} item(s) updated (${[...touched].join(', ')}); saved as version ${v}.\n${pc.dim('Approve again to include these changes.')}`);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(pc.red(`Error: ${err.message}`));
  process.exitCode = 1;
}
