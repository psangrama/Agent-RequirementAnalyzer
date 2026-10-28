// Offline test for the web UI server: real server + real CLI, fake Claude and fake GitHub.
// Run with `node test/web-offline.mjs`.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const drafts = fs.mkdtempSync(path.join(os.tmpdir(), 'reqagent-web-test-'));
const baseEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: 'test',
  ANTHROPIC_BASE_URL: 'http://localhost:4010',
  GITHUB_TOKEN: 'test',
  REQAGENT_DRAFTS_DIR: drafts,
  NO_PROXY: 'localhost',
  no_proxy: 'localhost',
  NO_COLOR: '1',
  CLAUDE_MODEL: 'sonnet',
  GITHUB_REPO: '',
};
const procs = [];
const start = (script, args, env) => {
  const p = spawn(process.execPath, [path.join(root, script), ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(p);
  return new Promise((r) => p.stdout.once('data', () => r(p)));
};

const H = { 'x-reqagent-ui': '1' };
const call = async (port, p, opts = {}) => {
  const res = await fetch(`http://localhost:${port}${p}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const waitJob = async (port, id) => {
  for (let i = 0; i < 200; i++) {
    const { body } = await call(port, `/api/jobs/${id}`);
    if (body.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
};

try {
  // ---------- A. upload → approve → dry run → push, against the mock Claude + mock GitHub ----------
  await start('test/mock-servers.js', [], baseEnv);
  await start('web/server.js', ['3101'], { ...baseEnv, GITHUB_API_URL: 'http://localhost:4020' });

  // Security: no custom header, or a foreign Host, is refused.
  assert.equal((await fetch('http://localhost:3101/api/config')).status, 403);
  const evilStatus = await new Promise((resolve) =>
    http.get({ host: '127.0.0.1', port: 3101, path: '/api/config', headers: { ...H, host: 'evil.example' } }, (r) => resolve(r.statusCode)),
  );
  assert.equal(evilStatus, 403, 'foreign Host header is refused');
  assert.match(await (await fetch('http://localhost:3101/')).text(), /ReqAgent/);

  // The model picker lists what the key can use, and names the default used when none is chosen.
  const models = (await call(3101, '/api/models')).body;
  assert.ok(models.models.some((m) => m.id === 'claude-opus-5-5'));
  assert.equal(models.default, 'claude-sonnet-5-5');

  // Changing the default model in .env takes effect without restarting the server.
  const envFile = path.join(drafts, 'test.env');
  fs.writeFileSync(envFile, 'CLAUDE_MODEL=opus\n');
  const { CLAUDE_MODEL: _unused, ...envNoModel } = baseEnv;
  await start('web/server.js', ['3103'], { ...envNoModel, GITHUB_API_URL: 'http://localhost:4020', REQAGENT_ENV_FILE: envFile });
  assert.equal((await call(3103, '/api/models')).body.default, 'claude-opus-5-5');
  fs.writeFileSync(envFile, 'CLAUDE_MODEL=haiku\n');
  assert.match((await call(3103, '/api/models')).body.default, /haiku/);

  // Bad uploads are rejected before anything runs.
  const badExt = await call(3101, '/api/analyze', { method: 'POST', headers: { 'x-filename': 'x.exe' }, body: 'abc' });
  assert.equal(badExt.status, 400);

  const sample = fs.readFileSync(path.join(root, 'examples/sample-requirements.md'));
  const a = await call(3101, '/api/analyze?model=opus', { method: 'POST', headers: { 'x-filename': 'sample-requirements.md' }, body: sample });
  assert.equal(a.status, 202);
  assert.match(a.body.command, /^reqagent analyze "sample-requirements.md" --no-review --model opus$/);
  assert.equal((await call(3101, '/api/analyze', { method: 'POST', headers: { 'x-filename': 'a.md' }, body: sample })).status, 409, 'one command at a time');
  const done = await waitJob(3101, a.body.id);
  assert.equal(done.status, 'done', done.log);
  assert.ok(done.run, 'the new run is reported');

  const view = (await call(3101, `/api/runs/${done.run}`)).body;
  assert.equal(view.items.length, 6);
  assert.deepEqual(view.items.map((i) => i.order), [1, 2, 3, 4, 5, 6], 'items come back numbered in creation order');
  assert.equal(view.items[0].type, 'epic');
  assert.equal(view.approved, null);

  // Pushing before approving, or without confirmation, is refused.
  assert.equal((await call(3101, `/api/runs/${done.run}/push`, { method: 'POST', body: JSON.stringify({ repo: 'o/r', dryRun: true }) })).status, 400);
  assert.equal((await call(3101, `/api/runs/${done.run}/approve`, { method: 'POST', body: JSON.stringify({ ids: ['E1; rm -rf /'] }) })).status, 400, 'ids are validated');

  // Change drafts before approving: edit by hand, then regenerate with Claude.
  const story = view.items.find((i) => i.type === 'story');
  const ed = await call(3101, `/api/runs/${done.run}/edit`, { method: 'POST', body: JSON.stringify({ id: story.id, patch: { title: 'My own better title', priority: 'high' } }) });
  assert.match(ed.body.command, /^reqagent-revise edit --run .* --id .* --file <your changes>$/);
  assert.equal((await waitJob(3101, ed.body.id)).status, 'done');
  let v2 = (await call(3101, `/api/runs/${done.run}`)).body;
  assert.equal(v2.items.find((i) => i.id === story.id).title, 'My own better title');
  const badEditStart = await call(3101, `/api/runs/${done.run}/edit`, { method: 'POST', body: JSON.stringify({ id: story.id, patch: { id: 'X9' } }) });
  assert.equal(badEditStart.status, 202);
  const badEdit = await waitJob(3101, badEditStart.body.id);
  assert.equal(badEdit.status, 'failed', "ids can't be edited");
  assert.ok(fs.readdirSync(path.join(drafts, done.run, 'history')).filter((n) => n.startsWith('issues.')).length >= 2, 'edit kept an earlier version');

  assert.equal((await call(3101, `/api/runs/${done.run}/regenerate`, { method: 'POST', body: JSON.stringify({ ids: [story.id], feedback: '   ' }) })).status, 400);
  const rg = await call(3101, `/api/runs/${done.run}/regenerate`, { method: 'POST', body: JSON.stringify({ ids: [story.id], feedback: 'Make it about sign-up' }) });
  assert.match(rg.body.command, /^reqagent-revise regenerate --run .* --ids .* --feedback "…"$/);
  const rgDone = await waitJob(3101, rg.body.id);
  assert.equal(rgDone.status, 'done', rgDone.log);
  v2 = (await call(3101, `/api/runs/${done.run}`)).body;
  assert.equal(v2.items.find((i) => i.id === story.id).title, 'Sign up with email, password and verification');
  const ev = (await call(3101, `/api/history?run=${done.run}`)).body.events.map((e) => e.event);
  assert.ok(ev.includes('rewrite') && ev.includes('manual-edit'), 'both changes are in history');

  // ---- UX features: friendly names, modified badges, version history, answers, bulk edits, estimates ----
  const listed = (await call(3101, '/api/runs')).body.runs.find((r) => r.name === done.run);
  assert.equal(listed.title, 'Sample Requirements', 'runs get a readable name, not the timestamp slug');
  assert.ok(listed.items > 0 && listed.createdAt);
  assert.equal(v2.title, 'Sample Requirements');
  assert.ok(v2.items.find((i) => i.id === story.id).modified, 'an edited item is marked modified');
  assert.ok(v2.items.filter((i) => i.modified).length < v2.items.length, 'untouched items are not');
  assert.ok(v2.items.every((i) => Array.isArray(i.source_refs)), 'items carry their source references');

  assert.equal((await call(3101, `/api/runs/${done.run}/rename`, { method: 'POST', body: JSON.stringify({ title: '   ' }) })).status, 400);
  assert.equal((await call(3101, `/api/runs/${done.run}/rename`, { method: 'POST', body: JSON.stringify({ title: 'Payments PRD v2' }) })).status, 200);
  assert.equal((await call(3101, `/api/runs/${done.run}`)).body.title, 'Payments PRD v2');

  const tl = (await call(3101, `/api/runs/${done.run}/history/${story.id}`)).body.versions;
  assert.ok(tl.length >= 3, 'original + manual edit + regenerate are all kept');
  assert.notEqual(tl[0].item.title, tl.at(-1).item.title);
  assert.equal((await call(3101, `/api/runs/${done.run}/history/bad%20id`)).status, 400);

  assert.equal((await call(3101, `/api/runs/${done.run}/answers`, { method: 'POST', body: JSON.stringify({ answers: { x: 'y' } }) })).status, 400, 'answer keys are validated');
  assert.equal((await call(3101, `/api/runs/${done.run}/answers`, { method: 'POST', body: JSON.stringify({ answers: { 0: 'Yes: mobile is in scope', 1: '   ' } }) })).status, 200);
  assert.deepEqual((await call(3101, `/api/runs/${done.run}`)).body.answers, { 0: 'Yes: mobile is in scope' }, 'blank answers are dropped, answers persist');

  // Several inline changes save as one command and one new version.
  const task = view.items.find((i) => i.type === 'task') || view.items.at(-1);
  const verBefore = fs.readdirSync(path.join(drafts, done.run, 'history')).filter((n) => n.startsWith('issues.')).length;
  const many = await call(3101, `/api/runs/${done.run}/edit`, { method: 'POST', body: JSON.stringify({ edits: { [story.id]: { priority: 'low' }, [task.id]: { priority: 'medium', estimate: 'XL' } } }) });
  assert.match(many.body.command, /^reqagent-revise apply-edits --run .* --file <2 changed items>$/);
  assert.equal((await waitJob(3101, many.body.id)).status, 'done');
  const afterMany = (await call(3101, `/api/runs/${done.run}`)).body.items;
  assert.equal(afterMany.find((i) => i.id === story.id).priority, 'low');
  assert.equal(afterMany.find((i) => i.id === task.id).estimate, 'XL');
  assert.equal(fs.readdirSync(path.join(drafts, done.run, 'history')).filter((n) => n.startsWith('issues.')).length, verBefore + 1, 'one save, one version');
  assert.equal((await call(3101, `/api/runs/${done.run}/edit`, { method: 'POST', body: JSON.stringify({ edits: {} }) })).status, 400);
  const badMany = await call(3101, `/api/runs/${done.run}/edit`, { method: 'POST', body: JSON.stringify({ edits: { [story.id]: { id: 'X' } } }) });
  assert.equal((await waitJob(3101, badMany.body.id)).status, 'failed', 'bulk edits cannot change ids');

  const est = (await call(3101, '/api/estimate?bytes=200000&ext=.pdf')).body.estimates;
  assert.ok(est.length >= 3 && est.every((e) => e.costLow > 0 && e.costHigh >= e.costLow && e.secsHigh >= e.secsLow));
  const byFam = (f) => est.find((e) => e.id.includes(f));
  assert.ok(byFam('fable').costHigh > byFam('sonnet').costHigh && byFam('sonnet').costHigh > byFam('haiku').costHigh, 'bigger models cost more');
  assert.ok((await call(3101, '/api/models')).body.recommended.length >= 3, 'recommended models are pinned');

  // ---- the same features from the command line ----
  const cli = (script, ...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(root, script), ...args], { env: baseEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) + String(e.stderr) };
    }
  };
  const rev = (...a) => cli('bin/revise.js', ...a, '--run', done.run);

  // answers: list, set, validate, clear
  let r = rev('answers');
  assert.match(r.out, /NFR-1[\s\S]*Yes: mobile is in scope/, 'the CLI shows the answer saved earlier from the web page');
  r = rev('answers', '--set', '0=Under 300 ms at p95');
  assert.match(r.out, /Under 300 ms at p95/);
  assert.equal(rev('answers', '--set', '9=nope').code, 1, 'unknown question is refused');
  assert.equal(rev('answers', '--set', 'bad').code, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(drafts, done.run, 'answers.json'), 'utf8'))['0'], 'Under 300 ms at p95', 'same file the web page uses');
  assert.equal((await call(3101, `/api/runs/${done.run}`)).body.answers['0'], 'Under 300 ms at p95', 'the page sees answers saved from the CLI');

  // regenerate --use-answers: needs ids when no item cites the answered requirement, uses them as feedback
  r = rev('regenerate', '--use-answers');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /No epic or story cites/);
  assert.equal(rev('regenerate').code, 1, 'needs --ids or --use-answers');
  const draftFile = path.join(drafts, done.run, 'issues.json');
  const draftJson = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  draftJson.flags[0].source_ref = 'FR-1'; // now the story citing FR-1 is "affected"
  fs.writeFileSync(draftFile, JSON.stringify(draftJson, null, 2));
  r = rev('regenerate', '--use-answers');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Regenerating 1 item\(s\)/, 'only the item citing the answered requirement');
  assert.ok(fs.readFileSync(path.join(drafts, 'history.log'), 'utf8').includes('answers from the product owner'), 'answers reached Claude as feedback and are logged');
  assert.equal(rev('answers', '--clear', '0').code, 0);
  assert.equal(rev('regenerate', '--use-answers').code, 1, 'nothing to use once cleared');

  // rename shows up in the CLI list and on the page
  assert.equal(rev('rename', '--title', 'Checkout PRD').code, 0);
  assert.match(cli('bin/reqagent.js', 'runs').out, /Checkout PRD/);
  assert.equal((await call(3101, `/api/runs/${done.run}`)).body.title, 'Checkout PRD');
  assert.equal(rev('rename', '--title', ' ').code, 1);

  // diff: overview, one item, bad version
  r = rev('diff');
  assert.match(r.out, new RegExp(`~ ${story.id.replace(/\./g, '\\.')}[\\s\\S]*changed: title`), 'overview lists changed items');
  r = rev('diff', '--id', story.id);
  assert.match(r.out, /- .*\n[\s\S]*\+ /, 'shows removed and added lines');
  assert.equal(rev('diff', '--from', '99').code, 1);

  const epic = view.items.find((i) => i.type === 'epic').id;
  const ap =await call(3101, `/api/runs/${done.run}/approve`, { method: 'POST', body: JSON.stringify({ ids: [epic] }) });
  assert.match(ap.body.command, new RegExp(`--approve ${epic}$`));
  assert.equal((await waitJob(3101, ap.body.id)).status, 'done');
  const approved = (await call(3101, `/api/runs/${done.run}`)).body.approved;
  assert.ok(approved.includes(epic) && approved.length >= 2);

  assert.equal((await call(3101, `/api/runs/${done.run}`)).body.stale, false);
  // Editing after approval makes the approval stale and blocks pushing until approved again.
  const ed2 = await call(3101, `/api/runs/${done.run}/edit`, { method: 'POST', body: JSON.stringify({ id: epic, patch: { title: 'Epic changed after approval' } }) });
  assert.equal((await waitJob(3101, ed2.body.id)).status, 'done');
  assert.equal((await call(3101, `/api/runs/${done.run}`)).body.stale, true);
  const staleDry = await call(3101, `/api/runs/${done.run}/push`, { method: 'POST', body: JSON.stringify({ repo: 'o/r', dryRun: true }) });
  assert.equal(staleDry.status, 400);
  assert.match(staleDry.body.error, /Approve again/);
  const ap2 = await call(3101, `/api/runs/${done.run}/approve`, { method: 'POST', body: JSON.stringify({ ids: [epic] }) });
  assert.equal((await waitJob(3101, ap2.body.id)).status, 'done');
  assert.equal((await call(3101, `/api/runs/${done.run}`)).body.stale, false);

  assert.equal((await call(3101, `/api/runs/${done.run}/push`, { method: 'POST', body: JSON.stringify({ repo: 'o/r' }) })).status, 400, 'a real push needs confirm');
  assert.equal((await call(3101, `/api/runs/${done.run}/push`, { method: 'POST', body: JSON.stringify({ repo: 'not a repo', dryRun: true }) })).status, 400);

  const dry = await call(3101, `/api/runs/${done.run}/push`, { method: 'POST', body: JSON.stringify({ repo: 'o/r', dryRun: true }) });
  assert.match(dry.body.command, /--dry-run$/);
  const dryDone = await waitJob(3101, dry.body.id);
  assert.match(dryDone.log, /DRY RUN/);
  assert.equal((await call(3101, `/api/runs/${done.run}`)).body.pushedCount, 0, 'dry run creates nothing');

  const push = await call(3101, `/api/runs/${done.run}/push`, { method: 'POST', body: JSON.stringify({ repo: 'o/r', confirm: true }) });
  const pushed = await waitJob(3101, push.body.id);
  assert.equal(pushed.status, 'done', pushed.log);
  assert.match(pushed.log, /Created \d+ issue/);
  assert.ok((await call(3101, `/api/runs/${done.run}`)).body.pushedCount > 0);

  // Once pushed, the drafts are frozen.
  const late = await call(3101, `/api/runs/${done.run}/regenerate`, { method: 'POST', body: JSON.stringify({ ids: 'all', feedback: 'again' }) });
  assert.equal((await waitJob(3101, late.body.id)).status, 'failed');

  const act = (await call(3101, '/api/activity')).body;
  assert.equal(act.current.label, 'regenerate');
  assert.ok(act.recent.length >= 4);
  const hist = (await call(3101, `/api/history?run=${done.run}`)).body.events.map((e) => e.event);
  for (const ev of ['analyze-start', 'approve', 'push-done']) assert.ok(hist.includes(ev), `history has ${ev}`);

  // ---------- B. Conductor panel against the conductor mock ----------
  const { fingerprint } = await (async () => {
    process.env.REQAGENT_DRAFTS_DIR = drafts;
    return import('../src/runs.js');
  })();
  const items = [
    ['E1', 'epic', null], ['E1.S1', 'story', 'E1'], ['E1.S2', 'story', 'E1'],
  ].map(([id, type, parent]) => ({ id, type, parent, title: `Title of ${id}`, description: 'd', acceptance_criteria: ['c'], labels: [], priority: 'medium', estimate: 'S', source_refs: [] }));
  const cdir = path.join(drafts, 'conductor-run');
  fs.mkdirSync(cdir);
  fs.writeFileSync(path.join(cdir, 'approved.json'), JSON.stringify({ items, fingerprint: fingerprint(items) }));
  fs.writeFileSync(path.join(cdir, 'issues.json'), JSON.stringify({ summary: 's', items, flags: [] }));
  const ref = (n) => ({ number: n, id: 9000 + n, url: `http://gh/o/r/issues/${n}` });
  fs.writeFileSync(path.join(cdir, 'pushed.json'), JSON.stringify({ E1: ref(1), 'E1.S1': ref(2), 'E1.S2': ref(3) }));

  await start('test/mock-github-conductor.js', ['4030'], baseEnv);
  await fetch('http://localhost:4030/__seed', { method: 'POST', body: JSON.stringify({ issues: [1, 2, 3].map((n) => ({ number: n, id: 9000 + n, title: `T${n}`, body: '' })) }) });
  await start('web/server.js', ['3102'], { ...baseEnv, GITHUB_API_URL: 'http://localhost:4030' });

  let c = (await call(3102, '/api/runs/conductor-run/conductor?repo=o/r')).body;
  assert.deepEqual(c.rows.map((r) => [r.order, r.number, r.state]), [[1, 2, 'pending'], [2, 3, 'pending']]);
  assert.equal(c.next, 2);

  const dryC = await call(3102, '/api/runs/conductor-run/conduct', { method: 'POST', body: JSON.stringify({ repo: 'o/r', mode: 'dry' }) });
  assert.match(dryC.body.command, /^reqagent-conduct --run conductor-run --repo o\/r --once --dry-run$/);
  assert.match((await waitJob(3102, dryC.body.id)).log, /would dispatch #2/);

  const once = await call(3102, '/api/runs/conductor-run/conduct', { method: 'POST', body: JSON.stringify({ repo: 'o/r', mode: 'once' }) });
  const onceDone = await waitJob(3102, once.body.id);
  assert.equal(onceDone.code, 3, onceDone.log); // dispatched, run still in progress
  c = (await call(3102, '/api/runs/conductor-run/conductor?repo=o/r')).body;
  assert.equal(c.rows[0].state, 'in-flight');
  assert.ok(c.rows[0].labels.includes('quorum:queued'));
  assert.equal(c.rows[1].state, 'pending');

  // Auto-dispatch loop: starts in the background, shows in activity, and can be stopped.
  const st = await call(3102, '/api/runs/conductor-run/conduct', { method: 'POST', body: JSON.stringify({ repo: 'o/r', mode: 'start' }) });
  assert.equal(st.status, 202);
  assert.equal((await call(3102, '/api/runs/conductor-run/conduct', { method: 'POST', body: JSON.stringify({ repo: 'o/r', mode: 'once' }) })).status, 409, 'no manual dispatch while the loop runs');
  assert.equal((await call(3102, '/api/activity')).body.loop.status, 'running');
  assert.equal((await call(3102, '/api/runs/conductor-run/conduct', { method: 'POST', body: JSON.stringify({ repo: 'o/r', mode: 'stop' }) })).status, 200);
  assert.equal((await waitJob(3102, st.body.id)).status, 'stopped');

  const ch = (await call(3102, '/api/history?run=conductor-run')).body.events.map((e) => e.event);
  assert.ok(ch.includes('conduct-dispatch'), 'conductor events appear in history');
  console.log('✔ web UI offline test passed');
} finally {
  procs.forEach((p) => p.kill());
  fs.rmSync(drafts, { recursive: true, force: true });
}
