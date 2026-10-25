// The confirmation step: nothing reaches GitHub until the user approves here.
import path from 'node:path';
import pc from 'picocolors';
import { select, checkbox, input, confirm } from '@inquirer/prompts';
import { FILES, readJson, writeJson, writeText, fingerprint } from './runs.js';
import { validateDraft, orderItems, orphans } from './schema.js';
import { terminalTable, counts, previewMarkdown, issueBody, allLabels } from './preview.js';
import { regenerateItem } from './analyzer.js';
import fs from 'node:fs/promises';
import { logEvent, saveVersion, listVersions } from './history.js';

async function loadDraft(dir) {
  const draft = await readJson(dir, FILES.issues);
  const problems = validateDraft(draft);
  if (problems.length) {
    throw new Error(`issues.json has problems:\n- ${problems.join('\n- ')}\nFix the file (or re-run analyze) and try again.`);
  }
  // If you edited issues.json by hand, keep that as a new numbered version.
  const before = (await listVersions(dir, FILES.issues)).length;
  const version = await saveVersion(dir, FILES.issues);
  if (before > 0 && version > before)
    await logEvent('manual-edit', path.basename(dir), `issues.json edited by hand (saved as v${version})`);
  return draft;
}

/** Drops items whose parent was dropped, repeatedly, and returns what got dropped. */
function cascade(items) {
  const dropped = [];
  let current = items;
  for (;;) {
    const lost = orphans(current);
    if (!lost.length) return { kept: current, dropped };
    dropped.push(...lost);
    const lostIds = new Set(lost.map((i) => i.id));
    current = current.filter((i) => !lostIds.has(i.id));
  }
}

/** "E1,E2.S3" → those items plus everything under them. "all" → everything. */
export function pickByIds(items, spec) {
  if (spec.trim().toLowerCase() === 'all') return items;
  const wanted = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((w) => !items.some((i) => i.id === w));
  if (unknown.length) throw new Error(`Unknown IDs: ${unknown.join(', ')}`);
  const picked = items.filter((i) => wanted.some((w) => i.id === w || i.id.startsWith(w + '.')));
  // Pull in ancestors so a picked story still has its epic.
  const byId = new Map(items.map((i) => [i.id, i]));
  const ids = new Set(picked.map((i) => i.id));
  for (const it of picked) {
    let p = it.parent;
    while (p && !ids.has(p)) {
      ids.add(p);
      p = byId.get(p)?.parent;
    }
  }
  return items.filter((i) => ids.has(i.id));
}

async function approve(dir, meta, items) {
  const ordered = orderItems(items);
  await writeJson(dir, FILES.approved, {
    approvedAt: new Date().toISOString(),
    run: meta.runName,
    fingerprint: fingerprint(ordered),
    items: ordered,
  });
  const version = await saveVersion(dir, FILES.approved);
  await logEvent('approve', meta.runName, `${counts(ordered)} (approval v${version})`);
  console.log(pc.green(`\n✔ Approved ${counts(ordered)}.`));
  console.log(`Saved to ${path.join(dir, FILES.approved)}`);
  console.log(`\nNext, preview what will happen on GitHub:\n  ${pc.bold('reqagent push --repo <owner/name> --dry-run')}`);
  console.log(`Then create the issues:\n  ${pc.bold('reqagent push --repo <owner/name>')}`);
}

function showHeader(draft, dir) {
  console.log(`\n${pc.bold('Drafts:')} ${counts(draft.items)}`);
  console.log(`${pc.bold('Full preview:')} ${path.join(dir, FILES.preview)}`);
  if (draft.flags.length) {
    console.log(pc.yellow(`\n⚠ ${draft.flags.length} requirement(s) need clarification:`));
    for (const f of draft.flags) console.log(pc.yellow(`  • [${f.source_ref}] ${f.problem}`) + pc.dim(`\n      → ${f.suggestion}`));
  }
  console.log('\n' + terminalTable(draft.items));
}

export async function reviewInteractive(dir, { model } = {}) {
  const meta = await readJson(dir, FILES.meta);
  let draft = await loadDraft(dir);
  showHeader(draft, dir);

  for (;;) {
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: `Approve all ${draft.items.length} issues`, value: 'all' },
        { name: 'Choose which issues to create', value: 'pick' },
        { name: 'Show the full text of an issue', value: 'show' },
        { name: 'Rewrite an issue with my feedback (uses Claude)', value: 'regen' },
        { name: "I've edited issues.json — reload it", value: 'reload' },
        { name: 'Show the table again', value: 'table' },
        { name: 'Cancel — create nothing', value: 'cancel' },
      ],
    });

    if (action === 'cancel') {
      console.log('Cancelled. Nothing was approved or created.');
      await logEvent('review-cancel', meta.runName, 'nothing approved');
      return false;
    }
    if (action === 'table') {
      showHeader(draft, dir);
      continue;
    }
    if (action === 'reload') {
      try {
        draft = await loadDraft(dir);
        await writeText(dir, FILES.preview, previewMarkdown(draft, meta));
        console.log(pc.green('Reloaded.'));
        showHeader(draft, dir);
      } catch (err) {
        console.log(pc.red(err.message));
      }
      continue;
    }
    if (action === 'show' || action === 'regen') {
      const id = await select({
        message: 'Which issue?',
        choices: orderItems(draft.items).map((i) => ({ name: `${i.id}  ${i.title}`, value: i.id })),
        pageSize: 15,
      });
      const item = draft.items.find((i) => i.id === id);
      if (action === 'show') {
        console.log(
          `\n${pc.bold(item.title)}\n${pc.dim(allLabels(item).join(', '))}\n\n${issueBody(item, { parentRef: item.parent, runName: meta.runName })}\n`,
        );
        continue;
      }
      const feedback = await input({ message: 'What should change?' });
      if (!feedback.trim()) continue;
      const rewriteModel = model || meta.model;
      console.log(pc.dim(`Asking ${rewriteModel}…`));
      try {
        const source = await fs.readFile(path.join(dir, FILES.source), 'utf8').catch(() => '');
        const siblings = draft.items.filter((i) => i.parent === item.parent && i.id !== item.id);
        const updated = await regenerateItem(item, feedback, { model: rewriteModel, sourceText: source, siblings });
        console.log(
          `\n${pc.bold('Before:')} ${item.title}\n${pc.bold('After:')}  ${updated.title}\n\n${issueBody(updated, { parentRef: updated.parent })}\n`,
        );
        if (await confirm({ message: 'Keep the rewritten version?', default: true })) {
          draft.items = draft.items.map((i) => (i.id === id ? updated : i));
          await writeJson(dir, FILES.issues, draft);
          await writeText(dir, FILES.preview, previewMarkdown(draft, meta));
          const v = await saveVersion(dir, FILES.issues);
          await logEvent(
            'rewrite',
            meta.runName,
            `${id}: "${item.title}" → "${updated.title}" | feedback: ${feedback} | model=${rewriteModel} (saved as v${v})`,
          );
          console.log(pc.green(`Saved (version ${v}; earlier versions are kept in the run's history folder).`));
        }
      } catch (err) {
        console.log(pc.red(err.message));
      }
      continue;
    }

    let chosen = draft.items;
    if (action === 'pick') {
      const ids = await checkbox({
        message: 'Untick anything you do NOT want created (space toggles, enter confirms)',
        choices: orderItems(draft.items).map((i) => ({
          name: `${i.id.padEnd(10)} ${i.type.padEnd(5)} ${i.title}`,
          value: i.id,
          checked: true,
        })),
        pageSize: 20,
        loop: false,
      });
      const { kept, dropped } = cascade(draft.items.filter((i) => ids.includes(i.id)));
      if (dropped.length) {
        console.log(
          pc.yellow(`Also leaving out ${dropped.length} item(s) whose parent you unticked: ${dropped.map((d) => d.id).join(', ')}`),
        );
      }
      chosen = kept;
      if (!chosen.length) {
        console.log('Nothing selected.');
        continue;
      }
      console.log('\n' + terminalTable(draft.items, { selected: new Set(chosen.map((i) => i.id)) }));
    }

    const ok = await confirm({ message: `Approve ${counts(chosen)} for creation on GitHub?`, default: false });
    if (ok) {
      await approve(dir, meta, chosen);
      return true;
    }
  }
}

/** Non-interactive approval, e.g. `review --approve all` or `--approve E1,E3.S2`. */
export async function reviewNonInteractive(dir, spec) {
  const meta = await readJson(dir, FILES.meta);
  const draft = await loadDraft(dir);
  const chosen = pickByIds(draft.items, spec);
  showHeader({ ...draft, items: draft.items }, dir);
  console.log('\n' + terminalTable(draft.items, { selected: new Set(chosen.map((i) => i.id)) }));
  await approve(dir, meta, chosen);
  return true;
}
