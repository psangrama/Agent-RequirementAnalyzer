# Code Walkthrough

This CLI tool ("reqagent") turns a requirements document into a reviewed, approved
GitHub issue backlog (epics → stories → tasks).

## Entry point

**[bin/reqagent.js](bin/reqagent.js)** wires everything together with `commander`. It loads `.env` from the
current folder, then from the tool's own folder, and defines seven commands:

| Command | What it does |
|---|---|
| `parse <file>` | Shows the extracted text (no API calls). |
| `analyze <file>` | Parses, calls the model, writes the run folder (`source.md`, `meta.json`, `issues.json`, `preview.md`), then goes straight into review when run in a TTY. On failure it writes `error.txt` and keeps the run. |
| `review` | Interactive approval, or `--approve all\|E1,E2.S3` without prompts. |
| `models` | Lists the models the API key can use and the current default. |
| `push` | Always shows a dry-run plan first, then asks "Create N issue(s)?" (skip with `-y`), then creates. |
| `runs` | Lists runs with status (pushed / approved / drafted / failed / incomplete); `--clean` deletes unfinished ones. |
| `history` | Shows the shared event log; `--run` adds one run's saved versions. |

## Pipeline overview (`src/`)

1. **[parsers.js](src/parsers.js)**: Loads a requirements file (`.md`, `.markdown`, `.txt`, `.docx`, `.pdf`,
   `.html`, `.htm`) and normalizes it into plain Markdown-ish text. DOCX goes through `mammoth` (to HTML) and
   then `turndown`; PDFs go through `pdf-parse`. It errors if no text is extracted (e.g. scanned PDFs).

2. **[schema.js](src/schema.js)**: Defines the data model with Zod: `ItemSchema` (epic/story/task
   with id, parent, title, description, acceptance criteria, labels, priority, estimate,
   source_refs), `FlagSchema` (ambiguous/missing requirements to flag), and `DraftSchema`
   (summary + items + flags). Also validates parent/child hierarchy rules (epic→story→task)
   and provides ordering/orphan-detection helpers. `z.toJSONSchema` turns these schemas into the
   JSON schema sent to the model as the tool's `input_schema`.

3. **[analyzer.js](src/analyzer.js)**: Sends the parsed text to Claude via the Anthropic SDK (streaming),
   forcing a `submit_backlog` tool call whose input must match the JSON schema from
   `schema.js`. If validation fails, it feeds the errors back as an error `tool_result` for up to 2 fix
   attempts. If the model doesn't call the tool at all, that also uses up an attempt, and a
   `max_tokens` stop gives a "split the document" error. Also has `regenerateItem` for rewriting a single
   issue (`submit_item` tool) based on user feedback; id, type and parent are forced back to the originals.

4. **[models.js](src/models.js)**: Resolves which Claude model to use (`--model` flag →
   `CLAUDE_MODEL` env → default). Accepts a full ID, a display name ("Claude Opus 5.5"), a shortcut
   (`opus`/`sonnet`/`haiku`/`fable`) or `pick` (interactive menu). Fetches the live model list from the API
   (`client.models.list`) with a built-in fallback, and warns with "did you mean" suggestions for unknown IDs.

5. **[runs.js](src/runs.js)**: Manages "run" folders under `drafts/<timestamp>_<slug>/` (the base folder can be
   moved with `REQAGENT_DRAFTS_DIR`). Each holds the journey of one analysis: `meta.json`, `source.md`,
   `issues.json`, `preview.md`, `approved.json`, `pushed.json`, `report.md`, plus `error.txt` (failed analyses,
   written by `bin/reqagent.js`) and a `history/` folder (see below). Includes JSON read/write helpers and the
   `fingerprint()` helper (SHA-256 of the approved items).

6. **[history.js](src/history.js)**: The audit trail. `logEvent` appends one line per event to the shared
   `drafts/history.log` and never throws, so logging can't break real work. `saveVersion` stores numbered copies
   of `issues.json` and `approved.json` in the run's `history/` folder (`issues.v001.json`, …) and skips a save
   if nothing changed. `readLog` and `listVersions` feed the `history` command.

7. **[preview.js](src/preview.js)**: Renders drafts as a colored terminal table (`cli-table3`)
   and as a full Markdown preview file, and builds the GitHub issue body text (with an HTML
   comment marker `<!-- reqagent:<run>:<id> -->` for idempotency tracking) and auto-generated
   labels (`type:`, `priority:`, `size:`).

8. **[review.js](src/review.js)**: The human-in-the-loop gate: an interactive menu (approve
   all / pick subset / show an issue / rewrite via Claude / reload edited JSON / show table / cancel)
   plus a non-interactive `--approve` path (`pickByIds` pulls in ancestors of picked items). Unticking an
   item also drops its descendants (`cascade`). `loadDraft` re-validates `issues.json` and saves a new
   version (logging `manual-edit`) if you edited it by hand. Nothing proceeds to GitHub until the user
   explicitly approves, at which point `approved.json` is written with its fingerprint and saved as a version.

9. **[github.js](src/github.js)**: Pushes approved items to GitHub via Octokit. It first verifies the approval
   fingerprint, then creates missing labels, diffs against existing issues (by the run-scoped marker comment,
   or by matching title) to avoid duplicates, creates issues in parent-first order, and links stories/tasks
   as GitHub sub-issues of their parent. Children of a duplicate are linked under the existing issue. Failed
   links are stored as `linkError` and retried on the next push (the `RELINK` action). It retries on rate
   limits, persists progress to `pushed.json` after every issue (so a crash/re-run resumes safely), and
   writes a final `report.md`. A dry run works without a token (it just can't check the repo), and
   `GITHUB_API_URL` can point it at another API host. Push start/done/failed are logged via `history.js`.

## Tests

- **[test/run-offline.mjs](test/run-offline.mjs)**: End-to-end test (`npm test`) that runs the real CLI in a
  child process against local fake servers. It sets `NO_COLOR=1` so output assertions aren't polluted by ANSI codes.
- **[test/mock-servers.js](test/mock-servers.js)**: Fake Anthropic and GitHub APIs. Any change to the provider or
  the request/response shape needs a matching change here.

## Configuration (environment variables)

| Variable | Used by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | analyzer.js | Required for analyze, rewrite and `models`. |
| `CLAUDE_MODEL` | models.js | Default model (ID, name, shortcut or `pick`). |
| `CLAUDE_MAX_TOKENS` | analyzer.js | Caps output tokens. |
| `GITHUB_TOKEN` | github.js | Required to create issues (not for dry run). |
| `GITHUB_REPO` | github.js | Default `owner/name`. |
| `GITHUB_API_URL` | github.js | Override the GitHub API base URL. |
| `REQAGENT_DRAFTS_DIR` | runs.js | Where run folders live (default `./drafts`). |
| `NO_COLOR` / `DEBUG` | picocolors / bin | Plain output; full error stacks. |

## Design notes worth flagging

- Idempotency is handled two ways: a run-scoped marker comment embedded in the issue body,
  and a fallback title-match against existing issues.
- The approval fingerprint is computed in `review.js` when you approve and checked in `github.js` before
  pushing. It guards against silently pushing an `approved.json` that was hand-edited after approval.
- `analyzer.js` has defensive retry logic around model quirks (400 errors for
  `tool_choice`+`thinking` combos, `max_tokens` limits on older models). These detect errors by
  matching Anthropic's error text.
- History must never break the work: `logEvent` swallows its own errors.
- Interactive paths depend on `process.stdin.isTTY`; without a TTY, `analyze` stops after drafting and
  `review` needs `--approve`.

## Impact map: what changes if the LLM provider changes (e.g. LiteLLM, Grok)

The model coupling is spread over more than `analyzer.js` and `models.js`:

| Area | What is Anthropic/Claude-specific |
|---|---|
| [src/analyzer.js](src/analyzer.js) | `@anthropic-ai/sdk` client; `messages.stream` and `inputJson` progress events; `tool_use` / `tool_result` blocks and `input_schema`; forced `tool_choice`; error-text regexes (`tool_choice\|thinking`, `max_tokens`); reading `msg.usage` and `msg.model`; "Claude" in user-facing messages |
| [src/models.js](src/models.js) | `client.models.list`; `KNOWN_MODELS`, `DEFAULT_MODEL`; shortcuts matched on `-opus-` etc.; "Which Claude model" prompt |
| [bin/reqagent.js](bin/reqagent.js) | `makeClient()` called in `analyze`, `review` and `models`; token line uses `usage.input_tokens` / `output_tokens`; "Claude" in option help |
| [src/review.js](src/review.js) | Menu label "(uses Claude)"; the model passed to `regenerateItem` |
| [src/schema.js](src/schema.js) | `z.toJSONSchema` output must be accepted by the new backend (e.g. `additionalProperties`, string length limits) |
| Config and docs | `package.json` dependencies, `.env.example`, README model sections and troubleshooting, `meta.json` model field |
| Tests | `test/mock-servers.js` fakes Anthropic's request/response shape; `test/run-offline.mjs` asserts on it |

## Impact notes for running in Docker

- Run with a TTY (`docker run -it`) for the interactive review menus, or use `--no-review` plus `review --approve`.
- Mount a volume for the drafts folder (`REQAGENT_DRAFTS_DIR`) so runs, history and `pushed.json` survive the
  container; `push` relies on `pushed.json` to resume without duplicates.
- Pass `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` at run time, not in the image.
- Set `NO_COLOR=1` if output is captured (picocolors force-enables color on Windows).
