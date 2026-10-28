// Line diff and per-field changes between two versions of one item (used by the CLI and the web page).
export function diffLines(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['same', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['del', a[i++]]);
    else out.push(['add', b[j++]]);
  }
  while (i < n) out.push(['del', a[i++]]);
  while (j < m) out.push(['add', b[j++]]);
  return out;
}

export const FIELDS = [['title', 'Title'], ['description', 'Description'], ['acceptance_criteria', 'Acceptance criteria'], ['labels', 'Labels'], ['priority', 'Priority'], ['estimate', 'Size']];
const lines = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n'));

/** [{ field, label, diff }] for each field that differs. */
export function itemChanges(a, b) {
  return FIELDS.filter(([k]) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(([k, label]) => ({ field: k, label, diff: diffLines(lines(a[k]), lines(b[k])) }));
}
