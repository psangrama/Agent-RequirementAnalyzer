// Sends the requirements text to Claude and gets back validated Epic/Story/Task drafts.
import Anthropic from '@anthropic-ai/sdk';
import { draftJsonSchema, itemJsonSchema, validateDraft, ItemSchema } from './schema.js';

const MAX_FIX_ATTEMPTS = 2;

const SYSTEM = `You are a senior product analyst who turns software requirement documents into a GitHub backlog.

Break the document into a three-level hierarchy:
- epic: a large capability or feature area (usually maps to a major section of the document)
- story: a user-facing or system behaviour that delivers value on its own; write the description as "As a <role>, I want <goal>, so that <benefit>" when a user role is clear
- task: a concrete, developer-sized piece of work needed to deliver its story (roughly half a day to three days)

Rules:
- Cover every requirement in the document. Do not invent features the document does not ask for.
- Every story has an epic as parent; every task has a story as parent. Epics have parent null.
- IDs: epics E1, E2…; stories E1.S1, E1.S2…; tasks E1.S1.T1…
- Acceptance criteria must be specific and testable (Given/When/Then or checklist style). Epics may summarise their outcome instead.
- source_refs must point back to the document: use its requirement IDs (e.g. FR-3, NFR-2) when it has them, otherwise the section heading.
- priority: use what the document says (must/should/could, P0/P1…); otherwise judge by dependency and user impact.
- estimate: t-shirt size of effort (XS < 2h, S ≈ half day, M ≈ 1-2 days, L ≈ 3-5 days, XL > 1 week; epics are usually L/XL).
- labels: only domain labels (frontend, backend, api, database, security, infra, devops, docs, testing, ux, integration…), lowercase, 1-3 per item.
- flags: list anything vague ("fast", "user-friendly"), untestable, missing (no error handling, no roles defined…) or conflicting, with a concrete clarifying question.
- Keep titles under 80 characters, imperative style ("Add password reset via email").

Return the result only by calling the submit_backlog tool.`;

export function makeClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  return new Anthropic();
}

async function callWithTool(client, { model, messages, tool, maxTokens, onProgress }) {
  if (!model) throw new Error('No model chosen.');
  const base = {
    model,
    max_tokens: Number(process.env.CLAUDE_MAX_TOKENS) || maxTokens,
    system: SYSTEM,
    tools: [tool],
    messages,
  };
  const run = async (tool_choice) => {
    const stream = client.messages.stream({ ...base, tool_choice });
    let chars = 0;
    stream.on('inputJson', (delta) => {
      chars += delta.length;
      onProgress?.(chars);
    });
    return stream.finalMessage();
  };
  let toolChoice = { type: 'tool', name: tool.name };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await run(toolChoice);
    } catch (err) {
      const msg = err?.message || '';
      if (err?.status === 404 && /model/i.test(msg)) {
        throw new Error(`Model "${model}" was not found for your API key. Run "reqagent models" to see what you can use.`);
      }
      if (err?.status !== 400) throw err;
      if (/tool_choice|thinking/i.test(msg) && toolChoice.type !== 'auto') {
        // Some models don't allow forcing a tool while thinking is on; fall back to "auto".
        toolChoice = { type: 'auto' };
      } else if (/max_tokens/i.test(msg) && base.max_tokens > 8192) {
        // Smaller/older models have a lower output limit.
        base.max_tokens = base.max_tokens > 32000 ? 32000 : 8192;
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Could not get a response from ${model}.`);
}

/**
 * @param {string} text  requirements text
 * @param {{model: string, extraInstructions?: string, onProgress?: (chars:number)=>void, log?: (msg:string)=>void}} opts
 */
export async function analyze(text, { model, extraInstructions, onProgress, log = () => {} } = {}) {
  const client = makeClient();
  const tool = {
    name: 'submit_backlog',
    description: 'Submit the full Epic/Story/Task backlog derived from the requirements document.',
    input_schema: draftJsonSchema(),
  };
  const userContent =
    `Here is the requirements document:\n\n<requirements>\n${text}\n</requirements>` +
    (extraInstructions ? `\n\nAdditional instructions from the user:\n${extraInstructions}` : '');
  const messages = [{ role: 'user', content: userContent }];

  for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    const msg = await callWithTool(client, { model, messages, tool, maxTokens: 64000, onProgress });
    const toolUse = msg.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (!toolUse) {
      if (msg.stop_reason === 'max_tokens') {
        throw new Error('The backlog was too large for one response. Split the document into smaller files and analyze each one.');
      }
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({ role: 'user', content: 'Please return the backlog by calling the submit_backlog tool.' });
      continue;
    }
    const problems = validateDraft(toolUse.input);
    if (problems.length === 0) {
      return { draft: toolUse.input, usage: msg.usage, model: msg.model };
    }
    log(`Draft had ${problems.length} problem(s); asking Claude to fix them (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS})…`);
    messages.push({ role: 'assistant', content: msg.content });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content: `The backlog failed validation. Fix these problems and call submit_backlog again with the complete corrected backlog:\n- ${problems.slice(0, 50).join('\n- ')}`,
        },
      ],
    });
  }
  throw new Error('Claude could not produce a valid backlog after several attempts. Try again, or simplify the document.');
}

/** Rewrites one item using the user's feedback. Keeps its id, type and parent. */
export async function regenerateItem(item, feedback, { model, sourceText, siblings = [] } = {}) {
  const client = makeClient();
  const tool = {
    name: 'submit_item',
    description: 'Submit the rewritten backlog item.',
    input_schema: itemJsonSchema(),
  };
  const content =
    `Rewrite this backlog item based on the feedback. Keep id "${item.id}", type "${item.type}" and parent ${JSON.stringify(item.parent)} unchanged.\n\n` +
    `<item>\n${JSON.stringify(item, null, 2)}\n</item>\n\n<feedback>\n${feedback}\n</feedback>\n\n` +
    (siblings.length ? `<related_items>\n${siblings.map((s) => `${s.id} [${s.type}] ${s.title}`).join('\n')}\n</related_items>\n\n` : '') +
    (sourceText ? `<requirements>\n${sourceText}\n</requirements>` : '');
  const msg = await callWithTool(client, {
    model,
    messages: [{ role: 'user', content }],
    tool,
    maxTokens: 8000,
  });
  const toolUse = msg.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a rewritten item.');
  const parsed = ItemSchema.safeParse({ ...toolUse.input, id: item.id, type: item.type, parent: item.parent });
  if (!parsed.success) throw new Error('Rewritten item was invalid: ' + parsed.error.issues.map((i) => i.message).join('; '));
  return parsed.data;
}
