
(() => {
'use strict';
// v75: boot guard. Start button must not die if later initialization throws.
try{
  const __earlyStartBtn=document.getElementById('startBtn');
  if(__earlyStartBtn){
    __earlyStartBtn.addEventListener('click',()=>{
      try{
        const st=document.getElementById('start');
        if(st) st.style.display='none';
        if(typeof unlockSpeech==='function') unlockSpeech();
        if(typeof clearEnglishJudgeCache==='function') clearEnglishJudgeCache();
        if(typeof render==='function') render();
      }catch(e){ console.error('early start fallback failed', e); }
    });
  }
}catch(e){ console.error('early start bind failed', e); }
try{

const APP_VERSION='v108-place-card-combo-rescue';
const $ = id => document.getElementById(id);
const WS_URL = 'wss://mine-server-git2.vigourjp2.workers.dev/room/english';
const N = 7;
const COLORS = ['#38bdf8','#f472b6','#a3e635','#facc15'];
const __crypto = (typeof globalThis!=='undefined' && globalThis.crypto) ? globalThis.crypto : null;
const clientId = (__crypto && typeof __crypto.randomUUID==='function') ? __crypto.randomUUID().slice(0,8) : ('c'+Math.floor(Math.random()*999999));
let socket=null,retryTimer=null,heartbeat=null,rx=0;
let selectedHandIndex=-1;
let activeJudgeWordForReason='';
let recentCells=[];
let lastJudgeMsg='';
let lastJudgeClass='info';
let suppressBroadcast=false;
const WORDS = [
  // 主語・代名詞
  {w:'I',pos:['subj','pron'],lv:1},{w:'you',pos:['subj','pron','pronObj'],lv:1},{w:'he',pos:['subj','pron'],lv:1},{w:'she',pos:['subj','pron'],lv:1},{w:'we',pos:['subj','pron'],lv:1},{w:'they',pos:['subj','pron'],lv:1},{w:'it',pos:['subj','pron','pronObj'],lv:1},{w:'me',pos:['noun','pronObj'],lv:1},
  // be / 助動詞 / 否定
  {w:'am',pos:['be'],lv:1},{w:'are',pos:['be'],lv:1},{w:'is',pos:['be'],lv:1},{w:'was',pos:['bePast'],lv:2},{w:'were',pos:['bePast'],lv:2},{w:'not',pos:['not'],lv:1},
  {w:'can',pos:['modal'],lv:2},{w:'must',pos:['modal'],lv:2},{w:'will',pos:['modal'],lv:2},{w:'should',pos:['modal'],lv:3},
  // 形容詞
  {w:'happy',pos:['adj'],lv:1},{w:'sad',pos:['adj'],lv:1},{w:'kind',pos:['adj'],lv:1},{w:'tall',pos:['adj'],lv:1},{w:'busy',pos:['adj'],lv:1},{w:'hungry',pos:['adj'],lv:1},{w:'fun',pos:['adj','noun'],lv:1},{w:'good',pos:['adj'],lv:1},{w:'bad',pos:['adj'],lv:1},{w:'nice',pos:['adj'],lv:1},{w:'big',pos:['adj'],lv:1},{w:'small',pos:['adj'],lv:1},{w:'new',pos:['adj'],lv:1},{w:'old',pos:['adj'],lv:1},{w:'interesting',pos:['adj','ving'],lv:2},{w:'important',pos:['adj'],lv:2},{w:'famous',pos:['adj'],lv:2},{w:'free',pos:['adj'],lv:2},{w:'right',pos:['adj','noun'],lv:2},
  // 一般動詞
  {w:'like',pos:['verb'],lv:1},{w:'play',pos:['verb'],lv:1},{w:'study',pos:['verb'],lv:1},{w:'read',pos:['verb'],lv:1},{w:'go',pos:['verb'],lv:1},{w:'come',pos:['verb'],lv:1},{w:'eat',pos:['verb'],lv:1},{w:'drink',pos:['verb'],lv:1},{w:'have',pos:['verb'],lv:1},{w:'watch',pos:['verb'],lv:1},{w:'listen',pos:['verb'],lv:1},{w:'speak',pos:['verb'],lv:1},{w:'write',pos:['verb'],lv:1},{w:'make',pos:['verb'],lv:2},{w:'take',pos:['verb'],lv:2},{w:'look',pos:['verb'],lv:2},{w:'get',pos:['verb'],lv:2},{w:'want',pos:['verbWant','verb'],lv:2},{w:'try',pos:['verb'],lv:2},{w:'need',pos:['verb'],lv:2},{w:'help',pos:['verb','noun'],lv:2},{w:'see',pos:['verb'],lv:1},{w:'swim',pos:['verb'],lv:1},{w:'visit',pos:['verb'],lv:2},{w:'learn',pos:['verb'],lv:2},{w:'enjoy',pos:['verb'],lv:2},
  // ing
  {w:'playing',pos:['ving'],lv:2},{w:'studying',pos:['ving'],lv:2},{w:'reading',pos:['ving'],lv:2},{w:'going',pos:['ving'],lv:2},{w:'listening',pos:['ving'],lv:2},{w:'watching',pos:['ving'],lv:2},{w:'eating',pos:['ving'],lv:2},{w:'writing',pos:['ving'],lv:2},{w:'speaking',pos:['ving'],lv:2},{w:'learning',pos:['ving'],lv:2},
  // 機能語
  {w:'to',pos:['to','prep'],lv:1},{w:'in',pos:['prep'],lv:1},{w:'on',pos:['prep'],lv:1},{w:'at',pos:['prep'],lv:1},{w:'for',pos:['prep'],lv:1},{w:'from',pos:['prep'],lv:2},{w:'with',pos:['prep'],lv:2},{w:'of',pos:['prep'],lv:2},{w:'about',pos:['prep'],lv:2},{w:'after',pos:['prep'],lv:2},{w:'before',pos:['prep'],lv:2},{w:'because',pos:['conj'],lv:2},{w:'and',pos:['conj'],lv:1},{w:'the',pos:['article'],lv:1},{w:'a',pos:['article'],lv:1},{w:'an',pos:['article'],lv:1},
  // 名詞
  {w:'school',pos:['noun'],lv:1},{w:'home',pos:['noun','advPlace'],lv:1},{w:'bed',pos:['noun'],lv:1},{w:'soccer',pos:['noun'],lv:1},{w:'tennis',pos:['noun'],lv:1},{w:'baseball',pos:['noun'],lv:1},{w:'English',pos:['noun','adj'],lv:1},{w:'Japanese',pos:['noun','adj'],lv:1},{w:'apples',pos:['noun'],lv:1},{w:'music',pos:['noun'],lv:1},{w:'books',pos:['noun'],lv:1},{w:'TV',pos:['noun'],lv:1},{w:'breakfast',pos:['noun'],lv:1},{w:'lunch',pos:['noun'],lv:1},{w:'dinner',pos:['noun'],lv:1},{w:'morning',pos:['noun'],lv:1},{w:'afternoon',pos:['noun'],lv:1},{w:'evening',pos:['noun'],lv:1},{w:'night',pos:['noun'],lv:1},{w:'friend',pos:['noun'],lv:1},{w:'friends',pos:['noun'],lv:1},{w:'family',pos:['noun'],lv:1},{w:'Japan',pos:['noun','place'],lv:1},{w:'Tokyo',pos:['noun','place'],lv:1},{w:'game',pos:['noun'],lv:1},{w:'games',pos:['noun'],lv:1},{w:'water',pos:['noun'],lv:1},{w:'food',pos:['noun'],lv:1},{w:'care',pos:['noun'],lv:2},{w:'front',pos:['noun'],lv:2},{w:'lot',pos:['noun'],lv:2},{w:'example',pos:['noun'],lv:2},{w:'time',pos:['noun'],lv:2},{w:'people',pos:['noun'],lv:2},{w:'world',pos:['noun'],lv:2},{w:'work',pos:['noun','verb'],lv:2},
  // 副詞・時
  {w:'very',pos:['adv'],lv:1},{w:'well',pos:['adv','noun'],lv:1},{w:'often',pos:['advTime'],lv:2},{w:'always',pos:['advTime'],lv:2},{w:'sometimes',pos:['advTime'],lv:2},{w:'now',pos:['advTime'],lv:1},{w:'today',pos:['advTime'],lv:1},{w:'everyday',pos:['advTime'],lv:2},{w:'tomorrow',pos:['advTime'],lv:2},{w:'yesterday',pos:['advTime'],lv:2}
];
const POS = Object.fromEntries(WORDS.map(x=>[x.w.toLowerCase(),x.pos]));
function wordMetaForApi(words){
  return (words||[]).map(w=>{
    const word=String(w||'').trim();
    const pos=POS[word.toLowerCase()] || [];
    return {w:word,pos:[...pos]};
  }).filter(x=>x.w);
}
// v87: 選択中の動詞手札を三人称単数現在形へ一時変化/戻す。
// 判定ルールではなく、プレイヤーの手札操作UI。API判定は従来通り外部APIだけ。
const THIRD_PERSON_BASE_TO_S = {
  be:'is', am:'is', are:'is', have:'has', do:'does', go:'goes',
  study:'studies', try:'tries',
  watch:'watches', speak:'speaks', like:'likes', play:'plays', read:'reads', come:'comes', eat:'eats', drink:'drinks',
  listen:'listens', write:'writes', make:'makes', take:'takes', look:'looks', get:'gets', want:'wants', need:'needs',
  help:'helps', see:'sees', swim:'swims', visit:'visits', learn:'learns', enjoy:'enjoys', work:'works'
};
const THIRD_PERSON_S_TO_BASE = Object.fromEntries(Object.entries(THIRD_PERSON_BASE_TO_S).map(([b,s])=>[String(s).toLowerCase(), b]));

// v74: ローカル英文テンプレ/フレーズバンクは判定・翻訳・理由に使わない。
// WORDS/POS は手札カテゴリ表示・配牌用メタデータだけ。
const PHRASE_BANK = [];
const PHRASE_MAP = new Map();

// Link Grammar Parser API連携。Cloudflare PagesだけではCライブラリを実行できないため、
// 無料コンテナ等に置いたAPI URLを ?lgapi=https://... または localStorage で指定する。
const IMAGE_INTEGRATION_VERSION='sentence-image-diversity-v44-case-preserve-frontend';
// v101: 判定キャッシュは完全廃止。毎回ブラウザAPIへ確認する。
const LINK_GRAMMAR_API_KEY='englishPittan.linkGrammarApi';
let __storedLgApi=''; try{ __storedLgApi=localStorage.getItem(LINK_GRAMMAR_API_KEY)||''; }catch(e){ __storedLgApi=''; }
let linkGrammarApi=(new URL(location.href).searchParams.get('lgapi') || __storedLgApi || 'https://english-pittan-lg-api.onrender.com').trim();
let linkGrammarStatus=linkGrammarApi ? 'READY' : 'OFF';
function clearEnglishJudgeCache(){
  // v101: 旧版の判定キャッシュを掃除するだけ。新規保存はしない。
  try{
    Object.keys(localStorage).forEach(k=>{
      if(k==='englishPittan.harperCache.v1' || k.startsWith('englishPittan.linkGrammarCache.')) localStorage.removeItem(k);
    });
  }catch(e){}
}
function evFromApiResult(data, words){
  const w=lowerWords(words);
  if(!data || !data.gameOk) return null;
  const text=(data.text||displayEnglish(w)).replace(/[.!?]$/,'');
  const ja=(data.ja || data.translation?.ja || data.translation?.translatedText || '');
  const sentenceType=data.sentenceType || data.acceptability?.sentenceType || '';
  const displayKind=data.acceptability?.displayKind || (sentenceType==='contextual_short_answer' ? '短い返事文' : (data.kind || 'API完全英文判定'));
  return {
    ok:true,
    kind:displayKind,
    pts:48+Math.min(28,w.length*6),
    text,
    ja,
    source:'api',
    parser:data,
    type:data.type || 'complete_sentence',
    sentenceType,
    utteranceType:data.acceptability?.utteranceType || sentenceType || ''
  };
}
async function linkGrammarEvaluate(words){
  // v44: APIへ送る英文はカード表示そのままの大小文字を保持する。
  // 旧版は lowerWords() した後に text を作っていたため、カードは「I」なのに API には「i am happy」を送り、
  // Strict Link Grammar が正常文をNG扱いするデグレが起きた。
  const originalWords=(words||[]).map(x=>String(x||'').trim()).filter(Boolean);
  const w=lowerWords(originalWords);
  const key=norm(w);
  if(!linkGrammarApi) return null;
  if(w.length<2) return null;
  // v101: キャッシュは使わない。毎回APIへ確認する。
  try{
    linkGrammarStatus='CHECK'; renderSafe();
    const base=linkGrammarApi.replace(/\/$/,'');
    const text=displayEnglish(originalWords);
    // v52: 単体評価ルートでも理由探索コンテキストを必ず同梱する。
    // 旧版は scanFromCell -> evaluateCandidatesByApi では context を送っていたが、
    // linkGrammarEvaluate() 直呼びルートでは text/words だけだったため、
    // reason job 側の handCandidates/deckCandidates が空になり、補完理由が出せなかった。
    const reasonContext=reasonCandidateContext();
    const payload={text,words:originalWords,...reasonContext};
    let res=await fetchWithTimeout(base+'/check-and-translate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)},7500);
    if(res.status===404) res=await fetchWithTimeout(base+'/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)},7500);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data=await res.json();
    const ev=evFromApiResult(data,originalWords);
    // v101: 成立結果も保存しない。
    scheduleReasonPolling(600);
    linkGrammarStatus='ON'; renderSafe();
    return ev;
  }catch(e){console.warn('English API failed',e); linkGrammarStatus='ERR'; renderSafe(); return null;}
}
function reasonCandidateContext(){
  const board=[];
  try{
    for(const c of (state?.board||[])){
      if(c && c.w) board.push(String(c.w));
    }
  }catch(e){}
  const hand=[];
  try{ hand.push(...((currentPlayer()?.hand)||[])); }catch(e){}
  // v67: 理由補完は「現在の手札」だけでなく、選択中カード・いま置いたカードも候補に入れる。
  // 種類別常備手札では、置いた瞬間に手札スロットが補充されるため、
  // APIへreason contextを送る時点で「今使った語」が手札から消えてしまうことがあった。
  // ここで補う。これは判定ではなく補完候補の文脈送信だけ。
  try{
    const hp=currentPlayer()?.hand||[];
    if(selectedHandIndex>=0 && hp[selectedHandIndex]) hand.push(String(hp[selectedHandIndex]));
    if(activeJudgeWordForReason) hand.push(String(activeJudgeWordForReason));
  }catch(e){}
  const deck=[];
  try{ deck.push(...WORDS.map(x=>x.w)); }catch(e){}
  const all=[...board,...hand,...deck];
  return {
    reasonBoardCandidates:[...new Set(board.map(String))],
    reasonHandCandidates:[...new Set(hand.map(String))],
    reasonDeckCandidates:[...new Set(deck.map(String))],
    reasonWordMetaMap:wordMetaForApi([...new Set(all.map(String))])
  };
}
function fetchWithTimeout(url, options={}, timeoutMs=7500){
  // v106: timeoutMs<=0 means no client-side abort.
  // Used for the bulk combo judgement so late-but-valid API results are not discarded.
  if(!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs)<=0){
    return fetch(url, options);
  }
  const ctrl = (typeof AbortController!=='undefined') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(()=>{ try{ctrl.abort();}catch(e){} }, timeoutMs) : null;
  const opts = ctrl ? {...options, signal:ctrl.signal} : options;
  return fetch(url, opts).finally(()=>{ if(timer) clearTimeout(timer); });
}
async function singleApiCheckItem(base, item){
  const res=await fetchWithTimeout(base+'/check-and-translate',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      text:item.text,
      words:item.words,
      wordMeta:item.wordMeta || wordMetaForApi(item.words),
      reasonPriorityEpoch:item.reasonPriorityEpoch || 0,
      reasonPrioritySeq:item.reasonPrioritySeq || 0,
      // v74: 盤面スキャン中の全NG候補でreason jobを作らない。
      // /check-and-translate は成立判定だけに使い、理由jobは明示要求だけに限定する。
      reasonMode:'none',
      reasonDisabled:true,
      ...reasonCandidateContext()
    })
  }, 7500);
  if(!res.ok) throw new Error('HTTP '+res.status);
  const data=await res.json();
  return data;
}
async function singleApiCheckText(text, seq=0){
  if(!linkGrammarApi) return null;
  const words=String(text||'').trim().split(/\s+/).filter(Boolean);
  if(words.length<2) return null;
  const base=linkGrammarApi.replace(/\/$/,'');
  return singleApiCheckItem(base,{text:displayEnglish(words),words,reasonPriorityEpoch:Date.now(),reasonPrioritySeq:seq});
}
async function batchApiCheckItems(base, items, reasonPriorityEpoch){
  // v85: 盤面候補を1件ずつ /check-and-translate へ直列送信しない。
  // 1候補7.5秒×複数候補で12秒watchdogを踏むのがゲーム崩壊の主因だった。
  // batchは成立判定だけ。翻訳/理由jobは後追いにして、1手の待ち時間を最小化する。
  const res=await fetchWithTimeout(base+'/check-and-translate-batch',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      candidates:items.map((item,i)=>({id:item.id ?? String(i), text:item.text, words:item.words, wordMeta:item.wordMeta || wordMetaForApi(item.words)})),
      limit:240,
      translate:false,
      withTranslate:false,
      reasonMode:'none',
      reasonDisabled:true,
      strictGameGate:false,
      acceptabilityModelGate:false,
      reasonPriorityEpoch:reasonPriorityEpoch || Date.now(),
      ...reasonCandidateContext()
    })
  }, 0);
  if(!res.ok) throw new Error('HTTP '+res.status);
  const data=await res.json();
  const arr=Array.isArray(data?.results)?data.results:[];
  const byId=new Map(arr.map(x=>[String(x.id),x]));
  return items.map((item,i)=>byId.get(String(item.id ?? i)) || null);
}
async function evaluateCandidatesByApi(routeCandidates){
  const out=[];
  if(!linkGrammarApi) return out;
  const pending=[];
  const byKey=new Map();
  // v23: この一手で発生したNG候補群。古いpendingより新しい一手を優先処理するための世代番号。
  const reasonPriorityEpoch=Date.now();
  const byKeyFirstOrder=new Map();
  for(const c of routeCandidates){
    const words=c.path.map(s=>s.w).map(x=>String(x||'').trim()).filter(Boolean);
    // v44: API判定用 text はカード表示そのまま。key/品詞判定だけ小文字正規化。
    const w=lowerWords(words);
    const key=norm(w);
    if(w.length<2) continue;
    // v101: 判定キャッシュは読まない。
    if(!byKey.has(key)){
      const seq=pending.length;
      const item={id:String(seq), key, words, text:displayEnglish(words), routes:[], reasonPriorityEpoch, reasonPrioritySeq:seq};
      byKey.set(key,item); byKeyFirstOrder.set(key,seq); pending.push(item);
    }
    byKey.get(key).routes.push(c);
  }
  if(!pending.length){ if(out.length) lastScanRejects=[]; else lastScanRejects=(lastScanRejects||[]).slice(0,1); return out; }

  try{
    linkGrammarStatus='CHECK'; renderSafe();
    const base=linkGrammarApi.replace(/\/$/,'');

    let batchResults=[];
    try{
      batchResults=await batchApiCheckItems(base,pending,reasonPriorityEpoch);
    }catch(e){
      // v85: batchが404/一時失敗の古いAPIでも遊べるよう、最後の保険だけ直列fallback。
      // 通常経路ではここへ来ない。reason jobは作らない。
      console.warn('batch judge failed; fallback to single checks', e);
      for(const item of pending){
        try{ batchResults.push(await singleApiCheckItem(base,item)); }
        catch(err){ batchResults.push({reason:'API一時未応答', type:'api_error'}); }
      }
    }

    // v87: 先に成立有無だけを見る。
    // 成立が1件以上あればNG経路は完全スキップ。成功時にNG理由/pending/jobを混ぜない。
    const successRows=[];
    for(let i=0;i<pending.length;i++){
      const item=pending[i];
      const finalResult=batchResults[i] || {reason:'API一時未応答', type:'api_error'};
      const ev=evFromApiResult(finalResult,item.words);
      if(ev) successRows.push({item, finalResult, ev});
    }

    if(successRows.length){
      for(const row of successRows){
        const {item, ev}=row;
        // v101: 成立結果はキャッシュ保存しない。
        for(const route of item.routes) out.push({...ev,cells:route.path.map(s=>s.i),dir:route.label,source:'api-batch'});
      }
      lastScanRejects=[];
    }else{
      // 成立0のときだけ代表NG TOP1を保持する。
      // 2件目以降は表示も理由解析もpollingもしない。
      function bestRouteOf(item){
        return (item.routes||[]).slice().sort((a,b)=>(b.path.length-a.path.length)||(a.path[0]?.i??999)-(b.path[0]?.i??999))[0] || null;
      }
      let top=null;
      for(let i=0;i<pending.length;i++){
        const item=pending[i];
        const route=bestRouteOf(item);
        if(!route) continue;
        const rank=[route.path.length, -(route.path[0]?.i??999), -i];
        if(!top || rank[0]>top.rank[0] || (rank[0]===top.rank[0] && rank[1]>top.rank[1]) || (rank[0]===top.rank[0] && rank[1]===top.rank[1] && rank[2]>top.rank[2])){
          top={i,item,route,finalResult:batchResults[i] || {reason:'API一時未応答', type:'api_error'},rank};
        }
      }
      lastScanRejects=[];
      if(top){
        const item=top.item;
        const finalResult=top.finalResult;
        const rejectBase={
          __reject:true,
          text:item.text,
          words:item.words,
          reason:finalResult?.reasonExplain?.explanationJa || finalResult?.reasonExplain?.explanationEn || '',
          reasonSource:finalResult?.reasonExplain?.method || finalResult?.reasonSource || '',
          reasonStatus:finalResult?.reasonStatus || '',
          reasonJobId:finalResult?.reasonJobId || '',
          reasonExplain:finalResult?.reasonExplain || null,
          reasonPriorityEpoch:item.reasonPriorityEpoch || reasonPriorityEpoch,
          reasonPrioritySeq:item.reasonPrioritySeq || 0,
          reasonJobAttempts:finalResult?.reasonJobAttempts || finalResult?.attempts || 0,
          reasonJobNextRetryAt:finalResult?.reasonJobNextRetryAt || finalResult?.nextRetryAt || null,
          reasonQueueRole:finalResult?.queueRole || finalResult?.reasonQueueRole || '',
          reasonQueueIndex:finalResult?.queueIndex ?? finalResult?.reasonQueueIndex ?? null,
          reasonQueueLabel:finalResult?.queueLabel || finalResult?.reasonQueueLabel || '',
          reasonQueueRevision:finalResult?.queueRevision || 0,
          reasonRunningText:finalResult?.runningText || '',
          type:finalResult?.type||'',
          sentenceType:finalResult?.sentenceType||'',
          fullParse:!!finalResult?.fullParse
        };
        // v101: NG理由もキャッシュ保存しない。表示中の lastScanRejects だけで扱う。
        lastScanRejects.push({
          ...rejectBase,
          cells:top.route.path.map(s=>s.i),
          dir:top.route.label
        });
      }
    }

    scheduleReasonPolling(600);
    linkGrammarStatus='ON'; renderSafe();
  }catch(e){console.warn('English API failed',e); linkGrammarStatus='ERR'; renderSafe();}
  return out;
}

function setLinkGrammarApi(url){
  linkGrammarApi=String(url||'').trim();
  if(linkGrammarApi) localStorage.setItem(LINK_GRAMMAR_API_KEY,linkGrammarApi); else localStorage.removeItem(LINK_GRAMMAR_API_KEY);
  linkGrammarStatus=linkGrammarApi?'READY':'OFF'; renderSafe();
}
window.setLinkGrammarApi=setLinkGrammarApi;
// v74: Harper・EXACT・ローカル文法判定・ローカル和訳辞書は撤去。
// 成立判定/理由/翻訳は外部APIだけを正本にする。
const HARPER_CACHE_KEY='englishPittan.harperCache.disabled.v74';
let harperStatus='OFF';
async function checkReasonApiHealth(label='起動時API確認'){
  if(!linkGrammarApi) return null;
  try{
    const base=linkGrammarApi.replace(/\/$/,'');
    const res=await fetchWithTimeout(base+'/health',{cache:'no-store'},5000);
    const data=await res.json().catch(()=>({ok:false,error:'invalid json'}));
    addLog(`${label}: ${base}/health ${data?.ok?'OK':'NG'} / HF_TOKEN:${data?.hfTokenPresent?'あり':'なし'} / reason:${data?.hfDisabledForReason?'StrictLG探索':'外部'}`, !!data?.ok);
    return data;
  }catch(e){
    addLog(`${label}: /health 失敗 ${String(e?.message||e)}`, false);
    return null;
  }
}
function renderSafe(){try{ if(typeof render==='function') render(); }catch(e){}}
function capSentence(words){
  return (Array.isArray(words)?words:[]).map(x=>String(x||'').trim()).filter(Boolean).join(' ');
}
async function initHarper(){ return false; }
async function harperEvaluate(words){ return null; }
const EXACT = new Map();
const EXACT_JA = new Map();

const HAND_ORDER = [
  ['subj','主語',10],['pron','主語',10],
  ['be','be動詞',20],['modal','助動詞',22],['not','否定',24],
  ['verbWant','動詞',30],['verb','動詞',32],['ving','〜ing',34],['to','to',36],
  ['prep','前置詞',38],['article','冠詞',40],
  ['adv','副詞',48],['adj','形容詞',50],
  ['noun','名詞',60],['advTime','時',70]
];
function handInfo(w){
  const ps=wordPos(w);
  let best={key:'etc',label:'その他',rank:99};
  for(const [key,label,rank] of HAND_ORDER){
    if(ps.includes(key) && rank<best.rank) best={key,label,rank};
  }
  return best;
}
function sortHand(hand){
  return (hand||[]).slice().sort((a,b)=>{
    const ia=handInfo(a), ib=handInfo(b);
    return (ia.rank-ib.rank) || String(a).localeCompare(String(b),'en',{sensitivity:'base'});
  });
}
function displayHandLabel(w){
  const ps=wordPos(w);
  const labels=[];
  if(ps.includes('subj')||ps.includes('pron')) labels.push('主語');
  if(ps.includes('be')) labels.push('be');
  if(ps.includes('modal')) labels.push('助');
  if(ps.includes('verb')||ps.includes('verbWant')) labels.push('動詞');
  if(ps.includes('ving')) labels.push('ing');
  if(ps.includes('adj')) labels.push('形容詞');
  if(ps.includes('noun')||ps.includes('place')||ps.includes('pronObj')) labels.push('名詞');
  if(ps.includes('prep')||ps.includes('to')) labels.push('前置詞');
  if(ps.includes('adv')||ps.includes('advTime')) labels.push('副詞');
  if(ps.includes('article')) labels.push('冠詞');
  if(ps.includes('not')) labels.push('否定');
  if(THIRD_PERSON_S_TO_BASE[String(w||'').toLowerCase()]) labels.unshift('三単現');
  return [...new Set(labels)].slice(0,2).join('/') || handInfo(w).label;
}
const HAND_SLOTS = [
  {key:'subj', label:'主語', poses:['subj']},
  {key:'be', label:'be/助', poses:['be','modal']},
  {key:'verb', label:'動詞', poses:['verb','verbWant']},
  {key:'comp', label:'形/ing', poses:['adj','ving']},
  {key:'noun', label:'名詞', poses:['noun']},
  {key:'extra', label:'追加', poses:['advTime','adv','to','prep','article','not']}
];
function wordsForSlot(slotIndex){
  const slot=HAND_SLOTS[slotIndex]||HAND_SLOTS[HAND_SLOTS.length-1];
  return WORDS.filter(x=>(x.pos||[]).some(p=>slot.poses.includes(p)));
}
function drawOneForSlot(slotIndex){
  const bag=wordsForSlot(slotIndex);
  return (bag[Math.floor(Math.random()*bag.length)]||WORDS[0]).w;
}
function slotInfo(i,w){
  const slot=HAND_SLOTS[i];
  if(slot) return {key:slot.key, label:slot.label, rank:i};
  return handInfo(w);
}
const targets = Array.from(EXACT.keys()).slice(0,24);
let state = freshState(2);
function freshState(playerCount=2){
  return {version:1,gameId:'eng-'+Date.now().toString(36),turn:0,turnNo:1,playerCount,wordsMade:0,scoredRouteKeys:[],board:Array.from({length:N*N},()=>null),players:Array.from({length:playerCount},(_,i)=>({name:'Player '+(i+1),score:0,tiles:0,color:COLORS[i],hand:drawHand(i)})),log:[{t:Date.now(),text:'新規ゲーム開始',good:true}],statusText:'単語タイルを選んで空きマスに置く',statusClass:'info',lastJudgeMsg:'',lastJudgeClass:'info'};
}
function drawHand(seed=0){
  // 詰み対策：種類ごとの固定スロットで、常に「主語 / be・助 / 動詞 / 形容詞・ing / 名詞 / 追加」を1枚ずつ持つ。
  if(seed===0) return ['I','am','like','happy','apples','today'];
  if(seed===1) return ['you','are','play','kind','soccer','now'];
  if(seed===2) return ['we','can','study','busy','English','very'];
  if(seed===3) return ['she','is','read','reading','books','in'];
  return HAND_SLOTS.map((_,i)=>drawOneForSlot(i));
}
function safeName(){return ($('nameInput').value||localStorage.englishName||('P-'+clientId)).trim().slice(0,18)}
function setMsg(text,cls='info',opts={}){const val=String(text||'');const klass=cls||'info';const el=$('msg');if(el){el.textContent=val;el.className='msg '+klass;} if(state){state.statusText=val;state.statusClass=klass;if(opts.judge){state.lastJudgeMsg=val;state.lastJudgeClass=klass;}} if(opts.judge){lastJudgeMsg=val;lastJudgeClass=klass;}}
function addLog(text,good=true){state.log.unshift({t:Date.now(),text,good});state.log=state.log.slice(0,40);}
function idx(x,y){return y*N+x}
function xy(i){return {x:i%N,y:Math.floor(i/N)}}
function currentPlayer(){return state.players[state.turn%state.playerCount]}
function wordPos(w){
  const k=String(w||'').toLowerCase();
  if(POS[k]) return POS[k];
  const base=THIRD_PERSON_S_TO_BASE[k];
  if(base && POS[base]) return POS[base];
  return [];
}
function hasPos(w,p){return wordPos(w).includes(p)}
function norm(arr){return arr.map(w=>String(w).trim()).join(' ').toLowerCase().replace(/\s+/g,' ')}
const UNUSED_PENALTY = 8;
function useCountOf(c){return Math.max(0, Number(c?.useCount||0));}
function useColor(count, ownerColor){
  if(count<=0) return {bg:'rgba(248,113,113,.16)', border:'rgba(248,113,113,.55)', text:'#fecaca', rainbow:false};
  const hue = [198,142,68,34,322,265,0][Math.min(count-1,6)];
  const bg = `hsla(${hue}, 92%, ${count>=4?56:48}%, .32)`;
  const border = `hsla(${hue}, 96%, 68%, .86)`;
  return {bg,border,text:'#fff',rainbow:count>=7};
}
function lowerWords(words){return (words||[]).map(x=>String(x||'').trim()).filter(Boolean).map(x=>x.toLowerCase());}
// v74: 3単現s補正などのローカル文法整形はしない。
function applySubjectVerbAgreement(words){ return Array.isArray(words)?words.slice():[]; }
function displayEnglish(words){
  // v34: no JS grammar/case rewriting before API judgment.
  // Send the exact card sequence to Strict Link Grammar; no auto-capitalization, no 3rd-person-s fix.
  return (Array.isArray(words)?words:[]).map(x=>String(x||'').trim()).filter(Boolean).join(' ');
}
// v74: ローカル品詞テンプレによる英文成立判定は完全撤去。
function evaluateSequence(words){ return null; }
async function evaluateSequenceAsync(words){
  const lg=await linkGrammarEvaluate(words);
  return lg||null;
}

const TRANSLATION_CACHE_KEY='englishPittan.translationCache.v4.apiOnly';
let translationCache={};
try{translationCache=JSON.parse(localStorage.getItem(TRANSLATION_CACHE_KEY)||'{}')||{};}catch(e){translationCache={};}
async function translateWithApi(text){
  if(!linkGrammarApi) return '';
  const key=String(text||'').trim().toLowerCase();
  if(!key) return '';
  if(translationCache[key]) return translationCache[key];
  try{
    const base=linkGrammarApi.replace(/\/$/,'');
    const res=await fetch(base+'/translate?text='+encodeURIComponent(text),{cache:'no-store'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data=await res.json();
    const ja=(data && (data.ja || data.translatedText || data.translation?.ja || data.translation?.translatedText)) || '';
    if(ja){
      translationCache[key]=ja;
      try{localStorage.setItem(TRANSLATION_CACHE_KEY,JSON.stringify(translationCache));}catch(e){}
      return ja;
    }
  }catch(e){console.warn('translate API failed',e);}
  return '';
}
async function resolveJapanese(words,ev){
  return (ev && ev.ja) ? ev.ja : '';
}
async function hydrateJapaneseForMatches(matches){
  for(const m of (matches||[])){
    if(!m || m.ja) continue;
    const text=String(m.text||'').trim();
    if(!text) continue;
    try{
      const ja=await translateWithApi(text);
      if(ja) m.ja=ja;
    }catch(e){}
  }
  return matches;
}
function translateSequence(words,ev){ return ''; }

function sentenceImageCacheKey(sentence, jaText='') {
  return 'sentencePixabay:v7:' + norm([sentence || '']);
}
function sentenceImageCacheRead(key){
  try{
    const raw=localStorage.getItem(key);
    if(!raw) return null;
    const data=JSON.parse(raw);
    if(!data || !data.imageUrl) return null;
    if(data.expiresAt && data.expiresAt<Date.now()){ localStorage.removeItem(key); return null; }
    return data;
  }catch(e){ return null; }
}
function sentenceImageCacheWrite(key,data){
  try{
    localStorage.setItem(key,JSON.stringify({...data,expiresAt:Date.now()+6*60*60*1000}));
  }catch(e){}
}
function sentenceImageRecentIds(){
  try{
    const arr=JSON.parse(localStorage.getItem('sentencePixabay:recentIds:v1')||'[]');
    return Array.isArray(arr) ? arr.map(String).filter(Boolean).slice(0,12) : [];
  }catch(e){ return []; }
}
function rememberSentenceImageId(id){
  id=String(id||'').trim();
  if(!id) return;
  try{
    const arr=sentenceImageRecentIds().filter(x=>x!==id);
    arr.unshift(id);
    localStorage.setItem('sentencePixabay:recentIds:v1',JSON.stringify(arr.slice(0,12)));
  }catch(e){}
}
function sentenceImageIsRecentlyUsed(data){
  const id=String(data?.id||'').trim();
  return !!id && sentenceImageRecentIds().includes(id);
}
async function fetchSentenceImage(sentence){
  if(!linkGrammarApi) return {ok:false,error:'image api off'};
  const base=linkGrammarApi.replace(/\/$/,'');
  const avoid=sentenceImageRecentIds().join(',');
  const url=base+'/sentence-image?q='+encodeURIComponent(sentence)+(avoid?'&avoid='+encodeURIComponent(avoid):'');
  const res=await fetch(url);
  const data=await res.json().catch(()=>({ok:false,error:'invalid json'}));
  if(!res.ok) throw new Error(data?.error || ('HTTP '+res.status));
  return data;
}
function renderSentenceImageData(art, sentence, data){
  const img=esc(data.imageUrl || data.previewUrl || '');
  const page=esc(data.pageURL || 'https://pixabay.com/');
  const tags=esc(data.tags || data.query || 'Pixabay');
  if(!img){
    art.innerHTML='<div class="sentenceImageFallback">画像URLが返ってきませんでした</div>';
    return;
  }
  art.innerHTML=`<img src="${img}" alt="${esc(sentence)}" loading="lazy" referrerpolicy="no-referrer"><div class="sentenceImageCredit"><a href="${page}" target="_blank" rel="noopener">Pixabay</a> / ${tags}</div>`;
}
async function showSentenceGeneratedImage(matches, index=0) {
  const unique=[]; const seen=new Set();
  for(const m of (matches || [])){
    if(!m || !m.text) continue;
    // v34: 成立文として採点されたものだけ画像対象。未完成/NG/古いパネルの残像を防ぐ。
    if(m.gameOk !== true) continue;
    if(String(m.type||'') !== 'complete_sentence') continue;
    if(String(m.sentenceType||m.utteranceType||'') === 'contextual_short_answer') continue;
    const k=norm(m.text.split(' '));
    if(seen.has(k)) continue;
    seen.add(k); unique.push(m);
  }
  const m = unique[index] || unique[0];
  if(!m){ const panel=$('sentenceImagePanel'); if(panel) panel.classList.remove('show'); return; }
  const panel=$('sentenceImagePanel'), title=$('sentenceImageTitle'), sub=$('sentenceImageSub'), art=$('sentenceImageArt');
  if(!panel || !title || !sub || !art) return;
  const sentence = m.text || '';
  const jaText = m.ja || '';
  const cacheKey=sentenceImageCacheKey(sentence,jaText);
  title.textContent = sentence;
  sub.textContent = jaText || '英文の意味に近い画像をPixabayから検索表示';
  panel.classList.remove('show'); void panel.offsetWidth; panel.classList.add('show');
  const cached=sentenceImageCacheRead(cacheKey);
  if(cached && !sentenceImageIsRecentlyUsed(cached)){
    renderSentenceImageData(art,sentence,cached);
    rememberSentenceImageId(cached.id);
    return;
  }
  art.innerHTML='<div class="sentenceImageLoading">画像検索中...</div>';
  try{
    const data=await fetchSentenceImage(sentence);
    if(data && data.ok && data.imageUrl){
      sentenceImageCacheWrite(cacheKey,data);
      renderSentenceImageData(art,sentence,data);
      rememberSentenceImageId(data.id);
    }else{
      art.innerHTML='<div class="sentenceImageFallback">画像が見つかりませんでした<br><small>'+esc(data?.query||data?.error||'')+'</small></div>';
    }
  }catch(e){
    art.innerHTML='<div class="sentenceImageFallback">画像APIエラー<br><small>'+esc(String(e.message||e))+'</small></div>';
  }
}


function pickSpeechVoice(langPrefix){
  try{
    const synth=window.speechSynthesis;
    if(!synth || typeof synth.getVoices!=='function') return null;
    const voices=synth.getVoices()||[];
    const prefix=String(langPrefix||'').toLowerCase();
    if(!voices.length) return null;
    return voices.find(v=>String(v.lang||'').toLowerCase()===prefix)
      || voices.find(v=>String(v.lang||'').toLowerCase().startsWith(prefix.split('-')[0]))
      || null;
  }catch(e){ return null; }
}
function unlockSpeech(){
  // スマホChrome/Safari対策: ユーザー操作中に SpeechSynthesis と AudioContext を一度だけ起こす。
  try{
    const C=window.AudioContext||window.webkitAudioContext;
    if(C){
      const ctx=new C();
      if(ctx.state==='suspended' && typeof ctx.resume==='function') ctx.resume().catch(()=>{});
      setTimeout(()=>{try{ctx.close();}catch(e){}},180);
    }
  }catch(e){}
  try{
    if(!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return false;
    const u=new SpeechSynthesisUtterance('ready');
    u.lang='en-US';
    u.volume=0.01;
    u.rate=1;
    const v=pickSpeechVoice('en-US')||pickSpeechVoice('en');
    if(v) u.voice=v;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    setTimeout(()=>{try{window.speechSynthesis.cancel();}catch(e){}},90);
    return true;
  }catch(e){
    console.warn('unlockSpeech failed', e);
    return false;
  }
}
function speakOne(enText, jaText, done){
  const finish=()=>{ if(typeof done==='function') done(); };
  try{
    if(!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) { finish(); return; }
    const synth=window.speechSynthesis;
    const queue=[];
    const en=String(enText||'').trim();
    const ja=String(jaText||'').trim();
    if(en){
      const u=new SpeechSynthesisUtterance(en);
      u.lang='en-US';
      u.rate=.92;
      u.pitch=1;
      u.volume=1;
      const v=pickSpeechVoice('en-US')||pickSpeechVoice('en');
      if(v) u.voice=v;
      queue.push(u);
    }
    if(ja){
      const u=new SpeechSynthesisUtterance(ja);
      u.lang='ja-JP';
      u.rate=1.02;
      u.pitch=1;
      u.volume=1;
      const v=pickSpeechVoice('ja-JP')||pickSpeechVoice('ja');
      if(v) u.voice=v;
      queue.push(u);
    }
    if(!queue.length){ finish(); return; }
    let i=0;
    const speakNext=()=>{
      const u=queue[i++];
      if(!u){ finish(); return; }
      let ended=false;
      const goNext=()=>{ if(ended) return; ended=true; setTimeout(speakNext,180); };
      u.onend=goNext;
      u.onerror=(e)=>{ console.warn('speech utterance failed', e); goNext(); };
      synth.speak(u);
      // Android Chromeで onend が返らない保険。長文でも途中で詰まらない程度に長め。
      const guardMs=Math.max(1800, Math.min(9000, String(u.text||'').length*160+900));
      setTimeout(goNext, guardMs);
    };
    speakNext();
  }catch(e){
    console.warn('speakOne failed', e);
    finish();
  }
}

function speakResultsSequential(matches){
  if(!matches||!matches.length) return;
  const unique=[]; const seen=new Set();
  for(const m of matches){const k=norm(m.text.split(' ')); if(seen.has(k)) continue; seen.add(k); unique.push(m);}
  if(!unique.length) return;
  try{ if('speechSynthesis' in window) window.speechSynthesis.cancel(); }catch(e){}
  let i=0;
  const next=()=>{
    const m=unique[i++];
    if(!m) return;
    highlightRoute(m, i-1, 1850);
    const prefix=unique.length>1 ? `Combo ${i}. ` : '';
    speakOne(prefix + m.text, m.ja||'', ()=>setTimeout(next,260));
  };
  next();
}
function playChime(ok=true){
  try{
    const C=window.AudioContext||window.webkitAudioContext;if(!C)return;
    const ctx=new C();
    const now=ctx.currentTime;
    const notes=ok?[523,659,784,1046]:[160,120];
    notes.forEach((f,i)=>{const o=ctx.createOscillator();const g=ctx.createGain();o.type=ok?'triangle':'sawtooth';o.frequency.value=f;g.gain.setValueAtTime(0.0001,now+i*.08);g.gain.exponentialRampToValueAtTime(ok?.16:.08,now+i*.08+.02);g.gain.exponentialRampToValueAtTime(0.0001,now+i*.08+.16);o.connect(g);g.connect(ctx.destination);o.start(now+i*.08);o.stop(now+i*.08+.18);});
    setTimeout(()=>ctx.close(),700);
  }catch(e){}
}
function showFx(made,gained,cellIndex,comboInfo=null){
  const top=made[0]; if(!top)return;
  const comboN=comboInfo?.count||1;
  const fx=$('fxBanner');
  fx.classList.toggle('combo', comboN>1);
  fx.querySelector('.fxBig').textContent = comboN>1 ? `COMBO ×${comboN}!` : 'GOOD!';
  $('fxEn').textContent=comboN>1 ? (comboInfo?.mode==='multi' ? `${comboN} SENTENCE COMBO!` : `${top.text}  ${comboN} ROUTES!`) : top.text;
  $('fxJa').textContent=comboN>1 && comboInfo?.mode==='multi' ? comboInfo.text : (top.ja||'');
  $('fxPts').textContent=(comboN>1?`${comboInfo?.mode==='multi'?'文コンボ':'経路コンボ'} +${comboInfo.bonus||0} / `:'')+'+'+gained+' POINTS';
  fx.classList.remove('show');void fx.offsetWidth;fx.classList.add('show');
  const cell=document.querySelectorAll('.cell')[cellIndex];
  let x=innerWidth/2,y=innerHeight/2;
  if(cell){const r=cell.getBoundingClientRect();x=r.left+r.width/2;y=r.top+r.height/2;}
  const pop=document.createElement('div');pop.className='scorePop';pop.style.left=x+'px';pop.style.top=y+'px';pop.innerHTML=`+${gained}<small>${comboN>1?'COMBO ×'+comboN:esc(top.kind)}</small>`;document.body.appendChild(pop);setTimeout(()=>pop.remove(),1300);
  const sparkCount=comboN>1?38:22;
  for(let i=0;i<sparkCount;i++){const sp=document.createElement('i');sp.className='spark';sp.style.left=x+'px';sp.style.top=y+'px';const a=Math.random()*Math.PI*2,d=30+Math.random()*(comboN>1?130:90);sp.style.setProperty('--dx',Math.cos(a)*d+'px');sp.style.setProperty('--dy',Math.sin(a)*d+'px');document.body.appendChild(sp);setTimeout(()=>sp.remove(),900);}
}


async function rescueAcceptedPrefixCandidates(routeCandidates, placeIndex){
  const out=[];
  if(!linkGrammarApi || !Array.isArray(routeCandidates) || !routeCandidates.length) return out;
  const base=linkGrammarApi.replace(/\/$/,'');
  const seen=new Set();
  const items=[];
  for(const c of routeCandidates){
    const path=Array.isArray(c.path)?c.path:[];
    for(let n=2;n<=path.length;n++){
      const seg=path.slice(0,n);
      if(!seg.some(s=>s.i===placeIndex)) continue;
      const words=seg.map(s=>String(s.w||'').trim()).filter(Boolean);
      if(words.length<2) continue;
      const key=seg.map(s=>s.i).join(',')+'|'+norm(words);
      if(seen.has(key)) continue;
      seen.add(key);
      items.push({seg, words, text:displayEnglish(words), label:c.label});
    }
  }
  // v108: 救済でもコンボを殺さない。
  // 旧実装は短い候補から確認し、最初に1件OKが出た時点で break していた。
  // そのため today 配置時に `like soccer today` が先に通ると、
  // 同じ today を含む `I am happy today` / `I like soccer today` まで確認せずコンボ漏れした。
  // 文そのもののハードコードではなく、今回置いたセルを含む候補だけを長い順にAPI確認し、OKを全部返す。
  items.sort((a,b)=>b.words.length-a.words.length || a.seg[0].i-b.seg[0].i);
  const targets=items.slice(0,64);
  const acceptedKeys=new Set();
  const concurrency=4;
  let next=0;
  async function worker(){
    while(next<targets.length){
      const item=targets[next++];
      try{
        const data=await singleApiCheckItem(base,{text:item.text, words:item.words, wordMeta:wordMetaForApi(item.words), reasonPriorityEpoch:Date.now(), reasonPrioritySeq:0});
        const ev=evFromApiResult(data,item.words);
        if(ev){
          const k=item.seg.map(s=>s.i).join(',')+'|'+norm(item.words);
          if(!acceptedKeys.has(k)){
            acceptedKeys.add(k);
            out.push({...ev,cells:item.seg.map(s=>s.i),dir:item.label||'prefix-rescue',source:'api-prefix-rescue-v108'});
          }
        }
      }catch(e){ console.warn('prefix rescue check failed', item.text, e); }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,targets.length)}, worker));
  if(out.length){
    lastScanRejects=[];
  }
  return out;
}

async function scanFromCell(placeIndex){
  lastScanRejects=[];
  const found=[];
  const candidates=[];
  const starts=[];

  // v91: 曲がり候補を復活。
  // v86 の「直線限定」は撤回。ゲーム本来の右/下隣接ルートを戻す。
  // ただし v87 以降の方針どおり、成立が1件以上ある場合は NG 経路を完全無視し、
  // 成立0のときだけ TOP1 のNG理由に絞る。曲がり候補は採点候補として復活させるが、
  // 失敗表示を大量に出して画面を壊す用途には使わない。
  for(let y=0;y<N;y++){
    for(let x=0;x<N;x++){
      const c=state.board[idx(x,y)];
      if(c) starts.push({x,y,i:idx(x,y),w:c.w});
    }
  }

  function pushPath(path,label){
    if(path.length<2 || !path.some(s=>s.i===placeIndex)) return;
    candidates.push({path:path.slice(),label});
  }

  function dfs(x,y,path,lastMove,turns){
    pushPath(path, turns===0 ? (lastMove==='D'?'縦':'横') : `隣接ルート${turns}曲がり`);
    for(const mv of [{dx:1,dy:0,k:'R'},{dx:0,dy:1,k:'D'}]){
      const nx=x+mv.dx, ny=y+mv.dy;
      if(nx<0||ny<0||nx>=N||ny>=N) continue;
      const ni=idx(nx,ny);
      const cell=state.board[ni];
      if(!cell) continue;
      if(path.some(s=>s.i===ni)) continue;
      const nt = lastMove && lastMove!==mv.k ? turns+1 : turns;
      // 曲がり判定は復活。文法のOK/NGは外部APIだけが決める。
      dfs(nx,ny,path.concat({i:ni,w:cell.w}),mv.k,nt);
    }
  }
  for(const st of starts){ dfs(st.x,st.y,[{i:st.i,w:st.w}],null,0); }

  // 直線候補も明示的に追加する。DFSと重複しても下の重複排除で落とす。
  function pushStraightSegments(cells,label){
    let run=[];
    function flush(){
      if(run.length>=2){
        for(let a=0;a<run.length;a++){
          for(let b=a+1;b<run.length;b++){
            const seg=run.slice(a,b+1);
            if(seg.some(s=>s.i===placeIndex)) pushPath(seg,label);
          }
        }
      }
      run=[];
    }
    for(const s of cells){
      if(s && s.w) run.push(s); else flush();
    }
    flush();
  }
  for(let y=0;y<N;y++){
    pushStraightSegments(Array.from({length:N},(_,x)=>{const i=idx(x,y), c=state.board[i]; return c?{i,w:c.w}:null;}),'横');
  }
  for(let x=0;x<N;x++){
    pushStraightSegments(Array.from({length:N},(_,y)=>{const i=idx(x,y), c=state.board[i]; return c?{i,w:c.w}:null;}),'縦');
  }

  // 盤面から作った候補は、文っぽさをHTML側で決めず、全部APIへまとめて投げる。
  // JS側の品詞テンプレ/単語別翻訳/「主語があるから文っぽい」判定では採点しない。
  const seenCand=new Set();
  const uniq=[];
  for(const c of candidates){
    const words=c.path.map(s=>s.w);
    const k=c.path.map(s=>s.i).join(',')+'|'+norm(words);
    if(seenCand.has(k)) continue;
    seenCand.add(k); uniq.push(c);
  }
  let apiMatches=await evaluateCandidatesByApi(uniq);
  // v100: 成立0なら、古いNGキャッシュ/バッチ経路漏れを疑ってprefixを単体APIで再確認する。
  // `I am hungry today` がNGでも、prefixの `I am hungry` がOKならここで救済する。
  if(!apiMatches.length){
    apiMatches=await rescueAcceptedPrefixCandidates(uniq, placeIndex);
  }
  for(const ev of apiMatches){
    ev.ja=await resolveJapanese(ev.text.split(' '),ev);
    found.push(ev);
  }
  found.sort((a,b)=>(b.cells.length-a.cells.length)||(b.pts-a.pts));
  const seen=new Set();
  return found.filter(f=>{const k=f.cells.join(',')+'|'+norm(f.text.split(' ')); if(seen.has(k)) return false; seen.add(k); return true;}).slice(0,24);
}
function selectScoringMatches(matches){
  // v94: 「一回使ったカードを同じターンの別成立経路で使えない」ように見える原因を撤去。
  // 旧実装は長い成立経路を先に採用し、短い成立経路がそのセル集合の部分集合なら捨てていた。
  // そのため、同じカードを共有するコンボが減り、「使用済みカードは再利用不可」に見えていた。
  // ゲーム仕様として、盤面カードは1ターン内でも複数の成立経路に参加できる。
  // ここでは API が gameOk:true と返した distinct な「セル列 + 英文」を全部採点対象にする。
  const seen=new Set();
  const out=[];
  for(const m of (matches||[])){
    const k=(m.cells||[]).join(',')+'|'+norm(String(m.text||'').split(' '));
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out.sort((a,b)=>
    (a.cells?.[0]??999)-(b.cells?.[0]??999) ||
    ((b.cells||[]).length-(a.cells||[]).length) ||
    String(a.text||'').localeCompare(String(b.text||''))
  );
}

function routeScoreKeyFromParts(cells, wordsOrText){
  const cellsKey=(cells||[]).map(x=>String(x)).join(',');
  const words=Array.isArray(wordsOrText) ? wordsOrText : String(wordsOrText||'').split(/\s+/).filter(Boolean);
  return cellsKey+'|'+norm(words);
}
function routeScoreKey(m){
  return routeScoreKeyFromParts(m?.cells||[], String(m?.text||'').split(/\s+/).filter(Boolean));
}
function scoredRouteSet(){
  if(!Array.isArray(state.scoredRouteKeys)) state.scoredRouteKeys=[];
  return new Set(state.scoredRouteKeys.map(String));
}
function rememberScoredRoutes(scoring){
  if(!Array.isArray(state.scoredRouteKeys)) state.scoredRouteKeys=[];
  const set=new Set(state.scoredRouteKeys.map(String));
  for(const m of (scoring||[])){
    const k=routeScoreKey(m);
    if(k) set.add(k);
  }
  state.scoredRouteKeys=[...set].slice(-600);
}

function summarizeScoring(scoring){
  const groups=new Map();
  for(const m of scoring){
    const key=norm(m.text.split(' '));
    if(!groups.has(key)) groups.set(key,{text:m.text,ja:m.ja,kind:m.kind,count:0,pts:0,routes:[]});
    const g=groups.get(key);
    g.count++;
    g.pts += m.pts;
    g.routes.push(m);
  }
  const list=[...groups.values()];
  let comboInfo=null;
  const totalRoutes=scoring.length;
  if(totalRoutes>1){
    const sentenceCount=list.length;
    const routeBonus=(totalRoutes-1)*18;
    comboInfo={count:totalRoutes, sentenceCount, routeCount:totalRoutes, text:list.map(g=>g.text+(g.count>1?` ×${g.count}`:'')).join(' / '), ja:'成立詳細を表示中', bonus:routeBonus, mode:sentenceCount>1?'multi':'route', groups:list, matches:scoring};
  }
  return {groups:list, comboInfo};
}
function coord(i){const p=xy(i);return String.fromCharCode(65+p.x)+(p.y+1);}
function routeText(m){return (m.cells||[]).map((i,n)=>`${n+1}.${coord(i)} ${state.board[i]?.w||''}`).join(' → ');}
let routeFocusCells=[];
let routeFocusTimer=null;
let failFocusCell=-1;
let failFocusTimer=null;
let lastScanRejects=[];
function highlightRoute(m,seq=0,duration=1600){
  routeFocusCells=(m?.cells||[]).slice();
  render();
  clearTimeout(routeFocusTimer);
  routeFocusTimer=setTimeout(()=>{routeFocusCells=[];render();},duration);
  const items=document.querySelectorAll('.comboItem');
  items.forEach((el,i)=>el.classList.toggle('active',i===seq));
}

function clearResultOverlays(){
  try{
    const cp=$('comboPanel');
    if(cp){
      clearTimeout(cp._hideTimer);
      cp._hideTimer=null;
      cp.classList.remove('show');
    }
    const ip=$('sentenceImagePanel');
    if(ip) ip.classList.remove('show');
    routeFocusCells=[];
    failFocusCell=-1;
  }catch(e){ console.warn('clearResultOverlays failed', e); }
}

function showComboDetails(scoring,comboInfo){
  const panel=$('comboPanel'), listEl=$('comboList'), title=$('comboTitle');
  if(!panel||!listEl) return;
  if(!comboInfo || scoring.length<=1){panel.classList.remove('show');return;}
  title.textContent=`COMBO ×${comboInfo.count}：${comboInfo.sentenceCount||comboInfo.count}文 / ${comboInfo.routeCount||comboInfo.count}経路`;
  listEl.innerHTML=scoring.map((m,i)=>{
    const ja=m.ja||'';
    const chips=(m.cells||[]).map((c,n)=>`<span class="routeChip">${n+1} ${coord(c)} ${esc(state.board[c]?.w||'')}</span>`).join('');
    return `<div class="comboItem" data-route="${i}"><b>${i+1}. ${esc(m.text)}</b><div class="comboJa">${esc(ja)} / ${esc(m.kind||'')}</div><div class="comboRoute">${esc(m.dir||'経路')}：${esc(routeText(m))}</div><div class="comboCards">${chips}</div></div>`;
  }).join('');
  panel.classList.add('show');
  // コンボ詳細は読了前に消さない。次コンボ・閉じる・盤面リセットまで保持する。
  clearTimeout(panel._hideTimer);
  panel._hideTimer=null;
  panel.querySelectorAll('.comboItem').forEach((el,i)=>{el.onclick=()=>highlightRoute(scoring[i],i,5200);});
  const closeBtn=$('comboClose');
  if(closeBtn && !closeBtn._wired){
    closeBtn._wired=true;
    closeBtn.onclick=()=>{
      clearTimeout(panel._hideTimer);
      panel.classList.remove('show');
      routeFocusCells=[];
      render();
    };
  }
  highlightRoute(scoring[0],0,5200);
}


const REASON_POLL_MAX_ITEMS=8;
const REASON_POLL_FAST_MS=1200;
const REASON_POLL_SLOW_MS=2800;
// v81: reasonJobId 取得後の polling で使う変数が未定義だと、
// pendingReasonList() が ReferenceError で落ち、/reason-result を一度も叩けない。
// 画面は「理由解析待ち」のまま固まる。ブラウザAPI確認以前にここで止まっていた。
const REASON_POLL_GIVEUP_MS=45000;
const reasonPollFirstSeenAt=Object.create(null);
let reasonPollTimer=null;
let reasonPollHeartbeat=null;
let reasonPollInFlight=false;
let reasonWakeLock=null;
let lastReasonDisplayContext=null;
function candidateKeyFromText(text){return norm(String(text||'').split(/\s+/).filter(Boolean));}
function reasonJobStatusOf(r){
  return String(r?.reasonStatus || r?.status || '').toLowerCase();
}
function circledNumber(n){
  const nums=['','①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];
  return nums[n] || `(${n})`;
}
function isReasonPending(r){
  if(!r||!r.__reject) return false;
  if(rejectReasonText(r)) return false;
  const st=reasonJobStatusOf(r);
  if(['success','none','unavailable','failure','failed','error','missing','timeout','cancelled','canceled'].includes(st)) return false;
  // v82: polling is only for a real browser API job id.
  // A displayed candidate may be marked pending for a few ms before /reason-job-context returns.
  // Do not poll by text, because that can attach to stale jobs and keeps the UI looking stuck.
  if(!r.reasonJobId) return false;
  if(st && !['pending','running','queued','retry','retrying'].includes(st)) return false;
  return true;
}
function updateReasonJobStateForText(text, patch={}){
  const key=candidateKeyFromText(text);
  if(!key) return false;
  let changed=false;
  function apply(r){
    if(!r) return;
    for(const [k,v] of Object.entries(patch)){
      if(v===undefined) continue;
      if(r[k]!==v){ r[k]=v; changed=true; }
    }
  }
  // v101: キャッシュ更新なし。現在表示中の候補だけ更新する。
  for(const r of lastScanRejects||[]){
    if(candidateKeyFromText(r.text)===key) apply(r);
  }
  return changed;
}
function pendingReasonLabel(r){
  const st=reasonJobStatusOf(r);
  const role=String(r?.reasonQueueRole||r?.queueRole||'').toLowerCase();
  const at=Number(r?.reasonJobAttempts||r?.attempts||0);
  const retry=at>0 ? `（再試行${at}）` : '';
  const err=String(r?.reasonJobError||r?.error||'').toLowerCase();
  // v74/v82: queueIndex はAPIサーバ全体の待ち位置なので画面には出さない。
  if(st==='running' || role==='running') return `理由解析中…${retry}`;
  if(['pending','queued','retry','retrying'].includes(st) || role==='waiting'){
    return r?.reasonJobId ? `理由解析待ち${retry}` : `理由解析開始中…${retry}`;
  }
  if(st==='unavailable'){
    if(err.includes('hf_token') || err.includes('token') || err.includes('credits') || err.includes('quota')) return '理由解析不可（外部AIなし）';
    return '理由解析不可（補完候補なし）';
  }
  if(st==='missing') return '理由解析ジョブ不明（再実行なし）';
  if(st==='timeout') return '理由解析タイムアウト';
  if(['failure','failed','error'].includes(st)) return `理由解析失敗（補完候補なし）${retry}`;
  if(r?.reasonJobId) return `理由解析待ち${retry}`;
  // v82: 代表候補以外をいつまでも「解析中」に見せない。
  return 'API判定NG（代表候補のみ理由解析）';
}
function updateReasonForText(text, reasonExplain, status='success'){
  const key=candidateKeyFromText(text);
  if(!key||!reasonExplain) return false;
  let changed=false;
  function apply(r){
    if(!r) return;
    r.reasonExplain=reasonExplain;
    r.reason=reasonExplain.explanationJa || reasonExplain.explanationEn || r.reason || '';
    r.reasonSource=reasonExplain.method || 'hf-chat-reason-only';
    r.reasonStatus=status;
    changed=true;
  }
  // v101: キャッシュ更新なし。現在表示中の候補だけ更新する。
  let sample=null;
  for(const r of lastScanRejects||[]){
    if(candidateKeyFromText(r.text)===key){
      sample=sample||r;
      apply(r);
    }
  }
  // v101: 理由解析結果はキャッシュ保存しない。lastScanRejectsの表示だけ更新する。
  return changed;
}
function pendingReasonList(){
  // v70: reason poll は「今回の一手でAPIが返した reasonJobId」だけを見る。
  // v81: この関数はheartbeat/render経由で頻繁に呼ぶため、未定義変数等で例外を投げると
  // poll全体が止まる。必ず空配列へ倒してUIロック/待ち表示の永久化を避ける。
  try{
  // v74: さらに同一reasonJobIdだけに限定し、古いpending/queueIndex表示で増殖して見える状態を避ける。
  const rejects=[];
  for(const r of lastScanRejects||[]){
    if(isReasonPending(r) && r.reasonJobId){
      const id=String(r.reasonJobId||'');
      if(id && !reasonPollFirstSeenAt[id]) reasonPollFirstSeenAt[id]=Date.now();
      if(id && Date.now()-reasonPollFirstSeenAt[id] > REASON_POLL_GIVEUP_MS){
        r.reasonStatus='timeout';
        r.reasonJobError='reason polling timed out on client; not re-enqueued';
        continue;
      }
      rejects.push({...r,__reasonOrigin:'lastScan'});
    }
  }
  rejects.sort((a,b)=>{
    const ar=String(a.reasonQueueRole||a.queueRole||'').toLowerCase();
    const br=String(b.reasonQueueRole||b.queueRole||'').toLowerCase();
    const arank=ar==='running'?0:(ar==='waiting'?1:2);
    const brank=br==='running'?0:(br==='waiting'?1:2);
    if(arank!==brank) return arank-brank;
    const aq=Number(a.reasonQueueIndex??a.queueIndex??999999), bq=Number(b.reasonQueueIndex??b.queueIndex??999999);
    if(aq!==bq) return aq-bq;
    const ae=Number(a.reasonPriorityEpoch||0), be=Number(b.reasonPriorityEpoch||0);
    if(be!==ae) return be-ae;
    const as=Number(a.reasonPrioritySeq||999999), bs=Number(b.reasonPrioritySeq||999999);
    if(as!==bs) return as-bs;
    return String(a.text||'').localeCompare(String(b.text||''));
  });
  const uniq=[]; const seen=new Set();
  for(const r of rejects){
    const key=r.reasonJobId || candidateKeyFromText(r.text);
    if(seen.has(key)) continue;
    seen.add(key); uniq.push(r);
  }
  return uniq;
  }catch(e){
    console.warn('pendingReasonList failed', e);
    return [];
  }
}
function hasPendingReasons(){ return pendingReasonList().length>0; }
async function ensureReasonWakeLock(){
  try{
    if(!hasPendingReasons() || document.visibilityState==='hidden') return;
    if(reasonWakeLock) return;
    if(navigator.wakeLock && location.protocol==='https:'){
      reasonWakeLock=await navigator.wakeLock.request('screen');
      reasonWakeLock.addEventListener('release',()=>{reasonWakeLock=null;});
    }
  }catch(e){ reasonWakeLock=null; }
}
function releaseReasonWakeLockIfDone(){
  if(hasPendingReasons()) return;
  const wl=reasonWakeLock; reasonWakeLock=null;
  try{ wl?.release?.(); }catch(e){}
}
function startReasonHeartbeat(){
  if(reasonPollHeartbeat) return;
  reasonPollHeartbeat=setInterval(()=>{
    if(!hasPendingReasons()){
      clearInterval(reasonPollHeartbeat);
      reasonPollHeartbeat=null;
      releaseReasonWakeLockIfDone();
      return;
    }
    scheduleReasonPolling(0);
  }, REASON_POLL_SLOW_MS);
}
function scheduleReasonPolling(delay=1000){
  clearTimeout(reasonPollTimer);
  if(hasPendingReasons()){
    startReasonHeartbeat();
    ensureReasonWakeLock();
  }
  reasonPollTimer=setTimeout(()=>{
    reasonPollTimer=null;
    pollPendingReasons().catch(e=>console.warn('reason poll failed',e));
  },Math.max(0,delay));
}
async function pollPendingReasons(){
  if(reasonPollInFlight) return;
  if(!linkGrammarApi) return;
  const uniq=pendingReasonList();
  if(!uniq.length){ releaseReasonWakeLockIfDone(); return; }
  reasonPollInFlight=true;
  let changed=false;
  try{
  const base=linkGrammarApi.replace(/\/$/,'');
  for(const r of uniq.slice(0, REASON_POLL_MAX_ITEMS)){
    try{
      const qs=r.reasonJobId ? ('id='+encodeURIComponent(r.reasonJobId)) : ('text='+encodeURIComponent(r.text||''));
      const res=await fetch(base+'/reason-result?'+qs,{cache:'no-store'});
      if(!res.ok) continue;
      const data=await res.json();
      const targetText=data?.text || r.text || '';
      if(data?.status==='missing'){
        // v70: poll 側から /reason-job?text=... を呼ばない。
        // missing を見つけても新規ジョブを作らず、この一手の表示だけ更新する。
        changed = updateReasonJobStateForText(r.text || targetText, {
          reasonStatus:'missing',
          reasonJobId:r.reasonJobId || '',
          reasonJobError:'reason-result missing; not re-enqueued by client',
          reasonQueueRole:'',
          reasonQueueIndex:null,
          reasonQueueLabel:''
        }) || changed;
        continue;
      }
      if(data?.status==='success' && data.reasonExplain){
        changed = updateReasonForText(targetText, data.reasonExplain, 'success') || changed;
      }else if(data?.status){
        changed = updateReasonJobStateForText(targetText, {
          reasonStatus: data.status,
          reasonJobId: data.id || r.reasonJobId || '',
          reasonJobError: data.error || '',
          reasonJobAttempts: data.attempts || 0,
          reasonJobNextRetryAt: data.nextRetryAt || null,
          reasonPriorityEpoch: data.priorityEpoch || r.reasonPriorityEpoch || 0,
          reasonPrioritySeq: data.prioritySeq ?? r.reasonPrioritySeq ?? 0,
          reasonQueueRole: data.queueRole || '',
          reasonQueueIndex: data.queueIndex ?? null,
          reasonQueueLabel: data.queueLabel || '',
          reasonQueueRevision: data.queueRevision || 0,
          reasonRunningText: data.runningText || ''
        }) || changed;
      }
    }catch(e){
      console.warn('reason-result poll failed', e);
      changed = updateReasonJobStateForText(r.text || '', {
        reasonStatus:'error',
        reasonJobId:r.reasonJobId || '',
        reasonJobError:'browser fetch /reason-result failed: '+String(e?.message||e)
      }) || changed;
    }
  }
  } finally {
    reasonPollInFlight=false;
  }
  if(changed){
    if(lastReasonDisplayContext){
      const ctx={...lastReasonDisplayContext};
      const info=buildFailInfo(ctx.placeIndex,ctx.word);
      lastReasonDisplayContext={...ctx};
      const prefix=ctx.partial?'別候補NG：':'不成立理由：';
      setMsg(prefix+info.short, ctx.cls||'bad', {judge:true});
      if(!ctx.partial) schedulePostJudgeHandCompletionReason();
    }
    renderSafe();
  }
  const still=pendingReasonList();
  if(still.length) scheduleReasonPolling(changed ? REASON_POLL_FAST_MS : REASON_POLL_SLOW_MS);
  else releaseReasonWakeLockIfDone();
}

['visibilitychange','pageshow','focus','online','pointerdown','touchstart'].forEach(ev=>{
  window.addEventListener(ev,()=>{
    if(document.visibilityState!=='hidden' && hasPendingReasons()) scheduleReasonPolling(0);
  }, {passive:true});
});


function currentReasonHandWords(includeSelectedOnly=false, ctx=null){
  // v74: 不成立を出したプレイヤーの手札スナップショットを優先する。
  // 文法判定はせず、API理由探索へ渡す文脈だけ作る。
  const out=[];
  const ctxHand=Array.isArray(ctx?.handSnapshot)?ctx.handSnapshot:[];
  if(ctxHand.length) out.push(...ctxHand.map(String));
  const pFromCtx = Number.isInteger(ctx?.playerIndex) ? state.players[ctx.playerIndex] : null;
  const hp=(pFromCtx?.hand || currentPlayer()?.hand || []);
  if(includeSelectedOnly){
    if(selectedHandIndex>=0 && hp[selectedHandIndex]) out.push(String(hp[selectedHandIndex]));
  }else{
    out.push(...hp.map(String));
    if(selectedHandIndex>=0 && hp[selectedHandIndex]) out.push(String(hp[selectedHandIndex]));
  }
  if(activeJudgeWordForReason) out.push(String(activeJudgeWordForReason));
  return [...new Set(out.map(x=>String(x||'').trim()).filter(Boolean))];
}
function boardLineReasonTexts(placeIndex){
  // v70: lastScanRejects が古くなった/空になった場合でも、現在盤面から
  // 横・縦の連続列を直接作る。判定はAPIだけ。ここでは候補文を漏らさない。
  const out=[];
  function pushRun(run){
    if(run.length<2) return;
    for(let a=0;a<run.length;a++){
      for(let b=a+1;b<run.length;b++){
        const seg=run.slice(a,b+1);
        if(Number.isInteger(placeIndex) && !seg.some(s=>s.i===placeIndex)) continue;
        out.push(seg.map(s=>String(s.w||'')).join(' '));
      }
    }
  }
  for(let y=0;y<N;y++){
    let run=[];
    for(let x=0;x<N;x++){
      const i=idx(x,y), c=state.board[i];
      if(c&&c.w) run.push({i,w:c.w}); else {pushRun(run); run=[];}
    }
    pushRun(run);
  }
  for(let x=0;x<N;x++){
    let run=[];
    for(let y=0;y<N;y++){
      const i=idx(x,y), c=state.board[i];
      if(c&&c.w) run.push({i,w:c.w}); else {pushRun(run); run=[];}
    }
    pushRun(run);
  }
  return [...new Set(out.map(x=>String(x||'').trim()).filter(Boolean))];
}
let handCompletionInFlight=false;
let handCompletionLastKey='';
let handCompletionLastAt=0;
async function refreshFailReasonWithHandCandidates(opts={}){ return false; }
async function refreshFailReasonWithSelectedHand(){ return false; }
function schedulePostJudgeHandCompletionReason(){ return; }

function apiRejectReason(raw){
  const v=String(raw||'').trim();
  if(!v) return '';
  if(v==='link grammar parse failed') return '英文として解析できません';
  return v;
}
function rejectReasonText(r){
  const ex=r?.reasonExplain||null;
  const explained=String(ex?.explanationJa||ex?.explanationEn||'').trim();
  // v11: 学習者向けに表示してよいNG理由は reason-explain の成功結果だけ。
  // API raw reason/type/sentenceType（phrase, fragment, invalid, missing ...）は内部ラベルなので絶対に表示しない。
  return explained || '';
}

function bestRejectCandidates(placeIndex){
  const list=(lastScanRejects||[]).filter(r=>(r.cells||[]).includes(placeIndex));
  // v87: 成立0のときだけ、代表NG経路TOP1だけ理由解析する。
  // 2件目以降は処理しない。成立ありの場合は placeTile 側でNG経路を完全スキップする。
  return list.sort((a,b)=>(b.cells.length-a.cells.length)||(a.cells[0]-b.cells[0])).slice(0,1);
}
function routeRejectText(r){
  const text=String(r?.text||'').trim();
  const reason=rejectReasonText(r);
  if(text && reason) return `候補「${text}」：${reason}`;
  if(text) return `候補「${text}」 / API判定NG`;
  if(reason) return `API判定NG: ${reason}`;
  return '';
}

let displayedRejectReasonRequestKeys=new Set();
let displayedRejectReasonPlacementKeys=new Set();
function requestDisplayedRejectReason(r){
  // v74: 盤面スキャン中はreason jobを作らないが、画面に表示する表示中NG候補だけは
  // 1本だけ明示的に理由解析へ投げる。これは文のハードコードではなく、表示対象の1件だけを説明するため。
  try{
    if(!linkGrammarApi || !r) return false;
    const text=String(r.text||'').trim();
    if(!text || rejectReasonText(r) || r.reasonJobId) return false;
    const ctx=lastReasonDisplayContext;
    const hand=currentReasonHandWords(false, ctx);
    // v96: 理由補完に盤面全体の単語を渡すと、実際の経路に使えない離れたカードまで混ぜて
    // 離れたカードや補充手札まで混ぜた非プレイ可能候補を作る。
    // 表示中NG候補の説明では、盤面側の追加材料は使わせない（手札/山札だけ）。
    const board=[];
    const deck=[];
    try{ deck.push(...WORDS.map(x=>x.w)); }catch(e){}
    const placementKey=String(lastReasonDisplayContext?.placementId || lastReasonDisplayContext?.placeIndex || -1);
    const placementOnceKey='placement:'+placementKey;
    // v82: 実装コメントでは「表示対象1件だけ」なのに、buildFailInfo() の再描画ごとに
    // 次のNG候補を順番に job 化していた。結果として候補が増殖し、最後の1件だけ
    // 「理由解析中…」で残る。1配置につき代表1件だけに固定する。
    if(displayedRejectReasonPlacementKeys.has(placementOnceKey)) return false;
    const key=JSON.stringify({placement:placementKey, text});
    if(displayedRejectReasonRequestKeys.has(key)) return false;
    displayedRejectReasonRequestKeys.add(key);
    displayedRejectReasonPlacementKeys.add(placementOnceKey);
    // /check-and-translate は盤面スキャン中 reasonMode:none で呼ぶため、
    // 最初の表示時点では reasonStatus/jobId が空になる。
    // この表示対象だけは今からジョブ化するので、即座に pending にして
    // 『詳細理由未取得』のまま表示しない。
    updateReasonJobStateForText(text, {
      reasonStatus:'pending',
      reasonQueueRole:'waiting',
      reasonQueueIndex:null,
      reasonQueueLabel:'理由解析待ち'
    });
    setTimeout(async()=>{
      try{
        const base=linkGrammarApi.replace(/\/$/,'');
        const qs=new URLSearchParams();
        qs.set('text', text);
        if(hand.length) qs.set('hand', hand.join(','));
        if(board.length) qs.set('board', board.join(','));
        if(deck.length) qs.set('deck', deck.join(','));
        try{
          const baseWords=String(text||'').trim().split(/\s+/).filter(Boolean);
          const allMetaWords=[...new Set([...baseWords,...hand,...board,...deck].map(String))];
          qs.set('wordMetaMap', JSON.stringify(wordMetaForApi(allMetaWords)));
        }catch(e){}
        if(r.reasonPriorityEpoch) qs.set('reasonPriorityEpoch', String(r.reasonPriorityEpoch));
        if(r.reasonPrioritySeq!==undefined) qs.set('reasonPrioritySeq', String(r.reasonPrioritySeq));
        // v95: 理由補完候補も採点と同じAPIゲートで検証させる。
        // Link Grammarだけで通った変な補完（例: I am Japanese need）を説明として出さない。
        qs.set('strictGameGate','1');
        qs.set('acceptabilityModelGate','1');
        const res=await fetch(base+'/reason-job-context?'+qs.toString(), {cache:'no-store'});
        if(!res.ok) throw new Error('HTTP '+res.status);
        const data=await res.json();
        updateReasonJobStateForText(text, {
          reasonStatus:data.status || 'pending',
          reasonJobId:data.id || '',
          reasonQueueRole:data.queueRole || '',
          reasonQueueIndex:data.queueIndex ?? null,
          reasonQueueLabel:data.queueLabel || '',
          reasonQueueRevision:data.queueRevision || 0,
          reasonPriorityEpoch:data.priorityEpoch || 0,
          reasonPrioritySeq:data.prioritySeq || 0
        });
            try{
          const rid=String(data?.id||'');
          if(rid){
            addLog(`ブラウザAPI確認: ${base}/reason-result?id=${encodeURIComponent(rid)}`, true);
            addLog(`理由キュー確認: ${base}/reason-queue`, true);
          }
        }catch(e){}
        if(data?.reasonExplain){
          updateReasonForText(text, data.reasonExplain, data.status || 'success');
        }
        scheduleReasonPolling(0);
        renderSafe();
        if(lastReasonDisplayContext){
          const c={...lastReasonDisplayContext};
          const info=buildFailInfo(c.placeIndex,c.word);
          setMsg((c.partial?'別候補NG：':'不成立理由：')+info.short, c.cls||'bad', {judge:true});
        }
      }catch(e){
        console.warn('displayed reject reason request failed', e);
        updateReasonJobStateForText(text, {reasonStatus:'unavailable', reasonJobError:String(e?.message||e)});
        renderSafe();
        if(lastReasonDisplayContext){
          const c={...lastReasonDisplayContext};
          const info=buildFailInfo(c.placeIndex,c.word);
          setMsg((c.partial?'別候補NG：':'不成立理由：')+info.short, c.cls||'bad', {judge:true});
        }
      }
    }, 0);
    return true;
  }catch(e){ console.warn('requestDisplayedRejectReason failed', e); return false; }
}

function buildFailInfo(placeIndex, word, successes=[]){
  { 
    const prev=lastReasonDisplayContext||{};
    const same=prev && prev.placeIndex===placeIndex && String(prev.word||'')===String(word||'');
    const pi=same && Number.isInteger(prev.playerIndex) ? prev.playerIndex : (state.turn%state.playerCount);
    const hp=(same && Array.isArray(prev.handSnapshot) && prev.handSnapshot.length) ? prev.handSnapshot.map(String) : ((state.players[pi]?.hand||[]).map(String));
    const placementId=same && prev.placementId ? prev.placementId : (Date.now().toString(36)+'-'+String(placeIndex));
    lastReasonDisplayContext={...prev,placeIndex,word,partial:false,cls:'bad',playerIndex:pi,handSnapshot:hp,placementId};
  }
  const successCellSets=(successes||[]).map(m=>new Set(m.cells||[]));
  const rejects=bestRejectCandidates(placeIndex).filter(r=>{
    const rcells=r.cells||[];
    // v33: 成立した長い経路に完全包含される短いNG候補は、成功時の別候補NGとして出さない。
    // 例: I am happy 成立時に、部分経路 Am happy の探索理由「happy Am」を表示しない。
    return !successCellSets.some(ss=>rcells.length>0 && rcells.every(i=>ss.has(i)));
  });
  const items=rejects.map(r=>{
    const text=String(r?.text||'候補なし').trim();
    let reason=rejectReasonText(r);
    if(!reason){
      reason=pendingReasonLabel(r);
    }
    return {text,reason};
  });
  // v74: 詳細理由未取得のまま放置しない。表示対象の表示中NG候補だけ、1本だけ明示reason job化する。
  try{
    const firstNeedReason=rejects.find(r=>String(r?.text||'').trim() && !rejectReasonText(r) && !r.reasonJobId);
    if(firstNeedReason) requestDisplayedRejectReason(firstNeedReason);
  }catch(e){}
  // v87: 不成立時だけ代表NG TOP1を表示・理由解析する。2件目以降は処理しない。
  const displayItems=items.slice(0,1);
  const moreCount=Math.max(0,items.length-displayItems.length);
  const short = displayItems.length
    ? `API判定NG候補：` + displayItems.map(it=>`「${it.text}」：${it.reason || '理由解析開始中…'}`).join(' / ') + (moreCount?` / 他${moreCount}件`:``)
    : `今回置いた「${word}」を含む直線候補はAPI判定NG（理由解析開始中…）`;
  const lines=[];
  if(items.length){
    lines.push(...items.map(it=>`候補: <b>${esc(it.text)}</b>${it.reason?`：${esc(it.reason)}`:''}`));
  }else{
    lines.push('API判定NG。具体的な学習者向け理由は reason-explain 成功時だけ表示します。');
  }
  return {short, detail:lines.join('<br>'), example:'', rejects};
}
function showFailDetails(info, cellIndex, opts={}){
  const partial=!!opts.partial;
  failFocusCell=cellIndex;
  clearTimeout(failFocusTimer);
  failFocusTimer=setTimeout(()=>{failFocusCell=-1;render();},3900);
  // ポップアップ式の不成立理由パネルは使わない。理由は上部メッセージ欄とログだけに出す。
  const cell=document.querySelectorAll('.cell')[cellIndex];
  let x=innerWidth/2,y=innerHeight/2;
  if(cell){const r=cell.getBoundingClientRect();x=r.left+r.width/2;y=r.top+r.height/2;}
  if(!partial){
    const pop=document.createElement('div');pop.className='badPop';pop.style.left=x+'px';pop.style.top=y+'px';pop.innerHTML=`NO!<small>不成立</small>`;document.body.appendChild(pop);setTimeout(()=>pop.remove(),1250);
    for(let i=0;i<14;i++){const sp=document.createElement('i');sp.className='badSpark';sp.style.left=x+'px';sp.style.top=y+'px';const a=Math.random()*Math.PI*2,d=24+Math.random()*58;sp.style.setProperty('--dx',Math.cos(a)*d+'px');sp.style.setProperty('--dy',Math.sin(a)*d+'px');document.body.appendChild(sp);setTimeout(()=>sp.remove(),850);}
  }
}


function longestLineTextIncludingCell(placeIndex){
  const opts=[];
  const pxy=xy(placeIndex);
  function collect(dx,dy,label){
    const cells=[];
    let x=pxy.x, y=pxy.y;
    while(x-dx>=0 && y-dy>=0 && x-dx<N && y-dy<N && state.board[idx(x-dx,y-dy)]?.w){ x-=dx; y-=dy; }
    while(x>=0 && y>=0 && x<N && y<N && state.board[idx(x,y)]?.w){
      const i=idx(x,y); cells.push({i,w:state.board[i].w}); x+=dx; y+=dy;
    }
    if(cells.some(c=>c.i===placeIndex)) opts.push({label,cells,text:displayEnglish(cells.map(c=>c.w))});
  }
  collect(1,0,'横');
  collect(0,1,'縦');
  opts.sort((a,b)=>(b.cells.length-a.cells.length)||(a.cells[0].i-b.cells[0].i));
  return opts[0]?.text || String(state.board[placeIndex]?.w || '').trim();
}
function completionHandWordsForPlayer(playerIndex){
  const arr=[];
  try{ arr.push(...((state.players[playerIndex]?.hand)||[])); }catch(e){}
  try{ if(activeJudgeWordForReason) arr.push(String(activeJudgeWordForReason)); }catch(e){}
  return [...new Set(arr.map(x=>String(x||'').trim()).filter(Boolean))];
}
function buildCompletionProbeItems(baseText, handWords){
  const base=String(baseText||'').trim().replace(/[.!?]$/,'');
  const baseWords=base.split(/\s+/).filter(Boolean);
  const hand=[...new Set((handWords||[]).map(x=>String(x||'').trim()).filter(Boolean))];
  const items=[]; const seen=new Set();
  function add(words, how, used){
    const text=displayEnglish(words).replace(/[.!?]$/,'');
    const k=text.toLowerCase();
    if(!text || seen.has(k)) return;
    seen.add(k);
    items.push({id:String(items.length), text, words, wordMeta:wordMetaForApi(words), completionHow:how, completionUsed:used});
  }
  if(!baseWords.length) return items;
  for(const a of hand) add([...baseWords,a], 'add-right-1', [a]);
  for(const a of hand){
    for(const b of hand){
      if(a.toLowerCase()===b.toLowerCase()) continue;
      add([...baseWords,a,b], 'add-right-2', [a,b]);
    }
  }
  return items.slice(0,72);
}
async function findContinuationCandidate(placeIndex, word){
  const playerIndex=state.turn%state.playerCount;
  const topReject=bestRejectCandidates(placeIndex)[0] || null;
  const baseText=String(topReject?.text || longestLineTextIncludingCell(placeIndex) || word || '').trim().replace(/[.!?]$/,'');
  const baseWords=baseText.split(/\s+/).filter(Boolean);
  if(!baseWords.length) return null;
  // v89: 1〜2語の作りかけは、補完候補APIを待たず即「採点前」にする。
  // v88 は I / I like の直後にも completion probe のAPI batchを待っていたため、
  // 盤面が「判定中…操作ロック中」で長時間止まって見えた。
  // すでに scanFromCell() で成立0は確認済みなので、短い断片は罰点化せず即ロック解除する。
  if(baseWords.length < 3){
    return {baseText, text:'', used:[], status:'partial-short-no-block'};
  }
  const hand=completionHandWordsForPlayer(playerIndex);
  if(!hand.length){
    return null;
  }
  const items=buildCompletionProbeItems(baseText, hand);
  if(!items.length){
    if(baseWords.length<3) return {baseText, text:'', used:[], status:'partial-no-items'};
    return null;
  }
  if(!linkGrammarApi){
    return baseWords.length<3 ? {baseText, text:'', used:[], status:'partial-api-off'} : null;
  }
  try{
    const base=linkGrammarApi.replace(/\/$/,'');
    const rows=await batchApiCheckItems(base,items,Date.now());
    for(let i=0;i<items.length;i++){
      const ev=evFromApiResult(rows[i],items[i].words);
      if(ev){
        return {baseText, text:ev.text || items[i].text, ja:ev.ja || rows[i]?.ja || '', used:items[i].completionUsed || [], status:'verified', ev};
      }
    }
  }catch(e){
    console.warn('continuation probe failed', e);
    // APIが一時的に失敗しただけで、短い作りかけを罰点化しない。
    if(baseWords.length<3) return {baseText, text:'', used:[], status:'probe-error'};
  }
  return null;
}
function continuationMessage(c){
  if(!c) return '';
  if(c.text && c.used?.length){
    return `採点前：「${c.baseText}」はまだ作りかけです。手札の「${c.used.join('」「')}」を続けると候補「${c.text}」になります。`;
  }
  return `採点前：「${c.baseText}」はまだ作りかけです。続けて単語を置いてください。`;
}

let placementJudgeBusy=false;
let placementJudgeSeq=0;
async function placeTile(cellIndex){
  // v14: 判定中に次のカードを置かせない。
  // 連打で複数の scan/check-and-translate が並走すると、古い判定結果が後から戻って
  // 新しい盤面へ上書きされ、gameOk:true の文まで NG/pending に見える。
  if(placementJudgeBusy){
    setMsg('判定中…。結果が出てから次のカードを置いてください。','info');
    return;
  }
  if(selectedHandIndex<0){setMsg('先に手札を選んで！','bad');return;}
  if(state.board[cellIndex]){setMsg('そこは埋まってる','bad');return;}
  const p=currentPlayer();
  const word=p.hand[selectedHandIndex];
  if(!word){setMsg('その手札は空','bad');return;}
  activeJudgeWordForReason=String(word||'');
  displayedRejectReasonRequestKeys=new Set();
  displayedRejectReasonPlacementKeys=new Set();
  placementJudgeBusy=true;
  const myJudgeSeq=++placementJudgeSeq;
  // v84: 判定中の配置はまだ確定ではないため、タイムアウト時に必ずロールバックできるようスナップショットを保持する。
  // v76はロック解除だけ行い、盤面/手札の仮変更を残したため、採点前カードが盤面に残ってゲーム状態が壊れた。
  const placementSnapshot={
    cellIndex,
    handIndex:selectedHandIndex,
    word,
    prevCell: state.board[cellIndex] ? JSON.parse(JSON.stringify(state.board[cellIndex])) : null,
    prevHandWord: word,
    prevSelectedHandIndex:selectedHandIndex,
    turn:state.turn,
    turnNo:state.turnNo,
    wordsMade:state.wordsMade,
    scores:state.players.map(p=>p.score),
    tiles:state.players.map(p=>p.tiles),
    lastJudgeMsg:state.lastJudgeMsg||'',
    lastJudgeClass:state.lastJudgeClass||'info',
    scoredRouteKeys:Array.isArray(state.scoredRouteKeys)?state.scoredRouteKeys.slice():[]
  };
  function rollbackTimedOutPlacement(reasonText){
    try{
      const snap=placementSnapshot;
      if(!snap || state.turn!==snap.turn) return false;
      state.board[snap.cellIndex]=snap.prevCell;
      if(state.players[snap.turn%state.playerCount] && snap.handIndex>=0){
        state.players[snap.turn%state.playerCount].hand[snap.handIndex]=snap.prevHandWord;
      }
      state.turn=snap.turn;
      state.turnNo=snap.turnNo;
      state.wordsMade=snap.wordsMade;
      state.scoredRouteKeys=Array.isArray(snap.scoredRouteKeys)?snap.scoredRouteKeys.slice():[];
      state.players.forEach((pl,i)=>{ if(Number.isFinite(snap.scores[i])) pl.score=snap.scores[i]; if(Number.isFinite(snap.tiles[i])) pl.tiles=snap.tiles[i]; });
      recentCells=[];
      routeFocusCells=[];
      failFocusCell=-1;
      selectedHandIndex=-1;
      activeJudgeWordForReason='';
      lastScanRejects=[];
      lastReasonDisplayContext=null;
      clearResultOverlays();
      setMsg(reasonText || '判定タイムアウト。仮配置を取り消しました。APIのhealthを確認してから、もう一度置いてください。','bad',{judge:true});
      recalcTiles();
      return true;
    }catch(e){
      console.warn('rollbackTimedOutPlacement failed', e);
      return false;
    }
  }
  // v106: combo judgement timeout removed.
  // Do not advance placementJudgeSeq or rollback after 30s; wait for the API result and score all returned combos.
  let placementTimedOut=false;
  let placementLockTimer=null;
  // v93: 新しい配置を始めたら、前回の成立コンボ/画像/経路ハイライトを必ず閉じる。
  // 採点前やNGになった時に古いGOOD表示が残って矛盾しないようにする。
  clearResultOverlays();
  state.board[cellIndex]={w:word,owner:state.turn%state.playerCount,baseOwner:state.turn%state.playerCount,at:Date.now(),useCount:0,unusedPenaltyApplied:false};
  p.hand[selectedHandIndex]=drawOneForSlot(selectedHandIndex);
  if(Array.isArray(p.handMeta)) p.handMeta[selectedHandIndex]=null;
  // 種類別固定スロットなのでソートしない。各枠を維持する。
  setMsg('API一括判定中…。候補をまとめて確認しています。','info');
  render();
  let made=[];
  try{
    made=await scanFromCell(cellIndex);
  }catch(e){
    console.warn('scanFromCell failed',e);
    made=[];
  }
  // v14: 万一、古い非同期判定が後から戻ってきても画面・点数へ反映しない。
  if(myJudgeSeq!==placementJudgeSeq){
    console.warn('stale placeTile result ignored', {myJudgeSeq, placementJudgeSeq, placementTimedOut});
    try{ clearTimeout(placementLockTimer); }catch(e){}
    // v84: timeout後に古いAPI結果が返ってきても、点数・ターン・盤面へ絶対反映しない。
    // タイムアウト時点でrollback済みだが、未実行ならここでも保険で取り消す。
    if(placementTimedOut) rollbackTimedOutPlacement('古い判定結果を破棄しました。仮配置は取り消し済みです。');
    placementJudgeBusy=false;
    render();
    return;
  }
  recentCells=[cellIndex]; routeFocusCells=[];
  let gained=1;
  if(made.length){
    failFocusCell=-1;
    let scoring=selectScoringMatches(made).filter(m=>!scoredRouteSet().has(routeScoreKey(m)));
    if(!scoring.length){
      made=[];
    }else{
    await hydrateJapaneseForMatches(scoring);
    const {groups,comboInfo}=summarizeScoring(scoring);
    const useDelta=new Map();
    for(const m of scoring){
      gained += m.pts;
      state.wordsMade++;
      m.cells.forEach(i=>{
        useDelta.set(i,(useDelta.get(i)||0)+1);
        if(!recentCells.includes(i)) recentCells.push(i);
      });
    }
    if(comboInfo){
      gained += comboInfo.bonus;
    }
    for(const g of groups){
      const suffix=g.count>1?` COMBO×${g.count}（${g.count}経路）`:'';
      addLog(`${p.name}: ${g.text}${suffix} / ${g.ja}（${g.kind}） +${g.pts}${g.count>1?` +コンボ${(g.count-1)*18}`:''}`,true);
      g.routes.forEach((r,ri)=>addLog(`　経路${ri+1}: ${r.dir||'経路'} ${routeText(r)}`,true));
    }
    useDelta.forEach((delta,i)=>{
      const cell=state.board[i];
      if(cell){
        cell.owner=state.turn%state.playerCount;
        cell.useCount=useCountOf(cell)+delta;
        cell.unusedPenaltyApplied=false;
      }
    });
    if(comboInfo){
      const label = comboInfo.mode==='multi' ? `${comboInfo.count}文コンボ` : `COMBO×${comboInfo.count}`;
      setMsg(`${label}！ ${comboInfo.text} +${gained}`,'good');
    }else{
      setMsg(`${scoring[0].text} 成立！ ${scoring[0].ja} +${gained}`,'good');
    }
    playChime(true);
    showFx(scoring,gained,cellIndex,comboInfo);
    showComboDetails(scoring,comboInfo);
    showSentenceGeneratedImage(scoring);
    speakResultsSequential(scoring);
    // v87: 成立が1件以上ある場合、NG経路は完全に無視する。
    // 成功時に別NG候補を表示/理由解析すると、成功と失敗が混ざってゲームが崩壊して見えるため。
    lastScanRejects=[];
    lastReasonDisplayContext=null;
    rememberScoredRoutes(scoring);
    }
  }
  if(!made.length){
    // v88: 成立0でも即NG/罰点にしない。
    // まず「手札を1〜2枚続ければ英文として成立する作りかけ」かを、API batchで軽く確認する。
    // 例: I / I like / I am は採点前として盤面に残し、罰点なし。完全NGの時だけTOP1理由解析と罰点。
    // v90: 成立0の後続可能チェックでAPIを待たない。
    // v88/v89 は findContinuationCandidate() が3語以上で completion batch API を待つため、
    // その間 placementJudgeBusy=true のままになり、盤面が止まって見えた。
    // 操作ロック中に行うのは成立判定まで。成立0なら短い断片は即「採点前」、長いものだけTOP1 NGへ進む。
    const __baseTextForPartial=String((bestRejectCandidates(cellIndex)[0]?.text) || longestLineTextIncludingCell(cellIndex) || word || '').trim().replace(/[.!?]$/,'');
    const __baseWordsForPartial=__baseTextForPartial.split(/\s+/).filter(Boolean);
    // v92: 3語は完成文が多い（I am happy / I like apples / I am interesting）。
    // v90 の <=3 採点前扱いは広すぎて、成立判定が少しでも漏れた時に完成文まで
    // 『まだ作りかけ』と嘘表示した。即時採点前に倒すのは 1〜2語だけに限定する。
    const continuation=(__baseWordsForPartial.length>0 && __baseWordsForPartial.length<=2)
      ? {baseText:__baseTextForPartial, text:'', used:[], status:'partial-fast-no-lock-v92-len2-only'}
      : null;
    if(continuation){
      gained=0;
      const cell=state.board[cellIndex];
      if(cell){ cell.unusedPenaltyApplied=false; cell.pendingSentence=true; }
      lastScanRejects=[];
      lastReasonDisplayContext=null;
      const msg=continuationMessage(continuation);
      addLog(`${p.name}: ${word} を配置。採点前：${continuation.text || continuation.baseText}（罰点なし）`,true);
      setMsg(msg,'info',{judge:true});
      clearResultOverlays();
    }else{
      gained = -UNUSED_PENALTY;
      const cell=state.board[cellIndex];
      if(cell){ cell.unusedPenaltyApplied=true; cell.pendingSentence=false; }
      const failInfo=buildFailInfo(cellIndex, word);
      addLog(`${p.name}: ${word} を配置。不成立：${failInfo.short} -${UNUSED_PENALTY}`,false);
      (failInfo.rejects||[]).slice(0,1).forEach(r=>{
        const meta=rejectReasonText(r)||pendingReasonLabel(r);
        addLog(`理由: ${r.text||'候補なし'}${meta?`：${meta}`:''}`,false);
      });
      setMsg(`不成立理由：${failInfo.short}　-${UNUSED_PENALTY}`,'bad',{judge:true});
      schedulePostJudgeHandCompletionReason();
      playChime(false);
      showFailDetails(failInfo, cellIndex);
      scheduleReasonPolling(600);
      clearResultOverlays();
    }
  }
  p.score+=gained;
  recalcTiles();
  nextTurn();
  selectedHandIndex=-1;
  // v90: ここより下の broadcast/render/setMsg で例外が出ても操作ロックを残さない。
  // selectable 表示もこの後の render で正しく出るよう、描画前にbusyを解除する。
  try{ clearTimeout(placementLockTimer); }catch(e){}
  placementJudgeBusy=false;
  try{
    broadcast({type:'englishPlace',gameId:state.gameId,state:lightState(),cellIndex,by:clientId});
  }catch(e){ console.warn('broadcast after place failed', e); }
  render();
  if(state.lastJudgeMsg){setMsg(state.lastJudgeMsg,state.lastJudgeClass||'info');}
  // v74: クライアント側で補完文を合成しない。
  if(lastReasonDisplayContext && !lastReasonDisplayContext.partial){
    schedulePostJudgeHandCompletionReason();
  }
}

function thirdPersonFormOf(word){
  const w=String(word||'').trim();
  const k=w.toLowerCase();
  if(!w) return '';
  if(THIRD_PERSON_BASE_TO_S[k]) return THIRD_PERSON_BASE_TO_S[k];
  const ps=wordPos(w);
  if(!(ps.includes('verb') || ps.includes('verbWant') || ps.includes('be'))) return '';
  if(/[^a-z]/i.test(w)) return '';
  if(/[sxz]$|ch$|sh$/i.test(w)) return w+'es';
  if(/[^aeiou]y$/i.test(w)) return w.slice(0,-1)+'ies';
  return w+'s';
}
function toggleSelectedThirdPerson(){
  if(placementJudgeBusy){setMsg('判定中…。結果が出てから手札を変化してください。','info');return;}
  const p=currentPlayer();
  if(!p){return;}
  if(selectedHandIndex<0){setMsg('先に変化したい手札を選んで！','bad');return;}
  const i=selectedHandIndex;
  const w=String(p.hand?.[i]||'').trim();
  if(!w){setMsg('その手札は空','bad');return;}
  if(!Array.isArray(p.handMeta)) p.handMeta=[];
  const meta=p.handMeta[i]||null;
  if(meta && meta.thirdOriginal && String(meta.thirdWord||'').toLowerCase()===w.toLowerCase()){
    p.hand[i]=meta.thirdOriginal;
    p.handMeta[i]=null;
    setMsg(`手札を戻した：${w} → ${p.hand[i]}`,'good');
    render();
    broadcast({type:'englishState',gameId:state.gameId,state:lightState(),reason:'third-person-restore'});
    return;
  }
  const reverted=THIRD_PERSON_S_TO_BASE[w.toLowerCase()];
  if(reverted && !meta){
    p.hand[i]=reverted;
    setMsg(`3単現を戻した：${w} → ${reverted}`,'good');
    render();
    broadcast({type:'englishState',gameId:state.gameId,state:lightState(),reason:'third-person-restore'});
    return;
  }
  const next=thirdPersonFormOf(w);
  if(!next || next.toLowerCase()===w.toLowerCase()){
    setMsg('3単現にできる動詞カードを選んで！','bad');
    return;
  }
  p.hand[i]=next;
  p.handMeta[i]={thirdOriginal:w, thirdWord:next};
  setMsg(`3単現に変化：${w} → ${next}`,'good');
  render();
  broadcast({type:'englishState',gameId:state.gameId,state:lightState(),reason:'third-person-toggle'});
}

function drawOne(){return WORDS[Math.floor(Math.random()*WORDS.length)].w}
function nextTurn(){state.turn=(state.turn+1)%state.playerCount;state.turnNo++;}
function recalcTiles(){state.players.forEach(p=>p.tiles=0);state.board.forEach(c=>{if(c&&state.players[c.owner])state.players[c.owner].tiles++;});}
function lightState(){return JSON.parse(JSON.stringify(state));}
function applyState(s,why='同期'){
  if(!s||!Array.isArray(s.board)||!Array.isArray(s.players))return;
  state=s;if(!Array.isArray(state.scoredRouteKeys))state.scoredRouteKeys=[];selectedHandIndex=-1;recentCells=[];failFocusCell=-1;recalcTiles();setMsg(why,'good');render();
}
function passTurn(){const p=currentPlayer();addLog(`${p.name}: パス`,false);nextTurn();broadcast({type:'englishState',gameId:state.gameId,state:lightState(),reason:'pass'});render();}
function swapHand(){const p=currentPlayer();p.hand=drawHand(99);p.handMeta=[];p.score=Math.max(0,p.score-5);addLog(`${p.name}: 手札入替 -5`,false);nextTurn();broadcast({type:'englishState',gameId:state.gameId,state:lightState(),reason:'swap'});render();}
function newGame(broadcastIt=true){clearEnglishJudgeCache();displayedRejectReasonRequestKeys=new Set();displayedRejectReasonPlacementKeys=new Set();const pc=Number($('playerCount').value)||2;state=freshState(pc);const name=safeName();state.players[0].name=name;localStorage.englishName=name;selectedHandIndex=-1;recentCells=[];failFocusCell=-1; if(broadcastIt)broadcast({type:'englishNewGame',gameId:state.gameId,state:lightState()});render();setMsg(state.playerCount===1?'1人練習開始。手札は種類別に常備。英文を作ると英語→日本語で読み上げる':'新規ゲーム開始。手札は種類別に常備。','good');}
function render(){
  $('turnNo').textContent=state.turnNo;$('wordsMade').textContent=state.wordsMade;$('filledNo').textContent=state.board.filter(Boolean).length;$('roomNo').textContent='english';$('myId').textContent=clientId;
  const tp=currentPlayer();$('turnPlayer').textContent=tp?tp.name:'-';$('turnPlayer').style.color=tp?tp.color:'#fff';
  const b=$('board');b.innerHTML='';state.board.forEach((c,i)=>{const d=document.createElement('button');d.className='cell '+(!c?'empty ':'')+(recentCells.includes(i)?'recent hit ':'');d.type='button';const routeNo=routeFocusCells.indexOf(i);if(routeNo>=0)d.classList.add('routeHit');if(i===failFocusCell)d.classList.add('failFocus');if(!c&&selectedHandIndex>=0&&!placementJudgeBusy)d.classList.add('selectable');if(c){const ownerColor=state.players[c.owner]?.color||'#fff';const cnt=useCountOf(c);const uc=useColor(cnt, ownerColor);if(uc.rainbow)d.classList.add('rainbow');if(cnt<=0)d.classList.add('unused');const usedLabel=cnt>0?`×${cnt}`:'前';d.innerHTML=`<span class="owner" style="background:${ownerColor}"></span>${routeNo>=0?`<span class="routeStep">${routeNo+1}</span>`:''}<span class="word">${esc(c.w)}</span><span class="useCount">${usedLabel}</span>${cnt<=0?'<span class="unusedMark">採点前</span>':''}<span class="pts">P${(c.owner||0)+1}</span>`;d.style.background=`linear-gradient(180deg, ${uc.bg}, ${hexAlpha(ownerColor,.13)}, rgba(255,255,255,.05))`;d.style.borderColor=uc.border;d.style.color=uc.text;} d.onclick=()=>placeTile(i);b.appendChild(d);});
  const h=$('hand');h.innerHTML='';(tp?.hand||[]).forEach((w,i)=>{const pos=handInfo(w);const t=document.createElement('button');t.type='button';t.className='tile cat-'+pos.key+' '+(i===selectedHandIndex?'on':'');t.innerHTML=`<span>${esc(w)}</span><small>${esc(displayHandLabel(w))}</small>`;t.onclick=()=>{if(placementJudgeBusy){setMsg('判定中…。成立確定ではありません。結果が出るまで操作ロック中。','info');return;}selectedHandIndex=i;render();refreshFailReasonWithSelectedHand();};h.appendChild(t);});
  $('selectedInfo').textContent=selectedHandIndex>=0?`選択: ${(tp.hand||[])[selectedHandIndex]}${(tp.handMeta&&tp.handMeta[selectedHandIndex])?'（3単現）':''}`:'未選択';
  const ps=$('players');ps.innerHTML='';state.players.forEach((p,i)=>{const row=document.createElement('div');row.className='player '+(i===state.turn?'current':'');row.innerHTML=`<span class="dot" style="background:${p.color}"></span><span class="pname">${esc(p.name)} <small>陣地${p.tiles||0}</small></span><span class="pscore">${p.score}</span>`;ps.appendChild(row);});
  const log=$('log');log.innerHTML='';state.log.forEach(x=>{const div=document.createElement('div');div.className='logItem';div.innerHTML=`<span class="${x.good?'goodText':'badText'}">●</span> ${esc(x.text)}`;log.appendChild(div);});
  $('targetList').innerHTML=`<span class="chip">StrictLG:${esc(linkGrammarStatus)}</span><span class="chip">判定:StrictLG+LT API</span><span class="chip">今回置いたカード必須</span><span class="chip">画像は成立後のみ</span>`+targets.slice(0,10).map(t=>`<span class="chip">${esc(t)}</span>`).join('');
  {const m=$('msg'); if(m){
    let t=state.statusText||''; let c=state.statusClass||'info';
    const generic=/成立なし|つなげ方/.test(t);
    if((!t||generic) && state.lastJudgeMsg){t=state.lastJudgeMsg;c=state.lastJudgeClass||'bad';}
    if(!t) t='単語タイルを選んで空きマスに置く';
    m.textContent=t; m.className='msg '+c;
  }}
}
function esc(s){return String(s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}
function hexAlpha(hex,a){const h=hex.replace('#','');const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);return `rgba(${r},${g},${b},${a})`;}
function setMp(text,cls){$('mp').textContent=text;$('mp').className=cls;}
function broadcast(obj){
  if(suppressBroadcast) return false;
  if(!socket||socket.readyState!==WebSocket.OPEN) return false;
  try{obj.clientId=clientId;obj.name=safeName();obj.time=Date.now();socket.send(JSON.stringify(obj));return true;}catch(e){return false;}
}
function connect(){
  if(socket&&(socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CONNECTING))return;
  clearTimeout(retryTimer);clearInterval(heartbeat);setMp('CONNECTING','info');
  socket=new WebSocket(WS_URL);
  socket.addEventListener('open',()=>{setMp('ONLINE','good');setMsg('オンライン接続成功。同じURLの人と同期','good');broadcast({type:'join',x:0,y:0,z:0,yaw:0,pitch:0});broadcast({type:'englishHello',wantState:true,gameId:state.gameId});heartbeat=setInterval(()=>broadcast({type:'ping'}),10000);});
  socket.addEventListener('message',ev=>{rx++;$('rx').textContent=rx;handleNet(ev.data);});
  socket.addEventListener('close',()=>{clearInterval(heartbeat);setMp('RETRY','bad');retryTimer=setTimeout(connect,3000);});
  socket.addEventListener('error',()=>setMp('ERROR','bad'));
}
function parse(raw){try{return JSON.parse(raw)}catch{return null}}
function eachPayload(msg,cb,depth=0){if(!msg||depth>3)return;if(typeof msg==='string'){eachPayload(parse(msg),cb,depth+1);return;}if(Array.isArray(msg)){msg.forEach(x=>eachPayload(x,cb,depth+1));return;}cb(msg);['payload','data','message','state'].forEach(k=>{if(msg[k]&&msg[k]!==msg)eachPayload(msg[k],cb,depth+1);});}
function handleNet(raw){eachPayload(raw,(msg)=>{
  if(!msg||msg.clientId===clientId)return;
  if(msg.type==='englishHello'&&msg.wantState){broadcast({type:'englishState',gameId:state.gameId,state:lightState(),reason:'hello-sync'});return;}
  if(msg.type==='englishNewGame'&&msg.state){applyState(msg.state,'相手が新規ゲーム開始');return;}
  if((msg.type==='englishState'||msg.type==='englishPlace')&&msg.state){
    const incomingTurn=Number(msg.state.turnNo)||0;
    if(msg.state.gameId!==state.gameId || incomingTurn>=state.turnNo){applyState(msg.state,'オンライン同期');}
  }
});}

// v70: persistent hand completion polling removed. Reason polling must not enqueue extra jobs.
$('startBtn').onclick=()=>{clearEnglishJudgeCache();try{unlockSpeech();}catch(e){console.warn('unlockSpeech unavailable',e);}$('start').style.display='none';render();checkReasonApiHealth('ブラウザAPI確認');};
$('connectBtn').onclick=()=>{try{unlockSpeech();}catch(e){console.warn('unlockSpeech unavailable',e);}connect();};
$('newGameBtn').onclick=()=>newGame(true);
$('resetBtn').onclick=()=>{if(confirm('盤面をリセットしてオンラインにも送信する？'))newGame(true);};
$('passBtn').onclick=passTurn;
$('drawBtn').onclick=swapHand;
$('thirdBtn').onclick=toggleSelectedThirdPerson;
$('nameInput').value=localStorage.englishName||('P-'+clientId);
$('nameInput').addEventListener('change',()=>{localStorage.englishName=safeName();state.players[0].name=safeName();broadcast({type:'englishState',gameId:state.gameId,state:lightState(),reason:'rename'});render();});
$('playerCount').addEventListener('change',()=>newGame(false));
newGame(false);render();
}catch(__bootErr){
  console.error('english-pittan boot failed', __bootErr);
  try{
    const m=document.getElementById('msg');
    if(m){ m.textContent='起動エラー: '+(__bootErr&&(__bootErr.message||String(__bootErr))); m.className='msg bad'; }
  }catch(e){}
}
})();

const sentenceImageCloseBtn=document.getElementById('sentenceImageClose');
if(sentenceImageCloseBtn){
  const closeSentenceImagePanel=(ev)=>{
    if(ev){ ev.preventDefault(); ev.stopPropagation(); }
    const panel=document.getElementById('sentenceImagePanel');
    if(panel) panel.classList.remove('show');
  };
  sentenceImageCloseBtn.addEventListener('click', closeSentenceImagePanel);
  sentenceImageCloseBtn.addEventListener('pointerdown', closeSentenceImagePanel);
  sentenceImageCloseBtn.addEventListener('touchstart', closeSentenceImagePanel, {passive:false});
}

