// Answers to the "requirements to clarify" questions, kept in answers.json beside the drafts.
// Question n is the n-th entry of issues.json "flags" (0-based, the same numbering the web page uses).
import { readJson, writeJson } from './runs.js';

const FILE = 'answers.json';

export const loadAnswers = (dir) => readJson(dir, FILE, {});
export const saveAnswers = (dir, answers) => writeJson(dir, FILE, answers);

/** Answered questions as { n, flag, answer }. */
export function answered(flags, answers) {
  return flags.map((flag, n) => ({ n, flag, answer: (answers[String(n)] || '').trim() })).filter((x) => x.answer);
}

/** The feedback text sent to Claude. Same wording as the web page. */
export function answersFeedback(list) {
  return 'Use these answers from the product owner to resolve open questions in the requirements:\n' + list.map((x) => `- [${x.flag.source_ref}] ${x.flag.suggestion} → ${x.answer}`).join('\n');
}

/** True when two requirement references name the same thing: equal, or one appears in the other as whole tokens ("FR-1" is not in "NFR-1"). */
export function refMatches(a, b) {
  const [x, y] = [a.toLowerCase().trim(), b.toLowerCase().trim()];
  if (!x || !y) return false;
  const within = (needle, hay) => new RegExp('(^|[^a-z0-9])' + needle.replace(/[^a-z0-9]/g, (c) => '\\' + c) + '($|[^a-z0-9])').test(hay);
  return x === y || within(x, y) || within(y, x);
}

/** Epics and stories whose source_refs mention a requirement that was answered. */
export function affectedItems(items, list) {
  return items.filter((it) => it.type !== 'task' && (it.source_refs || []).some((r) => list.some((x) => refMatches(r, x.flag.source_ref))));
}
