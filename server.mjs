import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 3000);
const root = process.cwd();
const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
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

// Claude(Anthropic) Messages API 호출.
// 웹 검색 도구를 쓰면 조사 도중 응답이 "pause_turn"으로 잠시 멈추고 이어서 요청해주길 기다리는
// 경우가 있어서, 조사가 완전히 끝날 때까지 최대 MAX_ROUNDS번 자동으로 이어서 요청한다.
// 응답이 max_tokens로 잘렸을 때도 같은 방식으로 이어쓰기를 요청한다.
const MAX_ROUNDS = 6;

async function callClaude(instructions, input) {
  const messages = [{ role: 'user', content: input }];
  let lastText = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        system: instructions,
        messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });

    const data = await upstream.json();
    if (!upstream.ok || data.error) {
      throw new Error(data?.error?.message || 'Claude request failed.');
    }

    const textThisRound = (data.content || [])
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
    if (textThisRound.trim()) lastText = textThisRound;

    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    if (data.stop_reason === 'max_tokens') {
      messages.push({ role: 'assistant', content: data.content });
      messages.push({ role: 'user', content: '이어서 JSON을 끝까지 완성해줘. 지금까지 작성한 내용을 포함해 완전한 JSON 하나로 다시 출력해.' });
      continue;
    }
    return lastText;
  }
  return lastText;
}

createServer(async (req, res) => {
  if (!isAuthorized(req, res)) return;

  if (req.method === 'POST' && req.url === '/api/report') {
    if (!process.env.ANTHROPIC_API_KEY) return send(res, 500, { error: 'ANTHROPIC_API_KEY is not set.' });

    let raw = '';
    for await (const chunk of req) raw += chunk;

    let instructions, input;
    try {
      ({ instructions, input } = JSON.parse(raw));
      if (typeof instructions !== 'string' || typeof input !== 'string') throw new Error('Invalid request.');
    } catch (error) {
      return send(res, 400, { error: error.message || 'Request failed.' });
    }

    // 응답 헤더를 먼저 보내고(200 고정), 조사가 끝날 때까지 15초마다 빈 공백 1바이트를
    // 흘려보낸다. 이렇게 하면 Render 등 플랫폼의 프록시가 "응답이 없다"고 판단해
    // 연결을 강제 종료(terminated)하는 것을 막을 수 있다. 공백은 JSON 앞뒤 여백으로
    // 허용되는 문자라 프론트엔드의 JSON 파싱에는 영향이 없다.
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const heartbeat = setInterval(() => {
      try { res.write(' '); } catch { /* connection already closed */ }
    }, 15000);

    try {
      const text = await callClaude(instructions, input);
      clearInterval(heartbeat);
      if (!text || !text.trim()) { res.end(JSON.stringify({ error: 'Claude returned no text.' })); return; }
      res.end(JSON.stringify({ text }));
    } catch (error) {
      clearInterval(heartbeat);
      res.end(JSON.stringify({ error: error.message || 'Request failed.' }));
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) return send(res, 403, { error: 'Forbidden' });
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : body); }
  catch { send(res, 404, { error: 'Not found' }); }
}).listen(port, '0.0.0.0', () => console.log(`Game Signal Desk: http://localhost:${port}`));
