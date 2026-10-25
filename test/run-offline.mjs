// Offline end-to-end test: fake Claude + fake GitHub, real CLI. Run with `npm test`.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const drafts = fs.mkdtempSync(path.join(os.tmpdir(), 'reqagent-'));
const env = {
  ...process.env,
  ANTHROPIC_API_KEY: 'test',
  ANTHROPIC_BASE_URL: 'http://localhost:4010',
  GITHUB_TOKEN: 'test',
  GITHUB_API_URL: 'http://localhost:4020',
  REQAGENT_DRAFTS_DIR: drafts,
  NO_PROXY: 'localhost',
  no_proxy: 'localhost',
  // picocolors force-enables ANSI color on win32 regardless of TTY, which would
  // break the plain-text assertions below when this test runs on Windows.
  NO_COLOR: '1',
  CLAUDE_MODEL: 'sonnet', // don't depend on the developer's own .env default
};
const cli = (...args) =>
  execFileSync(process.execPath, [path.join(root, 'bin/reqagent.js'), ...args], { env, encoding: 'utf8', stdio: 'pipe' });
const cliFails = (...args) => {
  try {
    cli(...args);
  } catch (e) {
    return e.stderr + e.stdout;
  }
  throw new Error(`expected failure: ${args.join(' ')}`);
};

const mocks = spawn(process.execPath, [path.join(root, 'test/mock-servers.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => mocks.stdout.once('data', r));

try {
  assert.match(cli('models'), /claude-opus-5-5[\s\S]*claude-sonnet-5-5.*current default/);
  assert.match(
    cliFails('analyze', path.join(root, 'examples/sample-requirements.md'), '--model', 'claude-nope-1'),
    /isn't available to your API key/,
  );
  assert.match(cliFails('analyze', path.join(root, 'examples/sample-requirements.md'), '--model', 'pick'), /not an interactive terminal/);
  assert.equal(fs.readdirSync(drafts).length, 0, 'a bad model must not leave an empty run folder');

  const out = cli('analyze', path.join(root, 'examples/sample-requirements.md'), '--model', 'opus', '--no-review');
  assert.match(out, /Analyzing with claude-opus-5-5/);
  const run0 = fs.readdirSync(drafts)[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(drafts, run0, 'meta.json'), 'utf8')).model, 'claude-opus-5-5');
  assert.match(out, /asking Claude to fix/, 'invalid first draft should trigger a fix-up');
  assert.match(out, /2 epics, 3 stories, 1 task/);

  assert.match(cliFails('push', '--repo', 'o/r', '--dry-run'), /Nothing has been approved/);

  cli('review', '--approve', 'all');
  const run = fs.readdirSync(drafts)[0];
  const approvedPath = path.join(drafts, run, 'approved.json');
  const original = fs.readFileSync(approvedPath, 'utf8');
  fs.writeFileSync(approvedPath, original.replace('Create users table', 'Drop users table'));
  assert.match(cliFails('push', '--repo', 'o/r', '--dry-run'), /changed after approval/);
  fs.writeFileSync(approvedPath, original);

  assert.match(cli('push', '--repo', 'o/r', '--dry-run'), /5 to create, 1 skipped/);

  // First push: one sub-issue link fails (GitHub hiccup).
  await fetch('http://localhost:4020/__failLinks?n=1');
  const first = cli('push', '--repo', 'o/r', '--yes', '--delay', '0');
  assert.match(first, /Created 5 issue/);
  assert.match(first, /1 issue\(s\) are not linked/);
  assert.match(fs.readFileSync(path.join(drafts, run, 'report.md'), 'utf8'), /link failed/);

  // Second push: nothing new is created, the failed link is retried.
  const second = cli('push', '--repo', 'o/r', '--yes', '--delay', '0');
  assert.match(second, /0 to create, 1 to re-link, 5 skipped/);
  assert.match(second, /re-linked 1/);
  assert.doesNotMatch(fs.readFileSync(path.join(drafts, run, 'report.md'), 'utf8'), /link failed/);
  assert.match(cli('push', '--repo', 'o/r', '--yes', '--delay', '0'), /0 to create, 6 skipped/);

  const state = await (await fetch('http://localhost:4020/__state')).json();
  assert.equal(state.issues.length, 6);
  assert.equal(state.subIssues.length, 3);
  assert.ok(state.labels.some((l) => l.name === 'type:epic'));

  // Version history: a hand edit and a second approval are both kept.
  const issuesPath = path.join(drafts, run, 'issues.json');
  fs.writeFileSync(issuesPath, fs.readFileSync(issuesPath, 'utf8').replace('Reset a forgotten password', 'Reset a forgotten password by email'));
  cli('review', '--approve', 'all');
  const versions = fs.readdirSync(path.join(drafts, run, 'history')).sort();
  assert.deepEqual(versions, ['approved.v001.json', 'approved.v002.json', 'issues.v001.json', 'issues.v002.json']);

  // A failed analysis is recorded, listed, and can be cleaned up.
  await fetch('http://localhost:4010/__failNext');
  assert.match(cliFails('analyze', path.join(root, 'examples/sample-requirements.md'), '--no-review'), /simulated failure/);
  assert.match(cli('runs'), /failed/);
  assert.match(cli('runs', '--clean', '--yes'), /Deleted 1 unfinished run/);
  assert.equal(fs.readdirSync(drafts).filter((n) => !n.endsWith('.log')).length, 1);

  const log = cli('history', '-n', '0');
  for (const ev of ['analyze-start', 'analyze-done', 'approve', 'push-start', 'push-done', 'manual-edit', 'analyze-failed', 'clean']) {
    assert.match(log, new RegExp(ev), `history should contain ${ev}`);
  }
  assert.match(cli('history', '--run', run), /issues.json: 2 saved version/);
  console.log('✔ offline end-to-end test passed');
} finally {
  mocks.kill();
  fs.rmSync(drafts, { recursive: true, force: true });
}
