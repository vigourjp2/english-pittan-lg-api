import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = 180;
const TIMEOUT_MS = 3500;
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const translateCache = new Map();

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
function pos(w){ return POS[String(w||'').toLowerCase()] || []; }
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

  // S + V + object. The object must be noun-like. This is the generic fix for "I like big".
  if(w.length>=3 && hasPos(w[0],'subj') && hasPos(w[1],'verb')){
    const v=w[1];
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
    if(!isNounLike(obj) && !['go','come','listen','look'].includes(w[2])) return {ok:false, reason:'modal verb requires valid complement'};
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
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const tr = await translateToJapanese(text);
      return send(res, 200, { text, ...tr });
    }
    if (url.pathname === '/check' || url.pathname === '/check-and-translate') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok: false, error: 'empty text' });
      const parsed = await runLinkParser(text);
      const gv = parsed.ok ? gameValidate(text) : {ok:false, reason:'link grammar parse failed'};
      const ok = !!(parsed.ok && gv.ok);
      let tr = null;
      if (ok && url.pathname === '/check-and-translate') {
        try { tr = await translateToJapanese(text); } catch(e) { tr = {ok:false, error:String(e.message||e)}; }
      }
      return send(res, 200, { text, ...parsed, ok, gameOk:gv.ok, sentenceType:gv.sentenceType || null, reason:gv.ok ? '' : gv.reason, ja:tr?.ja || '', translation:tr });
    }
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e.message || e) });
  }
});
server.listen(PORT, () => console.log(`Link Grammar API listening on ${PORT}`));
