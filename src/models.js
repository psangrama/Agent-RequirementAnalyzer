// Choosing which Claude model to use: --model flag > CLAUDE_MODEL in .env > default.
import pc from 'picocolors';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Used when the live list can't be fetched (offline, restricted key…). Newest first.
const KNOWN_MODELS = [
  { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', note: 'deepest reasoning; slowest and most expensive' },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', note: 'very strong on long, complex PRDs' },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', note: 'best balance of quality, speed and cost' },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', note: 'fastest and cheapest; fine for short, clear docs' },
];

// Short names you can type instead of a full model ID.
export const SHORTCUTS = ['fable', 'opus', 'sonnet', 'haiku'];

let cache;

/** Models your API key can use, newest first. Falls back to a built-in list if the API can't be reached. */
export async function listModels(client) {
  if (cache) return cache;
  try {
    const models = [];
    for await (const m of client.models.list({ limit: 100 }))
      models.push({ id: m.id, display_name: m.display_name, created_at: m.created_at });
    if (!models.length) throw new Error('empty list');
    models.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    for (const m of models) m.note = KNOWN_MODELS.find((k) => k.id === m.id)?.note;
    cache = { models, live: true };
  } catch {
    cache = { models: KNOWN_MODELS, live: false };
  }
  return cache;
}

/** The model to use when nothing is chosen on the command line. */
export function configuredModel() {
  return (process.env.CLAUDE_MODEL || '').trim() || DEFAULT_MODEL;
}

/**
 * Turns what the user typed into a real model ID.
 * - "pick" (or "?") opens a menu
 * - "opus" / "sonnet" / "haiku" / "fable" → the newest model of that family
 * - a full ID is checked against the models your key can use
 */
export async function resolveModel(client, requested, { interactive = process.stdin.isTTY, current } = {}) {
  const wanted = (requested || configuredModel()).trim();
  const lower = wanted.toLowerCase();

  if (lower === 'pick' || lower === '?') {
    if (!interactive) throw new Error("Can't show the model menu here (not an interactive terminal). Pass --model <id> instead.");
    return pickModel(client, current || DEFAULT_MODEL);
  }

  const { models, live } = await listModels(client);

  // Accept the display name too, e.g. CLAUDE_MODEL=Claude Haiku 4.5
  const byName = findByDisplayName(models, wanted) || findByDisplayName(KNOWN_MODELS, wanted);
  if (byName) return byName.id;

  if (SHORTCUTS.includes(lower)) {
    const match = models.find((m) => m.id.includes(`-${lower}-`)) || KNOWN_MODELS.find((m) => m.id.includes(`-${lower}-`));
    if (!match) throw new Error(`No "${lower}" model is available to your API key. Run "reqagent models" to see the list.`);
    return match.id;
  }
  if (live && !models.some((m) => m.id === wanted)) {
    const family = SHORTCUTS.find((f) => lower.includes(f));
    const close = models.filter((m) => (family ? m.id.includes(family) : m.id.includes(lower.split('-')[1] || lower))).map((m) => m.id);
    throw new Error(
      `Model "${wanted}" isn't available to your API key.` +
        (close.length ? ` Did you mean: ${close.slice(0, 3).join(', ')}?` : '') +
        ' Run "reqagent models" to see the list.',
    );
  }
  return wanted;
}

const squash = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/[\s_-]+/g, ' ')
    .trim();

function findByDisplayName(list, wanted) {
  const w = squash(wanted);
  return list.find((m) => m.display_name && (squash(m.display_name) === w || squash(m.display_name).replace(/^claude /, '') === w));
}

export async function pickModel(client, preselect) {
  const { select } = await import('@inquirer/prompts');
  const { models, live } = await listModels(client);
  if (!live) console.log(pc.dim('(Could not fetch the live model list; showing the built-in one.)'));
  return select({
    message: 'Which Claude model should analyze this document?',
    choices: models.map((m) => ({
      name: `${m.display_name || m.id}  ${pc.dim(m.id)}${m.note ? pc.dim(' — ' + m.note) : ''}`,
      value: m.id,
    })),
    default: models.some((m) => m.id === preselect) ? preselect : undefined,
    pageSize: 12,
  });
}

export async function printModels(client) {
  const { models, live } = await listModels(client);
  const configured = configuredModel();
  const shortcut = SHORTCUTS.includes(configured.toLowerCase()) ? models.find((m) => m.id.includes(`-${configured.toLowerCase()}-`)) : null;
  const current = findByDisplayName(models, configured)?.id || shortcut?.id || configured;
  console.log(pc.bold(live ? 'Models available to your API key (newest first):' : 'Built-in model list (could not reach the API):'));
  for (const m of models) {
    const mark = m.id === current ? pc.green(' ← current default') : '';
    console.log(`  ${m.id.padEnd(30)} ${pc.dim(m.display_name || '')}${m.note ? pc.dim(' — ' + m.note) : ''}${mark}`);
  }
  console.log(
    `\nUse one for a run:        ${pc.bold('reqagent analyze <file> --model <id>')}   (or opus / sonnet / haiku / fable)` +
      `\nChoose from a menu:       ${pc.bold('reqagent analyze <file> --model pick')}` +
      `\nChange the default:       set ${pc.bold('CLAUDE_MODEL=<id>')} in .env  (CLAUDE_MODEL=pick asks every time)`,
  );
}
