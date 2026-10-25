// Each analysis is a "run" folder under drafts/ holding every file for that file's journey to GitHub.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DRAFTS_DIR = path.resolve(process.env.REQAGENT_DRAFTS_DIR || 'drafts');

export const FILES = {
  meta: 'meta.json',
  source: 'source.md',
  issues: 'issues.json',
  preview: 'preview.md',
  approved: 'approved.json',
  pushed: 'pushed.json',
  report: 'report.md',
};

export async function createRun(sourceFile) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const slug = path
    .basename(sourceFile, path.extname(sourceFile))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  const dir = path.join(DRAFTS_DIR, `${stamp}_${slug}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function listRuns() {
  try {
    const entries = await fs.readdir(DRAFTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function resolveRun(name) {
  if (name) {
    const dir = path.isAbsolute(name) || name.includes(path.sep) ? path.resolve(name) : path.join(DRAFTS_DIR, name);
    await fs.access(dir).catch(() => {
      throw new Error(`Run not found: ${name}`);
    });
    return dir;
  }
  const runs = await listRuns();
  if (!runs.length) throw new Error('No runs yet. Start with: reqagent analyze <file>');
  return path.join(DRAFTS_DIR, runs[runs.length - 1]);
}

export async function readJson(dir, file, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${err.message}`);
    throw err;
  }
}

export async function writeJson(dir, file, data) {
  await fs.writeFile(path.join(dir, file), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function writeText(dir, file, text) {
  await fs.writeFile(path.join(dir, file), text, 'utf8');
}

export async function exists(dir, file) {
  return fs.access(path.join(dir, file)).then(
    () => true,
    () => false,
  );
}

/** Stable fingerprint of the approved items, so push can tell if they were changed after approval. */
export function fingerprint(items) {
  return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
}
