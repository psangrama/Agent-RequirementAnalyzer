// Renders drafts as a terminal table and as a readable Markdown preview.
import Table from 'cli-table3';
import pc from 'picocolors';
import { orderItems } from './schema.js';

export function autoLabels(item) {
  return [`type:${item.type}`, `priority:${item.priority}`, `size:${item.estimate}`];
}

export function allLabels(item) {
  return [...new Set([...autoLabels(item), ...item.labels.map((l) => l.toLowerCase())])];
}

export function issueBody(item, { parentRef, runName } = {}) {
  const lines = [item.description.trim(), ''];
  if (item.acceptance_criteria.length) {
    lines.push('### Acceptance criteria', ...item.acceptance_criteria.map((c) => `- [ ] ${c}`), '');
  }
  const meta = [];
  if (parentRef) meta.push(`**Parent:** ${parentRef}`);
  meta.push(`**Priority:** ${item.priority} · **Estimate:** ${item.estimate}`);
  if (item.source_refs.length) meta.push(`**Source:** ${item.source_refs.join(', ')}`);
  lines.push('---', meta.join('  \n'), '', `<!-- reqagent:${runName || 'run'}:${item.id} -->`);
  return lines.join('\n');
}

function indent(item) {
  return item.type === 'epic' ? '' : item.type === 'story' ? '  ' : '    ';
}

function typeTag(type) {
  return type === 'epic' ? pc.magenta('EPIC ') : type === 'story' ? pc.cyan('STORY') : pc.dim('TASK ');
}

function prioTag(p) {
  return p === 'high' ? pc.red(p) : p === 'medium' ? pc.yellow(p) : pc.green(p);
}

export function terminalTable(items, { selected } = {}) {
  const table = new Table({
    head: ['', 'ID', 'Type', 'Title', 'Prio', 'Size', 'Labels'].map((h) => pc.bold(h)),
    wordWrap: true,
    colWidths: [3, 12, 7, 52, 8, 6, 22],
    style: { head: [], border: ['grey'] },
  });
  for (const it of orderItems(items)) {
    const mark = selected ? (selected.has(it.id) ? pc.green('✔') : pc.red('✘')) : '';
    table.push([mark, it.id, typeTag(it.type), indent(it) + it.title, prioTag(it.priority), it.estimate, it.labels.join(', ')]);
  }
  return table.toString();
}

export function counts(items) {
  const c = { epic: 0, story: 0, task: 0 };
  for (const it of items) c[it.type]++;
  const n = (k, one, many) => `${c[k]} ${c[k] === 1 ? one : many}`;
  return `${n('epic', 'epic', 'epics')}, ${n('story', 'story', 'stories')}, ${n('task', 'task', 'tasks')} (${items.length} issues)`;
}

export function previewMarkdown(draft, meta) {
  const items = orderItems(draft.items);
  const out = [
    `# Issue preview — ${meta.sourceName}`,
    '',
    `Generated ${meta.createdAt} with ${meta.model}. **Nothing has been created on GitHub yet.**`,
    '',
    `**${counts(items)}**`,
    '',
    '## Summary',
    '',
    draft.summary,
    '',
  ];
  if (draft.flags.length) {
    out.push('## ⚠ Requirements to clarify', '', '| Source | Problem | Suggested question |', '|---|---|---|');
    for (const f of draft.flags) out.push(`| ${esc(f.source_ref)} | ${esc(f.problem)} | ${esc(f.suggestion)} |`);
    out.push('');
  }
  out.push('## Overview', '', '| ID | Type | Title | Priority | Size |', '|---|---|---|---|---|');
  for (const it of items)
    out.push(
      `| ${it.id} | ${it.type} | ${'&nbsp;&nbsp;'.repeat((indent(it).length / 2) * 2)}${esc(it.title)} | ${it.priority} | ${it.estimate} |`,
    );
  out.push('', '## Issues', '');
  for (const it of items) {
    const h = it.type === 'epic' ? '###' : it.type === 'story' ? '####' : '#####';
    out.push(
      `${h} ${it.id} · ${it.title}`,
      '',
      `\`${allLabels(it).join('` `')}\``,
      '',
      issueBody(it, { parentRef: it.parent ? `${it.parent}` : null, runName: meta.runName }),
      '',
    );
  }
  return out.join('\n');
}

function esc(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
