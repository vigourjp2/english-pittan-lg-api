import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = 180;
const TIMEOUT_MS = 3500;
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';
const LANGUAGETOOL_ENABLED = process.env.LANGUAGETOOL_ENABLED !== '0';
const LANGUAGETOOL_TIMEOUT_MS = Number(process.env.LANGUAGETOOL_TIMEOUT_MS || 3500);
const translateCache = new Map();
const proofCache = new Map();

const POS = {
  i:['subj','pron'], you:['subj','pron'], he:['subj','pron'], she:['subj','pron'], we:['subj','pron'], they:['subj','pron'], it:['subj','pron'], me:['noun','pronObj'],
  am:['be'], are:['be'], is:['be'], was:['bePast'], were:['bePast'], not:['not'],
  can:['modal'], must:['modal'], will:['modal'], should:['modal'],
  happy:['adj'], sad:['adj'], kind:['adj'], tall:['adj'], busy:['adj'], hungry:['adj'], fun:['adj','noun'], good:['adj'], bad:['adj'], nice:['adj'], big:['adj'], small:['adj'], new:['adj'], old:['adj'], interesting:['adj','ving'], important:['adj'], famous:['adj'], free:['adj'], right:['adj','noun'],
  like:['verb'], play:['verb'], study:['verb'], read:['verb'], go:['verb'], come:['verb'], eat:['verb'], drink:['verb'], have:['verb'], watch:['verb'], listen:['verb'], speak:['verb'], write:['verb'], make:['verb'], take:['verb'], look:['verb'], get:['verb'], want:['verbWant','verb'], try:['verb'], need:['verb'], help:['verb','noun'], see:['verb'], swim:['verb'], visit:['verb'], learn:['verb'], enjoy:['verb'],
  playing:['ving'], studying:['ving'], reading:['ving'], going:['ving'], listening:['ving'], watching:['ving'], eating:['ving'], writing:['ving'], speaking:['ving'], learning:['ving'],
  to:['to','prep'], in:['prep'], on:['prep'], at:['prep'], for:['prep'], from:['prep'], with:['prep'], of:['prep'], about:['prep'], after:['prep'], before:['prep'], because:['conj'], and:['conj'], the:['article'], a:['article'], an:['article'],
  school:['noun'], home:['noun','advPlace'], bed:['noun'], soccer:['noun'], tennis:['noun'], baseball:['noun'], english:['noun','adj'], japanese:['noun','adj'], apples:['noun'], music:['noun'], books:['noun'], tv:['noun'], breakfast:['noun'], lunch:['noun'], dinner:['noun'], morning:['noun'], afternoon:['noun'], evening:['noun'], night:['noun'], friend:['noun'], friends:['noun'], family:['noun'], japan:['noun','place'], tokyo:['noun','place'], game:['noun'], games:['noun'], water:['noun'], food:['noun'], care:['noun'], front:['noun'], lot:['noun'], example:['noun'], time:['noun'], people:['noun'], world:['noun'], work:['noun','verb'],
  very:['adv'], well:['adv','noun'], often:['advTime'], always:['advTime'], sometimes:['advTime'], now:['advTime'], today:['advTime'], everyday:['advTime'], tomorrow:['advTime'], yesterday:['advTime']
};
const VERB_3SG_TO_BASE = {
  likes:'like', plays:'play', studies:'study', reads:'read', goes:'go', comes:'come', eats:'eat', drinks:'drink', has:'have', watches:'watch', listens:'listen', speaks:'speak', writes:'write', makes:'make', takes:'take', looks:'look', gets:'get', wants:'want', tries:'try', needs:'need', helps:'help', sees:'see', swims:'swim', visits:'visit', learns:'learn', enjoys:'enjoy', does:'do'
};
function baseVerb(w){ return VERB_3SG_TO_BASE[String(w||'').toLowerCase()] || String(w||'').toLowerCase(); }
function isThirdPersonSingularSubject(w){
  w=String(w||'').toLowerCase();
  if(['he','she','it'].includes(w)) return true;
  if(['i','you','we','they','me'].includes(w)) return false;
  const ps=pos(w);
  if(!ps.includes('noun')) return false;
  if(w==='people') return false;
  if(w.endsWith('s') && w!=='tennis') return false;
  return true;
}
function present3sg(v){
  v=String(v||'').toLowerCase();
  const irregular={have:'has',do:'does'};
  if(irregular[v]) return irregular[v];
  if(/[^aeiou]y$/.test(v)) return v.slice(0,-1)+'ies';
  if(/(s|x|z|ch|sh|o)$/.test(v)) return v+'es';
  return v+'s';
}
function is3sgVerbForm(w){ return Object.prototype.hasOwnProperty.call(VERB_3SG_TO_BASE, String(w||'').toLowerCase()); }
function applySubjectVerbAgreementText(text){
  const parts=normalizeText(text).replace(/[.!?]+$/,'').split(/\s+/).filter(Boolean);
  if(parts.length>=2){
    const s=parts[0].toLowerCase(), v=parts[1].toLowerCase();
    if(isThirdPersonSingularSubject(s) && pos(v).includes('verb') && !is3sgVerbForm(v)){
      parts[1]=present3sg(v);
    }
  }
  return parts.join(' ');
}

function isLanguageToolBlockingMatch(m){
  const ruleId = String(m?.rule?.id || '');
  const cat = String(m?.rule?.category?.id || '').toUpperCase();
  const issue = String(m?.rule?.issueType || '').toLowerCase();
  const msg = String(m?.message || '');
  // ゲームでは小文字カードを許す。大文字・句点・空白など表示揺れはブロックしない。
  const ignoreRuleIds = new Set([
    'UPPERCASE_SENTENCE_START', 'MORFOLOGIK_RULE_EN_US', 'WHITESPACE_RULE',
    'COMMA_PARENTHESIS_WHITESPACE', 'EN_QUOTES', 'SENTENCE_WHITESPACE',
    'PUNCTUATION_PARAGRAPH_END', 'PERIOD_OF_TIME'
  ]);
  if (ignoreRuleIds.has(ruleId)) return false;
  if (cat === 'CASING' || cat === 'TYPOGRAPHY' || cat === 'PUNCTUATION') return false;
  if (issue === 'typographical' || issue === 'misspelling') return false;
  // LanguageTool側の文法・意味・一貫性指摘は成立判定で止める。
  return cat === 'GRAMMAR' || cat === 'CONFUSED_WORDS' || cat === 'COLLOCATIONS' || /grammar|agreement|verb|auxiliary|fragment|sentence/i.test(msg);
}
async function checkLanguageTool(text){
  text = normalizeText(text).replace(/[.!?]+$/,'');
  if (!LANGUAGETOOL_ENABLED) return { ok:true, disabled:true, blockingMatches:[], matches:[] };
  if (!text) return { ok:false, error:'empty text', blockingMatches:[], matches:[] };
  const key = text.toLowerCase();
  if (proofCache.has(key)) return proofCache.get(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LANGUAGETOOL_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ text, language:'en-US', enabledOnly:'false' });
    const r = await fetch(LANGUAGETOOL_URL, {
      method:'POST',
      headers:{ 'content-type':'application/x-www-form-urlencoded', 'accept':'application/json' },
      body,
      signal: controller.signal
    });
    if (!r.ok) throw new Error('LanguageTool HTTP '+r.status);
    const j = await r.json();
    const matches = Array.isArray(j?.matches) ? j.matches : [];
    const blockingMatches = matches.filter(isLanguageToolBlockingMatch).slice(0, 8).map(m => ({
      message:m.message,
      shortMessage:m.shortMessage,
      offset:m.offset,
      length:m.length,
      ruleId:m?.rule?.id,
      category:m?.rule?.category?.id,
      issueType:m?.rule?.issueType,
      replacements:(m.replacements||[]).slice(0,5).map(x=>x.value)
    }));
    const out = { ok:blockingMatches.length===0, source:'LanguageTool', matchesCount:matches.length, blockingMatches };
    proofCache.set(key, out);
    if (proofCache.size > 500) proofCache.delete(proofCache.keys().next().value);
    return out;
  } finally { clearTimeout(timer); }
}
function obviousClauseRunOnGuard(text){
  // APIサービスが見逃した時の最小限の安全装置。個別文ではなく、無接続の述語連結を落とす。
  const w = wordsOf(text);
  const connectors = new Set(['and','but','because','when','if','that','who','which','to']);
  let finite = 0;
  let lastFinite = -10;
  for (let i=0;i<w.length;i++){
    const x=w[i];
    const isFinite = hasPos(x,'be') || hasPos(x,'modal') || is3sgVerbForm(x) || (hasPos(x,'verb') && i>0 && hasPos(w[i-1],'subj'));
    if (!isFinite) continue;
    if (finite>0) {
      const between = w.slice(lastFinite+1, i);
      if (!between.some(t=>connectors.has(t))) {
        return { ok:false, reason:'unconnected finite verbs / clause run-on' };
      }
    }
    finite++;
    lastFinite=i;
  }
  return { ok:true };
}
function pos(w){
  w=String(w||'').toLowerCase();
  if(POS[w]) return POS[w];
  if(VERB_3SG_TO_BASE[w]) return ['verb','verb3sg'];
  return [];
}
function hasPos(w,p){ return pos(w).includes(p); }
function wordsOf(text){ return normalizeText(text).replace(/[.!?]+$/,'').split(/\s+/).filter(Boolean).map(w=>w.toLowerCase()); }
function isNounLike(ws){
  if(!ws.length) return false;
  // pronoun object, noun, gerund, article+NP, adjective(s)+noun, noun+prep+noun-ish
  const last=ws[ws.length-1];
  if(hasPos(last,'noun') || hasPos(last,'pronObj') || hasPos(last,'pron') || hasPos(last,'ving')) return true;
  return false;
}
function beMatches(s,b){
  s=String(s||'').toLowerCase(); b=String(b||'').toLowerCase();
  if(s==='i') return b==='am' || b==='was';
  if(['you','we','they'].includes(s)) return b==='are' || b==='were';
  if(['he','she','it'].includes(s) || hasPos(s,'noun')) return b==='is' || b==='was' || b==='are';
  return true;
}
function gameValidate(text){
  const w=wordsOf(text);
  if(w.length<2) return { ok:false, reason:'too short' };
  const last=w[w.length-1];
  if(['i','you','he','she','we','they','it','me'].includes(last)) return {ok:false, reason:'orphan pronoun at sentence end'};
  if(['to','in','on','at','for','from','with','of','about','after','before','a','an','the','can','must','will','should','am','is','are','was','were','not','and','because'].includes(last)) return {ok:false, reason:'function word at sentence end'};

  // S + be + adjective/gerund/noun-ish. This is a valid complete sentence if agreement is sane.
  if(w.length>=3 && (hasPos(w[0],'subj')||hasPos(w[0],'noun')) && hasPos(w[1],'be')){
    if(!beMatches(w[0],w[1])) return {ok:false, reason:'be verb agreement mismatch'};
    const comp=w.slice(2);
    if(comp.length===1 && (hasPos(comp[0],'adj') || hasPos(comp[0],'ving') || hasPos(comp[0],'noun'))) return {ok:true, sentenceType: hasPos(comp[0],'adj')?'SVC':'SVO/SVC'};
    if(comp.length===2 && hasPos(comp[0],'adv') && hasPos(comp[1],'adj')) return {ok:true, sentenceType:'SVC'};
    if(comp.length===2 && hasPos(comp[0],'not') && hasPos(comp[1],'adj')) return {ok:true, sentenceType:'SVC_NEG'};
  }

  // S + V + object. The object must be noun-like. Also enforce/accept 3rd-person singular -s.
  if(w.length>=3 && hasPos(w[0],'subj') && hasPos(w[1],'verb')){
    const subj3=isThirdPersonSingularSubject(w[0]);
    const verb3=is3sgVerbForm(w[1]);
    if(subj3 && !verb3) return {ok:false, reason:'third-person singular present verb needs -s'};
    if(!subj3 && verb3) return {ok:false, reason:'verb has third-person -s but subject is not third-person singular'};
    const v=baseVerb(w[1]);
    if(['go','come','listen','look'].includes(v)) return {ok:true, sentenceType:'SV/VP'};
    const obj=w.slice(2);
    if(obj.length===1 && hasPos(obj[0],'adj') && !hasPos(obj[0],'noun')) return {ok:false, reason:'transitive verb object is adjective-only'};
    if(!isNounLike(obj)) return {ok:false, reason:'transitive verb requires noun phrase object'};
    return {ok:true, sentenceType:'SVO'};
  }

  // modal + base verb, optionally with noun phrase object.
  if(w.length>=3 && hasPos(w[0],'subj') && hasPos(w[1],'modal') && hasPos(w[2],'verb')){
    if(w.length===3) return {ok:true, sentenceType:'S_MODAL_V'};
    const obj=w.slice(3);
    if(obj.length===1 && hasPos(obj[0],'adj') && !hasPos(obj[0],'noun')) return {ok:false, reason:'modal verb object is adjective-only'};
    if(!isNounLike(obj) && !['go','come','listen','look'].includes(baseVerb(w[2]))) return {ok:false, reason:'modal verb requires valid complement'};
    return {ok:true, sentenceType:'S_MODAL_VO'};
  }

  return {ok:true, sentenceType:'LG_PARSE'};
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
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 8192) reject(new Error('too large')); });
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
async function translateToJapanese(text) {
  text = normalizeText(text).replace(/[.!?]+$/,'');
  if (!text) return { ok:false, error:'empty text' };
  const key = text.toLowerCase();
  if (translateCache.has(key)) return { ok:true, ja:translateCache.get(key), source:'cache' };
  const params = new URLSearchParams({ q:text, langpair:'en|ja' });
  if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
  const url = 'https://api.mymemory.translated.net/get?' + params.toString();
  const r = await fetch(url, { headers: { 'accept':'application/json' } });
  if (!r.ok) throw new Error('translation HTTP '+r.status);
  const j = await r.json();
  const ja = j?.responseData?.translatedText || '';
  if (!ja) throw new Error('empty translation');
  translateCache.set(key, ja);
  if (translateCache.size > 500) translateCache.delete(translateCache.keys().next().value);
  return { ok:true, ja, source:'mymemory', rawStatus:j?.responseStatus };
}
async function getTextFromReq(req, url) {
  let text = url.searchParams.get('text') || '';
  if (req.method === 'POST') {
    const raw = await readBody(req);
    try { const j = JSON.parse(raw || '{}'); text = j.text || (Array.isArray(j.words) ? j.words.join(' ') : text); } catch { text = raw || text; }
  }
  return normalizeText(text);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { ok: true, service: 'link-grammar-api' });
  try {
    if (url.pathname === '/translate') {
      const rawText = await getTextFromReq(req, url);
      const text = applySubjectVerbAgreementText(rawText);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const tr = await translateToJapanese(text);
      return send(res, 200, { text, ...tr });
    }
    if (url.pathname === '/proof') {
      const rawText = await getTextFromReq(req, url);
      const text = applySubjectVerbAgreementText(rawText);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      let proof;
      try { proof = await checkLanguageTool(text); } catch(e) { proof = { ok:false, source:'LanguageTool', error:String(e.message||e), blockingMatches:[] }; }
      return send(res, 200, { text, ...proof });
    }
    if (url.pathname === '/check' || url.pathname === '/check-and-translate') {
      const rawText = await getTextFromReq(req, url);
      if (!rawText) return send(res, 400, { ok: false, error: 'empty text' });
      const text = applySubjectVerbAgreementText(rawText);
      const parsed = await runLinkParser(text);
      const gv = parsed.ok ? gameValidate(text) : {ok:false, reason:'link grammar parse failed'};
      const runOn = parsed.ok && gv.ok ? obviousClauseRunOnGuard(text) : {ok:true};
      let proof = { ok:true, skipped:!parsed.ok || !gv.ok || !runOn.ok };
      if (parsed.ok && gv.ok && runOn.ok) {
        try { proof = await checkLanguageTool(text); } catch(e) { proof = { ok:true, source:'LanguageTool', warning:String(e.message||e), blockingMatches:[] }; }
      }
      const ok = !!(parsed.ok && gv.ok && runOn.ok && proof.ok);
      const reason = !parsed.ok ? 'link grammar parse failed' : (!gv.ok ? gv.reason : (!runOn.ok ? runOn.reason : (!proof.ok ? 'LanguageTool grammar check failed' : '')));
      let tr = null;
      if (ok && url.pathname === '/check-and-translate') {
        try { tr = await translateToJapanese(text); } catch(e) { tr = {ok:false, error:String(e.message||e)}; }
      }
      return send(res, 200, { text, ...parsed, ok, gameOk:gv.ok, sentenceType:gv.sentenceType || null, reason, proof, ja:tr?.ja || '', translation:tr });
    }
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e.message || e) });
  }
});
server.listen(PORT, () => console.log(`Link Grammar API listening on ${PORT}`));
