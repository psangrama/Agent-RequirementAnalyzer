// Offline test for the Conductor: fake GitHub, real CLI. Run with `node test/conduct-offline.mjs`.
// Every `--once` call is a fresh process with no memory, so each step also proves "restart mid-run resumes".
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const drafts = fs.mkdtempSync(path.join(os.tmpdir(), 'conduct-'));
const PORT = 4030;
const api = `http://localhost:${PORT}`;
const env = {
  ...process.env,
  GITHUB_TOKEN: 'test',
  GITHUB_API_URL: api,
  REQAGENT_DRAFTS_DIR: drafts,
  NO_PROXY: 'localhost',
  no_proxy: 'localhost',
  NO_COLOR: '1', // picocolors force-enables color on win32 (see CLAUDE.md)
};
process.env.REQAGENT_DRAFTS_DIR = drafts;
const { fingerprint } = await import('../src/runs.js');

const conduct = (...args) => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin/conduct.js'), ...args, '--repo', 'o/r'], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};
const post = (p, body = {}) => fetch(api + p, { method: 'POST', body: JSON.stringify(body) });
const state = async () => (await fetch(api + '/__state')).json();
const issue = async (n) => (await state()).issues.find((i) => i.number === n);
const labelsOf = async (n) => (await issue(n)).labels.map((l) => l.name).sort();
const complete = (n, extra = {}) => post(`/__patch/${n}`, { state: 'closed', state_reason: 'completed', labels: [], ...extra });

const item = (id, type, parent, extra = {}) => ({
  id, type, parent, title: `Title of ${id}`, description: 'd', acceptance_criteria: ['c'], labels: [], priority: 'medium', estimate: 'S', source_refs: [], ...extra,
});
const baseItems = [
  item('E1', 'epic', null),
  item('E1.S1', 'story', 'E1', { labels: ['backend'] }),
  item('E1.S1.T1', 'task', 'E1.S1'),
  item('E1.S2', 'story', 'E1', { labels: ['backend'] }),
  item('E1.S3', 'story', 'E1', { labels: ['frontend'] }),
];
const ref = (n, extra = {}) => ({ number: n, id: 9000 + n, url: `http://gh/o/r/issues/${n}`, ...extra });
const basePushed = { E1: ref(1), 'E1.S1': ref(2), 'E1.S1.T1': ref(3), 'E1.S2': ref(4), 'E1.S3': ref(5) };
const seedIssues = [1, 2, 3, 4, 5].map((n) => ({ number: n, id: 9000 + n, title: `Title ${n}`, body: '' }));

let runCount = 0;
/** Writes a run folder like reqagent review + push would have, and seeds the fake GitHub. */
async function setup({ items = baseItems, pushed = basePushed, issues = seedIssues, tamper = false } = {}) {
  const name = `run${++runCount}`;
  const dir = path.join(drafts, name);
  fs.mkdirSync(dir, { recursive: true });
  const approved = { items, fingerprint: fingerprint(items) };
  if (tamper) approved.fingerprint = 'nope';
  fs.writeFileSync(path.join(dir, 'approved.json'), JSON.stringify(approved));
  fs.writeFileSync(path.join(dir, 'pushed.json'), JSON.stringify(pushed));
  await post('/__seed', { issues });
  return name;
}

const mock = spawn(process.execPath, [path.join(root, 'test/mock-github-conductor.js'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => mock.stdout.once('data', r));

try {
  // 1. Happy path: three stories, one at a time, in order; the epic closes after the last.
  let run = await setup();
  let r = conduct('--run', run, '--once');
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /Dispatched #2/);
  assert.deepEqual(await labelsOf(2), ['quorum:queued']);
  assert.deepEqual(await labelsOf(4), []);
  assert.match((await state()).comments[0].body, /run `run1`, story 1 of 3/);

  r = conduct('--run', run, '--once'); // nothing finished: no second dispatch, no duplicate comment
  assert.equal(r.code, 3);
  assert.match(r.out, /waiting: #2 .*quorum:queued/);
  assert.equal((await state()).comments.length, 1);

  await post('/__patch/2', { labels: ['quorum:in-review'] }); // Quorum opened a PR: still not complete
  r = conduct('--run', run, '--once');
  assert.match(r.out, /waiting/);
  assert.deepEqual(await labelsOf(4), []);

  await complete(2);
  r = conduct('--run', run, '--once');
  assert.match(r.out, /Dispatched #4/);
  assert.deepEqual(await labelsOf(4), ['quorum:queued']);
  assert.deepEqual(await labelsOf(5), []);

  await complete(4);
  r = conduct('--run', run, '--once');
  assert.match(r.out, /Dispatched #5/);
  assert.deepEqual(await labelsOf(5), ['area:ui', 'quorum:queued'], 'frontend story gets area:ui');

  await post('/__patch/5', { timeline: [{ event: 'cross-referenced', source: { issue: { number: 12, pull_request: { merged_at: '2026-01-01' } } } }] });
  await complete(5);
  r = conduct('--run', run, '--once');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Closed epic #1/);
  assert.match(r.out, /All 3 stories are completed/);
  assert.equal((await issue(1)).state, 'closed');
  const epicComment = (await state()).comments.find((c) => c.issue === 1);
  assert.match(epicComment.body, /#5 Title of E1\.S3 — #12/);
  const before = (await state()).comments.length;
  assert.equal(conduct('--run', run, '--once').code, 0); // re-running changes nothing
  assert.equal((await state()).comments.length, before);

  // 2. Blocked story waits (exit 2 with --once), then re-queued, then completed.
  run = await setup();
  conduct('--run', run, '--once');
  await post('/__patch/2', { labels: ['quorum:blocked'] });
  r = conduct('--run', run, '--once');
  assert.equal(r.code, 2);
  assert.match(r.out, /#2 .* is blocked/);
  assert.deepEqual(await labelsOf(4), []);
  await post('/__patch/2', { labels: ['quorum:queued'] });
  assert.equal(conduct('--run', run, '--once').code, 3);
  await complete(2);
  assert.match(conduct('--run', run, '--once').out, /Dispatched #4/);

  // 3. Dropped story pauses; --skip-dropped moves on.
  run = await setup();
  await complete(2, { state_reason: 'not_planned' });
  r = conduct('--run', run, '--once');
  assert.equal(r.code, 2);
  assert.match(r.out, /closed as not planned/);
  assert.deepEqual(await labelsOf(4), []);
  r = conduct('--run', run, '--once', '--skip-dropped');
  assert.match(r.out, /Dispatched #4/);

  // 4. A duplicate is excluded by default (and included on request).
  const dupPushed = { ...basePushed, 'E1.S1': ref(1, { skipped: 'duplicate' }) };
  run = await setup({ pushed: dupPushed });
  assert.match(conduct('--run', run, '--once').out, /1 skipped as duplicate[\s\S]*Dispatched #4/);
  run = await setup({ pushed: dupPushed });
  assert.match(conduct('--run', run, '--once', '--include-duplicates').out, /Dispatched #1/);

  // 5. A link error stops everything unless told otherwise.
  const linkPushed = { ...basePushed, 'E1.S2': ref(4, { linkError: 'boom' }) };
  run = await setup({ pushed: linkPushed });
  r = conduct('--run', run, '--once');
  assert.equal(r.code, 1);
  assert.match(r.out, /could not be linked/);
  assert.deepEqual(await labelsOf(2), []);
  assert.match(conduct('--run', run, '--once', '--ignore-link-errors').out, /Dispatched #2/);

  // 6. Another issue already in progress in the repo blocks dispatch (one story at a time per repo).
  run = await setup({ issues: [...seedIssues, { number: 9, id: 9009, title: 'Other work', labels: ['quorum:working'] }] });
  r = conduct('--run', run, '--once');
  assert.match(r.out, /#9 already carries a quorum status label/);
  assert.deepEqual(await labelsOf(2), []);

  // 7. Edited approvals are refused; dry run changes nothing.
  run = await setup({ tamper: true });
  assert.match(conduct('--run', run, '--once').out, /changed after approval/);
  run = await setup();
  r = conduct('--run', run, '--once', '--dry-run');
  assert.match(r.out, /would dispatch #2/);
  assert.deepEqual(await labelsOf(2), []);
  assert.equal((await state()).comments.length, 0);

  // 8. Status table.
  run = await setup();
  await complete(2);
  await post('/__patch/4', { labels: ['quorum:working'] });
  r = conduct('status', '--run', run);
  assert.match(r.out, /Title of E1\.S1[\s\S]*done/);
  assert.match(r.out, /Title of E1\.S2[\s\S]*working/);
  assert.match(r.out, /Title of E1\.S3[\s\S]*pending/);

  // 9. Loop mode: one long-running Conductor sees stories completed and finishes with exit 0.
  run = await setup();
  const loop = spawn(process.execPath, [path.join(root, 'bin/conduct.js'), '--run', run, '--repo', 'o/r', '--interval', '0.2'], { env });
  let loopOut = '';
  loop.stdout.on('data', (d) => (loopOut += d));
  const loopExit = new Promise((res) => loop.on('exit', res));
  for (const n of [2, 4, 5]) {
    for (let i = 0; i < 100 && !(await labelsOf(n)).includes('quorum:queued'); i++) await new Promise((x) => setTimeout(x, 100));
    assert.ok((await labelsOf(n)).includes('quorum:queued'), `loop should queue #${n}`);
    await complete(n);
  }
  assert.equal(await loopExit, 0, loopOut);
  assert.match(loopOut, /All 3 stories are completed/);

  // 10. Everything shows up in `reqagent history`.
  const hist = spawnSync(process.execPath, [path.join(root, 'bin/reqagent.js'), 'history', '-n', '0'], { env, encoding: 'utf8' });
  for (const ev of ['conduct-dispatch', 'conduct-wait', 'conduct-paused', 'conduct-epic-closed', 'conduct-done']) {
    assert.match(hist.stdout, new RegExp(ev), `history should contain ${ev}`);
  }
  console.log('✔ conductor offline test passed');
} finally {
  mock.kill();
  fs.rmSync(drafts, { recursive: true, force: true });
}
