import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = 180;
const TIMEOUT_MS = Number(process.env.LINK_GRAMMAR_TIMEOUT_MS || 3500);
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';
const LANGUAGETOOL_ENABLED = process.env.LANGUAGETOOL_ENABLED !== '0';
const LANGUAGETOOL_TIMEOUT_MS = Number(process.env.LANGUAGETOOL_TIMEOUT_MS || 4500);
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
  text = normalizeText(text).replace(/[.!?]+$/,'');
  return text ? text + '.' : '';
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 8192) reject(new Error('too large')); });
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
    } catch { text = raw || text; }
  }
  return normalizeText(text);
}
function cacheSet(cache, key, val, max=500){
  cache.set(key,val);
  if(cache.size>max) cache.delete(cache.keys().next().value);
}
function compactMatch(m){
  return {
    message:m.message,
    shortMessage:m.shortMessage,
    offset:m.offset,
    length:m.length,
    ruleId:m?.rule?.id,
    category:m?.rule?.category?.id,
    issueType:m?.rule?.issueType,
    replacements:(m.replacements||[]).slice(0,6).map(x=>x.value)
  };
}
function isBlockingLanguageToolMatch(m){
  const cat = String(m?.rule?.category?.id || '').toUpperCase();
  const issue = String(m?.rule?.issueType || '').toLowerCase();
  const ruleId = String(m?.rule?.id || '');
  // ゲームでは小文字カード・句点なし・軽い表記揺れは許す。文法・語法だけを裁定に使う。
  if (cat === 'CASING' || cat === 'TYPOGRAPHY' || cat === 'PUNCTUATION') return false;
  if (issue === 'typographical' || issue === 'misspelling') return false;
  if (['UPPERCASE_SENTENCE_START','MORFOLOGIK_RULE_EN_US','WHITESPACE_RULE'].includes(ruleId)) return false;
  return true;
}
function shouldAutoApplyMatch(m){
  if (!m || !Array.isArray(m.replacements) || !m.replacements.length) return false;
  const cat = String(m?.rule?.category?.id || '').toUpperCase();
  const issue = String(m?.rule?.issueType || '').toLowerCase();
  // 3単現・be動詞・助動詞・動詞形など、LanguageToolが明確な置換を出す文法指摘だけ自動補正。
  return cat === 'GRAMMAR' || issue === 'grammar' || /agreement|verb|auxiliary|tense/i.test(String(m.message||''));
}
function applyMatches(text, matches){
  let out = text;
  const applicable = matches
    .filter(shouldAutoApplyMatch)
    .filter(m => m.offset >= 0 && m.length > 0 && m.replacements?.[0]?.value)
    .sort((a,b)=>b.offset-a.offset);
  const applied=[];
  for(const m of applicable){
    const repl = m.replacements[0].value;
    out = out.slice(0,m.offset) + repl + out.slice(m.offset + m.length);
    applied.push(compactMatch(m));
  }
  return { text: normalizeText(out), applied: applied.reverse() };
}
async function callLanguageTool(text){
  text = normalizeText(text).replace(/[.!?]+$/,'');
  if (!LANGUAGETOOL_ENABLED) return { ok:true, disabled:true, text, matches:[], blockingMatches:[] };
  const key = text.toLowerCase();
  if (proofCache.has(key)) return proofCache.get(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LANGUAGETOOL_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ text: sentenceForParser(text), language:'en-US', enabledOnly:'false' });
    const r = await fetch(LANGUAGETOOL_URL, { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'}, body, signal:controller.signal });
    if(!r.ok) throw new Error('LanguageTool HTTP '+r.status);
    const j = await r.json();
    const matches = Array.isArray(j.matches) ? j.matches : [];
    const blockingMatches = matches.filter(isBlockingLanguageToolMatch);
    const out = { ok:blockingMatches.length===0, source:'LanguageTool', text, matchesCount:matches.length, matches:matches.slice(0,20).map(compactMatch), blockingMatches:blockingMatches.slice(0,12).map(compactMatch) };
    cacheSet(proofCache,key,out);
    return out;
  } finally { clearTimeout(timer); }
}
async function normalizeByLanguageTool(text){
  const original = normalizeText(text).replace(/[.!?]+$/,'');
  let first;
  try { first = await callLanguageTool(original); }
  catch(e){ return { text:original, changed:false, proof:{ ok:true, source:'LanguageTool', warning:String(e.message||e), blockingMatches:[] }, applied:[] }; }
  const { text: corrected, applied } = applyMatches(original, first.matches || []);
  if (!corrected || corrected === original) return { text:original, changed:false, proof:first, applied:[] };
  let second;
  try { second = await callLanguageTool(corrected); }
  catch(e){ second = { ok:true, source:'LanguageTool', warning:String(e.message||e), blockingMatches:[] }; }
  return { text:corrected, changed:true, proof:second, beforeProof:first, applied };
}
function runLinkParser(text) {
  return new Promise((resolve) => {
    const input = sentenceForParser(text);
    const args = ['en', '-batch', '-verbosity=0', '-graphics=0', '-null=0', '-islands-ok=0', '-spell=0', '-timeout=3'];
    const p = spawn('link-parser', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out='', err='';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => {
      clearTimeout(timer);
      const error = /\+\+\+\+\+ error/i.test(out) || /No complete linkages found/i.test(out) || code !== 0;
      const m = out.match(/Found\s+(\d+)\s+linkages/i);
      const linkages = m ? Number(m[1]) : (error ? 0 : 1);
      resolve({ ok: !error && linkages > 0, fullParse: !error && linkages > 0, linkages, nullCount: 0, stdout: out.slice(0,2000), stderr: err.slice(0,1000), code });
    });
    p.stdin.write(input + '\n');
    p.stdin.end();
  });
}
function stripHtml(s){
  return String(s || '').replace(/<[^>]*>/g,'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').trim();
}
function normalizeJaTranslation(ja, src){
  ja = stripHtml(ja).replace(/\s+/g, ' ').trim();
  if (!ja) return '';
  // 翻訳APIが原文をそのまま返す事故は失敗扱いにする。
  const a = ja.toLowerCase().replace(/[.!?。！？\s]/g,'');
  const b = String(src||'').toLowerCase().replace(/[.!?。！？\s]/g,'');
  if (a && b && a === b) return '';
  return ja;
}
async function translateByMyMemory(text){
  const attempts = [text, /[.!?]$/.test(text) ? text : text + '.'];
  let last = null;
  for (const q of attempts) {
    const params = new URLSearchParams({ q, langpair:'en|ja' });
    if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
    const r = await fetch('https://api.mymemory.translated.net/get?' + params.toString(), { headers:{accept:'application/json'} });
    if(!r.ok) { last = 'mymemory HTTP '+r.status; continue; }
    const j = await r.json();
    const ja = normalizeJaTranslation(j?.responseData?.translatedText || '', text);
    if(ja) return { ok:true, ja, source:'mymemory', rawStatus:j?.responseStatus };
    last = 'mymemory empty translation';
  }
  throw new Error(last || 'mymemory failed');
}
async function translateByGoogleGtx(text){
  // 無料・キーなしの最終フォールバック。Render側だけから呼び、結果はキャッシュする。
  const params = new URLSearchParams({ client:'gtx', sl:'en', tl:'ja', dt:'t', q:text });
  const r = await fetch('https://translate.googleapis.com/translate_a/single?' + params.toString(), { headers:{accept:'application/json'} });
  if(!r.ok) throw new Error('google-gtx HTTP '+r.status);
  const j = await r.json();
  const ja = normalizeJaTranslation((j?.[0]||[]).map(x=>x?.[0]||'').join(''), text);
  if(!ja) throw new Error('google-gtx empty translation');
  return { ok:true, ja, source:'google-gtx' };
}
async function translateToJapanese(text) {
  text = normalizeText(text).replace(/[.!?]+$/,'');
  if (!text) return { ok:false, error:'empty text' };
  const key = text.toLowerCase();
  if (translateCache.has(key)) return { ok:true, ja:translateCache.get(key), source:'cache' };
  const errors = [];
  for (const fn of [translateByMyMemory, translateByGoogleGtx]) {
    try {
      const out = await fn(text);
      if (out?.ja) {
        cacheSet(translateCache,key,out.ja);
        return out;
      }
    } catch(e) { errors.push(String(e.message||e)); }
  }
  return { ok:false, error:'all translation providers failed', errors };
}

function tokenizeWords(text){
  return normalizeText(text).replace(/[.!?]+$/,'').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
}
const SUBJECT_PRONOUNS = new Set(['i','you','he','she','it','we','they']);
const CLAUSE_CONNECTORS = new Set(['and','but','or','because','when','while','if','that','which','who','whom','whose','where','although','though','so','before','after','since','until']);
const FRONTED_OK_STARTERS = new Set([
  'today','tomorrow','yesterday','now','then','here','there','sometimes','often','always','usually','also','well','maybe','perhaps',
  'in','on','at','to','from','for','with','by','before','after','during','because','when','while','if','although','though'
]);
const BE_WORDS = new Set(['am','is','are','was','were','be','been','being']);
const MODALS = new Set(['can','could','will','would','shall','should','may','might','must']);
const HAVE_WORDS = new Set(['have','has','had']);
const DO_WORDS = new Set(['do','does','did']);
const COMMON_ADJECTIVES = new Set(['new','big','small','happy','sad','kind','busy','hungry','tall','short','nice','good','bad','interesting','important','beautiful','old','young','hot','cold','easy','hard']);
const COMMON_NOUNS = new Set(['apple','apples','book','books','bed','beds','school','soccer','music','home','morning','night','time','world','dinner','tennis','english']);
function looksFiniteVerb(tok){
  if (!tok) return false;
  if (BE_WORDS.has(tok) || MODALS.has(tok) || HAVE_WORDS.has(tok) || DO_WORDS.has(tok)) return true;
  // Link Grammar can parse gerunds/fragments; sentence mode only needs a conservative finite marker.
  if (/^[a-z]+s$/.test(tok) && !COMMON_NOUNS.has(tok)) return true;
  if (/^[a-z]+ed$/.test(tok)) return true;
  return false;
}
function validateIndependentSentence(text){
  const words = tokenizeWords(text);
  if (words.length < 2) return { ok:false, reason:'too short for sentence mode' };

  // Sentence mode: reject NP + subject + verb fragments such as "apples they see" / "books I read".
  // These are often relative-clause fragments ("apples that they see"), not standalone sentences.
  for (let i=1; i<words.length-1; i++) {
    if (SUBJECT_PRONOUNS.has(words[i]) && !CLAUSE_CONNECTORS.has(words[i-1])) {
      const prefix = words.slice(0,i);
      const first = prefix[0];
      const hasConnector = prefix.some(w => CLAUSE_CONNECTORS.has(w));
      const frontedIsAllowedAdverbial = FRONTED_OK_STARTERS.has(first);
      const next = words[i+1];
      const hasPredicateAfterSubject = looksFiniteVerb(next) || /^[a-z]+$/.test(next);
      if (!hasConnector && !frontedIsAllowedAdverbial && hasPredicateAfterSubject) {
        return { ok:false, reason:'sentence mode rejected noun-phrase / relative-clause fragment before subject' };
      }
    }
  }

  // Reject run-ons like "I am happy today can see": two finite predicates without a connector.
  let finiteCount = 0;
  for (let i=0; i<words.length; i++) {
    const w = words[i];
    if (CLAUSE_CONNECTORS.has(w)) { finiteCount = 0; continue; }
    if (BE_WORDS.has(w) || MODALS.has(w)) {
      finiteCount++;
      if (finiteCount >= 2) return { ok:false, reason:'unconnected finite verbs / clause run-on' };
    }
  }

  // Be + adjective + bare noun after personal subject is normally not a basic standalone sentence:
  // "I am new books" / "I am new bed".  This is category-based, not word-specific.
  if (SUBJECT_PRONOUNS.has(words[0]) && BE_WORDS.has(words[1]) && COMMON_ADJECTIVES.has(words[2]) && words[3] && COMMON_NOUNS.has(words[3])) {
    return { ok:false, reason:'be-complement is an adjective+noun phrase without determiner; not a valid basic sentence' };
  }
  return { ok:true, reason:'' };
}

async function checkPipeline(rawText, withTranslation=false){
  const original = normalizeText(rawText);
  const normalized = await normalizeByLanguageTool(original);
  const text = normalized.text;
  const parsed = await runLinkParser(text);
  const proof = normalized.proof || {ok:true, skipped:true};
  const sentenceMode = validateIndependentSentence(text);
  const ok = !!(text && parsed.ok && proof.ok && sentenceMode.ok);
  const reason = !text ? 'empty text' : (!parsed.ok ? 'link grammar parse failed' : (!proof.ok ? 'LanguageTool grammar check failed' : (!sentenceMode.ok ? sentenceMode.reason : '')));
  let translation = null;
  if(ok && withTranslation){
    try { translation = await translateToJapanese(text); }
    catch(e){ translation = { ok:false, error:String(e.message||e) }; }
  }
  return {
    originalText: original,
    text,
    normalized: normalized.changed,
    appliedCorrections: normalized.applied || [],
    ...parsed,
    ok,
    gameOk: ok,
    sentenceType: ok ? 'API_VERIFIED' : null,
    reason,
    proof,
    sentenceMode,
    ja: translation?.ja || '',
    translation
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok:true });
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { ok:true, service:'link-grammar-api', pipeline:'LanguageTool normalize/proof + Link Grammar + MyMemory' });
  try {
    if (url.pathname === '/proof') {
      const raw = await getTextFromReq(req,url);
      const norm = await normalizeByLanguageTool(raw);
      return send(res, 200, { ok:norm.proof?.ok !== false, originalText:raw, text:norm.text, normalized:norm.changed, appliedCorrections:norm.applied, proof:norm.proof, beforeProof:norm.beforeProof });
    }
    if (url.pathname === '/translate') {
      const raw = await getTextFromReq(req,url);
      const norm = await normalizeByLanguageTool(raw);
      const tr = await translateToJapanese(norm.text);
      return send(res, 200, { originalText:raw, text:norm.text, normalized:norm.changed, appliedCorrections:norm.applied, ...tr });
    }
    if (url.pathname === '/check' || url.pathname === '/check-and-translate') {
      const raw = await getTextFromReq(req,url);
      if(!raw) return send(res,400,{ok:false,error:'empty text'});
      const out = await checkPipeline(raw, url.pathname === '/check-and-translate');
      return send(res, 200, out);
    }
    return send(res, 404, { ok:false, error:'not found' });
  } catch(e){
    return send(res, 500, { ok:false, error:String(e.message||e) });
  }
});
server.listen(PORT, () => console.log(`English Pittan API listening on ${PORT}`));
