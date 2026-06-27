import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = Number(process.env.MAX_CHARS || 180);
const LINK_TIMEOUT_MS = Number(process.env.LINK_TIMEOUT_MS || 3500);
const HF_TIMEOUT_MS = Number(process.env.HF_TIMEOUT_MS || 12000);
const LT_TIMEOUT_MS = Number(process.env.LT_TIMEOUT_MS || 5000);

const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';
const HF_TOKEN = process.env.HF_TOKEN || '';
const ACCEPTABILITY_MODEL = process.env.ACCEPTABILITY_MODEL || 'EstherT/sentence-acceptability';
const ACCEPTABILITY_THRESHOLD = Number(process.env.ACCEPTABILITY_THRESHOLD || 0.72);
const HF_PROVIDER = process.env.HF_PROVIDER || 'hf-inference';
const HF_ZERO_SHOT_MODEL = process.env.HF_ZERO_SHOT_MODEL || 'facebook/bart-large-mnli';
const HF_ZERO_SHOT_FALLBACK = String(process.env.HF_ZERO_SHOT_FALLBACK || '1') !== '0';
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
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

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ac.signal });
    const raw = await r.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = { raw }; }
    if (!r.ok) {
      const msg = json?.error || json?.message || raw || `HTTP ${r.status}`;
      const e = new Error(msg);
      e.status = r.status;
      e.body = json;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function applyLanguageToolCorrections(text, matches = []) {
  let corrected = text;
  const usable = matches
    .filter(m => m?.replacements?.[0]?.value)
    .filter(m => {
      const id = String(m.rule?.id || '');
      // 大文字開始やピリオドなど、カードゲーム上の表記に関係ないものは補正しない。
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

function hfHeaders() {
  const h = { 'content-type': 'application/json', 'accept': 'application/json' };
  if (HF_TOKEN) h.authorization = `Bearer ${HF_TOKEN}`;
  return h;
}

function flattenClassificationOutput(output) {
  if (Array.isArray(output) && Array.isArray(output[0])) return output[0];
  if (Array.isArray(output)) return output;
  if (output && Array.isArray(output.labels) && Array.isArray(output.scores)) {
    return output.labels.map((label, i) => ({ label, score: output.scores[i] }));
  }
  return [];
}

function labelKind(label) {
  const s = String(label || '').toLowerCase().replace(/[ _-]+/g, '');
  if (!s) return 'unknown';
  if (s.includes('unacceptable') || s.includes('ungrammatical') || s.includes('incorrect') || s.includes('notacceptable') || s === 'label0' || s === '0' || s === 'negative') return 'bad';
  if (s.includes('acceptable') || s.includes('grammatical') || s.includes('correct') || s === 'label1' || s === '1' || s === 'positive') return 'good';
  return 'unknown';
}

function interpretClassification(items, threshold) {
  const rows = flattenClassificationOutput(items)
    .map(x => ({ label: String(x.label ?? ''), score: Number(x.score ?? 0) }))
    .filter(x => x.label && Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);
  const good = rows.find(r => labelKind(r.label) === 'good');
  const bad = rows.find(r => labelKind(r.label) === 'bad');
  const top = rows[0] || null;
  let goodScore = good?.score ?? null;
  let badScore = bad?.score ?? null;
  let ok = false;
  let reason = 'acceptability label not recognized';
  if (good) {
    ok = good.score >= threshold && (!bad || good.score >= bad.score);
    reason = ok ? '' : `acceptability score below threshold: ${good.score}`;
  } else if (top && labelKind(top.label) === 'good') {
    goodScore = top.score;
    ok = top.score >= threshold;
    reason = ok ? '' : `acceptability score below threshold: ${top.score}`;
  } else if (top && labelKind(top.label) === 'bad') {
    badScore = top.score;
    ok = false;
    reason = `model predicted ${top.label}`;
  }
  return { ok, score: goodScore, badScore, threshold, top, labels: rows.slice(0, 8), reason };
}

async function callHfTextClassification(text, model) {
  const apiUrl = `https://router.huggingface.co/${HF_PROVIDER}/models/${model}`;
  const payload = {
    inputs: terminalSentence(text),
    parameters: { top_k: 5, function_to_apply: 'softmax' },
    options: { wait_for_model: true }
  };
  const raw = await fetchJsonWithTimeout(apiUrl, {
    method: 'POST',
    headers: hfHeaders(),
    body: JSON.stringify(payload)
  }, HF_TIMEOUT_MS);
  return { raw, apiUrl };
}

async function callHfZeroShot(text, model) {
  const apiUrl = `https://router.huggingface.co/${HF_PROVIDER}/models/${model}`;
  const payload = {
    inputs: terminalSentence(text),
    parameters: {
      candidate_labels: ['grammatical English sentence', 'ungrammatical English word sequence'],
      multi_label: false
    },
    options: { wait_for_model: true }
  };
  const raw = await fetchJsonWithTimeout(apiUrl, {
    method: 'POST',
    headers: hfHeaders(),
    body: JSON.stringify(payload)
  }, HF_TIMEOUT_MS);
  const rows = flattenClassificationOutput(raw)
    .map(x => ({ label: String(x.label ?? ''), score: Number(x.score ?? 0) }))
    .filter(x => x.label && Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);
  const good = rows.find(r => /grammatical/i.test(r.label) && !/ungrammatical/i.test(r.label));
  const bad = rows.find(r => /ungrammatical/i.test(r.label));
  const score = good?.score ?? null;
  const ok = !!good && score >= ACCEPTABILITY_THRESHOLD && (!bad || good.score >= bad.score);
  return { ok, score, badScore: bad?.score ?? null, threshold: ACCEPTABILITY_THRESHOLD, top: rows[0] || null, labels: rows, raw, apiUrl, model, method: 'zero-shot', reason: ok ? '' : `zero-shot acceptability below threshold or ungrammatical top label` };
}

async function judgeAcceptability(text) {
  if (!HF_TOKEN) {
    return { ok:false, method:'hf', model:ACCEPTABILITY_MODEL, reason:'HF_TOKEN is not set' };
  }
  try {
    const { raw, apiUrl } = await callHfTextClassification(text, ACCEPTABILITY_MODEL);
    const judged = interpretClassification(raw, ACCEPTABILITY_THRESHOLD);
    return { ...judged, raw, apiUrl, model: ACCEPTABILITY_MODEL, method: 'text-classification' };
  } catch (e) {
    const primaryError = {
      message: String(e.message || e),
      status: e.status || null,
      body: e.body || null,
      model: ACCEPTABILITY_MODEL,
      method: 'text-classification'
    };
    if (!HF_ZERO_SHOT_FALLBACK) {
      return { ok:false, model:ACCEPTABILITY_MODEL, method:'text-classification', reason:'acceptability service failed', error:primaryError };
    }
    try {
      const z = await callHfZeroShot(text, HF_ZERO_SHOT_MODEL);
      return { ...z, primaryError, fallbackUsed: true };
    } catch (e2) {
      return {
        ok:false,
        model: ACCEPTABILITY_MODEL,
        method: 'text-classification',
        reason:'acceptability service failed',
        error: primaryError,
        fallbackError: { message:String(e2.message || e2), status:e2.status || null, body:e2.body || null, model:HF_ZERO_SHOT_MODEL, method:'zero-shot' }
      };
    }
  }
}

async function translateToJapanese(text) {
  text = normalizeText(text).replace(/[.!?]+$/, '');
  if (!text) return { ok:false, error:'empty text' };
  const key = text.toLowerCase();
  if (translateCache.has(key)) return { ok:true, ja:translateCache.get(key), source:'cache' };
  const params = new URLSearchParams({ q:text, langpair:'en|ja' });
  if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
  const url = 'https://api.mymemory.translated.net/get?' + params.toString();
  const j = await fetchJsonWithTimeout(url, { headers: { accept:'application/json' } }, 7000);
  const ja = j?.responseData?.translatedText || '';
  if (!ja) throw new Error('empty translation');
  translateCache.set(key, ja);
  if (translateCache.size > 500) translateCache.delete(translateCache.keys().next().value);
  return { ok:true, ja, source:'mymemory', rawStatus:j?.responseStatus };
}

async function checkSentence(text, withTranslate = false) {
  const originalText = normalizeText(text);
  const proof = await proofreadEnglish(originalText);
  const checkedText = proof.corrected || originalText;
  const parsed = await runLinkParser(checkedText);

  if (!parsed.ok) {
    return {
      originalText,
      text: checkedText,
      normalized: proof.normalized,
      appliedCorrections: proof.appliedCorrections || [],
      ok:false,
      gameOk:false,
      kind:'Link Grammar + HF Acceptability',
      sentenceType:null,
      reason:'link grammar parse failed',
      proof,
      fullParse: parsed.fullParse,
      strictLinkGrammar: parsed.strictLinkGrammar,
      linkages: parsed.linkages,
      nullCount: parsed.nullCount,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      code: parsed.code,
      acceptability:null,
      ja:'',
      translation:null
    };
  }

  const acceptability = await judgeAcceptability(checkedText);
  const ok = !!acceptability.ok;
  let translation = null;
  if (ok && withTranslate) {
    try { translation = await translateToJapanese(checkedText); }
    catch (e) { translation = { ok:false, error:String(e.message || e) }; }
  }
  return {
    originalText,
    text: checkedText,
    normalized: proof.normalized,
    appliedCorrections: proof.appliedCorrections || [],
    ok,
    gameOk: ok,
    kind:'Link Grammar + HF Acceptability',
    sentenceType: ok ? 'LG_HF_ACCEPTED' : null,
    reason: ok ? '' : (acceptability.reason || 'acceptability rejected'),
    proof,
    fullParse: parsed.fullParse,
    strictLinkGrammar: parsed.strictLinkGrammar,
    linkages: parsed.linkages,
    nullCount: parsed.nullCount,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    code: parsed.code,
    acceptability,
    ja: translation?.ja || '',
    translation
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok:true });
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') {
      return send(res, 200, {
        ok:true,
        service:'link-grammar-api',
        mode:'link-grammar-plus-hf-acceptability-router',
        acceptabilityModel: ACCEPTABILITY_MODEL,
        acceptabilityThreshold: ACCEPTABILITY_THRESHOLD,
        hfProvider: HF_PROVIDER,
        zeroShotFallback: HF_ZERO_SHOT_FALLBACK,
        zeroShotModel: HF_ZERO_SHOT_MODEL,
        hfTokenPresent: !!HF_TOKEN
      });
    }
    if (url.pathname === '/proof') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, await proofreadEnglish(text));
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

server.listen(PORT, () => console.log(`Link Grammar + HF Acceptability API listening on ${PORT}`));
