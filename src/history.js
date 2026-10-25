// Keeps a record of what happened: one shared log for all runs, plus numbered copies of
// every version of a run's drafts and approvals.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DRAFTS_DIR } from './runs.js';

export const LOG_FILE = path.join(DRAFTS_DIR, 'history.log');
const VERSIONS_DIR = 'history';

/** Appends one line to drafts/history.log. Never throws: history must not break the real work. */
export async function logEvent(event, run, details = '') {
  try {
    await fs.mkdir(DRAFTS_DIR, { recursive: true });
    const line = `${new Date().toISOString()} | ${event.padEnd(14)} | ${run || '-'} | ${String(details).replace(/\s*\n\s*/g, ' ')}\n`;
    await fs.appendFile(LOG_FILE, line, 'utf8');
  } catch {
    /* ignore */
  }
}

export async function readLog({ run, limit = 50 } = {}) {
  let text;
  try {
    text = await fs.readFile(LOG_FILE, 'utf8');
  } catch {
    return [];
  }
  let lines = text.split('\n').filter(Boolean);
  if (run) lines = lines.filter((l) => l.split(' | ')[2] === run);
  return limit ? lines.slice(-limit) : lines;
}

/**
 * Saves a numbered copy of a run file (e.g. issues.json → history/issues.v003.json)
 * unless it is identical to the latest saved version. Returns the version number.
 */
export async function saveVersion(dir, file) {
  const src = path.join(dir, file);
  let content;
  try {
    content = await fs.readFile(src, 'utf8');
  } catch {
    return null;
  }
  const versions = await listVersions(dir, file);
  const last = versions.at(-1);
  if (last && (await fs.readFile(last.path, 'utf8')) === content) return last.version;
  const version = (last?.version || 0) + 1;
  const base = path.basename(file, path.extname(file));
  await fs.mkdir(path.join(dir, VERSIONS_DIR), { recursive: true });
  await fs.writeFile(path.join(dir, VERSIONS_DIR, `${base}.v${String(version).padStart(3, '0')}${path.extname(file)}`), content, 'utf8');
  return version;
}

export async function listVersions(dir, file) {
  const base = path.basename(file, path.extname(file));
  const re = new RegExp(`^${base}\\.v(\\d+)${path.extname(file).replace('.', '\\.')}$`);
  let names = [];
  try {
    names = await fs.readdir(path.join(dir, VERSIONS_DIR));
  } catch {
    return [];
  }
  return names
    .map((n) => ({ n, m: re.exec(n) }))
    .filter((x) => x.m)
    .map((x) => ({ version: Number(x.m[1]), name: x.n, path: path.join(dir, VERSIONS_DIR, x.n) }))
    .sort((a, b) => a.version - b.version);
}
