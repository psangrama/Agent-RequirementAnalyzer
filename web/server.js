#!/usr/bin/env node
// Local web front end for reqagent. The page builds the same commands you would type
// (analyze → review --approve → push) and this server runs them. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT); // so drafts/ and .env resolve exactly as they do for the CLI
const ENV_FILE = process.env.REQAGENT_ENV_FILE || path.join(ROOT, '.env'); // the override is for tests
dotenv.config({ path: ENV_FILE, quiet: true });

// Pick up edits to the model settings in .env without restarting. A setting is only refreshed if it still
// has the value this server loaded from the file, so values set another way (shell, tests) are never overridden.
const LIVE_KEYS = ['CLAUDE_MODEL', 'CLAUDE_MAX_TOKENS'];
const readEnvFile = async () => dotenv.parse(await fs.readFile(ENV_FILE).catch(() => ''));
let loadedFromFile = await readEnvFile();
async function refreshEnv() {
  const now = await readEnvFile();
  for (const k of LIVE_KEYS) {
    if (process.env[k] !== loadedFromFile[k]) continue; // set elsewhere: leave it alone
    if (now[k] === undefined) delete process.env[k];
    else process.env[k] = now[k];
  }
  loadedFromFile = { ...loadedFromFile, ...Object.fromEntries(LIVE_KEYS.map((k) => [k, now[k]])) };
}

const { listRuns, readJson, FILES, DRAFTS_DIR } = await import('../src/runs.js');
const { orderItems } = await import('../src/schema.js');
const { listModels, configuredModel, resolveModel, DEFAULT_MODEL, KNOWN_MODELS } = await import('../src/models.js');
const { readLog, listVersions } = await import('../src/history.js');
const { friendlyTitle, runDate, recommended, estimate, itemTimeline } = await import('./helpers.js');
const { writeJson } = await import('../src/runs.js');
const { loadRun } = await import('../src/conductor/stories.js');
const { createGithub } = await import('../src/conductor/github-state.js');
const { readStates } = await import('../src/conductor/dispatch.js');

const PORT = Number(process.argv[2] || process.env.PORT || 3000); // an explicit argument beats the environment
const CLI = path.join(ROOT, 'bin', 'reqagent.js');
const CONDUCT = path.join(ROOT, 'bin', 'conduct.js');
const REVISE = path.join(ROOT, 'bin', 'revise.js');
const MAX_UPLOAD = 20 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.pdf', '.docx', '.md', '.html', '.htm']);
const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reqagent-web-'));

// --- one job at a time: runs the CLI with an argument list (never through a shell) ---
const jobs = new Map();
const children = new Map();
let current = null; // the foreground job (analyze / approve / push / one conductor check)
let loop = null; //    the background conductor loop, which runs beside foreground jobs

function startJob(label, args, { displayArgs = args, onExit, script = CLI, name = 'reqagent', background = false } = {}) {
  if (!background && current?.status === 'running') {
    const err = new Error(`Another command is still running (${current.label}). Wait for it to finish.`);
    err.status = 409;
    throw err;
  }
  const job = {
    id: crypto.randomUUID(), label, command: [name, ...displayArgs].join(' '), status: 'running',
    log: '', code: null, run: null, startedAt: new Date().toISOString(), endedAt: null,
  };
  jobs.set(job.id, job);
  if (background) loop = job;
  else current = job;
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(job.id, child);
  const add = (d) => (job.log = (job.log + d.toString()).slice(-50_000));
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', (e) => add(`
${e.message}
`));
  child.on('close', async (code, signal) => {
    job.code = code;
    job.endedAt = new Date().toISOString();
    job.status = signal ? 'stopped' : code === 0 ? 'done' : 'failed';
    children.delete(job.id);
    try {
      await onExit?.(job);
    } catch {
      /* ignore */
    }
  });
  return job;
}

// --- helpers ---
const send = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};
const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`File is larger than ${limit / 1024 / 1024} MB.`), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const ID_RE = /^[A-Z][A-Za-z0-9.\-]*$/;
const MODEL_RE = /^[\w .:-]{1,80}$/;

async function requireRun(name) {
  if (!(await listRuns()).includes(name)) throw bad('Run not found.', 404);
  return path.join(DRAFTS_DIR, name);
}

/** Key order and formatting must not matter when comparing an approved item with its draft. */
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Every saved version of issues.json, parsed, oldest first. */
async function loadVersions(dir) {
  const out = [];
  for (const v of await listVersions(dir, FILES.issues)) {
    try {
      out.push({ version: v.version, items: JSON.parse(await fs.readFile(v.path, 'utf8')).items || [] });
    } catch {
      /* skip an unreadable version */
    }
  }
  return out;
}

async function runView(name) {
  const dir = await requireRun(name);
  const issues = await readJson(dir, FILES.issues, null);
  const approved = await readJson(dir, FILES.approved, null);
  const pushed = await readJson(dir, FILES.pushed, {});
  const meta = await readJson(dir, FILES.meta, null).catch(() => null);
  const answers = await readJson(dir, 'answers.json', {}).catch(() => ({}));
  const versions = await loadVersions(dir);
  const original = new Map((versions[0]?.items || []).map((i) => [i.id, canon(i)])); // what Claude first drafted
  return {
    run: name,
    title: friendlyTitle(meta, name),
    model: meta?.model || null,
    createdAt: runDate(meta, name),
    versionCount: versions.length,
    answers,
    summary: issues?.summary || '',
    flags: issues?.flags || [],
    items: orderItems(issues?.items || []).map((it, order) => {
      const { id, type, parent, title, priority, estimate, labels, description, acceptance_criteria, source_refs } = it;
      return {
        order: order + 1, id, type, parent, title, priority, estimate, labels, description, acceptance_criteria, source_refs: source_refs || [],
        modified: original.has(id) && original.get(id) !== canon(it),
        issue: pushed[id]?.number ? { number: pushed[id].number, url: pushed[id].url, skipped: pushed[id].skipped } : null,
      };
    }),
    approved: approved ? approved.items.map((i) => i.id) : null,
    // true when drafts were changed after they were approved, so approving again is needed
    stale: Boolean(approved && approved.items.some((a) => canon(a) !== canon((issues?.items || []).find((i) => i.id === a.id)))),
    pushedCount: Object.values(pushed).filter((p) => !p.skipped).length,
    defaults: { repo: process.env.GITHUB_REPO || '' },
  };
}

// --- API ---
async function api(req, res, url) {
  const p = url.pathname;
  let m;

  if (req.method === 'GET' && p === '/api/config') {
    return send(res, 200, {
      repo: process.env.GITHUB_REPO || '',
      hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
      hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
    });
  }
  // The same list `reqagent models` shows, for the page's model picker.
  if (req.method === 'GET' && p === '/api/models') {
    let list = { models: [], live: false };
    try {
      const { makeClient } = await import('../src/analyzer.js');
      list = await listModels(makeClient());
    } catch {
      /* no API key or no network: the page falls back to the shortcuts */
    }
    const wanted = configuredModel();
    let def = DEFAULT_MODEL;
    if (!['pick', '?'].includes(wanted.toLowerCase())) {
      try {
        const { makeClient } = await import('../src/analyzer.js');
        def = await resolveModel(makeClient(), wanted, { interactive: false });
      } catch {
        def = wanted;
      }
    }
    return send(res, 200, { ...list, default: def, recommended: recommended(list.models.length ? list.models : KNOWN_MODELS) });
  }
  // Rough cost and time per recommended model for a document of the given size (all estimates).
  if (req.method === 'GET' && p === '/api/estimate') {
    const bytes = Math.max(0, Number(url.searchParams.get('bytes')) || 0);
    const ext = (url.searchParams.get('ext') || '').toLowerCase();
    const maxTokens = Number(process.env.CLAUDE_MAX_TOKENS) || undefined;
    return send(res, 200, { estimates: estimate({ bytes, ext, maxTokens }, recommended(KNOWN_MODELS)) });
  }
  if (req.method === 'GET' && p === '/api/runs') {
    const names = (await listRuns()).reverse();
    const runs = [];
    for (const name of names) {
      const dir = path.join(DRAFTS_DIR, name);
      const pushed = await readJson(dir, FILES.pushed, {}).catch(() => ({}));
      const issues = await readJson(dir, FILES.issues, null).catch(() => null);
      const stage = Object.keys(pushed).length ? 'pushed' : (await readJson(dir, FILES.approved, null).catch(() => null)) ? 'approved' : issues ? 'drafted' : 'failed';
      const meta = await readJson(dir, FILES.meta, null).catch(() => null);
      runs.push({ name, stage, title: friendlyTitle(meta, name), createdAt: runDate(meta, name), items: issues?.items?.length ?? 0 });
    }
    return send(res, 200, { runs });
  }
  // Give a run a name people recognise instead of its timestamp folder.
  if (req.method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/rename$/.exec(p))) {
    const run = decodeURIComponent(m[1]);
    const dir = await requireRun(run);
    const { title } = JSON.parse((await readBody(req, 5_000)).toString() || '{}');
    if (typeof title !== 'string' || !title.trim() || title.length > 80) throw bad('Enter a name of 1 to 80 characters.');
    const meta = await readJson(dir, FILES.meta, null);
    if (!meta) throw bad('This run has no details to rename.', 409);
    await writeJson(dir, FILES.meta, { ...meta, title: title.trim() });
    return send(res, 200, { ok: true, title: title.trim() });
  }
  // Answers to the "requirements to clarify" questions; they feed the next regenerate.
  if (req.method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/answers$/.exec(p))) {
    const run = decodeURIComponent(m[1]);
    const dir = await requireRun(run);
    const { answers } = JSON.parse((await readBody(req, 100_000)).toString() || '{}');
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw bad('Nothing to save.');
    const clean = {};
    for (const [k, v] of Object.entries(answers)) {
      if (!/^\d{1,3}$/.test(k) || typeof v !== 'string') throw bad('Invalid answer.');
      if (v.length > 1000) throw bad('An answer is too long (1000 characters at most).');
      if (v.trim()) clean[k] = v.trim();
    }
    await writeJson(dir, 'answers.json', clean);
    const { logEvent } = await import('../src/history.js');
    await logEvent('clarify', run, `${Object.keys(clean).length} answer(s) saved`);
    return send(res, 200, { ok: true, answers: clean });
  }
  // Every version of one item, for the "what changed" view.
  if (req.method === 'GET' && (m = /^\/api\/runs\/([^/]+)\/history\/([^/]+)$/.exec(p))) {
    const dir = await requireRun(decodeURIComponent(m[1]));
    const id = decodeURIComponent(m[2]);
    if (!ID_RE.test(id)) throw bad('Unknown item.');
    return send(res, 200, { id, versions: itemTimeline(await loadVersions(dir), id, canon) });
  }
  if (req.method === 'GET' && (m = /^\/api\/jobs\/([\w-]+)$/.exec(p))) {
    const job = jobs.get(m[1]);
    return job ? send(res, 200, job) : send(res, 404, { error: 'Unknown job.' });
  }
  if (req.method === 'GET' && (m = /^\/api\/runs\/([^/]+)$/.exec(p))) return send(res, 200, await runView(decodeURIComponent(m[1])));

  if (req.method === 'GET' && p === '/api/activity') {
    const recent = [...jobs.values()].slice(-6).reverse().map(({ log, ...j }) => j);
    const all = [...jobs.values()].slice(-60).map((j, i, arr) => ({ ...j, seq: [...jobs.values()].indexOf(j) + 1, log: j.log.slice(-6000) }));
    return send(res, 200, { current: current && { ...current, log: undefined }, loop: loop && { ...loop, log: undefined }, recent, jobs: all });
  }
  if (req.method === 'GET' && p === '/api/history') {
    const run = url.searchParams.get('run') || undefined;
    const lines = await readLog({ run, limit: 200 });
    const events = lines.reverse().map((l) => {
      const [time, event, runName, ...rest] = l.split(' | ');
      return { time, event: event?.trim(), run: runName, details: rest.join(' | ') };
    });
    return send(res, 200, { events });
  }

  // Conductor: story states straight from GitHub (read-only).
  if (req.method === 'GET' && (m = /^\/api\/runs\/([^/]+)\/conductor$/.exec(p))) {
    const dir = await requireRun(decodeURIComponent(m[1]));
    const repo = url.searchParams.get('repo') || process.env.GITHUB_REPO || '';
    if (!REPO_RE.test(repo)) throw bad('Enter the repository as owner/name.');
    const { stories, excluded } = await loadRun(dir, { ignoreLinkErrors: true });
    const github = createGithub({ repo });
    const states = await readStates(github, stories);
    const rows = [];
    for (const [i, s] of stories.entries()) {
      const { kind, issue } = states.get(s.number);
      const prs = await github.linkedPrs(s.number);
      rows.push({ order: i + 1, id: s.draftId, title: s.title, number: s.number, url: s.url, state: kind, labels: github.names(issue).filter((n) => n.startsWith('quorum:') || n === 'area:ui'), prs });
    }
    const next = rows.find((r) => r.state !== 'done');
    return send(res, 200, {
      rows, next: next?.number ?? null,
      excluded: excluded.map((s) => ({ id: s.draftId, title: s.title, number: s.number })),
      loopRunning: loop?.status === 'running' && loop.run === path.basename(dir),
    });
  }

  if (req.method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/conduct$/.exec(p))) {
    const run = decodeURIComponent(m[1]);
    await requireRun(run);
    const { repo, mode, skipDropped } = JSON.parse((await readBody(req, 10_000)).toString() || '{}');
    if (!REPO_RE.test(repo || '')) throw bad('Enter the repository as owner/name.');
    if (mode === 'stop') {
      const child = loop && children.get(loop.id);
      if (!child) throw bad('The Conductor loop is not running.', 409);
      child.kill();
      return send(res, 200, { ok: true });
    }
    if (!['dry', 'once', 'start'].includes(mode)) throw bad('Unknown mode.');
    if (mode !== 'start' && loop?.status === 'running') throw bad('Stop the Conductor loop first; it is already dispatching.', 409);
    const base = ['--run', run, '--repo', repo, ...(skipDropped ? ['--skip-dropped'] : [])];
    const opts = { script: CONDUCT, name: 'reqagent-conduct' };
    if (mode === 'start') {
      if (loop?.status === 'running') throw bad('The Conductor loop is already running.', 409);
      const job = startJob('conductor loop', [...base, '--interval', '30'], { ...opts, background: true });
      job.run = run;
      return send(res, 202, job);
    }
    const job = startJob(mode === 'dry' ? 'conductor dry run' : 'conductor dispatch', [...base, '--once', ...(mode === 'dry' ? ['--dry-run'] : [])], opts);
    return send(res, 202, job);
  }

  // 1. Analyze: the uploaded file is the request body; its name travels in a header.
  if (req.method === 'POST' && p === '/api/analyze') {
    const name = path.basename(decodeURIComponent(req.headers['x-filename'] || ''));
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw bad('Upload a .pdf, .docx, .md or .html file.');
    let model = url.searchParams.get('model') || '';
    if (model && !MODEL_RE.test(model)) throw bad('Invalid model.');
    if (!model && ['pick', '?'].includes(configuredModel().toLowerCase())) model = DEFAULT_MODEL; // .env says "ask every time"; a browser can't be asked mid-run
    const instructions = (url.searchParams.get('instructions') || '').slice(0, 2000);
    if (current?.status === 'running') throw bad(`Another command is still running (${current.label}).`, 409);
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) throw bad('The file is empty.');
    const dest = path.join(uploadDir, name.replace(/[^\w. -]/g, '_'));
    await fs.writeFile(dest, body);
    const before = new Set(await listRuns());
    const args = ['analyze', dest, '--no-review', ...(model ? ['--model', model] : []), ...(instructions ? ['--instructions', instructions] : [])];
    const display = ['analyze', `"${name}"`, '--no-review', ...(model ? ['--model', model] : []), ...(instructions ? ['--instructions', '"…"'] : [])];
    const job = startJob('analyze', args, {
      displayArgs: display,
      onExit: async (j) => {
        const after = (await listRuns()).filter((r) => !before.has(r));
        j.run = after.at(-1) || null;
        await fs.rm(dest, { force: true });
      },
    });
    return send(res, 202, job);
  }

  // 2. Approve: ids are validated, then passed to `review --approve`.
  if (req.method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/approve$/.exec(p))) {
    const run = decodeURIComponent(m[1]);
    await requireRun(run);
    const { ids } = JSON.parse((await readBody(req, 100_000)).toString() || '{}');
    const spec = ids === 'all' ? 'all' : Array.isArray(ids) ? ids.join(',') : '';
    if (!spec || (spec !== 'all' && !ids.every((i) => typeof i === 'string' && ID_RE.test(i)))) throw bad('Choose at least one item to approve.');
    return send(res, 202, startJob('approve', ['review', '--run', run, '--approve', spec]));
  }

  // 2b. Change drafts before approving: regenerate with Claude, or edit by hand.
  if (req.method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/regenerate$/.exec(p))) {
    const run = decodeURIComponent(m[1]);
    await requireRun(run);
    const { ids, feedback, model } = JSON.parse((await readBody(req, 100_000)).toString() || '{}');
    const spec = ids === 'all' ? 'all' : Array.isArray(ids) && ids.length && ids.every((i) => typeof i === 'string' && ID_RE.test(i)) ? ids.join(',') : '';
    if (!spec) throw bad('Choose at least one item to regenerate.');
    if (typeof feedback !== 'string' || !feedback.trim()) throw bad('Say what should change.');
    if (feedback.length > 4000) throw bad('Feedback is too long (4000 characters at most).');
    if (model && !MODEL_RE.test(model)) throw bad('Invalid model.');
    const args = ['regenerate', '--run', run, '--ids', spec, '--feedback', feedback.trim(), ...(model ? ['--model', model] : [])];
    const display = ['regenerate', '--run', run, '--ids', spec.length > 60 ? `${spec.split(',').length} items` : spec, '--feedback', '"…"', ...(model ? ['--model', model] : [])];
    return send(res, 202, startJob('regenerate', args, { script: REVISE, name: 'reqagent-revise', displayArgs: display }));
  }
  if (req.method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/edit$/.exec(p))) {
    const run = decodeURIComponent(m[1]);
    await requireRun(run);
    const { id, patch, edits } = JSON.parse((await readBody(req, 400_000)).toString() || '{}');
    // `edits` ({id: changes}) saves several items in one step (inline priority/size, bulk edits); `id` + `patch` edits one.
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const many = edits !== undefined;
    if (many) {
      const keys = isObj(edits) ? Object.keys(edits) : [];
      if (!keys.length || keys.length > 500 || !keys.every((k) => ID_RE.test(k) && isObj(edits[k]))) throw bad('Nothing to change.');
    } else {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('Unknown item.');
      if (!isObj(patch)) throw bad('Nothing to change.');
    }
    const file = path.join(uploadDir, `edit-${crypto.randomUUID()}.json`);
    await fs.writeFile(file, JSON.stringify(many ? edits : patch));
    try {
      const job = startJob('edit', many ? ['apply-edits', '--run', run, '--file', file] : ['edit', '--run', run, '--id', id, '--file', file], {
        script: REVISE, name: 'reqagent-revise',
        displayArgs: many ? ['apply-edits', '--run', run, '--file', `<${Object.keys(edits).length} changed items>`] : ['edit', '--run', run, '--id', id, '--file', '<your changes>'],
        onExit: () => fs.rm(file, { force: true }),
      });
      return send(res, 202, job);
    } catch (err) {
      await fs.rm(file, { force: true });
      throw err;
    }
  }

  // 3. Push: a dry run is always allowed; the real push needs confirm: true.
  if (req.method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/push$/.exec(p))) {
    const run = decodeURIComponent(m[1]);
    const dir = await requireRun(run);
    const { repo, dryRun, confirm } = JSON.parse((await readBody(req, 10_000)).toString() || '{}');
    if (!REPO_RE.test(repo || '')) throw bad('Enter the repository as owner/name.');
    if (!dryRun && confirm !== true) throw bad('Creating issues needs explicit confirmation.');
    if (!(await readJson(dir, FILES.approved, null))) throw bad('Approve the issues first.');
    if ((await runView(run)).stale) throw bad('You changed the drafts after approving them. Approve again before creating issues.');
    const args = ['push', '--run', run, '--repo', repo, ...(dryRun ? ['--dry-run'] : ['--yes'])];
    return send(res, 202, startJob(dryRun ? 'dry run' : 'push', args));
  }

  send(res, 404, { error: 'Not found' });
}

// --- server ---
const html = await fs.readFile(path.join(ROOT, 'web', 'index.html'));
const server = http.createServer(async (req, res) => {
  try {
    // The server can create GitHub issues, so refuse requests that don't come from our own page:
    // DNS-rebinding (odd Host header) and cross-site forms/fetches (missing custom header).
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, { error: 'Forbidden host.' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await refreshEnv();
      if (req.headers['x-reqagent-ui'] !== '1') return send(res, 403, { error: 'Forbidden.' });
      return await api(req, res, url);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    send(res, status, { error: err.message });
  }
});

// HOST is 127.0.0.1 unless you change it. In Docker it is 0.0.0.0 inside the container, and the compose file
// publishes the port on the host's 127.0.0.1 only. The Host-header check above still applies either way.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => console.log(`reqagent web UI: http://localhost:${PORT}`));
const shutdown = () => fs.rm(uploadDir, { recursive: true, force: true }).finally(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
