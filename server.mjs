import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 3000);
const root = process.cwd();
const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || '';
const hasSupabase = Boolean(supabaseUrl && supabaseSecretKey);
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

async function readJsonBody(req, maxBytes = 2_500_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('Request body is too large.');
  }
  return JSON.parse(raw || '{}');
}

async function supabaseRequest(path, { method = 'GET', body, prefer } = {}) {
  if (!hasSupabase) {
    const error = new Error('Supabase storage is not configured.');
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: supabaseSecretKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Supabase request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function reportFields(report) {
  const info = report?.info || {};
  return {
    game: String(report?.game || '제목 없음').slice(0, 300),
    developer: String(info.dev || '').slice(0, 300),
    overall: String(report?.sns_trend?.overall || '혼재').slice(0, 80),
    stage: String(report?.stage_label || '').slice(0, 200),
    generated_at: String(report?.generated_at || '').slice(0, 40),
    updated_at: new Date().toISOString(),
    report_data: report
  };
}

const reportSummary = row => ({
  id: row.id,
  game: row.game,
  dev: row.developer,
  date: row.generated_at || row.created_at,
  overall: row.overall,
  stage: row.stage,
  share_token: row.share_token,
  expires_at: row.expires_at
});

async function handleReportStorage(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/storage-status') {
    return send(res, 200, { configured: hasSupabase, retention_days: 7 });
  }

  if (req.method === 'GET' && pathname === '/api/reports') {
    const now = encodeURIComponent(new Date().toISOString());
    const rows = await supabaseRequest(`reports?select=id,game,developer,overall,stage,generated_at,created_at,expires_at,share_token&expires_at=gt.${now}&order=created_at.desc&limit=100`);
    return send(res, 200, { reports: (rows || []).map(reportSummary) });
  }

  const reportMatch = pathname.match(/^\/api\/reports\/([^/]+)$/);
  if (req.method === 'GET' && reportMatch) {
    const id = encodeURIComponent(decodeURIComponent(reportMatch[1]));
    const now = encodeURIComponent(new Date().toISOString());
    const rows = await supabaseRequest(`reports?select=report_data,share_token,expires_at&id=eq.${id}&expires_at=gt.${now}&limit=1`);
    if (!rows?.length) return send(res, 404, { error: 'Report not found or expired.' });
    return send(res, 200, { report: rows[0].report_data, share_token: rows[0].share_token, expires_at: rows[0].expires_at });
  }

  if (req.method === 'POST' && pathname === '/api/reports') {
    const { id, report } = await readJsonBody(req);
    if (typeof id !== 'string' || !id.trim() || id.length > 400 || !report || typeof report !== 'object' || Array.isArray(report)) {
      return send(res, 400, { error: 'A valid report id and report object are required.' });
    }
    const encodedId = encodeURIComponent(id);
    const existing = await supabaseRequest(`reports?select=share_token,expires_at&id=eq.${encodedId}&limit=1`);
    let rows;
    if (existing?.length) {
      rows = await supabaseRequest(`reports?id=eq.${encodedId}`, {
        method: 'PATCH', body: reportFields(report), prefer: 'return=representation'
      });
    } else {
      rows = await supabaseRequest('reports', {
        method: 'POST', body: { id, ...reportFields(report) }, prefer: 'return=representation'
      });
    }
    return send(res, 200, { id, share_token: rows?.[0]?.share_token || existing?.[0]?.share_token, expires_at: rows?.[0]?.expires_at || existing?.[0]?.expires_at });
  }

  return false;
}

async function handleSharedReport(res, pathname) {
  const match = pathname.match(/^\/api\/shared-reports\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  if (!match) return false;
  const now = encodeURIComponent(new Date().toISOString());
  const rows = await supabaseRequest(`reports?select=report_data,share_token,expires_at&share_token=eq.${encodeURIComponent(match[1])}&expires_at=gt.${now}&limit=1`);
  if (!rows?.length) return send(res, 404, { error: 'Report not found or expired.' });
  return send(res, 200, { report: rows[0].report_data, share_token: rows[0].share_token, expires_at: rows[0].expires_at });
}

// Claude가 web_search 도구를 쓰면 검색 결과를 인용하며 문장 안에
// <cite index="...">...</cite> 같은 인용 태그를 그대로 끼워 넣는 경우가 있다.
// 최종 결과에는 자연어 문장만 남기고 이런 태그는 제거한다. (인용 태그 안의 실제 문장 내용은 보존)
function stripCitationTags(text) {
  return text
    .replace(/<\/?cite[^>]*>/gi, '')   // 인용 태그 제거
    .replace(/[ \t]{2,}/g, ' ');       // 태그가 사라진 자리에 남는 연속 공백을 하나로 정리 (줄바꿈은 JSON 구조상 보존)
}

// Claude(Anthropic) Messages API 호출.
// 웹 검색 도구를 쓰면 조사 도중 응답이 "pause_turn"으로 잠시 멈추고 이어서 요청해주길 기다리는
// 경우가 있어서, 조사가 완전히 끝날 때까지 최대 MAX_ROUNDS번 자동으로 이어서 요청한다.
// 응답이 max_tokens로 잘렸을 때도 같은 방식으로 이어쓰기를 요청한다.
const MAX_ROUNDS = 6;

async function callClaude(instructions, input, useWebSearch = true, timeoutMs = 360000) {
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
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        system: instructions,
        messages,
        ...(useWebSearch ? { tools: [{ type: 'web_search_20250305', name: 'web_search' }] } : {})
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
  const requestUrl = new URL(req.url, 'http://localhost');
  const pathname = requestUrl.pathname;

  try {
    if (req.method === 'GET' && pathname.startsWith('/api/shared-reports/')) {
      const handled = await handleSharedReport(res, pathname);
      if (handled !== false) return;
    }
  } catch (error) {
    return send(res, error.status || 500, { error: error.message || 'Shared report request failed.' });
  }

  const isPublicSharePage = req.method === 'GET' && (pathname === '/' || pathname === '/index.html') && requestUrl.searchParams.has('share');
  if (!isPublicSharePage && !isAuthorized(req, res)) return;

  if (pathname === '/api/storage-status' || pathname === '/api/reports' || pathname.startsWith('/api/reports/')) {
    try {
      const handled = await handleReportStorage(req, res, pathname);
      if (handled !== false) return;
    } catch (error) {
      return send(res, error.status || 500, { error: error.message || 'Report storage request failed.' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/report') {
    if (!process.env.ANTHROPIC_API_KEY) return send(res, 500, { error: 'ANTHROPIC_API_KEY is not set.' });

    let instructions, input, useWebSearch = true, timeoutMs = 360000;
    try {
      ({ instructions, input, useWebSearch = true, timeoutMs = 360000 } = await readJsonBody(req));
      if (typeof instructions !== 'string' || typeof input !== 'string') throw new Error('Invalid request.');
      if (typeof useWebSearch !== 'boolean') throw new Error('Invalid useWebSearch value.');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 360000) throw new Error('Invalid timeoutMs value.');
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
      const text = stripCitationTags(await callClaude(instructions, input, useWebSearch, timeoutMs));
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
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) return send(res, 403, { error: 'Forbidden' });
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : body); }
  catch { send(res, 404, { error: 'Not found' }); }
}).listen(port, '0.0.0.0', () => console.log(`Game Signal Desk: http://localhost:${port}`));
