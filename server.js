import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = Number(process.env.MAX_CHARS || 180);
const LINK_TIMEOUT_MS = Number(process.env.LINK_TIMEOUT_MS || 3500);
const LT_TIMEOUT_MS = Number(process.env.LT_TIMEOUT_MS || 5000);
const HF_TIMEOUT_MS = Number(process.env.HF_TIMEOUT_MS || 25000);

const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_CHAT_MODEL = process.env.HF_CHAT_MODEL || 'deepseek-ai/DeepSeek-R1:fastest';
const HF_CHAT_URL = process.env.HF_CHAT_URL || 'https://router.huggingface.co/v1/chat/completions';
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const SAPLING_API_KEY = process.env.SAPLING_API_KEY || '';
const SAPLING_API_URL = process.env.SAPLING_API_URL || 'https://api.sapling.ai/api/v1/edits';
const SAPLING_TIMEOUT_MS = Number(process.env.SAPLING_TIMEOUT_MS || 10000);
const translateCache = new Map();

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

function terminalSentence(text) {
  const t = normalizeText(text);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 32768) reject(new Error('request body too large'));
    });
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

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ac.signal });
    const raw = await r.text();
    if (!r.ok) {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const msg = body?.error?.message || body?.error || body?.message || raw || `HTTP ${r.status}`;
      const e = new Error(msg);
      e.status = r.status;
      e.body = body;
      throw e;
    }
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const raw = await fetchTextWithTimeout(url, options, timeoutMs);
  try { return raw ? JSON.parse(raw) : null; }
  catch { return { raw }; }
}

function applyLanguageToolCorrections(text, matches = []) {
  let corrected = text;
  const usable = matches
    .filter(m => m?.replacements?.[0]?.value)
    .filter(m => {
      const id = String(m.rule?.id || '');
      return !['UPPERCASE_SENTENCE_START', 'MORFOLOGIK_RULE_EN_US'].includes(id);
    })
    .sort((a, b) => b.offset - a.offset);
  for (const m of usable) {
    corrected = corrected.slice(0, m.offset) + m.replacements[0].value + corrected.slice(m.offset + m.length);
  }
  return normalizeText(corrected);
}

async function proofreadEnglish(text) {
  const src = normalizeText(text);
  if (!src) return { ok:false, text:src, corrected:src, normalized:false, matches:[], error:'empty text' };
  try {
    const body = new URLSearchParams({ text: src, language: 'en-US' });
    const j = await fetchJsonWithTimeout(LANGUAGETOOL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
      body
    }, LT_TIMEOUT_MS);
    const matches = Array.isArray(j?.matches) ? j.matches : [];
    const corrected = applyLanguageToolCorrections(src, matches);
    return {
      ok: true,
      text: src,
      corrected,
      normalized: corrected !== src,
      matchesCount: matches.length,
      appliedCorrections: matches.map(m => ({
        offset: m.offset,
        length: m.length,
        replacement: m.replacements?.[0]?.value || '',
        ruleId: m.rule?.id || '',
        message: m.message || ''
      })).slice(0, 12)
    };
  } catch (e) {
    return { ok:false, text:src, corrected:src, normalized:false, matchesCount:0, appliedCorrections:[], error:String(e.message || e) };
  }
}

function runLinkParser(text) {
  return new Promise((resolve) => {
    const args = ['en', '-batch', '-verbosity=0', '-graphics=0', '-null=0', '-islands-ok=0', '-spell=0', '-timeout=3'];
    const p = spawn('link-parser', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, LINK_TIMEOUT_MS);
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', e => {
      clearTimeout(timer);
      resolve({ ok:false, fullParse:false, strictLinkGrammar:false, linkages:0, nullCount:0, stdout:'', stderr:String(e.message || e), code:-1 });
    });
    p.on('close', code => {
      clearTimeout(timer);
      const hardError = /\+\+\+\+\+ error/i.test(out) || /No complete linkages found/i.test(out) || code !== 0;
      const m = out.match(/Found\s+(\d+)\s+linkages/i);
      const linkages = m ? Number(m[1]) : (hardError ? 0 : 1);
      const ok = !hardError && linkages > 0;
      resolve({
        ok,
        fullParse: ok,
        strictLinkGrammar: ok,
        linkages,
        nullCount: 0,
        stdout: out.slice(0, 1800),
        stderr: err.slice(0, 1000),
        code
      });
    });
    p.stdin.write(terminalSentence(text) + '\n');
    p.stdin.end();
  });
}

function tryExtractJson(s) {
  if (!s) return null;
  const t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function judgeAcceptability(text) {
  if (!HF_TOKEN) return { ok:false, method:'hf-chat', model:HF_CHAT_MODEL, reason:'HF_TOKEN is not set' };

  const system = [
    'You are a strict English sentence acceptability judge for a children\'s word-order game.',
    'Decide whether the input is one complete, natural, standalone Standard English sentence.',
    'Reject word salad, fragments, run-ons, leftover extra verbs, unnatural word order, object-fronting/topicalization, or sequences that only parse by unusual poetic/elliptical readings.',
    'Accept ordinary simple English sentences, including normal auxiliaries, adverbs, adjectives, objects, and prepositional phrases.',
    'Classify the input as complete_sentence, fragment, phrase, word_salad, or invalid. gameOk must be true only when the input is one complete, natural, standalone Standard English sentence. Return ONLY compact JSON: {"ok":true|false,"gameOk":true|false,"type":"complete_sentence|fragment|phrase|word_salad|invalid","reason":"short reason","sentenceType":"short label"}.'
  ].join(' ');

  const payload = {
    model: HF_CHAT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `INPUT: ${JSON.stringify(normalizeText(text))}` }
    ],
    temperature: 0,
    max_tokens: 80,
    response_format: { type: 'json_object' }
  };

  try {
    const j = await fetchJsonWithTimeout(HF_CHAT_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${HF_TOKEN}`,
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify(payload)
    }, HF_TIMEOUT_MS);
    const content = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || '';
    const parsed = tryExtractJson(content);
    if (!parsed || typeof parsed.ok !== 'boolean') {
      return { ok:false, method:'hf-chat', model:HF_CHAT_MODEL, reason:'HF chat returned non-JSON decision', raw:j, content };
    }
    return {
      ok: !!parsed.ok,
      gameOk: parsed.gameOk !== undefined ? !!parsed.gameOk : !!parsed.ok,
      type: String(parsed.type || (parsed.ok ? 'complete_sentence' : 'invalid')),
      method:'hf-chat',
      model:HF_CHAT_MODEL,
      reason: parsed.ok ? '' : String(parsed.reason || 'rejected by acceptability judge'),
      sentenceType: String(parsed.sentenceType || (parsed.ok ? 'HF_CHAT_ACCEPTED' : 'HF_CHAT_REJECTED')),
      rawDecision: parsed
    };
  } catch (e) {
    return {
      ok:false,
      method:'hf-chat',
      model:HF_CHAT_MODEL,
      reason:'HF chat acceptability service failed',
      error:{ message:String(e.message || e), status:e.status || null, body:e.body || null }
    };
  }
}


async function explainWithSapling(text) {
  const src = normalizeText(text);
  if (!src) return { ok:false, provider:'sapling', text:src, error:'empty text' };
  if (!SAPLING_API_KEY) {
    return { ok:false, provider:'sapling', text:src, error:'SAPLING_API_KEY is not set' };
  }

  const payload = {
    key: SAPLING_API_KEY,
    text: src,
    session_id: 'english-pittan-reason-test'
  };

  try {
    const data = await fetchJsonWithTimeout(SAPLING_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify(payload)
    }, SAPLING_TIMEOUT_MS);

    return {
      ok: true,
      provider: 'sapling',
      text: src,
      editsCount: Array.isArray(data?.edits) ? data.edits.length : 0,
      data
    };
  } catch (e) {
    return {
      ok: false,
      provider: 'sapling',
      text: src,
      error: String(e.message || e),
      status: e.status || null,
      body: e.body || null
    };
  }
}

async function translateByGoogleGtx(text) {
  const q = normalizeText(text).replace(/[.!?]+$/, '');
  const url = 'https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({
    client:'gtx', sl:'en', tl:'ja', dt:'t', q
  }).toString();
  const j = await fetchJsonWithTimeout(url, { headers:{ accept:'application/json' } }, 7000);
  const ja = Array.isArray(j?.[0]) ? j[0].map(x => x?.[0] || '').join('') : '';
  if (!ja) throw new Error('empty google-gtx translation');
  return { ok:true, ja, source:'google-gtx' };
}

async function translateByMyMemory(text) {
  const q = normalizeText(text).replace(/[.!?]+$/, '');
  const params = new URLSearchParams({ q, langpair:'en|ja' });
  if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
  const url = 'https://api.mymemory.translated.net/get?' + params.toString();
  const j = await fetchJsonWithTimeout(url, { headers: { accept:'application/json' } }, 7000);
  const ja = j?.responseData?.translatedText || '';
  if (!ja) throw new Error('empty mymemory translation');
  return { ok:true, ja, source:'mymemory', rawStatus:j?.responseStatus };
}

async function translateToJapanese(text) {
  text = normalizeText(text).replace(/[.!?]+$/, '');
  if (!text) return { ok:false, error:'empty text' };
  const key = text.toLowerCase();
  if (translateCache.has(key)) return { ok:true, ja:translateCache.get(key), source:'cache' };
  let lastErr = null;
  for (const fn of [translateByGoogleGtx, translateByMyMemory]) {
    try {
      const r = await fn(text);
      translateCache.set(key, r.ja);
      if (translateCache.size > 500) translateCache.delete(translateCache.keys().next().value);
      return r;
    } catch(e) { lastErr = e; }
  }
  return { ok:false, error:String(lastErr?.message || lastErr || 'translation failed') };
}

async function checkSentence(text, withTranslate = false) {
  const originalText = normalizeText(text);
  const proof = await proofreadEnglish(originalText);
  const checkedText = proof.corrected || originalText;
  const parsed = await runLinkParser(checkedText);

  const acceptability = await judgeAcceptability(checkedText);

  if (!parsed.ok) {
    // StrictLG: Link Grammar がNGならゲーム判定は必ずNGのまま。
    // HF Chat Acceptability は、NG理由を補足するためだけに使う。
    const type = acceptability.type || 'invalid';
    const hfReason = acceptability.reason ? String(acceptability.reason) : '';
    const reason = hfReason || 'link grammar parse failed';
    return {
      originalText, text: checkedText, normalized: proof.normalized, appliedCorrections: proof.appliedCorrections || [],
      ok: false, gameOk: false, type, kind:'Strict Link Grammar + HF reason only',
      sentenceType: acceptability.sentenceType || type,
      reason, proof,
      fullParse: parsed.fullParse, strictLinkGrammar: parsed.strictLinkGrammar,
      linkages: parsed.linkages, nullCount: parsed.nullCount, stdout: parsed.stdout, stderr: parsed.stderr, code: parsed.code,
      acceptability, ja: '', translation: null
    };
  }

  const ok = !!acceptability.ok;
  const type = acceptability.type || (ok ? 'complete_sentence' : 'invalid');
  const gameOk = !!(ok && acceptability.gameOk !== false && type === 'complete_sentence');
  let translation = null;
  if (gameOk && withTranslate) translation = await translateToJapanese(checkedText);
  return {
    originalText, text: checkedText, normalized: proof.normalized, appliedCorrections: proof.appliedCorrections || [],
    ok, gameOk, type, kind:'Link Grammar + HF Chat Acceptability',
    sentenceType: gameOk ? (acceptability.sentenceType || 'complete_sentence') : (acceptability.sentenceType || type),
    reason: gameOk ? '' : (acceptability.reason || 'acceptability rejected'), proof,
    fullParse: parsed.fullParse, strictLinkGrammar: parsed.strictLinkGrammar,
    linkages: parsed.linkages, nullCount: parsed.nullCount, stdout: parsed.stdout, stderr: parsed.stderr, code: parsed.code,
    acceptability, ja: translation?.ja || '', translation
  };
}

function normalizeCandidateItem(item, i = 0) {
  if (typeof item === 'string') {
    const text = normalizeText(item);
    return { id: String(i), text, words: text.split(/\s+/).filter(Boolean) };
  }
  const words = Array.isArray(item?.words) ? item.words.map(x => normalizeText(String(x))).filter(Boolean) : null;
  const text = normalizeText(item?.text || (words ? words.join(' ') : ''));
  return { id: String(item?.id ?? i), text, words: words || text.split(/\s+/).filter(Boolean) };
}

async function checkSentenceBatch(req) {
  const raw = await readBody(req);
  let j = {};
  try { j = JSON.parse(raw || '{}'); } catch { j = {}; }
  const input = Array.isArray(j?.candidates) ? j.candidates : [];
  const max = Math.max(1, Math.min(Number(j?.limit || 120), 240));
  const seen = new Map();
  for (let i = 0; i < input.length && seen.size < max; i++) {
    const item = normalizeCandidateItem(input[i], i);
    if (!item.text) continue;
    const key = item.text.toLowerCase();
    if (!seen.has(key)) seen.set(key, item);
  }
  const items = [...seen.values()];
  const results = [];
  const concurrency = Math.max(1, Math.min(Number(process.env.BATCH_CONCURRENCY || 4), 8));
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      try {
        const checked = await checkSentence(item.text, true);
        const accept = checked.acceptability || {};
        const type = accept.type || (checked.gameOk ? 'complete_sentence' : (checked.fullParse ? 'fragment' : 'invalid'));
        const gameOk = !!(checked.ok && checked.gameOk && (accept.gameOk !== false) && type === 'complete_sentence');
        results.push({
          id: item.id,
          words: item.words,
          originalText: checked.originalText,
          text: String(checked.text || item.text).replace(/[.!?]$/,''),
          ok: !!checked.ok,
          gameOk,
          validEnglish: !!checked.ok,
          type,
          sentenceType: checked.sentenceType || accept.sentenceType || type,
          kind: checked.kind || 'API判定',
          reason: checked.reason || accept.reason || '',
          ja: gameOk ? (checked.ja || checked.translation?.ja || '') : '',
          fullParse: checked.fullParse,
          strictLinkGrammar: checked.strictLinkGrammar,
          linkages: checked.linkages,
          nullCount: checked.nullCount,
          normalized: checked.normalized,
          appliedCorrections: checked.appliedCorrections || []
        });
      } catch (e) {
        results.push({ id:item.id, words:item.words, text:item.text, ok:false, gameOk:false, validEnglish:false, type:'error', reason:String(e.message || e), ja:'' });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  const order = new Map(items.map((x,i)=>[x.id,i]));
  results.sort((a,b)=>(order.get(a.id)??0)-(order.get(b.id)??0));
  return { ok:true, count:results.length, results };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok:true });
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') {
      return send(res, 200, {
        ok:true,
        service:'link-grammar-api',
        mode:'strict-link-grammar-hf-reason-only',
        hfChatModel: HF_CHAT_MODEL,
        hfChatUrl: HF_CHAT_URL,
        hfTokenPresent: !!HF_TOKEN,
        saplingKeyPresent: !!SAPLING_API_KEY
      });
    }
    if (url.pathname === '/proof') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, await proofreadEnglish(text));
    }
    if (url.pathname === '/explain-sapling') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, await explainWithSapling(text));
    }
    if (url.pathname === '/translate') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, { text, ...(await translateToJapanese(text)) });
    }
    if (url.pathname === '/acceptability') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, { text, ...(await judgeAcceptability(text)) });
    }
    if (url.pathname === '/check-and-translate-batch') {
      if (req.method !== 'POST') return send(res, 405, { ok:false, error:'POST required' });
      return send(res, 200, await checkSentenceBatch(req));
    }
    if (url.pathname === '/check' || url.pathname === '/check-and-translate') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, await checkSentence(text, url.pathname === '/check-and-translate'));
    }
    return send(res, 404, { ok:false, error:'not found' });
  } catch (e) {
    return send(res, 500, { ok:false, error:String(e.message || e), status:e.status || null, body:e.body || null });
  }
});

server.listen(PORT, () => console.log(`Link Grammar + HF Chat Acceptability API listening on ${PORT}`));
