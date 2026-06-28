import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = Number(process.env.MAX_CHARS || 180);
const LINK_TIMEOUT_MS = Number(process.env.LINK_TIMEOUT_MS || 3500);
const LT_TIMEOUT_MS = Number(process.env.LT_TIMEOUT_MS || 5000);
const HF_TIMEOUT_MS = Number(process.env.HF_TIMEOUT_MS || 25000);
const HF_MODEL_SCAN_TIMEOUT_MS = Number(process.env.HF_MODEL_SCAN_TIMEOUT_MS || 20000);
// v43: production gate adds a lightweight HF grammar classifier only after Link Grammar + LanguageTool pass.
// The selected production model is abdulmatinomotoso/English_Grammar_Checker because diagnostics verified:
// OK: I am happy / The cat is sleeping, NG: eating am happy / walking am happy / he am happy.
// /diagnose-acceptability remains available for model inspection. /check now uses the production HF gate when enabled.
const HF_SCAN_MODELS = (process.env.HF_SCAN_MODELS || 'textattack/roberta-base-CoLA,abdulmatinomotoso/English_Grammar_Checker,agentlans/snowflake-arctic-xs-grammar-classifier,nikolasmoya/c4-binary-english-grammar-checker,pszemraj/electra-small-discriminator-CoLA,textattack/bert-base-uncased-CoLA,EstherT/sentence-acceptability').split(',').map(s => s.trim()).filter(Boolean);
const ACCEPTABILITY_HF_ENABLED = !/^false|0|off$/i.test(String(process.env.ACCEPTABILITY_HF_ENABLED || 'true'));
const ACCEPTABILITY_HF_MODEL = process.env.ACCEPTABILITY_HF_MODEL || 'abdulmatinomotoso/English_Grammar_Checker';
const ACCEPTABILITY_HF_FAIL_CLOSED = /^true|1|on$/i.test(String(process.env.ACCEPTABILITY_HF_FAIL_CLOSED || 'false'));
const ACCEPTABILITY_HF_DAILY_MAX = Math.max(0, Number(process.env.ACCEPTABILITY_HF_DAILY_MAX || 80));
const ACCEPTABILITY_HF_CACHE_MAX = Math.max(100, Number(process.env.ACCEPTABILITY_HF_CACHE_MAX || 2000));

const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_CHAT_MODEL = process.env.HF_CHAT_MODEL || 'deepseek-ai/DeepSeek-R1:fastest';
const HF_CHAT_URL = process.env.HF_CHAT_URL || 'https://router.huggingface.co/v1/chat/completions';
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || '';
const PIXABAY_TIMEOUT_MS = Number(process.env.PIXABAY_TIMEOUT_MS || 9000);
const sentenceImageCache = new Map();
const translateCache = new Map();
const hfAcceptabilityCache = new Map();
let hfAcceptabilityStats = { day:'', calls:0, cacheHits:0, accepted:0, rejected:0, unavailable:0, skipped:0 };
function currentUtcDayKey() { return new Date().toISOString().slice(0, 10); }
function resetHfAcceptabilityStatsIfNeeded() { const d = currentUtcDayKey(); if (hfAcceptabilityStats.day !== d) hfAcceptabilityStats = { day:d, calls:0, cacheHits:0, accepted:0, rejected:0, unavailable:0, skipped:0 }; }
function trimHfAcceptabilityCache() { while (hfAcceptabilityCache.size > ACCEPTABILITY_HF_CACHE_MAX) hfAcceptabilityCache.delete(hfAcceptabilityCache.keys().next().value); }

const REASON_JOB_RETRY_DELAYS_MS = (process.env.REASON_JOB_RETRY_DELAYS_MS || '3000,8000,15000,30000').split(',').map(x => Number(x.trim())).filter(Number.isFinite); // v26: 失敗直後の0ms即リトライを廃止
const REASON_JOB_MAX_ATTEMPTS_RAW = Number(process.env.REASON_JOB_MAX_ATTEMPTS || 3);
const REASON_JOB_MAX_ATTEMPTS = Math.max(1, Math.min(5, Number.isFinite(REASON_JOB_MAX_ATTEMPTS_RAW) ? REASON_JOB_MAX_ATTEMPTS_RAW : 3)); // v26: Render環境変数が999999等でも強制クランプ、標準3回
const REASON_JOB_MAX_CACHE = Number(process.env.REASON_JOB_MAX_CACHE || 800);
const REASON_JOB_TIMEOUT_MS = Math.max(3000, Number(process.env.REASON_JOB_TIMEOUT_MS || 30000)); // v51/v53: 理由job全体の安全弁。候補数の打ち切りではなく、外部I/Oハングでキューを塞がないため。
const REASON_CANDIDATE_TIMEOUT_MS = Math.max(1000, Number(process.env.REASON_CANDIDATE_TIMEOUT_MS || 2500)); // v51/v53: 候補1件ごとの軽量判定I/O安全弁。候補数上限ではない。
const REASON_FINAL_HF_TIMEOUT_MS = Math.max(2500, Number(process.env.REASON_FINAL_HF_TIMEOUT_MS || 7000)); // v53: 理由表示に出す候補だけ、/check本判定と同じHF文法ゲートで最終確認する。
const reasonJobs = new Map();
let reasonQueueRunning = false;
let reasonQueueTimer = null;
let reasonJobSeq = 1;
let reasonStats = { created:0, success:0, retry:0, failure:0, unavailable:0 };
let reasonQueueRevision = 0;

function isTerminalReasonStatus(st) {
  return ['success','failure','failed','error','cancelled','canceled','unavailable'].includes(String(st || '').toLowerCase());
}
function isNonRetryableReasonError(err) {
  if (err?.retryable === false) return true;
  const bodyText = (() => {
    try { return typeof err?.body === 'string' ? err.body : JSON.stringify(err?.body || ''); } catch { return ''; }
  })();
  const msg = String((err?.message || err || '') + ' ' + bodyText).toLowerCase();
  const status = Number(err?.status || 0);
  // v28: HF Inference Providers の月間無料枠/プリペイド枠切れは、再試行しても成功しない。
  // これを retryable にすると「一瞬で再試行3→失敗」やキュー詰まりに見えるため、unavailable へ即落とす。
  const quotaLike =
    msg.includes('depleted your monthly included credits') ||
    msg.includes('monthly included credits') ||
    msg.includes('pre-paid credits') ||
    msg.includes('inference providers') && msg.includes('credits') ||
    msg.includes('insufficient credits') ||
    msg.includes('credits exhausted') ||
    msg.includes('quota exceeded') ||
    msg.includes('billing') ||
    msg.includes('payment required');
  return !HF_TOKEN || status === 400 || status === 401 || status === 402 || status === 403 || status === 404 || quotaLike || msg.includes('hf_token is not set') || msg.includes('authorization') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('model not found') || msg.includes('invalid api key') || msg.includes('invalid token');
}


function withReasonTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label || 'reason operation'} timed out after ${timeoutMs}ms`);
        err.retryable = false;
        err.reasonTimeout = true;
        reject(err);
      }, timeoutMs);
    })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function expireStaleRunningReasonJobs() {
  const now = Date.now();
  let changed = false;
  for (const j of reasonJobs.values()) {
    if (String(j.status || '').toLowerCase() !== 'running') continue;
    const age = now - Number(j.startedAt || j.updatedAt || 0);
    if (age > REASON_JOB_TIMEOUT_MS * 2) {
      j.status = 'failure';
      j.lastError = `stale running reason job expired after ${age}ms`;
      j.nextRetryAt = null;
      j.updatedAt = now;
      reasonStats.failure++;
      changed = true;
    }
  }
  if (changed) reasonQueueRevision++;
  return changed;
}


function reasonKey(text) {
  return normalizeText(text).toLowerCase().replace(/[.!?]+$/,'').replace(/\s+/g,' ');
}
function reasonContextSignature(diagnostics = {}) {
  // v39: 理由探索は「その時点の盤面/手札/候補カード」に依存する。
  // 文だけで成功キャッシュすると、候補なしで作った古い結果が、候補ありの現在盤面に再利用される。
  // 単語別文法ルールではなく、探索入力そのものをjob keyに含める。
  const board = uniqueWordsFromArray(diagnostics.reasonBoardCandidates || diagnostics.boardCandidates || [], 80);
  const hand = uniqueWordsFromArray(diagnostics.reasonHandCandidates || diagnostics.handCandidates || [], 40);
  const deck = uniqueWordsFromArray(diagnostics.reasonDeckCandidates || diagnostics.reasonCandidates || diagnostics.deckCandidates || [], 220);
  const sig = JSON.stringify({ board, hand, deck });
  let h = 2166136261;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}
function reasonJobKey(text, diagnostics = {}) {
  return reasonKey(text) + '|ctx:' + reasonContextSignature(diagnostics);
}
function latestReasonJobByText(text) {
  const k = reasonKey(text);
  return [...reasonJobs.values()]
    .filter(j => reasonKey(j.text) === k)
    .sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0] || null;
}
function reasonDiagnosticsForJob(diagnostics = {}) {
  // v39: 作成時に盤面/手札/候補カードを捨てない。成立判定前の自動補正は禁止。
  return {
    ...diagnostics,
    judgeSource: diagnostics.judgeSource || 'link-grammar',
    linkGrammarOk: !!diagnostics.linkGrammarOk,
    linkages: Number(diagnostics.linkages || 0),
    reasonBoardCandidates: uniqueWordsFromArray(diagnostics.reasonBoardCandidates || diagnostics.boardCandidates || [], 80),
    reasonHandCandidates: uniqueWordsFromArray(diagnostics.reasonHandCandidates || diagnostics.handCandidates || [], 40),
    reasonDeckCandidates: uniqueWordsFromArray(diagnostics.reasonDeckCandidates || diagnostics.reasonCandidates || diagnostics.deckCandidates || [], 220)
  };
}
function trimReasonJobs() {
  if (reasonJobs.size <= REASON_JOB_MAX_CACHE) return;
  const removable = [...reasonJobs.entries()].filter(([,j]) => j.status === 'success').sort((a,b)=>(a[1].updatedAt||0)-(b[1].updatedAt||0));
  while (reasonJobs.size > REASON_JOB_MAX_CACHE && removable.length) {
    reasonJobs.delete(removable.shift()[0]);
  }
}
function activeReasonJobs() {
  return [...reasonJobs.values()].filter(j => !['success','failure','failed','error','cancelled','canceled','unavailable'].includes(String(j.status || '').toLowerCase()));
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
    if (['success','failure','failed','error','cancelled','canceled','unavailable','running'].includes(st)) continue;
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
  if (['success','failure','failed','error','unavailable'].includes(String(job.status || '').toLowerCase())) {
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
  const key = reasonJobKey(src, diagnostics);
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
      diagnostics: reasonDiagnosticsForJob(diagnostics),
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
    job.diagnostics = reasonDiagnosticsForJob({ ...job.diagnostics, ...diagnostics });
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
  expireStaleRunningReasonJobs();
  if (reasonQueueRunning) return;
  reasonQueueRunning = true;
  try {
    while (true) {
      expireOverAttemptJobs();
      const now = Date.now();
      const ready = [...reasonJobs.values()]
        .filter(j => !['success','failure','failed','error','cancelled','canceled','unavailable','running'].includes(String(j.status || '').toLowerCase()) && Number(j.attempts || 0) < REASON_JOB_MAX_ATTEMPTS && (j.nextRetryAt || 0) <= now)
        .sort(compareReasonJobs)[0];
      if (!ready) break;
      ready.status = 'running';
      ready.startedAt = Date.now();
      ready.updatedAt = ready.startedAt;
      reasonQueueRevision++;
      try {
        const r = await withReasonTimeout(explainRejectedSentence(ready.text, ready.diagnostics || {}), REASON_JOB_TIMEOUT_MS, `reason job ${ready.id}`);
        const hasExplanation = !!(r?.ok && (String(r.explanationJa||'').trim() || String(r.explanationEn||'').trim()));
        if (!hasExplanation) {
          const err = new Error(r?.error || 'reason-explain returned no explanation');
          err.status = r?.status || null;
          err.retryable = r?.retryable !== false;
          throw err;
        }
        ready.status = 'success';
        ready.result = r;
        ready.lastError = '';
        ready.updatedAt = Date.now();
        reasonStats.success++;
        reasonQueueRevision++;
      } catch (e) {
        if (e?.reasonTimeout) {
          ready.status = 'failure';
          ready.nextRetryAt = null;
          ready.lastError = String(e.message || e);
          ready.updatedAt = Date.now();
          reasonStats.failure++;
          reasonQueueRevision++;
          continue;
        }
        if (isNonRetryableReasonError(e)) {
          ready.status = 'unavailable';
          ready.nextRetryAt = null;
          ready.lastError = String(e.message || e);
          ready.updatedAt = Date.now();
          reasonStats.unavailable++;
          reasonQueueRevision++;
          continue;
        }
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
  const next = [...reasonJobs.values()].filter(j => !['success','failure','failed','error','cancelled','canceled','unavailable','running'].includes(String(j.status || '').toLowerCase())).sort((a,b)=>(a.nextRetryAt||0)-(b.nextRetryAt||0) || compareReasonJobs(a,b))[0];
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


const ltGateCache = new Map();
const LT_GATE_IGNORE_RULE_IDS = new Set([
  'UPPERCASE_SENTENCE_START',
  'WHITESPACE_RULE',
  'COMMA_PARENTHESIS_WHITESPACE',
  'EN_QUOTES',
  'MORFOLOGIK_RULE_EN_US'
]);
function simplifyLanguageToolMatch(m) {
  const rule = m?.rule || {};
  const category = rule?.category || {};
  const id = String(rule?.id || '');
  const issueType = String(rule?.issueType || '');
  const categoryId = String(category?.id || '');
  const ignored = LT_GATE_IGNORE_RULE_IDS.has(id) || issueType === 'typographical' || categoryId === 'CASING';
  const blocking = !ignored && (issueType === 'grammar' || categoryId === 'GRAMMAR');
  return {
    offset: Number(m?.offset || 0),
    length: Number(m?.length || 0),
    ruleId: id,
    message: String(m?.message || ''),
    shortMessage: String(m?.shortMessage || ''),
    issueType,
    categoryId,
    categoryName: String(category?.name || ''),
    replacements: Array.isArray(m?.replacements) ? m.replacements.slice(0, 5).map(r => String(r?.value || '')).filter(Boolean) : [],
    ignored,
    blocking,
    usedForCorrection: false
  };
}
async function languageToolErrorGate(text) {
  const src = normalizeText(text);
  const key = src.toLowerCase();
  const cached = ltGateCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!src) return { checked:false, ok:true, matches:[], blockingMatches:[], error:'empty text' };
  try {
    const body = new URLSearchParams({ text: src, language: 'en-US' });
    const j = await fetchJsonWithTimeout(LANGUAGETOOL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
      body
    }, LT_TIMEOUT_MS);
    const matches = (Array.isArray(j?.matches) ? j.matches : []).map(simplifyLanguageToolMatch);
    const blockingMatches = matches.filter(m => m.blocking);
    const value = {
      checked:true,
      ok:blockingMatches.length === 0,
      usedForCorrection:false,
      matches,
      blockingMatches,
      matchesCount:matches.length,
      blockingCount:blockingMatches.length,
      gate:'languagetool-error-detection-only'
    };
    ltGateCache.set(key, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
    if (ltGateCache.size > 500) ltGateCache.delete(ltGateCache.keys().next().value);
    return value;
  } catch (e) {
    return { checked:false, ok:true, usedForCorrection:false, matches:[], blockingMatches:[], matchesCount:0, blockingCount:0, error:String(e.message || e), gate:'languagetool-error-detection-only-failed-open' };
  }
}
function localAcceptabilityFromLinkParserAndLt(text, parsed, ltGate = null) {
  const base = localAcceptabilityFromLinkParser(text, parsed);
  if (!strictLinkGrammarGameOk(parsed)) return { ...base, method:'strict-link-grammar-plus-languagetool-error-gate', gate:'strict-link-grammar-failed', languageToolBlocking:false };
  const blocking = Array.isArray(ltGate?.blockingMatches) ? ltGate.blockingMatches : [];
  if (blocking.length > 0) {
    const top = blocking[0];
    return {
      ok:false,
      gameOk:false,
      type:'grammar_error',
      method:'strict-link-grammar-plus-languagetool-error-gate',
      reason: top.message || 'LanguageTool detected a blocking grammar issue.',
      sentenceType:'not_complete_sentence',
      utteranceType:'grammar_error',
      displayKind:'文法エラー',
      jaHint:'',
      noteJa: top.message ? `LanguageTool判定: ${top.message}` : 'LanguageToolが文法上の問題を検出しました。',
      noteEn: top.message || '',
      gate:'languagetool-blocking-rule',
      hfUsed:false,
      languageToolBlocking:true,
      blockingRuleId: top.ruleId || '',
      blockingMessage: top.message || '',
      blockingMatches: blocking.slice(0, 5)
    };
  }
  return { ...base, method:'strict-link-grammar-plus-languagetool-error-gate', gate:'strict-link-grammar-and-languagetool', languageToolBlocking:false };
}
async function hfAcceptabilityGate(text) {
  resetHfAcceptabilityStatsIfNeeded();
  const src = normalizeText(text);
  // v45: HF判定キャッシュは exact text。lowercase化すると `walking...` と `Walking...` の検証が混ざるため。
  const key = `${ACCEPTABILITY_HF_MODEL}::${src}`;
  const cached = hfAcceptabilityCache.get(key);
  if (cached) {
    hfAcceptabilityStats.cacheHits++;
    return { ...cached, cached:true };
  }
  if (!ACCEPTABILITY_HF_ENABLED) {
    hfAcceptabilityStats.skipped++;
    return { checked:false, ok:true, available:false, enabled:false, model:ACCEPTABILITY_HF_MODEL, reason:'hf-acceptability-disabled', failOpen:!ACCEPTABILITY_HF_FAIL_CLOSED };
  }
  if (!HF_TOKEN) {
    hfAcceptabilityStats.unavailable++;
    return { checked:false, ok:!ACCEPTABILITY_HF_FAIL_CLOSED, available:false, enabled:true, model:ACCEPTABILITY_HF_MODEL, reason:'HF_TOKEN is not set', failOpen:!ACCEPTABILITY_HF_FAIL_CLOSED };
  }
  if (ACCEPTABILITY_HF_DAILY_MAX > 0 && hfAcceptabilityStats.calls >= ACCEPTABILITY_HF_DAILY_MAX) {
    hfAcceptabilityStats.unavailable++;
    return { checked:false, ok:!ACCEPTABILITY_HF_FAIL_CLOSED, available:false, enabled:true, model:ACCEPTABILITY_HF_MODEL, reason:'daily HF acceptability limit reached', dailyMax:ACCEPTABILITY_HF_DAILY_MAX, failOpen:!ACCEPTABILITY_HF_FAIL_CLOSED };
  }
  hfAcceptabilityStats.calls++;
  const summary = await callHfInferenceModel(ACCEPTABILITY_HF_MODEL, src);
  const judgement = inferAcceptabilityFromHfSummary(summary);
  let value;
  if (!judgement.ok || judgement.acceptable === null) {
    hfAcceptabilityStats.unavailable++;
    value = { checked:true, ok:!ACCEPTABILITY_HF_FAIL_CLOSED, available:false, enabled:true, model:ACCEPTABILITY_HF_MODEL, judgement, reason: judgement.error || judgement.reason || 'unknown HF output', failOpen:!ACCEPTABILITY_HF_FAIL_CLOSED };
  } else if (judgement.acceptable === false) {
    hfAcceptabilityStats.rejected++;
    value = { checked:true, ok:false, available:true, enabled:true, model:ACCEPTABILITY_HF_MODEL, judgement, reason:`acceptability rejected by ${ACCEPTABILITY_HF_MODEL}`, failOpen:false };
  } else {
    hfAcceptabilityStats.accepted++;
    value = { checked:true, ok:true, available:true, enabled:true, model:ACCEPTABILITY_HF_MODEL, judgement, reason:'acceptability accepted', failOpen:false };
  }
  hfAcceptabilityCache.set(key, value);
  trimHfAcceptabilityCache();
  return { ...value, cached:false };
}

function applyHfAcceptabilityToLocalAcceptability(baseAccept, hfGate) {
  if (!(baseAccept?.ok && baseAccept?.gameOk !== false && baseAccept?.type === 'complete_sentence')) return baseAccept;
  if (!hfGate?.checked && hfGate?.ok !== false) {
    return { ...baseAccept, method:'strict-link-grammar-plus-languagetool-plus-hf-grammar-gate', gate:'strict-link-grammar-languagetool-hf-unchecked-open', hfUsed:false, hfAcceptability:hfGate };
  }
  if (hfGate?.ok === false) {
    const msg = hfGate?.judgement?.reason || hfGate?.reason || 'External grammar classifier rejected this sentence.';
    return {
      ok:false,
      gameOk:false,
      type:'grammar_error',
      method:'strict-link-grammar-plus-languagetool-plus-hf-grammar-gate',
      reason: msg,
      sentenceType:'not_complete_sentence',
      utteranceType:'grammar_error',
      displayKind:'文法エラー',
      jaHint:'',
      noteJa:`文法判定モデル: ${msg}`,
      noteEn:msg,
      gate:'hf-grammar-classifier-rejected',
      hfUsed:true,
      hfAcceptability:hfGate,
      hfModel:hfGate?.model || ACCEPTABILITY_HF_MODEL,
      languageToolBlocking:false
    };
  }
  return { ...baseAccept, method:'strict-link-grammar-plus-languagetool-plus-hf-grammar-gate', gate:'strict-link-grammar-languagetool-hf-accepted', hfUsed:!!hfGate?.checked, hfAcceptability:hfGate, hfModel:hfGate?.model || ACCEPTABILITY_HF_MODEL };
}

async function evaluateGameTextExact(text) {
  const src = normalizeText(text);
  const parsed = await runLinkParser(src);
  let ltGate = null;
  if (strictLinkGrammarGameOk(parsed)) ltGate = await languageToolErrorGate(src);
  let acceptability = localAcceptabilityFromLinkParserAndLt(src, parsed, ltGate);
  let hfGate = null;
  if (acceptability.ok && acceptability.gameOk !== false && acceptability.type === 'complete_sentence') {
    hfGate = await hfAcceptabilityGate(src);
    acceptability = applyHfAcceptabilityToLocalAcceptability(acceptability, hfGate);
  }
  return { text:src, parsed, languageTool:ltGate, hfAcceptability:hfGate, acceptability, ok:!!acceptability.ok, gameOk:!!(acceptability.ok && acceptability.gameOk !== false && acceptability.type === 'complete_sentence') };
}

async function evaluateGameTextLightForReason(text) {
  const src = normalizeText(text);
  const parsed = await runLinkParser(src);
  let ltGate = null;
  if (strictLinkGrammarGameOk(parsed)) ltGate = await languageToolErrorGate(src);
  const acceptability = localAcceptabilityFromLinkParserAndLt(src, parsed, ltGate);
  return {
    text: src,
    parsed,
    languageTool: ltGate,
    hfAcceptability: null,
    acceptability,
    ok: !!acceptability.ok,
    gameOk: !!(acceptability.ok && acceptability.gameOk !== false && acceptability.type === 'complete_sentence'),
    lightOnly: true
  };
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

const HF_GENERATION_MODEL_RE = /(t5|grammar-correction|correction-model|text2text|bart|pegasus)/i;
const HF_FORCE_CLASSIFICATION_MODELS = new Set([
  'nikolasmoya/c4-binary-english-grammar-checker',
  'abdulmatinomotoso/English_Grammar_Checker',
  'agentlans/snowflake-arctic-xs-grammar-classifier',
  'pszemraj/electra-small-discriminator-CoLA'
]);

function hfModelKind(model) {
  const m = String(model || '');
  if (HF_FORCE_CLASSIFICATION_MODELS.has(m)) return 'classification';
  return HF_GENERATION_MODEL_RE.test(m) ? 'text-generation' : 'classification';
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
    version:'hf-model-scan-v3-second-pass-classifier-candidates',
    text:src,
    count:results.length,
    models,
    results
  };
}


function inferAcceptabilityFromHfSummary(summary) {
  const labels = Array.isArray(summary?.labels) ? summary.labels : [];
  const top = summary?.top || labels.slice().sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0))[0] || null;
  const generated = String(summary?.generatedText || '').trim();
  const topLabelRaw = String(top?.label || '').trim();
  const topLabel = topLabelRaw.toLowerCase();
  const generatedLower = generated.toLowerCase();
  const model = String(summary?.model || '');
  const score = Number(top?.score || 0);
  let acceptable = null;
  let reason = 'unknown-output';
  let labelMapping = '';

  // v42 bug: it scanned all labels, but classifier output normally includes both LABEL_0 and LABEL_1.
  // Therefore every result contained LABEL_0 somewhere and was treated as unacceptable.
  // v42.1 decides from the top label only.
  if (/\bunacceptable\b|\bnot acceptable\b|\bincorrect\b|\bungrammatical\b|\bbad\b|\berror\b/.test(topLabel) || /\bunacceptable\b|\bnot acceptable\b|\bincorrect\b|\bungrammatical\b|\bbad\b|\berror\b/.test(generatedLower)) {
    acceptable = false; reason = 'negative-top-label-or-generated-text';
  } else if (/\bacceptable\b|\bcorrect\b|\bgrammatical\b|\bgood\b|\bok\b/.test(topLabel) || /\bacceptable\b|\bcorrect\b|\bgrammatical\b|\bgood\b|\bok\b/.test(generatedLower)) {
    acceptable = true; reason = 'positive-top-label-or-generated-text';
  } else if (model === 'textattack/roberta-base-CoLA' || model === 'textattack/bert-base-uncased-CoLA' || model === 'EstherT/sentence-acceptability' || model === 'cointegrated/roberta-large-cola-krishna2020' || model === 'mrm8488/deberta-v3-small-finetuned-cola') {
    labelMapping = `${model}: LABEL_1=acceptable, LABEL_0=unacceptable`;
    if (topLabel === 'label_1') {
      acceptable = true; reason = 'cola-like-label_1-acceptable';
    } else if (topLabel === 'label_0') {
      acceptable = false; reason = 'cola-like-label_0-unacceptable';
    }
  } else if (model === 'nikolasmoya/c4-binary-english-grammar-checker') {
    // This model card reports a binary English grammar checker. Labels must be verified by benchmark.
    labelMapping = 'c4-binary grammar checker: tentative LABEL_1=acceptable, LABEL_0=unacceptable';
    if (topLabel === 'label_1') {
      acceptable = true; reason = 'c4-label_1-tentative-acceptable';
    } else if (topLabel === 'label_0') {
      acceptable = false; reason = 'c4-label_0-tentative-unacceptable';
    }
  } else if (model === 'abdulmatinomotoso/English_Grammar_Checker' || model === 'agentlans/snowflake-arctic-xs-grammar-classifier' || model === 'pszemraj/electra-small-discriminator-CoLA') {
    // New v42.3 candidates. Keep label mapping explicit but tentative; benchmark decides whether usable.
    labelMapping = `${model}: tentative LABEL_1=acceptable, LABEL_0=unacceptable; natural labels override this`;
    if (topLabel === 'label_1') {
      acceptable = true; reason = 'v423-label_1-tentative-acceptable';
    } else if (topLabel === 'label_0') {
      acceptable = false; reason = 'v423-label_0-tentative-unacceptable';
    }
  } else if (topLabel === 'label_1') {
    acceptable = true; reason = 'generic-label_1-assumed-acceptable';
    labelMapping = 'generic fallback: LABEL_1=acceptable';
  } else if (topLabel === 'label_0') {
    acceptable = false; reason = 'generic-label_0-assumed-unacceptable';
    labelMapping = 'generic fallback: LABEL_0=unacceptable';
  }

  return {
    model,
    ok: !!summary?.ok,
    provider: summary?.provider || '',
    kind: summary?.kind || '',
    acceptable,
    confidence: score || null,
    reason,
    labelMapping,
    top,
    labels: labels.slice(0, 8),
    generatedText: generated,
    error: summary?.error || '',
    attempts: summary?.attempts || undefined
  };
}

async function diagnoseAcceptabilityWithModels(text, modelFilter = '', scanAll = false) {
  const src = normalizeText(text);
  const parsed = await runLinkParser(src);
  const lt = await languageToolErrorGate(src);
  const baseAccept = localAcceptabilityFromLinkParserAndLt(src, parsed, lt);
  const hfScan = await scanHfModels(src, modelFilter || (scanAll ? '' : 'textattack/roberta-base-CoLA'));
  const modelJudgements = (hfScan.results || []).map(inferAcceptabilityFromHfSummary);
  const usable = modelJudgements.filter(x => x.ok && x.acceptable !== null);
  const rejected = usable.filter(x => x.acceptable === false);
  const accepted = usable.filter(x => x.acceptable === true);
  let preview = {
    ok: !!(baseAccept.ok && baseAccept.gameOk !== false && baseAccept.type === 'complete_sentence'),
    gate: baseAccept.gate,
    reason: baseAccept.reason || baseAccept.noteJa || '',
    note: 'Acceptability models are diagnostic only in v42.3; /check is not changed by this endpoint.'
  };
  if (preview.ok && rejected.length > 0) {
    preview = {
      ok: false,
      gate: 'acceptability-model-diagnostic-rejected',
      reason: `acceptability diagnostic rejected by ${rejected[0].model}`,
      rejectedBy: rejected.map(x => ({ model:x.model, confidence:x.confidence, reason:x.reason, top:x.top })).slice(0, 5),
      note: 'diagnostic only: not yet used as the game gate'
    };
  }
  return {
    ok:true,
    version:'v43-hf-grammar-gate-abdul-only',
    text:src,
    usedForCorrection:false,
    linkGrammar:{ ok:strictLinkGrammarGameOk(parsed), fullParse:parsed.fullParse, strictLinkGrammar:parsed.strictLinkGrammar, linkages:parsed.linkages, nullCount:parsed.nullCount, code:parsed.code },
    languageTool:lt,
    baseGate:baseAccept,
    hfDiagnostic:{ tokenPresent:!!HF_TOKEN, modelFilter:modelFilter || '', scanVersion:hfScan.version, count:hfScan.count, models:hfScan.models, judgements:modelJudgements, acceptedCount:accepted.length, rejectedCount:rejected.length, usableCount:usable.length },
    finalGatePreview:preview
  };
}


function strictLinkGrammarGameOk(parsed) {
  return !!(
    parsed &&
    parsed.ok === true &&
    parsed.fullParse === true &&
    parsed.strictLinkGrammar === true &&
    Number(parsed.linkages || 0) > 0 &&
    Number(parsed.nullCount || 0) === 0 &&
    Number(parsed.code || 0) === 0
  );
}


function contextualShortAnswerInfo(text) {
  // v37: no phrase-specific contextual-short-answer classification.
  // Acceptance is based only on the actual Strict Link Grammar API result.
  return null;
}

function localAcceptabilityFromLinkParser(text, parsed) {
  const src = normalizeText(text);
  const words = src.split(/\s+/).filter(Boolean);
  const lgOk = strictLinkGrammarGameOk(parsed);
  if (lgOk) {
    const shortAnswer = contextualShortAnswerInfo(src);
    return {
      ok:true,
      gameOk:true,
      type:'complete_sentence',
      method:'strict-link-grammar-only',
      reason:'',
      sentenceType: shortAnswer?.sentenceType || 'complete_sentence',
      utteranceType: shortAnswer?.utteranceType || 'standalone_sentence',
      displayKind: shortAnswer?.displayKind || '完全な文',
      jaHint: shortAnswer?.ja || '',
      noteJa: shortAnswer?.noteJa || '',
      noteEn: shortAnswer?.noteEn || '',
      gate:'link-grammar-only',
      hfUsed:false
    };
  }
  return {
    ok:false,
    gameOk:false,
    type: words.length <= 1 ? 'word' : 'fragment_or_invalid_order',
    method:'strict-link-grammar-only',
    reason:'Strict Link Grammar could not build a complete full parse with nullCount=0.',
    sentenceType: words.length <= 1 ? 'single_word' : 'not_complete_sentence',
    gate:'link-grammar-only',
    hfUsed:false
  };
}

function localReasonFromDiagnostics(text, diagnostics = {}) {
  const src = normalizeText(text);
  const words = src.split(/\s+/).filter(Boolean);
  const linkages = Number(diagnostics.linkages || 0);
  const linkGrammarOk = !!diagnostics.linkGrammarOk;
  let observedStructure = '';
  let incompletePart = '';
  let explanationEn = '';
  let explanationJa = '';

  if (!src) {
    observedStructure = 'empty input';
    incompletePart = 'no words were provided';
    explanationEn = 'No words were placed, so this cannot be checked as a complete English sentence.';
    explanationJa = '単語が置かれていないため、完全な英文として判定できません。';
  } else if (words.length === 1) {
    observedStructure = 'single word';
    incompletePart = 'a complete sentence needs more structure than one word';
    explanationEn = `"${src}" is only one word. A complete English sentence normally needs enough words to form a full statement.`;
    explanationJa = `「${src}」は単語だけです。完全な英文にするには、文として意味が完結するだけの語のつながりが必要です。`;
  } else if (!linkGrammarOk || linkages <= 0) {
    observedStructure = 'multiple words, but no complete strict Link Grammar linkage';
    incompletePart = 'the placed words do not connect as one complete sentence under strict parsing';
    explanationEn = `The words "${src}" did not form a complete strict Link Grammar parse. Some word connection is missing, extra, or in an unnatural order for a complete sentence.`;
    explanationJa = `「${src}」は Strict Link Grammar で完全な文として結びつきませんでした。語のつながりが足りない、余っている、または語順が自然な完全英文になっていない可能性があります。`;
  } else {
    observedStructure = 'parser accepted structure but game rejected it by a secondary rule';
    incompletePart = 'game acceptability rule rejected the candidate';
    explanationEn = `The candidate "${src}" was rejected by the game acceptability rule, not by a paid AI service.`;
    explanationJa = `「${src}」はゲーム側の成立条件で不成立になりました。有料AIサービスではなく、ローカル判定結果です。`;
  }
  return {
    ok:true,
    method:'local-link-grammar-reason-v30',
    model:'none',
    observedStructure,
    incompletePart,
    explanationEn,
    explanationJa,
    confidence: linkGrammarOk ? 0.7 : 0.85,
    rawReason:{ local:true, words, diagnostics:{ linkGrammarOk, linkages, judgeSource:diagnostics.judgeSource || '' } }
  };
}

async function judgeAcceptability(text) {
  const ev = await evaluateGameTextExact(text);
  return ev.acceptability;
}



function uniqueWordsFromArray(arr, max = 160) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(arr) ? arr : []) {
    const w = normalizeText(String(x || '')).replace(/[.!?]+$/,'').trim();
    if (!w || /\s/.test(w)) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function wordsFromQuery(url, names, max = 160) {
  // v50: browser URL debug helper. This is not grammar logic.
  // It only lets a normal address-bar URL pass hand/board/deck context
  // without DevTools Console. Accepts comma, pipe, slash, or newline separated words.
  const raw = [];
  for (const name of names) {
    for (const value of url.searchParams.getAll(name)) {
      if (!value) continue;
      raw.push(...String(value).split(/[|,\/\n\r\t]+/g));
    }
  }
  return uniqueWordsFromArray(raw, max);
}

function canonicalGameWords(words) {
  // v34: no grammar/case hardcoding. Do not lowercase, do not special-case I/am/is/etc.
  // Use the exact card tokens/text supplied by the game and let Strict Link Grammar be the oracle.
  return (words || [])
    .map(x => normalizeText(String(x || '')).replace(/[.!?]+$/,'').trim())
    .filter(Boolean);
}
function formatCandidateSentence(wordsOrText) {
  const words = Array.isArray(wordsOrText) ? canonicalGameWords(wordsOrText) : canonicalGameWords(String(wordsOrText||'').split(/\s+/));
  return words.join(' ');
}
function uniqueSentence(words) {
  return formatCandidateSentence(words).replace(/[.!?]+$/,'');
}
function limitedPermutations(arr, max = 120) {
  const a = (arr || []).slice();
  const out = [];
  const used = Array(a.length).fill(false);
  const cur = [];
  const seen = new Set();
  function rec() {
    if (out.length >= max) return;
    if (cur.length === a.length) {
      const s = uniqueSentence(cur);
      if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(cur.slice()); }
      return;
    }
    const local = new Set();
    for (let i = 0; i < a.length; i++) {
      const k = String(a[i]).toLowerCase();
      if (used[i] || local.has(k)) continue;
      local.add(k); used[i] = true; cur.push(a[i]); rec(); cur.pop(); used[i] = false;
      if (out.length >= max) return;
    }
  }
  rec();
  return out;
}

async function explainByExploration(text, diagnostics = {}) {
  const src = normalizeText(text).replace(/[.!?]+$/,'');
  const words = canonicalGameWords(src.split(/\s+/).filter(Boolean));
  const wordSet = new Set(words.map(w => w.toLowerCase()));

  // v48: 候補順の調整でも、無制限に /check(HF込み) を叩く方式でもない。
  // 1手候補を全列挙し、まず LG+LanguageTool の軽い判定でふるいにかける。
  // HF 文法分類は軽い判定を通った候補だけに使う。
  // これは特定英文をOKにする処理ではなく、判定コストを段階化した最短距離探索。
  const boardRaw = uniqueWordsFromArray(diagnostics.reasonBoardCandidates || diagnostics.boardCandidates || [], 1000000);
  const board = boardRaw.filter(w => !wordSet.has(String(w).toLowerCase()));
  const hand = uniqueWordsFromArray(diagnostics.reasonHandCandidates || diagnostics.handCandidates || [], 1000000);
  const deck = uniqueWordsFromArray(diagnostics.reasonDeckCandidates || diagnostics.reasonCandidates || diagnostics.deckCandidates || [], 1000000);
  const candidates = uniqueWordsFromArray([...board, ...hand, ...deck], 1000000);
  const boardSet = new Set(board.map(w => w.toLowerCase()));
  const handSet = new Set(hand.map(w => w.toLowerCase()));
  const deckOnly = candidates.filter(c => !boardSet.has(c.toLowerCase()) && !handSet.has(c.toLowerCase()));
  const originalKey = src.toLowerCase();
  const startedAt = Date.now();
  let checks = 0;
  let finalHfChecks = 0;
  let finalHfRejected = 0;
  let finalHfSuppressed = 0;
  const checked = new Map();

  async function isGood(sentence) {
    const t = normalizeText(sentence).replace(/[.!?]+$/,'');
    const k = t.toLowerCase();
    if (!t || k === originalKey) return false;
    if (checked.has(k)) return checked.get(k);
    checks++;

    // v48: 理由探索では、候補全部にいきなり /check 相当(HF込み)をかけない。
    // まず軽い LG + LanguageTool だけで全候補をふるいにかける。
    // HF 文法分類は、軽い判定を通った「成立しそうな候補」にだけ最後にかける。
    const light = await withReasonTimeout(evaluateGameTextLightForReason(t), REASON_CANDIDATE_TIMEOUT_MS, `reason light candidate ${t}`);
    if (!light.gameOk) {
      const value = {
        ok:false,
        stage:'light-rejected',
        parsed:light.parsed,
        languageTool:light.languageTool,
        acceptability:light.acceptability,
        hfAcceptability:null,
        text:t
      };
      checked.set(k, value);
      return value;
    }

    // v53: ここではまだ「候補発見」だけ。表示確定は runLevel 側でHF文法ゲートに通す。
    // 候補全部にHFをかけず、LG+LanguageToolを通った候補だけ最終確認する。
    const value = {
      ok:true,
      stage:'light-accepted-awaiting-hf-display-filter-v53',
      parsed:light.parsed,
      languageTool:light.languageTool,
      acceptability:light.acceptability,
      hfAcceptability:{ checked:false, skipped:true, reason:'HF is deferred until the candidate is about to be displayed v53' },
      text:t
    };
    checked.set(k, value);
    return value;
  }

  async function verifyReasonDisplayCandidate(lightResult) {
    const t = normalizeText(lightResult?.text || '').replace(/[.!?]+$/,'');
    if (!t || !lightResult?.ok) return { ok:false, stage:'display-filter-no-light-candidate', text:t };
    try {
      const hfGate = await withReasonTimeout(hfAcceptabilityGate(t), REASON_FINAL_HF_TIMEOUT_MS, `reason final HF candidate ${t}`);
      const finalAcceptability = applyHfAcceptabilityToLocalAcceptability(lightResult.acceptability, hfGate);
      const finalOk = !!(finalAcceptability?.ok && finalAcceptability?.gameOk !== false && finalAcceptability?.type === 'complete_sentence');
      return {
        ok: finalOk,
        stage: finalOk ? 'light-and-hf-accepted-for-reason-display-v53' : 'hf-rejected-for-reason-display-v53',
        text:t,
        parsed:lightResult.parsed,
        languageTool:lightResult.languageTool,
        acceptability:finalAcceptability,
        hfAcceptability:hfGate
      };
    } catch (e) {
      // v53: HFが遅い/失敗した候補は「仮候補」として表示しない。間違った候補を出すより安全側に倒す。
      return { ok:false, stage:'hf-unavailable-suppressed-for-reason-display-v53', text:t, error:String(e?.message || e), parsed:lightResult.parsed, languageTool:lightResult.languageTool, acceptability:lightResult.acceptability, hfAcceptability:{ checked:false, ok:false, available:false, reason:String(e?.message || e) } };
    }
  }

  function opSentence(op) { return uniqueSentence(op.words); }
  function pushOp(list, seen, op) {
    const sentence = opSentence(op);
    const k = sentence.toLowerCase();
    if (!sentence || k === originalKey || seen.has(k)) return;
    seen.add(k);
    list.push({ ...op, sentence });
  }
  function permutationsAll(arr) {
    const a = (arr || []).slice();
    const out = [];
    const used = Array(a.length).fill(false);
    const cur = [];
    const seen = new Set();
    function rec() {
      if (cur.length === a.length) {
        const s = uniqueSentence(cur);
        const k = s.toLowerCase();
        if (s && !seen.has(k)) { seen.add(k); out.push(cur.slice()); }
        return;
      }
      const local = new Set();
      for (let i = 0; i < a.length; i++) {
        const k = String(a[i]).toLowerCase();
        if (used[i] || local.has(k)) continue;
        local.add(k);
        used[i] = true; cur.push(a[i]); rec(); cur.pop(); used[i] = false;
      }
    }
    rec();
    return out;
  }

  function buildOneStepOps() {
    const ops = [];
    const seen = new Set();
    const addSources = [
      { source:'hand', list:hand },
      { source:'board', list:board },
      { source:'deck', list:deckOnly }
    ];
    for (const { source, list } of addSources) {
      for (const c of list) {
        pushOp(ops, seen, { depth:1, action:'add-left', source, candidate:c, words:[c, ...words] });
        pushOp(ops, seen, { depth:1, action:'add-right', source, candidate:c, words:[...words, c] });
      }
    }
    const replaceSources = [
      { source:'hand', list:hand },
      { source:'board', list:board },
      { source:'deck', list:deckOnly }
    ];
    for (let i = 0; i < words.length; i++) {
      for (const { source, list } of replaceSources) {
        for (const c of list) {
          if (String(c).toLowerCase() === String(words[i]).toLowerCase()) continue;
          const nw = words.slice(); nw[i] = c;
          pushOp(ops, seen, { depth:1, action:'replace', source, from:words[i], to:c, candidate:c, words:nw });
        }
      }
    }
    if (words.length > 2) {
      for (let i = 0; i < words.length; i++) {
        const nw = words.slice(0,i).concat(words.slice(i+1));
        pushOp(ops, seen, { depth:1, action:'delete', source:'board', remove:words[i], words:nw });
      }
    }
    if (words.length >= 2 && words.length <= 5) {
      for (const perm of permutationsAll(words)) {
        const s = uniqueSentence(perm);
        if (s.toLowerCase() === originalKey) continue;
        pushOp(ops, seen, { depth:1, action:'reorder', source:'board', words:perm });
      }
    }
    return ops;
  }

  function buildTwoStepOps() {
    const ops = [];
    const seen = new Set();
    for (let i = 0; i < hand.length; i++) {
      for (let j = 0; j < hand.length; j++) {
        if (i === j && hand.length > 1) continue;
        pushOp(ops, seen, { depth:2, action:'add-two-right', source:'hand', candidate:hand[i], candidate2:hand[j], words:[...words, hand[i], hand[j]] });
        pushOp(ops, seen, { depth:2, action:'add-two-left', source:'hand', candidate:hand[i], candidate2:hand[j], words:[hand[i], hand[j], ...words] });
      }
    }
    return ops;
  }

  async function runLevel(ops) {
    const found = [];
    for (const op of ops) {
      let r = null;
      try {
        r = await isGood(op.sentence || uniqueSentence(op.words));
      } catch (e) {
        // v49: 候補1件の外部I/O詰まりで理由job全体・後続jobを止めない。
        r = { ok:false, stage:'candidate-error', text:op.sentence || uniqueSentence(op.words), error:String(e?.message || e) };
      }
      if (r && r.ok) {
        finalHfChecks++;
        const final = await verifyReasonDisplayCandidate(r);
        if (!final.ok) {
          if (final.stage === 'hf-rejected-for-reason-display-v53') finalHfRejected++;
          else finalHfSuppressed++;
          continue;
        }
        found.push({
          action: op.action,
          source: op.source || 'deck',
          depth: op.depth || 1,
          candidate: op.candidate || '',
          candidate2: op.candidate2 || '',
          from: op.from || '',
          to: op.to || '',
          remove: op.remove || '',
          sentence: final.text,
          linkages: final.parsed.linkages,
          fullParse: final.parsed.fullParse,
          strictLinkGrammar: final.parsed.strictLinkGrammar,
          languageToolBlocking: !!final.acceptability?.languageToolBlocking,
          languageToolBlockingRuleId: final.acceptability?.blockingRuleId || '',
          reasonCandidateStage: final.stage || '',
          hfReasonDisplayChecked: !!final.hfAcceptability?.checked,
          hfReasonDisplayAccepted: final.hfAcceptability?.ok === true,
          hfReasonDisplayModel: final.hfAcceptability?.model || ACCEPTABILITY_HF_MODEL,
          hfReasonDisplayConfidence: final.hfAcceptability?.judgement?.confidence ?? null
        });
        // v53: 表示してよい候補(HF最終確認済み)が見つかったら返す。
        // 軽量判定だけで見つかった候補は、HFで落ちた場合は表示せず次候補へ進む。
        return found;
      }
    }
    return found;
  }

  const oneStepOps = buildOneStepOps();
  let suggestions = await runLevel(oneStepOps);
  let exploredDepth = 1;
  let twoStepOpsCount = 0;
  if (!suggestions.length) {
    const twoStepOps = buildTwoStepOps();
    twoStepOpsCount = twoStepOps.length;
    suggestions = await runLevel(twoStepOps);
    exploredDepth = 2;
  }

  const top = suggestions[0] || null;
  let explanationJa = '';
  let explanationEn = '';
  if (top) {
    const srcLabel = top.source === 'hand' ? '手札の' : (top.source === 'deck' ? '候補カードの' : '盤面の');
    if (top.action === 'add-right') {
      explanationJa = `${srcLabel}「${top.candidate}」を後ろに置くと英文になります。候補: ${top.sentence}`;
      explanationEn = `Adding "${top.candidate}" after this makes a complete sentence: ${top.sentence}`;
    } else if (top.action === 'add-left') {
      explanationJa = `${srcLabel}「${top.candidate}」を前に置くと英文になります。候補: ${top.sentence}`;
      explanationEn = `Adding "${top.candidate}" before this makes a complete sentence: ${top.sentence}`;
    } else if (top.action === 'replace') {
      explanationJa = `「${top.from}」を${srcLabel}「${top.to}」に変えると英文になります。候補: ${top.sentence}`;
      explanationEn = `Replacing "${top.from}" with "${top.to}" makes a complete sentence: ${top.sentence}`;
    } else if (top.action === 'delete') {
      explanationJa = `「${top.remove}」を外すと英文になります。候補: ${top.sentence}`;
      explanationEn = `Removing "${top.remove}" makes a complete sentence: ${top.sentence}`;
    } else if (top.action === 'reorder') {
      explanationJa = `カードの順番を変えると英文になります。候補: ${top.sentence}`;
      explanationEn = `Reordering the cards makes a complete sentence: ${top.sentence}`;
    } else if (top.action === 'add-two-right') {
      explanationJa = `手札の「${top.candidate}」「${top.candidate2}」を続けて後ろに置くと英文になります。候補: ${top.sentence}`;
      explanationEn = `Adding "${top.candidate}" and "${top.candidate2}" after this makes a complete sentence: ${top.sentence}`;
    } else if (top.action === 'add-two-left') {
      explanationJa = `手札の「${top.candidate}」「${top.candidate2}」を続けて前に置くと英文になります。候補: ${top.sentence}`;
      explanationEn = `Adding "${top.candidate}" and "${top.candidate2}" before this makes a complete sentence: ${top.sentence}`;
    }
  } else {
    explanationJa = `Strict Link Grammarでは完全な英文になりませんでした。現在渡された盤面・手札・候補カードを軽量判定で調べましたが、成立する経路は見つかりませんでした。`;
    explanationEn = `Strict Link Grammar could not build a complete sentence. I checked the finite board/hand/candidate set by shortest edit distance with a fast light oracle and did not find a completing path.`;
  }
  return {
    ok:true,
    method:'strict-link-grammar-oracle-exploration-v53-display-candidates-hf-filtered',
    model:'none',
    observedStructure: top ? 'nearest successful path found and confirmed by final HF display filter' : 'no successful path found in staged finite candidate set',
    incompletePart: top ? top.action : 'not found in exhaustive finite candidate set',
    explanationEn,
    explanationJa,
    confidence: top ? 0.97 : 0.72,
    suggestions,
    rawReason:{
      exploration:true,
      exhaustive:true,
      stagedReason:true,
      fastFirstSuccess:true,
      timeoutIsolated:true,
      lightFirst:true,
      hfOnlyAfterLightAccept:true,
      hfNetworkSkippedInReason:false,
      hfFinalDisplayFilter:true,
      finalHfChecks,
      finalHfRejected,
      finalHfSuppressed,
      noArbitraryCandidateBudget:true,
      text:src,
      words,
      checks,
      elapsedMs: Date.now() - startedAt,
      exploredDepth,
      oneStepOpsCount: oneStepOps.length,
      twoStepOpsCount,
      boardCandidates:board,
      handCandidates:hand,
      deckCandidateCount:deck.length,
      diagnostics:{ judgeSource:diagnostics.judgeSource || '', linkages:diagnostics.linkages || 0, linkGrammarOk:!!diagnostics.linkGrammarOk }
    }
  };
}

async function explainRejectedSentence(text, diagnostics = {}) {
  // v34: no local grammar templates/case hacks. Explore candidate paths and accept only actual Strict Link Grammar success.
  return explainByExploration(text, diagnostics);
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

function noAutocorrectProof(originalText) {
  return {
    ok:true,
    text: originalText,
    corrected: originalText,
    normalized:false,
    matchesCount:0,
    appliedCorrections:[],
    note:'no-autocorrect: game judgement uses the exact placed cards'
  };
}

async function checkSentence(text, withTranslate = false, reasonMeta = {}) {
  const originalText = normalizeText(text);
  const proof = noAutocorrectProof(originalText);
  const checkedText = originalText;
  const ev = await evaluateGameTextExact(checkedText);
  const parsed = ev.parsed;
  const acceptability = ev.acceptability;
  const ok = !!acceptability.ok;
  const type = acceptability.type || (ok ? 'complete_sentence' : 'invalid');
  const gameOk = !!(ok && acceptability.gameOk !== false && type === 'complete_sentence');
  let translation = null;
  let reasonExplain = null;
  let reasonJob = null;
  if (gameOk && acceptability.jaHint) translation = { ok:true, ja:acceptability.jaHint, source:'contextual-short-answer' };
  else if (gameOk && withTranslate) translation = await translateToJapanese(checkedText);
  if (!gameOk) {
    reasonJob = enqueueReasonJob(checkedText, {
      judgeSource: acceptability.gate || 'strict-link-grammar-plus-languagetool',
      linkGrammarOk: strictLinkGrammarGameOk(parsed),
      linkages: parsed.linkages,
      languageTool: ev.languageTool,
      languageToolBlocking: !!acceptability.languageToolBlocking,
      blockingRuleId: acceptability.blockingRuleId || '',
      blockingMessage: acceptability.blockingMessage || '',
      ...reasonMeta
    });
    if (reasonJob?.status === 'success') reasonExplain = reasonJob.result;
  }
  return {
    originalText, text: checkedText, normalized: proof.normalized, appliedCorrections: proof.appliedCorrections || [],
    ok, gameOk, type, kind:'Strict Link Grammar + LanguageTool + HF Grammar Classifier Gate v49',
    sentenceType: gameOk ? (acceptability.sentenceType || 'complete_sentence') : (acceptability.sentenceType || type),
    reason: gameOk ? '' : (acceptability.noteJa || acceptability.reason || reasonExplain?.explanationJa || reasonExplain?.explanationEn || ''),
    reasonSource: gameOk ? '' : (acceptability.languageToolBlocking ? 'languagetool-error-gate' : (acceptability.hfUsed ? 'hf-grammar-classifier-gate' : (reasonExplain?.ok ? reasonExplain.method : 'reason-job-pending'))),
    reasonStatus: gameOk ? 'none' : (reasonJob?.status || 'pending'),
    reasonJobId: gameOk ? '' : (reasonJob?.id || ''),
    reasonExplain, proof,
    fullParse: parsed.fullParse, strictLinkGrammar: parsed.strictLinkGrammar,
    linkages: parsed.linkages, nullCount: parsed.nullCount, stdout: parsed.stdout, stderr: parsed.stderr, code: parsed.code,
    acceptability, languageTool: ev.languageTool, hfAcceptability: ev.hfAcceptability, ja: translation?.ja || '', translation
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
        const checked = await checkSentence(item.text, true, { reasonPriorityEpoch: j.reasonPriorityEpoch || j.reasonEpoch || Date.now(), reasonPrioritySeq: Number(item.id || 0), words:item.words, reasonBoardCandidates:j.reasonBoardCandidates || j.boardCandidates || [], reasonHandCandidates:j.reasonHandCandidates || j.handCandidates || [], reasonDeckCandidates:j.reasonDeckCandidates || j.reasonCandidates || j.deckCandidates || [] });
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
        mode:'link-grammar-plus-languagetool-error-gate-v53-reason-display-hf-filter',
        hfChatModel: HF_CHAT_MODEL,
        hfChatUrl: HF_CHAT_URL,
        hfTokenPresent: !!HF_TOKEN,
        reasonProvider:'strict-link-grammar-languagetool-hf-grammar-gate-v53-reason-display-hf-filter',
        quotaFree:true,
        hfDisabledForReason:true,
        hfDisabledForAcceptability:!ACCEPTABILITY_HF_ENABLED,
        hfAcceptabilityModel: ACCEPTABILITY_HF_MODEL,
        hfAcceptabilityFailClosed: ACCEPTABILITY_HF_FAIL_CLOSED,
        hfAcceptabilityDailyMax: ACCEPTABILITY_HF_DAILY_MAX,
        hfAcceptabilityStats,
        hfAcceptabilityCacheSize: hfAcceptabilityCache.size,
        hfAcceptabilityCacheKeyPolicy:'exact-text-case-sensitive-v45',
        reasonExplorePolicy:'light-first-reason-plus-final-hf-display-filter-v53',
        browserQueryContext:true, reasonHfNetworkDisabled:false, reasonDisplayHfFilter:true, reasonFinalHfTimeoutMs:REASON_FINAL_HF_TIMEOUT_MS,
        acceptanceGate:'strict-link-grammar-plus-languagetool-plus-hf-grammar-gate',
        pixabayKeyPresent: !!PIXABAY_API_KEY,
        hfModelScanVersion: 'v2-no-generation-params-for-classifiers',
        hfModelScanModels: HF_SCAN_MODELS,
        reasonJobs: { size: reasonJobs.size, running: reasonQueueRunning, maxAttempts: REASON_JOB_MAX_ATTEMPTS, rawMaxAttempts: REASON_JOB_MAX_ATTEMPTS_RAW, timeoutMs: REASON_JOB_TIMEOUT_MS, candidateTimeoutMs: REASON_CANDIDATE_TIMEOUT_MS, stats: reasonStats, successCacheSize: [...reasonJobs.values()].filter(j=>j.status==='success').length, pendingSize: [...reasonJobs.values()].filter(j=>!['success','failure','failed','error','cancelled','canceled','unavailable'].includes(String(j.status||'').toLowerCase())).length }
      });
    }
    if (url.pathname === '/diagnose') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const src = normalizeText(text);
      const parsed = await runLinkParser(src);
      const lt = await languageToolErrorGate(src);
      let acceptability = localAcceptabilityFromLinkParserAndLt(src, parsed, lt);
      let hfGate = null;
      if (acceptability.ok && acceptability.gameOk !== false && acceptability.type === 'complete_sentence') {
        hfGate = await hfAcceptabilityGate(src);
        acceptability = applyHfAcceptabilityToLocalAcceptability(acceptability, hfGate);
      }
      return send(res, 200, {
        ok:true,
        text:src,
        usedForCorrection:false,
        linkGrammar:{
          ok: strictLinkGrammarGameOk(parsed),
          fullParse: parsed.fullParse,
          strictLinkGrammar: parsed.strictLinkGrammar,
          linkages: parsed.linkages,
          nullCount: parsed.nullCount,
          code: parsed.code
        },
        languageTool:lt,
        hfAcceptability:hfGate,
        finalGatePreview:{
          ok: !!(acceptability.ok && acceptability.gameOk !== false && acceptability.type === 'complete_sentence'),
          type: acceptability.type,
          gate: acceptability.gate,
          method: acceptability.method,
          reason: acceptability.reason || acceptability.noteJa || '',
          blockingRuleId: acceptability.blockingRuleId || '',
          blockingMessage: acceptability.blockingMessage || ''
        },
        acceptability
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

    if (url.pathname === '/diagnose-acceptability' || url.pathname === '/diagnose-models') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      return send(res, 200, await diagnoseAcceptabilityWithModels(text, url.searchParams.get('model') || '', url.searchParams.get('scan') === '1'));
    }
    if (url.pathname === '/diagnose-model-benchmark') {
      const scanAll = url.searchParams.get('scan') === '1';
      const model = url.searchParams.get('model') || '';
      const samples = [
        'I am happy',
        'The cat is sleeping',
        'eating am happy',
        'walking am happy',
        'he am happy'
      ];
      const results = [];
      for (const sample of samples) {
        results.push(await diagnoseAcceptabilityWithModels(sample, model, scanAll));
      }
      return send(res, 200, {
        ok:true,
        version:'v42.3-model-scan-second-pass-benchmark',
        note:'diagnostic only; this spends one HF inference request per sample per model unless cached by upstream/provider',
        model:model || (scanAll ? 'HF_SCAN_MODELS' : 'textattack/roberta-base-CoLA'),
        scanAll,
        expected:{
          'I am happy':'OK',
          'The cat is sleeping':'OK',
          'eating am happy':'NG',
          'walking am happy':'NG',
          'he am happy':'NG by LanguageTool before model gate'
        },
        results
      });
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
    if (url.pathname === '/reason-selftest') {
      const text = normalizeText(url.searchParams.get('text') || 'I am');
      const startedAt = Date.now();
      const r = await explainRejectedSentence(text, { judgeSource:'manual-selftest' });
      return send(res, 200, {
        ok: !!(r?.ok && (String(r.explanationJa||'').trim() || String(r.explanationEn||'').trim())),
        text,
        elapsedMs: Date.now() - startedAt,
        hfTokenPresent: !!HF_TOKEN,
        reasonProvider:'strict-link-grammar-languagetool-hf-grammar-gate-v53-reason-display-hf-filter',
        quotaFree:true,
        hfDisabledForReason:true,
        hfDisabledForAcceptability:!ACCEPTABILITY_HF_ENABLED,
        hfAcceptabilityModel: ACCEPTABILITY_HF_MODEL,
        hfAcceptabilityFailClosed: ACCEPTABILITY_HF_FAIL_CLOSED,
        hfAcceptabilityDailyMax: ACCEPTABILITY_HF_DAILY_MAX,
        hfAcceptabilityStats,
        hfAcceptabilityCacheSize: hfAcceptabilityCache.size,
        hfAcceptabilityCacheKeyPolicy:'exact-text-case-sensitive-v45',
        reasonExplorePolicy:'light-first-reason-plus-final-hf-display-filter-v53',
        browserQueryContext:true, reasonHfNetworkDisabled:false, reasonDisplayHfFilter:true, reasonFinalHfTimeoutMs:REASON_FINAL_HF_TIMEOUT_MS,
        acceptanceGate:'strict-link-grammar-plus-languagetool-plus-hf-grammar-gate',
        hfChatModel: HF_CHAT_MODEL,
        hfChatUrl: HF_CHAT_URL,
        result: r
      });
    }

    if (url.pathname === '/reason-context-test') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const diagnostics = {
        judgeSource:'manual-browser-reason-context-test-v53',
        reasonBoardCandidates: wordsFromQuery(url, ['reasonBoardCandidates','boardCandidates','board','boardWords'], 80),
        reasonHandCandidates: wordsFromQuery(url, ['reasonHandCandidates','handCandidates','hand','handWords'], 80),
        reasonDeckCandidates: wordsFromQuery(url, ['reasonDeckCandidates','reasonCandidates','deckCandidates','deck','deckWords'], 220)
      };
      const job = enqueueReasonJob(normalizeText(text), diagnostics);
      return send(res, 200, {
        ok:true,
        text: normalizeText(text),
        contextReceived: diagnostics,
        next:`/reason-result?id=${job?.id || ''}`,
        ...publicReasonJob(job)
      });
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
      if (!job && text) job = latestReasonJobByText(text);
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
    if (url.pathname === '/link-test') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const parsed = await runLinkParser(text);
      return send(res, 200, {
        text: normalizeText(text),
        ok: strictLinkGrammarGameOk(parsed),
        gate: 'strict-link-grammar-only',
        hfUsed: false,
        fullParse: parsed.fullParse,
        strictLinkGrammar: parsed.strictLinkGrammar,
        linkages: parsed.linkages,
        nullCount: parsed.nullCount,
        stdout: parsed.stdout,
        stderr: parsed.stderr,
        code: parsed.code
      });
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
      const queryBoardCandidates = wordsFromQuery(url, ['reasonBoardCandidates','boardCandidates','board','boardWords'], 80);
      const queryHandCandidates = wordsFromQuery(url, ['reasonHandCandidates','handCandidates','hand','handWords'], 80);
      const queryDeckCandidates = wordsFromQuery(url, ['reasonDeckCandidates','reasonCandidates','deckCandidates','deck','deckWords'], 220);
      const reasonMeta = {
        reasonPriorityEpoch: body.reasonPriorityEpoch || body.reasonEpoch || Number(url.searchParams.get('reasonPriorityEpoch') || 0),
        reasonPrioritySeq: body.reasonPrioritySeq || body.reasonSeq || Number(url.searchParams.get('reasonPrioritySeq') || 0),
        words: Array.isArray(body.words) ? body.words : wordsFromQuery(url, ['words'], 80),
        reasonBoardCandidates: body.reasonBoardCandidates || body.boardCandidates || queryBoardCandidates,
        reasonHandCandidates: body.reasonHandCandidates || body.handCandidates || queryHandCandidates,
        reasonDeckCandidates: body.reasonDeckCandidates || body.reasonCandidates || body.deckCandidates || queryDeckCandidates
      };
      return send(res, 200, await checkSentence(text, url.pathname === '/check-and-translate', reasonMeta));
    }
    return send(res, 404, { ok:false, error:'not found' });
  } catch (e) {
    return send(res, 500, { ok:false, error:String(e.message || e), status:e.status || null, body:e.body || null });
  }
});

server.listen(PORT, () => console.log(`Strict Link Grammar + LanguageTool v50 Browser Context Debug API listening on ${PORT}`));
