import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = Number(process.env.MAX_CHARS || 180);
const LINK_TIMEOUT_MS = Number(process.env.LINK_TIMEOUT_MS || 3500);
const LT_TIMEOUT_MS = Number(process.env.LT_TIMEOUT_MS || 5000);
const HF_TIMEOUT_MS = Number(process.env.HF_TIMEOUT_MS || 25000);
const HF_MODEL_SCAN_TIMEOUT_MS = Number(process.env.HF_MODEL_SCAN_TIMEOUT_MS || 20000);
const HF_SCAN_MODELS = (process.env.HF_SCAN_MODELS || 'textattack/roberta-base-CoLA,cointegrated/roberta-large-cola-krishna2020,mrm8488/deberta-v3-small-finetuned-cola,EstherT/sentence-acceptability,nikolasmoya/c4-binary-english-grammar-checker,vennify/t5-base-grammar-correction,samadpls/t5-base-grammar-checker,hassaanik/grammar-correction-model').split(',').map(s => s.trim()).filter(Boolean);

const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_CHAT_MODEL = process.env.HF_CHAT_MODEL || 'deepseek-ai/DeepSeek-R1:fastest';
const HF_CHAT_URL = process.env.HF_CHAT_URL || 'https://router.huggingface.co/v1/chat/completions';
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const translateCache = new Map();

const REASON_JOB_RETRY_DELAYS_MS = (process.env.REASON_JOB_RETRY_DELAYS_MS || '0,2000,4000,8000,15000,30000').split(',').map(x => Number(x.trim())).filter(Number.isFinite);
const REASON_JOB_MAX_ATTEMPTS = Number(process.env.REASON_JOB_MAX_ATTEMPTS || 999999); // keep retrying while the service is alive
const REASON_JOB_MAX_CACHE = Number(process.env.REASON_JOB_MAX_CACHE || 800);
const reasonJobs = new Map();
let reasonQueueRunning = false;
let reasonQueueTimer = null;
let reasonJobSeq = 1;
let reasonStats = { created:0, success:0, retry:0, failure:0 };

function reasonKey(text) {
  return normalizeText(text).toLowerCase().replace(/[.!?]+$/,'').replace(/\s+/g,' ');
}
function trimReasonJobs() {
  if (reasonJobs.size <= REASON_JOB_MAX_CACHE) return;
  const removable = [...reasonJobs.entries()].filter(([,j]) => j.status === 'success').sort((a,b)=>(a[1].updatedAt||0)-(b[1].updatedAt||0));
  while (reasonJobs.size > REASON_JOB_MAX_CACHE && removable.length) {
    reasonJobs.delete(removable.shift()[0]);
  }
}
function publicReasonJob(job) {
  if (!job) return { ok:false, status:'missing' };
  return {
    ok: job.status === 'success',
    id: job.id,
    text: job.text,
    status: job.status,
    attempts: job.attempts,
    nextRetryAt: job.nextRetryAt || null,
    updatedAt: job.updatedAt,
    error: job.status === 'success' ? '' : (job.lastError || ''),
    reasonExplain: job.status === 'success' ? job.result : null
  };
}
function enqueueReasonJob(text, diagnostics = {}) {
  const src = normalizeText(text);
  const key = reasonKey(src);
  if (!src || !key) return null;
  let job = reasonJobs.get(key);
  if (!job) {
    job = {
      id: 'r' + (reasonJobSeq++).toString(36) + '-' + Math.random().toString(36).slice(2,8),
      key, text:src,
      diagnostics: { judgeSource: diagnostics.judgeSource || 'link-grammar', linkGrammarOk: !!diagnostics.linkGrammarOk, linkages: Number(diagnostics.linkages || 0) },
      status:'pending', attempts:0,
      createdAt: Date.now(), updatedAt: Date.now(), nextRetryAt: Date.now(),
      lastError:'', result:null
    };
    reasonJobs.set(key, job);
    reasonStats.created++;
    trimReasonJobs();
  } else if (job.status !== 'success') {
    // keep latest diagnostics but never reset attempts/result
    job.diagnostics = { ...job.diagnostics, ...diagnostics };
    if (job.status !== 'running') job.status = 'pending';
    if (!job.nextRetryAt || job.nextRetryAt > Date.now()) job.nextRetryAt = Date.now();
    job.updatedAt = Date.now();
  }
  scheduleReasonQueue(0);
  return job;
}
function scheduleReasonQueue(delayMs = 0) {
  if (reasonQueueTimer) clearTimeout(reasonQueueTimer);
  reasonQueueTimer = setTimeout(() => { reasonQueueTimer = null; processReasonQueue().catch(()=>{}); }, Math.max(0, delayMs));
}
async function processReasonQueue() {
  if (reasonQueueRunning) return;
  reasonQueueRunning = true;
  try {
    while (true) {
      const now = Date.now();
      const ready = [...reasonJobs.values()]
        .filter(j => j.status !== 'success' && j.status !== 'running' && (j.nextRetryAt || 0) <= now)
        .sort((a,b)=>(a.nextRetryAt||0)-(b.nextRetryAt||0) || a.createdAt-b.createdAt)[0];
      if (!ready) break;
      ready.status = 'running';
      ready.updatedAt = Date.now();
      try {
        const r = await explainRejectedSentence(ready.text, ready.diagnostics || {});
        const hasExplanation = !!(r?.ok && (String(r.explanationJa||'').trim() || String(r.explanationEn||'').trim()));
        if (!hasExplanation) throw new Error(r?.error || 'reason-explain returned no explanation');
        ready.status = 'success';
        ready.result = r;
        ready.lastError = '';
        ready.updatedAt = Date.now();
        reasonStats.success++;
      } catch (e) {
        ready.attempts++;
        ready.lastError = String(e.message || e);
        ready.updatedAt = Date.now();
        reasonStats.retry++;
        if (ready.attempts >= REASON_JOB_MAX_ATTEMPTS) {
          // In normal operation this should not happen because max is huge; keep retryable but record it.
          ready.attempts = 0;
          reasonStats.failure++;
        }
        const delay = REASON_JOB_RETRY_DELAYS_MS[Math.min(ready.attempts, REASON_JOB_RETRY_DELAYS_MS.length - 1)] ?? 30000;
        ready.status = 'pending';
        ready.nextRetryAt = Date.now() + delay;
      }
    }
  } finally {
    reasonQueueRunning = false;
  }
  const next = [...reasonJobs.values()].filter(j => j.status !== 'success' && j.status !== 'running').sort((a,b)=>(a.nextRetryAt||0)-(b.nextRetryAt||0))[0];
  if (next) scheduleReasonQueue(Math.max(0, (next.nextRetryAt || Date.now()) - Date.now()));
}


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


function hfModelPath(model) {
  return String(model || '').split('/').map(encodeURIComponent).join('/');
}

const HF_GENERATION_MODEL_RE = /(t5|grammar-correction|grammar-checker|correction-model|text2text|bart|pegasus)/i;

function hfModelKind(model) {
  return HF_GENERATION_MODEL_RE.test(String(model || '')) ? 'text-generation' : 'classification';
}

function hfPayloadForModel(model, text, variant = 0) {
  const src = normalizeText(text);
  const kind = hfModelKind(model);
  if (kind === 'classification') {
    // Classification/CoLA models must NOT receive generation params such as max_new_tokens.
    // That caused: PreTrainedTokenizerFast.__call__() got an unexpected keyword argument 'max_new_tokens'.
    return {
      kind,
      inputUsed: src,
      payload: {
        inputs: src,
        options: { wait_for_model: true }
      }
    };
  }

  // Text-to-text grammar correction models are inconsistent. Try plain input first, then a grammar prefix.
  const inputUsed = variant === 1 ? `grammar: ${src}` : src;
  return {
    kind,
    inputUsed,
    payload: {
      inputs: inputUsed,
      options: { wait_for_model: true },
      parameters: { max_new_tokens: 80 }
    }
  };
}

function summarizeHfOutput(model, data, meta = {}) {
  const raw = data;
  const flat = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : data;
  const labels = [];
  if (Array.isArray(flat)) {
    for (const x of flat.slice(0, 12)) {
      if (x && typeof x === 'object') labels.push({ label: x.label, score: x.score });
    }
  }
  let generatedText = '';
  if (Array.isArray(data) && data[0]?.generated_text) generatedText = String(data[0].generated_text || '');
  else if (Array.isArray(data) && data[0]?.summary_text) generatedText = String(data[0].summary_text || '');
  else if (data?.generated_text) generatedText = String(data.generated_text || '');
  else if (data?.summary_text) generatedText = String(data.summary_text || '');

  const error = data?.error || data?.message || '';
  const top = labels.slice().sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0))[0] || null;
  return { model, ok: !error, error, top, labels, generatedText, raw, ...meta };
}

async function postHfModelEndpoint(endpoint, payload) {
  return fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${HF_TOKEN}`,
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify(payload)
  }, HF_MODEL_SCAN_TIMEOUT_MS);
}

async function callHfInferenceModel(model, text) {
  const src = normalizeText(text);
  if (!HF_TOKEN) return { model, ok:false, error:'HF_TOKEN is not set' };
  const path = hfModelPath(model);
  const urls = [
    `https://router.huggingface.co/hf-inference/models/${path}`,
    `https://api-inference.huggingface.co/models/${path}`
  ];
  const kind = hfModelKind(model);
  const variants = kind === 'text-generation' ? [0, 1] : [0];
  const attempts = [];

  for (const variant of variants) {
    const { payload, inputUsed } = hfPayloadForModel(model, src, variant);
    for (const endpoint of urls) {
      try {
        const data = await postHfModelEndpoint(endpoint, payload);
        return { provider:'hf-inference', endpoint, ...summarizeHfOutput(model, data, { kind, inputUsed, variant }) };
      } catch (e) {
        attempts.push({
          endpoint,
          kind,
          inputUsed,
          variant,
          payload,
          error:String(e.message || e),
          status:e.status || null,
          body:e.body || null
        });
      }
    }
  }
  return { model, ok:false, kind, provider:'hf-inference', error:'all HF inference endpoints failed', attempts };
}

async function scanHfModels(text, modelFilter = '') {
  const src = normalizeText(text);
  const models = modelFilter ? [modelFilter] : HF_SCAN_MODELS;
  const results = [];
  for (const model of models) {
    results.push(await callHfInferenceModel(model, src));
  }
  return {
    ok:true,
    version:'hf-model-scan-v2-no-generation-params-for-classifiers',
    text:src,
    count:results.length,
    models,
    results
  };
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


async function explainRejectedSentence(text, diagnostics = {}) {
  const src = normalizeText(text);
  if (!src) return { ok:false, method:'hf-chat-reason-only', model:HF_CHAT_MODEL, error:'empty text' };
  if (!HF_TOKEN) return { ok:false, method:'hf-chat-reason-only', model:HF_CHAT_MODEL, error:'HF_TOKEN is not set' };

  const safeDiagnostics = {
    judgeSource: diagnostics.judgeSource || 'link-grammar',
    linkGrammarOk: !!diagnostics.linkGrammarOk,
    linkages: Number(diagnostics.linkages || 0)
  };

  const system = [
    'You explain English grammar rejections for an educational English word puzzle game.',
    'The game engine has already rejected the input as not being a complete, natural, standalone English sentence. Do not override, reverse, or debate that rejection.',
    'Explain the exact input as a learner-facing grammar explanation, not as a game rule.',
    'Use a structure-first method for every input:',
    'Step 1: identify the words already present and their likely grammatical roles in observedStructure.',
    'Step 2: identify only the additional information, relationship, or sentence structure needed to make the input complete in incompletePart.',
    'Step 3: write a concise learner-facing explanation based on Step 1 and Step 2.',
    'Consistency rule: do not claim that any word type, grammatical role, or sentence element is missing if your observedStructure says it is already present.',
    'If you are uncertain about a specific grammatical label, describe the missing information more generally instead of guessing a part of speech.',
    'Avoid terse internal labels such as "missing verb", "fragment", "parse failed", or "invalid" as the user-facing explanation.',
    'Do not use word-specific hardcoded rules or memorize examples. Explain only what information or structure is incomplete, missing, or unnatural in the exact input.',
    'Avoid vague alternatives like "a verb or something". Prefer the most specific missing information that follows from the observed structure.',
    'Use plain language suitable for a learner. Return only JSON with keys: observedStructure, incompletePart, explanationEn, explanationJa, confidence.'
  ].join(' ');

  const payload = {
    model: HF_CHAT_MODEL,
    messages: [
      { role:'system', content: system },
      { role:'user', content: JSON.stringify({ input: src, diagnostics: safeDiagnostics }) }
    ],
    temperature: 0,
    max_tokens: 180,
    response_format: { type:'json_object' }
  };

  try {
    const j = await fetchJsonWithTimeout(HF_CHAT_URL, {
      method:'POST',
      headers:{
        'authorization': `Bearer ${HF_TOKEN}`,
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify(payload)
    }, HF_TIMEOUT_MS);
    const content = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || '';
    const parsed = tryExtractJson(content) || {};
    const observedStructure = String(parsed.observedStructure || '').trim();
    const incompletePart = String(parsed.incompletePart || '').trim();
    const explanationEn = String(parsed.explanationEn || '').trim();
    const explanationJa = String(parsed.explanationJa || '').trim();
    if (!explanationEn && !explanationJa) {
      return { ok:false, method:'hf-chat-reason-only', model:HF_CHAT_MODEL, error:'HF reason returned empty explanation', raw:j, content };
    }
    return {
      ok:true,
      method:'hf-chat-reason-only',
      model:HF_CHAT_MODEL,
      observedStructure,
      incompletePart,
      explanationEn,
      explanationJa,
      confidence: parsed.confidence ?? null,
      rawReason: parsed
    };
  } catch (e) {
    return { ok:false, method:'hf-chat-reason-only', model:HF_CHAT_MODEL, error:String(e.message || e), status:e.status || null, body:e.body || null };
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
    const type = acceptability.type || 'invalid';
    const gameOk = !!(acceptability.ok && acceptability.gameOk !== false && type === 'complete_sentence');
    let translation = null;
    let reasonExplain = null;
    let reasonJob = null;
    if (gameOk && withTranslate) translation = await translateToJapanese(checkedText);
    if (!gameOk) {
      reasonJob = enqueueReasonJob(checkedText, { judgeSource:'link-grammar', linkGrammarOk:false, linkages:parsed.linkages });
      if (reasonJob?.status === 'success') reasonExplain = reasonJob.result;
    }
    return {
      originalText, text: checkedText, normalized: proof.normalized, appliedCorrections: proof.appliedCorrections || [],
      ok: gameOk, gameOk, type, kind:'Link Grammar + HF Reason Job',
      sentenceType: gameOk ? (acceptability.sentenceType || 'complete_sentence') : (acceptability.sentenceType || type),
      reason: gameOk ? '' : (reasonExplain?.explanationJa || reasonExplain?.explanationEn || ''),
      reasonSource: gameOk ? '' : (reasonExplain?.ok ? reasonExplain.method : 'reason-job-pending'),
      reasonStatus: gameOk ? 'none' : (reasonJob?.status || 'pending'),
      reasonJobId: gameOk ? '' : (reasonJob?.id || ''),
      reasonExplain, proof,
      fullParse: parsed.fullParse, strictLinkGrammar: parsed.strictLinkGrammar,
      linkages: parsed.linkages, nullCount: parsed.nullCount, stdout: parsed.stdout, stderr: parsed.stderr, code: parsed.code,
      acceptability, ja: translation?.ja || '', translation
    };
  }

  const ok = !!acceptability.ok;
  const type = acceptability.type || (ok ? 'complete_sentence' : 'invalid');
  const gameOk = !!(ok && acceptability.gameOk !== false && type === 'complete_sentence');
  let translation = null;
  let reasonExplain = null;
  let reasonJob = null;
  if (gameOk && withTranslate) translation = await translateToJapanese(checkedText);
  if (!gameOk) {
    reasonJob = enqueueReasonJob(checkedText, { judgeSource:'link-grammar-plus-hf-chat', linkGrammarOk:true, linkages:parsed.linkages });
    if (reasonJob?.status === 'success') reasonExplain = reasonJob.result;
  }
  return {
    originalText, text: checkedText, normalized: proof.normalized, appliedCorrections: proof.appliedCorrections || [],
    ok, gameOk, type, kind:'Link Grammar + HF Reason Job',
    sentenceType: gameOk ? (acceptability.sentenceType || 'complete_sentence') : (acceptability.sentenceType || type),
    reason: gameOk ? '' : (reasonExplain?.explanationJa || reasonExplain?.explanationEn || ''),
    reasonSource: gameOk ? '' : (reasonExplain?.ok ? reasonExplain.method : 'reason-job-pending'),
    reasonStatus: gameOk ? 'none' : (reasonJob?.status || 'pending'),
    reasonJobId: gameOk ? '' : (reasonJob?.id || ''),
    reasonExplain, proof,
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
          reason: checked.reason || checked.reasonExplain?.explanationJa || checked.reasonExplain?.explanationEn || '',
          reasonSource: checked.reasonSource || checked.reasonExplain?.method || '',
          reasonStatus: checked.reasonStatus || '',
          reasonJobId: checked.reasonJobId || '',
          reasonExplain: checked.reasonExplain || null,
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
        mode:'link-grammar-reason-job-v13-confirmed-api-result-only',
        hfChatModel: HF_CHAT_MODEL,
        hfChatUrl: HF_CHAT_URL,
        hfTokenPresent: !!HF_TOKEN,
        hfModelScanVersion: 'v2-no-generation-params-for-classifiers',
        hfModelScanModels: HF_SCAN_MODELS,
        reasonJobs: { size: reasonJobs.size, running: reasonQueueRunning, stats: reasonStats, successCacheSize: [...reasonJobs.values()].filter(j=>j.status==='success').length, pendingSize: [...reasonJobs.values()].filter(j=>j.status!=='success').length }
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

    if (url.pathname === '/hf-model-scan' || url.pathname === '/hf-model-scan-v2') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, await scanHfModels(text, url.searchParams.get('model') || ''));
    }
    if (url.pathname === '/acceptability') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, { text, ...(await judgeAcceptability(text)) });
    }
    if (url.pathname === '/reason-job') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const job = enqueueReasonJob(text, { judgeSource:'manual-reason-job' });
      return send(res, 200, { text, ...publicReasonJob(job) });
    }
    if (url.pathname === '/reason-result') {
      const text = await getTextFromReq(req, url);
      const id = url.searchParams.get('id') || '';
      let job = null;
      if (id) job = [...reasonJobs.values()].find(j => j.id === id) || null;
      if (!job && text) job = reasonJobs.get(reasonKey(text)) || null;
      if (!job) return send(res, 200, { ok:false, status:'missing', text });
      return send(res, 200, { text: job.text, ...publicReasonJob(job) });
    }
    if (url.pathname === '/reason-explain') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const job = enqueueReasonJob(text, { judgeSource:'manual-reason-explain' });
      if (job?.status === 'success') return send(res, 200, { text, ...job.result, reasonJobId:job.id, reasonStatus:'success' });
      return send(res, 200, { text, ok:false, reasonJobId:job?.id || '', reasonStatus:job?.status || 'pending', status:job?.status || 'pending', attempts:job?.attempts || 0 });
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
