import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 3000);
const root = process.cwd();
const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const send = (res, status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const hasTeamLogin = Boolean(process.env.APP_USERNAME && process.env.APP_PASSWORD);
const isAuthorized = (req, res) => {
  if (!hasTeamLogin) return true;
  const expected = `Basic ${Buffer.from(`${process.env.APP_USERNAME}:${process.env.APP_PASSWORD}`).toString('base64')}`;
  if (req.headers.authorization === expected) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Game Signal Desk"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Team login is required.');
  return false;
};
const responseText = (data) => {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
  return (data.output || [])
    .flatMap(item => item.content || [])
    .filter(part => part.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
};

createServer(async (req, res) => {
  if (!isAuthorized(req, res)) return;
  if (req.method === 'POST' && req.url === '/api/report') {
    if (!process.env.OPENAI_API_KEY) return send(res, 500, { error: 'OPENAI_API_KEY is not set.' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const { instructions, input } = JSON.parse(raw);
      if (typeof instructions !== 'string' || typeof input !== 'string') throw new Error('Invalid request.');
      const upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, instructions, input, tools: [{ type: 'web_search' }], tool_choice: 'auto' })
      });
      const data = await upstream.json();
      if (!upstream.ok) return send(res, upstream.status, { error: data?.error?.message || 'OpenAI request failed.' });
      return send(res, 200, { text: responseText(data) });
    } catch (error) { return send(res, 400, { error: error.message || 'Request failed.' }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) return send(res, 403, { error: 'Forbidden' });
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : body); }
  catch { send(res, 404, { error: 'Not found' }); }
}).listen(port, '0.0.0.0', () => console.log(`Game Signal Desk: http://localhost:${port}`));
