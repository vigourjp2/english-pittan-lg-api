import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = 160;
const TIMEOUT_MS = 3500;

function send(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 4096) reject(new Error('too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function normalizeText(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^A-Za-z0-9 .,!?'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}
function runLinkParser(text) {
  return new Promise((resolve) => {
    const args = ['en', '-batch', '-verbosity=0', '-graphics=0', '-null=0', '-islands-ok=0', '-spell=0', '-timeout=3'];
    const p = spawn('link-parser', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => {
      clearTimeout(timer);
      const error = /\+\+\+\+\+ error/i.test(out) || /No complete linkages found/i.test(out) || code !== 0;
      const m = out.match(/Found\s+(\d+)\s+linkages/i);
      const linkages = m ? Number(m[1]) : (error ? 0 : 1);
      resolve({ ok: !error && linkages > 0, fullParse: !error && linkages > 0, linkages, nullCount: 0, stdout: out.slice(0, 2000), stderr: err.slice(0, 1000), code });
    });
    p.stdin.write(text.endsWith('.') || /[!?]$/.test(text) ? text + '\n' : text + '.\n');
    p.stdin.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { ok: true, service: 'link-grammar-api' });
  if (url.pathname !== '/check') return send(res, 404, { ok: false, error: 'not found' });
  try {
    let text = url.searchParams.get('text') || '';
    if (req.method === 'POST') {
      const raw = await readBody(req);
      try { const j = JSON.parse(raw || '{}'); text = j.text || (Array.isArray(j.words) ? j.words.join(' ') : text); } catch { text = raw || text; }
    }
    text = normalizeText(text);
    if (!text) return send(res, 400, { ok: false, error: 'empty text' });
    const result = await runLinkParser(text);
    return send(res, 200, { text, ...result });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e.message || e) });
  }
});
server.listen(PORT, () => console.log(`Link Grammar API listening on ${PORT}`));
