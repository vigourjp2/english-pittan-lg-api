import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = Number(process.env.MAX_CHARS || 240);
const TIMEOUT_MS = Number(process.env.LINK_GRAMMAR_TIMEOUT_MS || 3500);
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';
// Real grammatical acceptability service. Default is a CoLA text-classification model,
// not handwritten grammar rules. LABEL_1/ACCEPTABLE means acceptable.
const HF_TOKEN = process.env.HF_TOKEN || '';
const ACCEPTABILITY_MODEL = process.env.ACCEPTABILITY_MODEL || 'textattack/roberta-base-CoLA';
const ACCEPTABILITY_URL = process.env.ACCEPTABILITY_URL || `https://api-inference.huggingface.co/models/${ACCEPTABILITY_MODEL}`;
const ACCEPTABILITY_THRESHOLD = Number(process.env.ACCEPTABILITY_THRESHOLD || 0.72);
const acceptabilityCache = new Map();
const translateCache = new Map();
const proofCache = new Map();

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
function normalizeText(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^A-Za-z0-9 .,!?'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}
function sentenceForParser(text) {
  const t = normalizeText(text);
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : t + '.';
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 16384) reject(new Error('too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function getTextFromReq(req, url) {
  let text = url.searchParams.get('text') || '';
  if (req.method === 'POST') {
    const raw = await readBody(req);
    try {
      const j = JSON.parse(raw || '{}');
      text = j.text || (Array.isArray(j.words) ? j.words.join(' ') : text);
    } catch {
      text = raw || text;
    }
  }
  return normalizeText(text);
}

function parseLinkParserOutput(out, err, code) {
  const noComplete = /No complete linkages found/i.test(out) || /No complete linkages found/i.test(err);
  const hardError = /\+\+\+\+\+ error/i.test(out) || /\+\+\+\+\+ error/i.test(err) || code !== 0;
  const linkageMatch = out.match(/Found\s+(\d+)\s+linkages/i);
  const linkages = linkageMatch ? Number(linkageMatch[1]) : (noComplete || hardError ? 0 : 1);
  // We run link-parser with -null=0 and -islands-ok=0. Therefore a successful complete
  // linkage here is the Link Grammar strict criterion; no handwritten grammar validation.
  const ok = !hardError && !noComplete && linkages > 0;
  return {
    ok,
    fullParse: ok,
    strictLinkGrammar: ok,
    linkages,
    nullCount: 0,
    stdout: out.slice(0, 2400),
    stderr: err.slice(0, 1200),
    code
  };
}
function runLinkParser(text) {
  return new Promise((resolve) => {
    const input = sentenceForParser(text);
    if (!input) return resolve({ ok:false, fullParse:false, strictLinkGrammar:false, linkages:0, nullCount:0, stdout:'', stderr:'empty text', code:null });
    const args = [
      'en',
      '-batch',
      '-verbosity=0',
      '-graphics=0',
      '-null=0',
      '-islands-ok=0',
      '-spell=0',
      '-timeout=3'
    ];
    const p = spawn('link-parser', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', e => {
      clearTimeout(timer);
      resolve({ ok:false, fullParse:false, strictLinkGrammar:false, linkages:0, nullCount:0, stdout:'', stderr:String(e.message || e), code:null });
    });
    p.on('close', code => {
      clearTimeout(timer);
      resolve(parseLinkParserOutput(out, err, code));
    });
    p.stdin.write(input + '\n');
    p.stdin.end();
  });
}

async function proofreadWithLanguageTool(text) {
  text = normalizeText(text);
  const key = text.toLowerCase();
  if (proofCache.has(key)) return proofCache.get(key);
  const body = new URLSearchParams({ text, language: 'en-US', enabledOnly: 'false' });
  const r = await fetch(LANGUAGETOOL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
    body
  });
  if (!r.ok) throw new Error('LanguageTool HTTP ' + r.status);
  const j = await r.json();
  const matches = Array.isArray(j.matches) ? j.matches : [];
  // Apply LanguageTool's first suggested replacements only. This is not a grammar engine
  // implemented here; it is external service normalization before strict Link Grammar parse.
  let corrected = text;
  const appliedCorrections = [];
  const usable = matches
    .filter(m => m && Array.isArray(m.replacements) && m.replacements.length && Number.isFinite(m.offset) && Number.isFinite(m.length))
    .sort((a,b) => b.offset - a.offset);
  for (const m of usable) {
    const replacement = String(m.replacements[0]?.value || '');
    if (!replacement) continue;
    corrected = corrected.slice(0, m.offset) + replacement + corrected.slice(m.offset + m.length);
    appliedCorrections.unshift({ offset:m.offset, length:m.length, replacement, ruleId:m.rule?.id || '', message:m.message || '' });
  }
  const result = { ok:true, source:'LanguageTool', matchesCount:matches.length, appliedCorrections, corrected:normalizeText(corrected), rawMatches:matches.slice(0, 6).map(m => ({ message:m.message, ruleId:m.rule?.id, category:m.rule?.category?.id, offset:m.offset, length:m.length, replacements:(m.replacements||[]).slice(0,3).map(r=>r.value) })) };
  proofCache.set(key, result);
  if (proofCache.size > 300) proofCache.delete(proofCache.keys().next().value);
  return result;
}

async function translateMyMemory(text) {
  const params = new URLSearchParams({ q:text, langpair:'en|ja' });
  if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
  const r = await fetch('https://api.mymemory.translated.net/get?' + params.toString(), { headers: { accept:'application/json' } });
  if (!r.ok) throw new Error('MyMemory HTTP ' + r.status);
  const j = await r.json();
  const ja = j?.responseData?.translatedText || '';
  if (!ja || ja.trim().toLowerCase() === text.trim().toLowerCase()) throw new Error('empty translation');
  return { ok:true, ja, source:'mymemory', rawStatus:j?.responseStatus };
}
async function translateGoogleGtx(text) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=' + encodeURIComponent(text);
  const r = await fetch(url, { headers: { accept:'application/json' } });
  if (!r.ok) throw new Error('google-gtx HTTP ' + r.status);
  const j = await r.json();
  const ja = Array.isArray(j?.[0]) ? j[0].map(x => x?.[0] || '').join('') : '';
  if (!ja) throw new Error('empty translation');
  return { ok:true, ja, source:'google-gtx' };
}
async function translateToJapanese(text) {
  text = normalizeText(text).replace(/[.!?]+$/,'');
  if (!text) return { ok:false, error:'empty text' };
  const key = text.toLowerCase();
  if (translateCache.has(key)) return { ok:true, ja:translateCache.get(key).ja, source:translateCache.get(key).source || 'cache' };
  let lastErr = null;
  for (const fn of [translateMyMemory, translateGoogleGtx]) {
    try {
      const tr = await fn(text);
      translateCache.set(key, { ja:tr.ja, source:tr.source });
      if (translateCache.size > 500) translateCache.delete(translateCache.keys().next().value);
      return tr;
    } catch (e) { lastErr = e; }
  }
  return { ok:false, error:String(lastErr?.message || lastErr || 'translation failed') };
}

async function classifyAcceptability(text) {
  text = normalizeText(text);
  const key = text.toLowerCase();
  if (acceptabilityCache.has(key)) return acceptabilityCache.get(key);

  const headers = { 'content-type':'application/json', 'accept':'application/json' };
  if (HF_TOKEN) headers.authorization = `Bearer ${HF_TOKEN}`;

  const payload = { inputs:text, options:{ wait_for_model:true } };
  let r, j;
  try {
    r = await fetch(ACCEPTABILITY_URL, { method:'POST', headers, body:JSON.stringify(payload) });
    j = await r.json().catch(() => null);
  } catch (e) {
    return { ok:false, source:'hf-cola', error:String(e.message || e), model:ACCEPTABILITY_MODEL };
  }
  if (!r.ok) {
    return { ok:false, source:'hf-cola', error:`HTTP ${r.status}`, raw:j, model:ACCEPTABILITY_MODEL };
  }

  // HF text-classification may return [{label,score}] or [[{label,score}]].
  const arr = Array.isArray(j?.[0]) ? j[0] : (Array.isArray(j) ? j : []);
  let acceptable = null;
  let unacceptable = null;
  for (const item of arr) {
    const label = String(item?.label || '').toUpperCase();
    const score = Number(item?.score || 0);
    if (label.includes('LABEL_1') || (label.includes('ACCEPT') && !label.includes('UNACCEPT'))) acceptable = { label:item.label, score };
    if (label.includes('LABEL_0') || label.includes('UNACCEPT')) unacceptable = { label:item.label, score };
  }
  const best = [...arr].sort((a,b) => Number(b?.score||0)-Number(a?.score||0))[0] || null;
  const score = acceptable?.score ?? ((String(best?.label||'').toUpperCase().includes('LABEL_1')) ? Number(best?.score||0) : 0);
  const isAcceptable = !!acceptable && score >= ACCEPTABILITY_THRESHOLD;
  const result = {
    ok:true,
    source:'hf-cola',
    model:ACCEPTABILITY_MODEL,
    threshold:ACCEPTABILITY_THRESHOLD,
    acceptable:isAcceptable,
    acceptableScore:score,
    unacceptableScore:unacceptable?.score ?? null,
    label:acceptable?.label || best?.label || '',
    raw:j
  };
  acceptabilityCache.set(key, result);
  if (acceptabilityCache.size > 500) acceptabilityCache.delete(acceptabilityCache.keys().next().value);
  return result;
}

async function checkStrict(text, { translate=false } = {}) {
  const originalText = normalizeText(text);
  let proof = null;
  let normalizedText = originalText;
  try {
    proof = await proofreadWithLanguageTool(originalText);
    normalizedText = proof.corrected || originalText;
  } catch (e) {
    proof = { ok:false, error:String(e.message || e) };
  }
  const parsed = await runLinkParser(normalizedText);
  const acceptability = await classifyAcceptability(normalizedText);
  const ok = !!parsed.ok && !!acceptability.ok && !!acceptability.acceptable;
  let reason = '';
  if (!parsed.ok) reason = 'strict Link Grammar parse failed';
  else if (!acceptability.ok) reason = 'acceptability service failed';
  else if (!acceptability.acceptable) reason = 'CoLA acceptability rejected';
  let tr = null;
  if (ok && translate) tr = await translateToJapanese(normalizedText);
  return {
    originalText,
    text: normalizedText,
    normalized: normalizedText !== originalText,
    appliedCorrections: proof?.appliedCorrections || [],
    ok,
    gameOk: ok,
    kind: 'Link Grammar + CoLA Acceptability',
    sentenceType: ok ? 'LG_COLA_ACCEPTED' : null,
    reason,
    proof,
    acceptability,
    ...parsed,
    ja: tr?.ja || '',
    translation: tr
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { ok: true, service: 'link-grammar-api', mode:'link-grammar-plus-cola-acceptability', acceptabilityModel:ACCEPTABILITY_MODEL, acceptabilityThreshold:ACCEPTABILITY_THRESHOLD });
  try {
    if (url.pathname === '/proof') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, { text, ...(await proofreadWithLanguageTool(text)) });
    }
    if (url.pathname === '/translate') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, { text, ...(await translateToJapanese(text)) });
    }
    if (url.pathname === '/check' || url.pathname === '/check-and-translate') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const result = await checkStrict(text, { translate:url.pathname === '/check-and-translate' });
      return send(res, 200, result);
    }
    return send(res, 404, { ok:false, error:'not found' });
  } catch (e) {
    return send(res, 500, { ok:false, error:String(e.message || e) });
  }
});
server.listen(PORT, () => console.log(`Link Grammar strict wrapper listening on ${PORT}`));
