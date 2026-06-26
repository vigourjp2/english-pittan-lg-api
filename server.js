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
async function translateToJapanese(text) {
  text = normalizeText(text).replace(/[.!?]+$/,'');
  if (!text) return { ok:false, error:'empty text' };
  const key = text.toLowerCase();
  if (translateCache.has(key)) return { ok:true, ja:translateCache.get(key), source:'cache' };
  const params = new URLSearchParams({ q:text, langpair:'en|ja' });
  if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
  const r = await fetch('https://api.mymemory.translated.net/get?' + params.toString(), { headers:{accept:'application/json'} });
  if(!r.ok) throw new Error('translation HTTP '+r.status);
  const j = await r.json();
  const ja = j?.responseData?.translatedText || '';
  if(!ja) throw new Error('empty translation');
  cacheSet(translateCache,key,ja);
  return { ok:true, ja, source:'mymemory', rawStatus:j?.responseStatus };
}
async function checkPipeline(rawText, withTranslation=false){
  const original = normalizeText(rawText);
  const normalized = await normalizeByLanguageTool(original);
  const text = normalized.text;
  const parsed = await runLinkParser(text);
  const proof = normalized.proof || {ok:true, skipped:true};
  const ok = !!(text && parsed.ok && proof.ok);
  const reason = !text ? 'empty text' : (!parsed.ok ? 'link grammar parse failed' : (!proof.ok ? 'LanguageTool grammar check failed' : ''));
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
