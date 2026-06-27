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
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || '';
const PIXABAY_TIMEOUT_MS = Number(process.env.PIXABAY_TIMEOUT_MS || 9000);
const sentenceImageCache = new Map();
const translateCache = new Map();

const REASON_JOB_RETRY_DELAYS_MS = (process.env.REASON_JOB_RETRY_DELAYS_MS || '3000,8000,15000,30000').split(',').map(x => Number(x.trim())).filter(Number.isFinite); // v26: 失敗直後の0ms即リトライを廃止
const REASON_JOB_MAX_ATTEMPTS_RAW = Number(process.env.REASON_JOB_MAX_ATTEMPTS || 3);
const REASON_JOB_MAX_ATTEMPTS = Math.max(1, Math.min(5, Number.isFinite(REASON_JOB_MAX_ATTEMPTS_RAW) ? REASON_JOB_MAX_ATTEMPTS_RAW : 3)); // v26: Render環境変数が999999等でも強制クランプ、標準3回
const REASON_JOB_MAX_CACHE = Number(process.env.REASON_JOB_MAX_CACHE || 800);
const reasonJobs = new Map();
let reasonQueueRunning = false;
let reasonQueueTimer = null;
let reasonJobSeq = 1;
let reasonStats = { created:0, success:0, retry:0, failure:0 };
let reasonQueueRevision = 0;

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
function activeReasonJobs() {
  return [...reasonJobs.values()].filter(j => !['success','failure','failed','error','cancelled','canceled'].includes(String(j.status || '').toLowerCase()));
}
function waitingReasonJobs() {
  return activeReasonJobs().filter(j => j.status !== 'running').sort(compareReasonJobs);
}
function runningReasonJob() {
  return activeReasonJobs().find(j => j.status === 'running') || null;
}

function expireOverAttemptJobs() {
  let changed = false;
  for (const j of reasonJobs.values()) {
    const st = String(j.status || '').toLowerCase();
    if (['success','failure','failed','error','cancelled','canceled','running'].includes(st)) continue;
    if (Number(j.attempts || 0) >= REASON_JOB_MAX_ATTEMPTS) {
      j.status = 'failure';
      j.nextRetryAt = null;
      j.lastError = j.lastError || `reason attempts exceeded (${REASON_JOB_MAX_ATTEMPTS})`;
      j.updatedAt = Date.now();
      reasonStats.failure++;
      changed = true;
    }
  }
  if (changed) reasonQueueRevision++;
}
function reasonQueueMeta(job) {
  if (!job) return { queueRevision: reasonQueueRevision, queueRole:'missing', queueIndex:null, queueLabel:'' };
  if (job.status === 'running') return { queueRevision: reasonQueueRevision, queueRole:'running', queueIndex:0, queueLabel:'理由解析中' };
  if (['success','failure','failed','error'].includes(String(job.status || '').toLowerCase())) {
    return { queueRevision: reasonQueueRevision, queueRole:job.status, queueIndex:null, queueLabel:'' };
  }
  const wait = waitingReasonJobs();
  const idx = wait.findIndex(j => j.id === job.id);
  const n = idx >= 0 ? idx + 1 : null;
  return { queueRevision: reasonQueueRevision, queueRole:'waiting', queueIndex:n, queueLabel:n ? `理由解析待ち${n}` : '理由解析待ち' };
}
function publicReasonJob(job) {
  if (!job) return { ok:false, status:'missing', ...reasonQueueMeta(null) };
  return {
    ok: job.status === 'success',
    id: job.id,
    text: job.text,
    status: job.status,
    attempts: job.attempts,
    nextRetryAt: job.nextRetryAt || null,
    updatedAt: job.updatedAt,
    priorityEpoch: job.priorityEpoch || 0,
    prioritySeq: job.prioritySeq || 0,
    error: job.status === 'success' ? '' : (job.lastError || ''),
    reasonExplain: job.status === 'success' ? job.result : null,
    runningJobId: runningReasonJob()?.id || '',
    runningText: runningReasonJob()?.text || '',
    ...reasonQueueMeta(job)
  };
}
function publicReasonQueue() {
  const run = runningReasonJob();
  const wait = waitingReasonJobs();
  return {
    ok:true,
    queueRevision: reasonQueueRevision,
    running: run ? publicReasonJob(run) : null,
    waiting: wait.slice(0, 30).map(j => publicReasonJob(j)),
    size: activeReasonJobs().length,
    stats: reasonStats
  };
}
function reasonPriorityFromDiagnostics(diagnostics = {}) {
  const epoch = Number(diagnostics.reasonPriorityEpoch ?? diagnostics.priorityEpoch ?? diagnostics.reasonEpoch ?? 0);
  const seq = Number(diagnostics.reasonPrioritySeq ?? diagnostics.prioritySeq ?? diagnostics.reasonSeq ?? 0);
  return {
    priorityEpoch: Number.isFinite(epoch) ? epoch : 0,
    prioritySeq: Number.isFinite(seq) ? seq : 0
  };
}
function compareReasonJobs(a, b) {
  // v23: ユーザーが新しく置いたカード由来の経路を最優先。
  // 同じ一手内では候補生成順。古い失敗リトライや古いlocalStorage由来のpendingを前に出さない。
  const pe = (b.priorityEpoch || 0) - (a.priorityEpoch || 0);
  if (pe) return pe;
  const ps = (a.prioritySeq || 0) - (b.prioritySeq || 0);
  if (ps) return ps;
  return (a.nextRetryAt || 0) - (b.nextRetryAt || 0) || a.createdAt - b.createdAt;
}
function enqueueReasonJob(text, diagnostics = {}) {
  const src = normalizeText(text);
  const key = reasonKey(src);
  if (!src || !key) return null;
  const now = Date.now();
  const pr = reasonPriorityFromDiagnostics(diagnostics);
  let job = reasonJobs.get(key);
  const terminal = job && ['failure','failed','error','cancelled','canceled'].includes(String(job.status || '').toLowerCase());
  const newerRequest = !job || pr.priorityEpoch > (job.priorityEpoch || 0) || (pr.priorityEpoch === (job.priorityEpoch || 0) && pr.prioritySeq < (job.prioritySeq || 0));
  if (!job || (terminal && newerRequest)) {
    // v26: 失敗済みjobを同じ英文キーで再利用しない。
    // 「I am」が過去に4回失敗済みだと、新規ゲームでも一瞬で再試行4/failureになるため、
    // 新しい一手から来た再要求は attempts=0 の新jobとして作り直す。
    job = {
      id: 'r' + (reasonJobSeq++).toString(36) + '-' + Math.random().toString(36).slice(2,8),
      key, text:src,
      diagnostics: { judgeSource: diagnostics.judgeSource || 'link-grammar', linkGrammarOk: !!diagnostics.linkGrammarOk, linkages: Number(diagnostics.linkages || 0) },
      status:'pending', attempts:0,
      createdAt: now, updatedAt: now, nextRetryAt: now,
      ...pr,
      lastError:'', result:null
    };
    reasonJobs.set(key, job);
    reasonStats.created++;
    reasonQueueRevision++;
    trimReasonJobs();
  } else if (job.status !== 'success') {
    // v26: running中は割り込めないが、終わった瞬間の再ソート用に優先度だけ更新する。
    // terminalで newerRequest ではない場合は、無限復活させず failure のまま返す。
    job.diagnostics = { ...job.diagnostics, ...diagnostics };
    if (newerRequest) {
      job.priorityEpoch = pr.priorityEpoch;
      job.prioritySeq = pr.prioritySeq;
    }
    if (!terminal && job.status !== 'running') job.status = 'pending';
    if (!terminal && (!job.nextRetryAt || job.nextRetryAt > now)) job.nextRetryAt = now;
    job.updatedAt = now;
    reasonQueueRevision++;
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
      expireOverAttemptJobs();
      const now = Date.now();
      const ready = [...reasonJobs.values()]
        .filter(j => !['success','failure','failed','error','cancelled','canceled','running'].includes(String(j.status || '').toLowerCase()) && Number(j.attempts || 0) < REASON_JOB_MAX_ATTEMPTS && (j.nextRetryAt || 0) <= now)
        .sort(compareReasonJobs)[0];
      if (!ready) break;
      ready.status = 'running';
      ready.updatedAt = Date.now();
      reasonQueueRevision++;
      try {
        const r = await explainRejectedSentence(ready.text, ready.diagnostics || {});
        const hasExplanation = !!(r?.ok && (String(r.explanationJa||'').trim() || String(r.explanationEn||'').trim()));
        if (!hasExplanation) throw new Error(r?.error || 'reason-explain returned no explanation');
        ready.status = 'success';
        ready.result = r;
        ready.lastError = '';
        ready.updatedAt = Date.now();
        reasonStats.success++;
        reasonQueueRevision++;
      } catch (e) {
        ready.attempts++;
        ready.lastError = String(e.message || e);
        ready.updatedAt = Date.now();
        reasonStats.retry++;
        if (ready.attempts >= REASON_JOB_MAX_ATTEMPTS) {
          // v24: 古い失敗jobを無限に先頭へ戻さない。失敗として確定し、新しい一手を詰まらせない。
          ready.status = 'failure';
          ready.nextRetryAt = null;
          reasonStats.failure++;
          reasonQueueRevision++;
          continue;
        }
        const delay = REASON_JOB_RETRY_DELAYS_MS[Math.min(ready.attempts, REASON_JOB_RETRY_DELAYS_MS.length - 1)] ?? 30000;
        ready.status = 'pending';
        ready.nextRetryAt = Date.now() + delay;
        reasonQueueRevision++;
      }
    }
  } finally {
    reasonQueueRunning = false;
  }
  expireOverAttemptJobs();
  const next = [...reasonJobs.values()].filter(j => !['success','failure','failed','error','cancelled','canceled','running'].includes(String(j.status || '').toLowerCase())).sort((a,b)=>(a.nextRetryAt||0)-(b.nextRetryAt||0) || compareReasonJobs(a,b))[0];
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

async function checkSentence(text, withTranslate = false, reasonMeta = {}) {
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
      reasonJob = enqueueReasonJob(checkedText, { judgeSource:'link-grammar', linkGrammarOk:false, linkages:parsed.linkages, ...reasonMeta });
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
    reasonJob = enqueueReasonJob(checkedText, { judgeSource:'link-grammar-plus-hf-chat', linkGrammarOk:true, linkages:parsed.linkages, ...reasonMeta });
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
        const checked = await checkSentence(item.text, true, { reasonPriorityEpoch: j.reasonPriorityEpoch || j.reasonEpoch || Date.now(), reasonPrioritySeq: Number(item.id || 0) });
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


function sentenceImageNorm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function sentenceImageWords(text) {
  return sentenceImageNorm(text).split(/\s+/).filter(Boolean);
}
const SENTENCE_IMAGE_STOP = new Set(['i','me','my','you','your','he','she','we','they','it','am','are','is','was','were','be','been','being','a','an','the','to','of','for','in','on','at','with','and','or','very','really','today','now','everyday','can','will','would','could','should','must','may','might','do','does','did']);
const SUBJECT_WORDS = new Set(['child','children','boy','girl','kid','kids','student','students','person','people','man','woman']);
const OBJECT_VISUAL_HINTS = {
  apple:'fruit', apples:'fruit', banana:'fruit', bananas:'fruit', orange:'fruit', oranges:'fruit', soccer:'ball', football:'ball', baseball:'ball', tennis:'racket', basketball:'ball', book:'book', books:'books', music:'headphones', japanese:'japan flag', english:'uk flag', school:'school building', park:'park', home:'house', house:'house', dog:'dog', cat:'cat'
};
function termVariants(w) {
  w = String(w || '').toLowerCase();
  const out = new Set([w]);
  if (w.endsWith('ies')) out.add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) out.add(w.slice(0, -2));
  if (w.endsWith('s') && w.length > 3) out.add(w.slice(0, -1));
  if (w.endsWith('ing') && w.length > 5) {
    out.add(w.slice(0, -3));
    const stem = w.slice(0, -3);
    if (stem.length >= 2 && stem.at(-1) === stem.at(-2)) out.add(stem.slice(0, -1));
  }
  if (w === 'soccer') out.add('football');
  if (w === 'football') out.add('soccer');
  if (w === 'happy') { out.add('smile'); out.add('smiling'); }
  if (w === 'sad') { out.add('cry'); out.add('crying'); out.add('unhappy'); }
  return [...out].filter(Boolean);
}
function visualCoreTerms(words) {
  return words.filter(w => !SENTENCE_IMAGE_STOP.has(w));
}
function sentenceImageProfile(sentence) {
  const words = sentenceImageWords(sentence).filter(w => !['a','an','the'].includes(w));
  const first = words[0] || '';
  const pronounSubject = new Set(['i','he','she','me','him','her']);
  const pluralSubject = new Set(['we','they','you','us','them']);
  const beWords = new Set(['am','are','is','was','were','be','been','being']);
  const modalWords = new Set(['can','will','would','could','should','must','may','might']);
  const subject = pronounSubject.has(first) ? 'child' : (pluralSubject.has(first) ? 'children' : first);
  let kind = 'generic';
  let verb = '';
  let core = [];
  if (words.length >= 3 && beWords.has(words[1])) {
    kind = 'state';
    core = visualCoreTerms(words.slice(2));
  } else {
    let i = 1;
    while (i < words.length && modalWords.has(words[i])) i++;
    verb = words[i] || '';
    const rest = words.slice(i + 1).filter(w => !['to','of','for','in','on','at','with'].includes(w));
    kind = verb ? 'action' : 'generic';
    core = visualCoreTerms([verb, ...rest]);
  }
  const required = core.filter(w => !['like','likes','love','loves','want','wants','go','goes'].includes(w));
  return { words, subject, kind, verb, core, required };
}
function toPixabayGerund(v) {
  v = String(v || '').toLowerCase().trim();
  if (!v) return '';
  if (v.endsWith('ie')) return v.slice(0, -2) + 'ying';
  if (v.endsWith('e') && !['be','see','flee'].includes(v)) return v.slice(0, -1) + 'ing';
  if (/^[a-z]{3}$/.test(v) && /[bcdfghjklmnpqrstvwxyz][aeiou][bcdfghjklmnpqrstvwxyz]$/.test(v) && !/[wxy]$/.test(v)) return v + v.slice(-1) + 'ing';
  return v + 'ing';
}
function buildSentenceImageQueries(sentence) {
  const profile = sentenceImageProfile(sentence);
  const { words, subject, kind, verb } = profile;
  if (!words.length) return [];
  const originalNoArticles = words.join(' ');
  const queries = [];
  function add(q) {
    q = String(q || '')
      .replace(/\b(a|an|the)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    if (q && !queries.includes(q)) queries.push(q);
  }
  const core = profile.core;
  const required = profile.required;
  const coreText = core.join(' ');
  const requiredText = required.join(' ');
  const hintText = required.map(w => OBJECT_VISUAL_HINTS[w]).filter(Boolean).join(' ');

  if (kind === 'state' && requiredText) {
    add([subject, 'with', requiredText, 'face cartoon illustration'].join(' '));
    add([subject, requiredText, 'emotion cartoon illustration'].join(' '));
    add([requiredText, subject, 'cartoon illustration'].join(' '));
    add([requiredText, 'face expression illustration'].join(' '));
  }

  if (kind === 'action' && verb) {
    const gerund = toPixabayGerund(verb);
    if (['like','likes','love','loves','want','wants'].includes(verb) && requiredText) {
      add([subject, 'holding', requiredText, hintText, 'cartoon illustration'].join(' '));
      add([subject, 'eating', requiredText, hintText, 'cartoon illustration'].join(' '));
      add([subject, 'with', requiredText, hintText, 'illustration'].join(' '));
      add([requiredText, hintText, 'illustration'].join(' '));
    } else if (verb === 'play' || verb === 'plays') {
      add([subject, 'playing', requiredText, hintText, 'cartoon illustration'].join(' '));
      add(['kids playing', requiredText, hintText, 'illustration'].join(' '));
      add([requiredText, 'player cartoon illustration'].join(' '));
    } else if (verb === 'go' || verb === 'goes') {
      add([subject, 'going to', requiredText, hintText, 'cartoon illustration'].join(' '));
      add([requiredText, hintText, 'building illustration'].join(' '));
    } else {
      add([subject, gerund, requiredText, hintText, 'cartoon illustration'].join(' '));
      add([subject, verb, requiredText, hintText, 'illustration'].join(' '));
      add([gerund, requiredText, hintText, 'illustration'].join(' '));
    }
  }
  if (requiredText) add([requiredText, hintText, 'cartoon illustration'].join(' '));
  if (coreText) add([subject, coreText, 'illustration'].join(' '));
  add([originalNoArticles, 'illustration'].join(' '));
  return queries.slice(0, 10);
}
function textHasAnyVariant(text, word) {
  return termVariants(word).some(v => text.includes(v));
}
function scorePixabayHit(hit, query, profile, avoidIds = new Set()) {
  const text = sentenceImageNorm([hit?.tags, hit?.name, hit?.type].filter(Boolean).join(' '));
  const textWords = new Set(text.split(/\s+/).filter(Boolean));
  const qWords = sentenceImageWords(query).filter(w => !['illustration','image','picture','cartoon','emotion','face','with','holding','eating'].includes(w));
  let score = 0;
  let matchedCore = 0;
  for (const w of qWords) {
    if (!w) continue;
    if (termVariants(w).some(v => textWords.has(v))) { score += 9; matchedCore++; }
    else if (textHasAnyVariant(text, w)) { score += 4; matchedCore += 0.5; }
  }
  let requiredMatched = 0;
  for (const w of (profile?.required || [])) {
    if (textHasAnyVariant(text, w)) { score += 22; requiredMatched++; }
    else score -= 16;
  }
  if ((profile?.required || []).length && requiredMatched === 0) score -= 55;
  if (profile?.kind === 'action' && profile?.verb && !['like','likes','love','loves','want','wants','go','goes'].includes(profile.verb)) {
    if (textHasAnyVariant(text, profile.verb) || textHasAnyVariant(text, toPixabayGerund(profile.verb))) score += 14;
  }
  const id = String(hit?.id || '');
  if (id && avoidIds.has(id)) score -= 120;
  if (String(hit?.type || '').includes('vector')) score += 8;
  if (String(hit?.type || '').includes('illustration')) score += 6;
  if (hit?.isGRated === true) score += 6;
  if (hit?.isLowQuality === true) score -= 80;
  if (hit?.isAiGenerated === true) score -= 25;
  const humanWanted = profile?.subject && SUBJECT_WORDS.has(profile.subject);
  const humanHit = /\b(child|kid|kids|boy|girl|person|people|student|player|teen|pupil|man|woman|children)\b/.test(text);
  if (humanHit) score += humanWanted ? 10 : 2;
  if (humanWanted && !humanHit && profile?.kind !== 'generic') score -= 10;
  if (humanWanted && /\b(elephant|animal|dog|cat|bird|horse|lion|bear|pet|mammal)\b/.test(text) && !(profile?.required || []).some(w => ['dog','cat','horse'].includes(w))) score -= 28;
  if (/\b(icon|symbol|background|pattern|wallpaper|texture|logo|frame|border)\b/.test(text)) score -= 16;
  if (matchedCore < 1.2 && (profile?.core || []).length) score -= 16;
  const w = Number(hit?.webformatWidth || hit?.imageWidth || 0);
  const h = Number(hit?.webformatHeight || hit?.imageHeight || 0);
  if (w && h) {
    const ratio = w / h;
    if (ratio > 0.45 && ratio < 1.9) score += 4;
    if (ratio < 0.28 || ratio > 2.8) score -= 10;
  }
  score += Math.min(8, Number(hit?.likes || 0) / 18);
  score += Math.min(5, Number(hit?.downloads || 0) / 25000);
  return score;
}
async function searchPixabayImages(query) {
  const params = new URLSearchParams({
    key: PIXABAY_API_KEY,
    q: query,
    image_type: 'illustration',
    safesearch: 'true',
    per_page: '12',
    order: 'popular'
  });
  const url = 'https://pixabay.com/api/?' + params.toString();
  const data = await fetchJsonWithTimeout(url, {}, PIXABAY_TIMEOUT_MS);
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  return { data, hits };
}
async function sentenceImageForText(sentence, opts = {}) {
  const text = normalizeText(sentence).replace(/[.!?]$/,'');
  if (!text) return { ok:false, error:'empty q' };
  if (!PIXABAY_API_KEY) return { ok:false, sentence:text, error:'missing_PIXABAY_API_KEY' };
  const avoidIds = new Set(String(opts.avoid || '').split(',').map(s => s.trim()).filter(Boolean));
  const cacheKey = sentenceImageNorm(text) + '|avoid:' + [...avoidIds].slice(0, 12).sort().join(',');
  const cached = sentenceImageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cache:true };

  const profile = sentenceImageProfile(text);
  const queries = buildSentenceImageQueries(text);
  const all = [];
  const tried = [];
  for (const query of queries) {
    tried.push(query);
    try {
      const { hits } = await searchPixabayImages(query);
      for (const hit of hits) all.push({ hit, query, score: scorePixabayHit(hit, query, profile, avoidIds) });
    } catch (e) {
      // keep trying other query shapes; one weak query must not kill the whole image feature
    }
  }
  all.sort((a,b)=>b.score-a.score);
  const best = all.find(x => (x.hit?.webformatURL || x.hit?.largeImageURL || x.hit?.previewURL) && x.score > -40)
    || all.find(x => x.hit?.webformatURL || x.hit?.largeImageURL || x.hit?.previewURL);
  if (!best) return { ok:false, sentence:text, queries:tried, required:profile.required, error:'no_image_found' };
  const h = best.hit;
  const value = {
    ok:true,
    sentence:text,
    query:best.query,
    queries:tried,
    required:profile.required,
    score:Math.round(best.score * 10) / 10,
    imageUrl:h.webformatURL || h.largeImageURL || h.previewURL,
    previewUrl:h.previewURL || '',
    largeImageUrl:h.largeImageURL || '',
    pageURL:h.pageURL || '',
    tags:h.tags || '',
    provider:'pixabay',
    attribution:'Image via Pixabay',
    type:h.type || '',
    width:h.webformatWidth || h.imageWidth || 0,
    height:h.webformatHeight || h.imageHeight || 0,
    user:h.user || '',
    id:h.id || ''
  };
  sentenceImageCache.set(cacheKey, { value, expiresAt:Date.now() + 90 * 60 * 1000 });
  if (sentenceImageCache.size > 500) sentenceImageCache.delete(sentenceImageCache.keys().next().value);
  return value;
}


const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok:true });
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') {
      return send(res, 200, {
        ok:true,
        service:'link-grammar-api',
        mode:'link-grammar-reason-job-v26-no-instant-terminal-reuse',
        hfChatModel: HF_CHAT_MODEL,
        hfChatUrl: HF_CHAT_URL,
        hfTokenPresent: !!HF_TOKEN,
        pixabayKeyPresent: !!PIXABAY_API_KEY,
        hfModelScanVersion: 'v2-no-generation-params-for-classifiers',
        hfModelScanModels: HF_SCAN_MODELS,
        reasonJobs: { size: reasonJobs.size, running: reasonQueueRunning, maxAttempts: REASON_JOB_MAX_ATTEMPTS, rawMaxAttempts: REASON_JOB_MAX_ATTEMPTS_RAW, stats: reasonStats, successCacheSize: [...reasonJobs.values()].filter(j=>j.status==='success').length, pendingSize: [...reasonJobs.values()].filter(j=>!['success','failure','failed','error','cancelled','canceled'].includes(String(j.status||'').toLowerCase())).length }
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

    if (url.pathname === '/sentence-image') {
      const text = url.searchParams.get('q') || url.searchParams.get('text') || '';
      if (!text) return send(res, 400, { ok:false, error:'missing q' });
      return send(res, 200, await sentenceImageForText(text, { avoid:url.searchParams.get('avoid') || '' }));
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
    if (url.pathname === '/reason-queue') {
      return send(res, 200, publicReasonQueue());
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
      return send(res, 200, { text, ok:false, reasonJobId:job?.id || '', reasonStatus:job?.status || 'pending', ...publicReasonJob(job) });
    }
    if (url.pathname === '/check-and-translate-batch') {
      if (req.method !== 'POST') return send(res, 405, { ok:false, error:'POST required' });
      return send(res, 200, await checkSentenceBatch(req));
    }
    if (url.pathname === '/check' || url.pathname === '/check-and-translate') {
      let text = url.searchParams.get('text') || '';
      let body = {};
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try { body = JSON.parse(raw || '{}') || {}; text = body.text || (Array.isArray(body.words) ? body.words.join(' ') : text); }
        catch { text = raw || text; }
      }
      text = normalizeText(text);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const reasonMeta = {
        reasonPriorityEpoch: body.reasonPriorityEpoch || body.reasonEpoch || Number(url.searchParams.get('reasonPriorityEpoch') || 0),
        reasonPrioritySeq: body.reasonPrioritySeq || body.reasonSeq || Number(url.searchParams.get('reasonPrioritySeq') || 0)
      };
      return send(res, 200, await checkSentence(text, url.pathname === '/check-and-translate', reasonMeta));
    }
    return send(res, 404, { ok:false, error:'not found' });
  } catch (e) {
    return send(res, 500, { ok:false, error:String(e.message || e), status:e.status || null, body:e.body || null });
  }
});

server.listen(PORT, () => console.log(`Link Grammar + HF Chat Acceptability API listening on ${PORT}`));
