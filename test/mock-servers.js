// Local stand-ins for the Claude and GitHub APIs so the whole flow can be tested offline.
// Usage: node test/mock-servers.js   (Claude on :4010, GitHub on :4020)
import http from 'node:http';

const draftValid = {
  summary: 'A smart home companion app covering accounts, devices and automations.',
  flags: [
    { source_ref: 'NFR-1', problem: '"Fast" is not measurable.', suggestion: 'What response time is acceptable, e.g. p95 < 300 ms?' },
  ],
  items: [
    {
      id: 'E1',
      type: 'epic',
      parent: null,
      title: 'User accounts',
      description: 'Sign-up, sign-in and password reset.',
      acceptance_criteria: [],
      labels: ['backend'],
      priority: 'high',
      estimate: 'XL',
      source_refs: ['1. User Accounts'],
    },
    {
      id: 'E1.S1',
      type: 'story',
      parent: 'E1',
      title: 'Sign up with email and password',
      description: 'As a new user, I want to sign up with email so that I can use the app.',
      acceptance_criteria: ['Given a valid email and password, an account is created'],
      labels: ['backend', 'frontend'],
      priority: 'high',
      estimate: 'M',
      source_refs: ['FR-1'],
    },
    {
      id: 'E1.S1.T1',
      type: 'task',
      parent: 'E1.S1',
      title: 'Create users table and sign-up API',
      description: 'POST /auth/signup.',
      acceptance_criteria: ['Returns 201 with user id'],
      labels: ['backend', 'database'],
      priority: 'high',
      estimate: 'S',
      source_refs: ['FR-1'],
    },
    {
      id: 'E1.S2',
      type: 'story',
      parent: 'E1',
      title: 'Reset a forgotten password',
      description: 'As a user, I want to reset my password.',
      acceptance_criteria: ['Link expires after 30 minutes'],
      labels: ['backend'],
      priority: 'high',
      estimate: 'M',
      source_refs: ['FR-2'],
    },
    {
      id: 'E2',
      type: 'epic',
      parent: null,
      title: 'Device management',
      description: 'Adding and monitoring devices.',
      acceptance_criteria: [],
      labels: ['frontend'],
      priority: 'medium',
      estimate: 'XL',
      source_refs: ['2. Device Management'],
    },
    {
      id: 'E2.S1',
      type: 'story',
      parent: 'E2',
      title: 'Add a device by scanning its QR code',
      description: 'As a user, I want to scan a QR code to add a device.',
      acceptance_criteria: ['Device appears in list after scan'],
      labels: ['frontend'],
      priority: 'high',
      estimate: 'L',
      source_refs: ['FR-4'],
    },
  ],
};
// First answer is deliberately broken (task under an epic) to exercise the fix-up retry.
const draftBroken = structuredClone(draftValid);
draftBroken.items[2].parent = 'E1';

let claudeCalls = 0;
let failNextClaude = false;
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        const data = [
          ['claude-opus-5-5', 'Claude Opus 5.5', '2026-06-01T00:00:00Z'],
          ['claude-sonnet-5-5', 'Claude Sonnet 5.5', '2026-05-01T00:00:00Z'],
          ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5', '2025-10-01T00:00:00Z'],
        ].map(([id, display_name, created_at]) => ({ type: 'model', id, display_name, created_at }));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id }));
      }
      if (req.url === '/__failNext') {
        failNextClaude = true;
        res.writeHead(200);
        return res.end('ok');
      }
      if (failNextClaude) {
        failNextClaude = false;
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'simulated failure' } }));
      }
      claudeCalls++;
      const payload = JSON.parse(body);
      const toolName = payload.tools[0].name;
      const input =
        toolName === 'submit_item'
          ? { ...draftValid.items[1], title: 'Sign up with email, password and verification' }
          : claudeCalls === 1
            ? draftBroken
            : draftValid;
      console.log(
        `[claude] call ${claudeCalls} model=${payload.model} tool=${toolName} tool_choice=${JSON.stringify(payload.tool_choice)} msgs=${payload.messages.length}`,
      );
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send('message_start', {
        message: {
          id: 'msg_' + claudeCalls,
          type: 'message',
          role: 'assistant',
          model: payload.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1200, output_tokens: 0 },
        },
      });
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_' + claudeCalls, name: toolName, input: {} } });
      const json = JSON.stringify(input);
      for (let i = 0; i < json.length; i += 500)
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 500) } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 900 } });
      send('message_stop', {});
      res.end();
    });
  })
  .listen(4010);

// --- GitHub -----------------------------------------------------------------
const issues = [
  { id: 9000, number: 1, title: 'Add a device by scanning its QR code', body: 'pre-existing', html_url: 'http://gh/o/r/issues/1' },
];
const labels = [{ name: 'bug' }];
const subIssues = [];
let failLinks = 0;
const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const data = body ? JSON.parse(body) : {};
      console.log(`[github] ${req.method} ${p}`);
      if (req.method === 'GET' && p === '/repos/o/r') return json(res, 200, { has_issues: true, permissions: { push: true } });
      if (req.method === 'GET' && p === '/repos/o/r/issues') return json(res, 200, issues);
      if (req.method === 'GET' && p === '/repos/o/r/labels') return json(res, 200, labels);
      if (req.method === 'POST' && p === '/repos/o/r/labels') {
        labels.push({ name: data.name });
        return json(res, 201, data);
      }
      if (req.method === 'POST' && p === '/repos/o/r/issues') {
        const n = issues.length + 1;
        const is = {
          id: 9000 + n,
          number: n,
          title: data.title,
          body: data.body,
          labels: data.labels,
          html_url: `http://gh/o/r/issues/${n}`,
        };
        issues.push(is);
        return json(res, 201, is);
      }
      const m = /^\/repos\/o\/r\/issues\/(\d+)\/sub_issues$/.exec(p);
      if (req.method === 'POST' && m) {
        if (failLinks > 0) {
          failLinks--;
          return json(res, 500, { message: 'simulated link failure' });
        }
        subIssues.push({ parent: +m[1], child: data.sub_issue_id });
        return json(res, 201, {});
      }
      if (p === '/__failLinks') {
        failLinks = Number(url.searchParams.get('n') || 1);
        return json(res, 200, {});
      }
      if (req.method === 'GET' && p === '/__state') return json(res, 200, { issues, labels, subIssues });
      json(res, 404, { message: 'Not Found' });
    });
  })
  .listen(4020, () => console.log('mocks ready'));
