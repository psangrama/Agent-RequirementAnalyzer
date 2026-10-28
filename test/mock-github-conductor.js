// Stateful fake GitHub for the Conductor test: issues get / list-by-label / labels / comments / close / timeline.
// Control endpoints: POST /__seed {issues}, POST /__patch/:n {state, state_reason, labels}, GET /__state.
import http from 'node:http';

const port = Number(process.argv[2] || 4030);
let issues = [];
let labels = [];
let comments = [];

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};
const view = (is) => ({ ...is, labels: is.labels.map((name) => ({ name })), html_url: `http://gh/o/r/issues/${is.number}` });

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const data = body ? JSON.parse(body) : {};
      const find = (n) => issues.find((i) => i.number === Number(n));

      if (p === '/__seed') {
        issues = data.issues.map((i) => ({ state: 'open', state_reason: null, labels: [], timeline: [], ...i }));
        labels = [];
        comments = [];
        return json(res, 200, {});
      }
      let m = /^\/__patch\/(\d+)$/.exec(p);
      if (m) return Object.assign(find(m[1]), data), json(res, 200, {});
      if (p === '/__state') return json(res, 200, { issues: issues.map(view), labels, comments });

      if (req.method === 'GET' && p === '/repos/o/r/issues') {
        const want = url.searchParams.get('labels');
        const state = url.searchParams.get('state') || 'open';
        const out = issues.filter((i) => (state === 'all' || i.state === state) && (!want || i.labels.includes(want)));
        return json(res, 200, out.map(view));
      }
      m = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(p);
      if (m) {
        const is = find(m[1]);
        if (!is) return json(res, 404, { message: 'Not Found' });
        if (req.method === 'PATCH') {
          if (data.state) is.state = data.state;
          if (data.state_reason) is.state_reason = data.state_reason;
        }
        return json(res, 200, view(is));
      }
      m = /^\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(p);
      if (req.method === 'POST' && m) {
        const is = find(m[1]);
        is.labels = [...new Set([...is.labels, ...data.labels])];
        return json(res, 200, is.labels.map((name) => ({ name })));
      }
      m = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(p);
      if (req.method === 'POST' && m) {
        comments.push({ issue: Number(m[1]), body: data.body });
        return json(res, 201, { id: comments.length });
      }
      m = /^\/repos\/o\/r\/issues\/(\d+)\/timeline$/.exec(p);
      if (m) return json(res, 200, find(m[1]).timeline);
      if (p === '/repos/o/r/labels') {
        if (req.method === 'POST') {
          labels.push({ name: data.name });
          return json(res, 201, data);
        }
        return json(res, 200, labels);
      }
      json(res, 404, { message: 'Not Found' });
    });
  })
  .listen(port, () => console.log('mock ready'));
