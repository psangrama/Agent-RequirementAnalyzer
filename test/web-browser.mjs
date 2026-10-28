// Browser test for the web UI: drives the real page in headless Chrome/Edge through the DevTools protocol.
// Skips itself when no browser is installed. Run with `node test/web-browser.mjs`.
// Set SHOT_DIR=<folder> to also save screenshots.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const browser = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));
if (!browser) {
  console.log('- web browser test skipped (no Chrome or Edge found; set CHROME_PATH)');
  process.exit(0);
}

const drafts = fs.mkdtempSync(path.join(os.tmpdir(), 'reqagent-browser-test-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reqagent-browser-profile-'));
const shots = process.env.SHOT_DIR;
if (shots) fs.mkdirSync(shots, { recursive: true });
const env = {
  ...process.env, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://localhost:4010', GITHUB_TOKEN: 'test',
  GITHUB_API_URL: 'http://localhost:4020', REQAGENT_DRAFTS_DIR: drafts, NO_PROXY: 'localhost', no_proxy: 'localhost', NO_COLOR: '1', CLAUDE_MODEL: 'sonnet', GITHUB_REPO: '',
};
const procs = [];
const start = (cmd, args, e = env) => {
  const p = spawn(cmd, args, { env: e, stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(p);
  return new Promise((r) => p.stdout.once('data', () => r(p)));
};

// ---- seed a realistic 26-item run (3 epics, 8 stories, 15 tasks) with questions to clarify ----
const RUN = '2026-10-28-09-15-00_payments-prd';
const mk = (id, type, parent, title, priority, estimate, ref) => ({
  id, type, parent, title, description: `Details for ${title}.`, acceptance_criteria: type === 'epic' ? [] : [`${title} works as described`],
  labels: ['backend'], priority, estimate, source_refs: [ref],
});
const items = [];
const prios = ['high', 'medium', 'medium', 'low', 'high', 'medium', 'low', 'medium'];
let n = 0, tasksLeft = 15;
[3, 3, 2].forEach((stories, e) => {
  items.push(mk(`E${e + 1}`, 'epic', null, `Epic number ${e + 1} capability`, 'high', 'XL', `FR-${e + 1}`));
  for (let s = 1; s <= stories; s++) {
    const sid = `E${e + 1}.S${s}`;
    items.push(mk(sid, 'story', `E${e + 1}`, `Story ${sid} behaviour`, prios[n % prios.length], 'M', `FR-${e + 1}`));
    const t = Math.min(tasksLeft, n < 7 ? 2 : 1);
    for (let k = 1; k <= t; k++) items.push(mk(`${sid}.T${k}`, 'task', sid, `Task ${sid}.T${k} work item`, prios[(n + k) % prios.length], 'S', `FR-${e + 1}`));
    tasksLeft -= t; n++;
  }
});
assert.equal(items.length, 26);
const dir = path.join(drafts, RUN);
fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
const draft = {
  summary: 'A payments platform covering checkout, refunds and reporting.',
  flags: [
    { source_ref: 'FR-1', problem: 'Mobile support is not mentioned.', suggestion: 'Should the checkout work on mobile?' },
    { source_ref: 'NFR-1', problem: '"Fast" is not measurable.', suggestion: 'What response time is acceptable?' },
  ],
  items,
};
fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify(draft, null, 2));
fs.writeFileSync(path.join(dir, 'history', 'issues.v001.json'), JSON.stringify(draft, null, 2));
fs.writeFileSync(path.join(dir, 'source.md'), '# Payments PRD\n');
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ runName: RUN, sourceName: 'payments-prd.pdf', sourceFile: 'x', format: 'pdf', model: 'claude-sonnet-5-5', createdAt: '2026-10-28T09:15:00.000Z' }));

// ---- minimal DevTools-protocol client ----
let ws, msgId = 0;
const pending = new Map(), errors = [];
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n${expression}`);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expression, what, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expression).catch(() => false)) return;
    await sleep(120);
  }
  throw new Error(`timed out waiting for: ${what}`);
};
const shot = async (name) => {
  if (!shots) return;
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(data, 'base64'));
};
const clickText = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) throw new Error('no ${sel} starting with ' + ${JSON.stringify(text)}); b.click(); return true; })()`);

try {
  await start(process.execPath, [path.join(root, 'test/mock-servers.js')]);
  await start(process.execPath, [path.join(root, 'web/server.js'), '3200']);
  const chrome = spawn(browser, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--window-size=1440,1000', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  procs.push(chrome);
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    target = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
  }
  assert.ok(target, 'browser started');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value || a.description).join(' '));
  };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://localhost:3200/#runs/${RUN}` });
  await ev('window.confirm = () => true; true').catch(() => {});

  // ---- Runs page: full-width tree, friendly name, stepper marks ----
  await waitFor(`document.querySelectorAll('table.issues tbody tr').length === 26`, '26 issue rows');
  await ev('window.confirm = () => true; true');
  assert.equal(await ev(`document.querySelector('.runhead h2').textContent`), 'Payments Prd', 'friendly run name, not the timestamp slug');
  assert.match(await ev(`document.querySelector('.stepper').textContent`), /● 1 Review & approve.*○ 2 Create on GitHub.*○ 3 Conduct/s, 'stepper marks done / current / pending');
  assert.ok(await ev(`document.querySelector('.runs').classList.contains('list-collapsed')`), 'the run list tucks away once a run is open');
  assert.ok((await ev(`document.querySelector('table.issues').getBoundingClientRect().width`)) > 850, 'the issue tree uses the full width');
  assert.equal(await ev(`document.querySelectorAll('table.issues tbody input[type=checkbox]').length`), 26, 'tasks have checkboxes too');
  assert.match(await ev(`document.body.innerText`), /Priority mix: \d+ high · \d+ medium · \d+ low/);
  await shot('1-runs');

  // run list is collapsible
  const w1 = await ev(`document.querySelector('#detail').getBoundingClientRect().width`);
  await ev(`document.querySelector('.runlist .head button').click(); true`);
  assert.equal(await ev(`document.querySelector('.runs').classList.contains('list-collapsed')`), false, 'the list can be expanded again');
  assert.ok((await ev(`document.querySelector('#detail').getBoundingClientRect().width`)) < w1 - 150, 'an open run list takes space from the tree');
  assert.match(await ev(`document.querySelector('.runitem').innerText`), /Payments Prd[\s\S]*26 items/);
  await ev(`document.querySelector('.runlist .head button').click(); true`);

  // ---- clarifications are answerable and saved ----
  assert.match(await ev(`document.querySelector('.clar summary').textContent`), /0 of 2 answered/);
  assert.ok(await ev(`document.querySelector('.clar').open`), 'open while questions are unanswered');
  await ev(`document.querySelector('.q .ans button').click(); true`); // "Yes"
  assert.equal(await ev(`document.querySelector('.q .ans input').value`), 'Yes');
  assert.match(await ev(`document.querySelector('.clar summary').textContent`), /1 of 2 answered/);
  await ev(`(() => { const i = document.querySelectorAll('.q .ans input')[1]; i.value = 'p95 under 300 ms'; i.dispatchEvent(new Event('input')); return true; })()`);
  await waitFor(`fetch('/api/runs/${RUN}', {headers:{'x-reqagent-ui':'1'}}).then(r=>r.json()).then(d => Object.keys(d.answers).length === 2)`, 'answers saved on the server');
  await shot('2-clarifications');

  // ---- task-level selection and the sticky footer ----
  assert.match(await ev(`document.querySelector('.foot').textContent`), /26 selected/);
  await ev(`document.querySelector('table.issues tr.task input[type=checkbox]').click(); true`);
  assert.match(await ev(`document.querySelector('.foot').textContent`), /25 selected/, 'unticking one task leaves it out');
  assert.match(await ev(`document.querySelector('.foot button.btn:not(.secondary)').textContent`), /Approve selected \(25\) → Create on GitHub/);
  await ev(`document.querySelector('table.issues tr.task input[type=checkbox]').click(); true`);
  const footBottom = await ev(`(() => { const f = document.querySelector('.foot').getBoundingClientRect(), m = document.querySelector('#main').getBoundingClientRect(); return Math.abs(f.bottom - m.bottom) < 3; })()`);
  assert.ok(footBottom, 'the footer stays pinned to the bottom of the panel');

  // ---- inline priority change is staged, then saved in one step; item becomes "modified" ----
  await ev(`(() => { const s = document.querySelectorAll('table.issues tbody tr')[1].querySelectorAll('select')[0]; s.value = 'low'; s.dispatchEvent(new Event('change')); return true; })()`);
  assert.match(await ev(`document.querySelector('.foot .pending').textContent`), /1 unsaved change/);
  assert.ok(await ev(`document.querySelector('.foot button.btn:not(.secondary):not(.small)').disabled`), 'cannot approve with unsaved changes');
  await clickText('.foot .pending button', 'Save changes');
  await waitFor(`document.querySelector('table.issues .badge.modified') && !document.querySelector('.foot .pending')`, 'modified badge after saving');

  // ---- bulk edit of the selection ----
  await ev(`(() => { const s = document.querySelector('.bulk select'); s.value = 'medium'; s.dispatchEvent(new Event('change')); return true; })()`);
  assert.match(await ev(`document.querySelector('.foot .pending').textContent`), /26 unsaved change|\d+ unsaved change/);
  await clickText('.foot .pending button', 'Discard');
  assert.equal(await ev(`!document.querySelector('.foot .pending')`), true);

  // ---- editor drawer: side panel keeps your place, shows diff between versions ----
  const scrollBefore = await ev(`document.querySelector('#main').scrollTop = 120; document.querySelector('#main').scrollTop`);
  await ev(`document.querySelectorAll('table.issues tbody tr')[1].querySelector('button.btn').click(); true`);
  await waitFor(`document.querySelector('.drawer')`, 'edit drawer');
  assert.ok(await ev(`document.querySelector('.drawer .df .btn').disabled`), 'Save is disabled until something changes');
  await ev(`(() => { const i = document.querySelector('.drawer input[type=text]'); i.value = 'Story E1.S1 behaviour, reworded'; i.dispatchEvent(new Event('input')); return true; })()`);
  assert.match(await ev(`document.querySelector('.drawer .df').textContent`), /Unsaved changes/);
  await shot('3-drawer');
  await clickText('.drawer .df button', 'Save');
  await waitFor(`!document.querySelector('.drawer')`, 'drawer closes after save');
  await waitFor(`document.querySelector('table.issues tbody').textContent.includes('reworded')`, 'new title in table');
  assert.ok(Math.abs((await ev(`document.querySelector('#main').scrollTop`)) - scrollBefore) < 10, 'your place in the list is kept');
  await ev(`document.querySelectorAll('table.issues tbody tr')[1].querySelector('button.btn').click(); true`);
  await waitFor(`document.querySelector('.tabs button:nth-child(2)').textContent.includes('History (3)')`, 'three versions of this item');
  await ev(`document.querySelector('.tabs button:nth-child(2)').click(); true`);
  assert.ok(await ev(`document.querySelector('.drawer .diff .add') && document.querySelector('.drawer .diff .del')`), 'a diff between versions is shown');
  await shot('4-history-diff');
  await ev(`document.querySelector('.drawer .df .btn.secondary').click(); true`);
  await waitFor(`!document.querySelector('.drawer')`, 'cancel closes');

  // ---- command panel: collapsible, no raw paths or "Next: reqagent ..." hints ----
  const logText = await ev(`document.querySelector('#tl').innerText`);
  assert.doesNotMatch(logText, /[A-Z]:\\|Next: reqagent|\/tmp\//, 'no file paths or CLI hints in the panel');
  await ev(`document.querySelector('#tlToggle').click(); true`);
  assert.ok(await ev(`document.querySelector('#timeline').classList.contains('collapsed') && getComputedStyle(document.querySelector('#tl')).display === 'none'`));
  await waitFor(`document.querySelector('#main').getBoundingClientRect().width > 1200`, 'main panel takes the freed space'); // the grid animates
  await shot('5-collapsed-panel');
  await ev(`document.querySelector('#tlToggle').click(); true`);

  // ---- final confirm wizard: approve → preview → create ----
  await ev(`document.querySelector('#repo').value = 'o/r'; document.querySelector('#repo').dispatchEvent(new Event('input')); true`);
  await clickText('.foot button', 'Approve selected');
  await waitFor(`document.querySelector('.modal')`, 'confirm dialog');
  const dlg = await ev(`document.querySelector('.modal').innerText`);
  assert.equal(await ev(`document.querySelector('.modal input[type=text]').value`), 'o/r', 'the confirm screen shows the repository');
  assert.match(dlg, /26 \(3 epics, 8 stories, 15 tasks\)/, 'confirm screen lists the issue count');
  assert.match(dlg, /Approve 26 selected items[\s\S]*Preview on GitHub[\s\S]*Create 26 issues/);
  await shot('6-confirm');
  await clickText('.modal button', 'Approve & preview');
  await waitFor(`document.querySelectorAll('.modal .steps li.done').length === 2`, 'approve and preview done', 30000);
  assert.match(await ev(`[...document.querySelectorAll('.modal button')].map((b) => b.textContent).join('|')`), /Create 26 issues in o\/r/);
  assert.equal(await ev(`fetch('/api/runs/${RUN}', {headers:{'x-reqagent-ui':'1'}}).then(r=>r.json()).then(d=>d.pushedCount)`), 0, 'nothing created before the last click');
  await clickText('.modal button', 'Create 26 issues');
  await waitFor(`!document.querySelector('.modal')`, 'wizard closes after creating', 30000);
  await waitFor(`document.querySelector('.foot').textContent.includes('already created')`, 'frozen state after create', 30000);
  assert.match(await ev(`document.querySelector('.stepper').textContent`), /✓ 1 Review.*✓ 2 Create.*● 3 Conduct/s, 'steps are marked done');
  assert.match(await ev(`document.querySelector('#tl').innerText`), /Conduct with Quorum →/, 'clickable next step in the command panel');
  await shot('7-created');

  // ---- History: filters, wrapping, empty state ----
  await clickText('#nav button', 'History');
  await waitFor(`document.querySelectorAll('table tbody tr').length > 3`, 'history rows');
  assert.ok(await ev(`document.querySelectorAll('.toolbar select').length === 2`), 'run and event filters');
  const before = await ev(`document.querySelectorAll('table tbody tr').length`);
  await ev(`(() => { const s = document.querySelectorAll('.toolbar select')[1]; s.value = 'approve'; s.dispatchEvent(new Event('change')); return true; })()`);
  assert.ok((await ev(`document.querySelectorAll('table tbody tr').length`)) < before);
  await ev(`(() => { const i = document.querySelector('.toolbar input'); i.value = 'zzz-no-such'; i.dispatchEvent(new Event('input')); return true; })()`);
  assert.match(await ev(`document.querySelector('table tbody').innerText`), /No events match these filters/);
  assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'no horizontal scrolling');
  await ev(`(() => { const i = document.querySelector('.toolbar input'); i.value = ''; i.dispatchEvent(new Event('input')); return true; })()`);
  await shot('8-history');

  // ---- Conductor: empty state without a repo, confirmation before auto-dispatch ----
  await ev(`document.querySelector('#repo').value = ''; document.querySelector('#repo').dispatchEvent(new Event('input')); true`);
  await clickText('#nav button', 'Conductor');
  await waitFor(`document.querySelector('table tbody')`, 'conductor table');
  assert.match(await ev(`document.querySelector('table tbody').innerText`), /Enter the repository/);
  await ev(`document.querySelector('#repo').value = 'o/r'; document.querySelector('#repo').dispatchEvent(new Event('input')); true`);
  await clickText('.row button', 'Start auto-dispatch');
  await waitFor(`document.querySelector('.modal')`, 'auto-dispatch confirmation');
  assert.ok(await ev(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Start auto-dispatch').disabled`), 'cannot start until acknowledged');
  await ev(`document.querySelector('.modal input[type=checkbox]').click(); true`);
  assert.equal(await ev(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Start auto-dispatch').disabled`), false);
  await shot('9-conductor-confirm');
  await ev(`document.querySelector('.modal .btn.secondary').click(); true`);

  // ---- New run: recommended models pinned with rough cost/time ----
  await clickText('#nav button', 'New run');
  await waitFor(`document.querySelectorAll('.mcard').length >= 4`, 'model cards');
  const cards = await ev(`[...document.querySelectorAll('.mcard')].map((c) => c.innerText)`);
  assert.match(cards[0], /Default/);
  assert.match(cards[1], /recommended/i,'first pinned model is the recommended one');
  assert.ok(cards.length >= 4 && cards.length <= 6, 'a handful of pinned models, not every model');
  assert.ok(cards.every((c) => /\$/.test(c)), 'every card shows a price');
  await ev(`(async () => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(200000)], 'big.pdf')); const i = document.querySelector('input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`[...document.querySelectorAll('.mcard .est')].some((e) => /\\d+s|min/.test(e.innerText))`, 'cost and time estimates after choosing a file');
  await shot('10-new-run');

  assert.deepEqual(errors, [], 'no errors in the browser console');
  console.log('✔ web UI browser test passed');
} catch (err) {
  await shot('failure').catch(() => {});
  console.error('browser errors:', errors);
  throw err;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  procs.forEach((p) => p.kill());
  await sleep(300);
  fs.rmSync(drafts, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
