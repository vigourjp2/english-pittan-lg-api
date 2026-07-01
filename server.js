import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
// v111: authoritative multiplayer room server for /room/english.
// Browser clients no longer decide P1/P2 locally. The room server assigns seats by join order.
const englishRooms = new Map();
let englishWsConnSeq = 1;

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(String(key || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function wsSend(socket, obj) {
  if (!socket || socket.destroyed) return false;
  let payload;
  try { payload = Buffer.from(JSON.stringify(obj)); } catch { return false; }
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); return true; } catch { return false; }
}
function wsClose(socket, code = 1000, reason = '') {
  try {
    const reasonBuf = Buffer.from(String(reason || '').slice(0, 80));
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0); reasonBuf.copy(payload, 2);
    const header = Buffer.from([0x88, payload.length]);
    socket.write(Buffer.concat([header, payload]));
  } catch {}
  try { socket.end(); } catch {}
}
function parseWsFrames(holder, chunk, onText) {
  holder.buffer = holder.buffer && holder.buffer.length ? Buffer.concat([holder.buffer, chunk]) : Buffer.from(chunk);
  let buf = holder.buffer;
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p); p += 8;
      if (big > BigInt(8 * 1024 * 1024)) throw new Error('ws frame too large');
      len = Number(big);
    }
    let mask;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4); p += 4;
    }
    if (buf.length - p < len) break;
    let payload = Buffer.from(buf.subarray(p, p + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    p += len;
    off = p;
    if (opcode === 0x8) throw new Error('ws close');
    if (opcode === 0x9) continue;
    if (opcode === 0x1) onText(payload.toString('utf8'));
  }
  holder.buffer = off < buf.length ? buf.subarray(off) : Buffer.alloc(0);
}
function getEnglishRoom(roomId) {
  const id = String(roomId || 'english').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'english';
  let r = englishRooms.get(id);
  if (!r) {
    r = { id, createdAt: Date.now(), playerCount: 2, seats: [], clients: new Set(), state: null, updateSeq: 0 };
    englishRooms.set(id, r);
  }
  return r;
}
function normalizePlayerCount(n) {
  n = Number(n || 2);
  if (!Number.isFinite(n)) n = 2;
  return Math.max(2, Math.min(4, Math.floor(n)));
}
function roomHostId(room) { return room.seats[0]?.clientId || null; }
function seatIndexForClient(room, clientId) {
  const cid = String(clientId || '');
  if (!cid) return -1;
  return room.seats.findIndex(s => s && s.clientId === cid);
}
function cleanupRoom(room) {
  for (const c of Array.from(room.clients)) {
    if (!c.socket || c.socket.destroyed) room.clients.delete(c);
  }
  // Keep seat ownership briefly across reloads by clientId. Do not remove seats immediately.
  if (room.clients.size === 0 && Date.now() - (room.lastActiveAt || room.createdAt) > 30 * 60 * 1000) {
    englishRooms.delete(room.id);
  }
}
function assignSeat(room, client) {
  cleanupRoom(room);
  const cid = String(client.clientId || '');
  if (!cid) return -1;
  const existing = seatIndexForClient(room, cid);
  if (existing >= 0) {
    room.seats[existing] = { clientId: cid, name: client.name || room.seats[existing].name || `Player ${existing + 1}` };
    client.seatIndex = existing;
    return existing;
  }
  for (let i = 0; i < room.playerCount; i++) {
    if (!room.seats[i]) {
      room.seats[i] = { clientId: cid, name: client.name || `Player ${i + 1}` };
      client.seatIndex = i;
      return i;
    }
  }
  client.seatIndex = -1;
  return -1;
}
function stampRoomState(room, state) {
  if (!state || !Array.isArray(state.players)) return state;
  state.playerCount = normalizePlayerCount(state.playerCount || room.playerCount);
  room.playerCount = normalizePlayerCount(state.playerCount);
  state.roomHostId = roomHostId(room);
  state.roomCreatedAt = room.createdAt;
  state.serverUpdateSeq = room.updateSeq;
  for (let i = 0; i < room.playerCount; i++) {
    if (!state.players[i]) state.players[i] = { name: `Player ${i + 1}`, clientId: null, score: 0, tiles: 0 };
    const seat = room.seats[i];
    state.players[i].clientId = seat?.clientId || null;
    if (seat?.name) state.players[i].name = seat.name;
  }
  return state;
}
function sendSeatAssigned(room, client, reason = 'seat-assigned') {
  const state = room.state ? stampRoomState(room, structuredClone(room.state)) : null;
  wsSend(client.socket, {
    type: 'seatAssigned',
    server: true,
    roomId: room.id,
    roomHostId: roomHostId(room),
    roomCreatedAt: room.createdAt,
    seatIndex: client.seatIndex,
    playerCount: room.playerCount,
    seats: room.seats.map((s, i) => s ? { seatIndex: i, clientId: s.clientId, name: s.name } : null),
    state,
    needNewGame: !state && client.seatIndex === 0,
    reason,
    time: Date.now()
  });
}
function broadcastRoom(room, obj, exceptClient = null) {
  cleanupRoom(room);
  const msg = { server: true, roomId: room.id, roomHostId: roomHostId(room), roomCreatedAt: room.createdAt, time: Date.now(), ...obj };
  for (const c of room.clients) {
    if (exceptClient && c === exceptClient) continue;
    wsSend(c.socket, msg);
  }
}
function canClientUpdateRoom(room, client, msg) {
  if (client.seatIndex < 0) return { ok: false, reason: '観戦中の端末は操作できません。' };
  if (msg.type === 'englishNewGame') {
    return client.seatIndex === 0 ? { ok: true } : { ok: false, reason: '新規ゲームはP1だけです。' };
  }
  if (!room.state) {
    return client.seatIndex === 0 ? { ok: true } : { ok: false, reason: 'P1の新規ゲーム開始待ちです。' };
  }
  const turn = Number(room.state.turn || 0) % normalizePlayerCount(room.state.playerCount || room.playerCount);
  if (client.seatIndex !== turn) {
    return { ok: false, reason: `ちょっと待って。今はP${turn + 1}のターンです。あなたはP${client.seatIndex + 1}です。` };
  }
  return { ok: true };
}
function handleEnglishRoomMessage(room, client, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  room.lastActiveAt = Date.now();
  const cid = String(msg.clientId || client.clientId || '').slice(0, 80);
  if (cid && !client.clientId) client.clientId = cid;
  if (msg.name) client.name = String(msg.name).trim().slice(0, 18);
  if (!client.clientId) return;
  if (msg.playerCount) room.playerCount = normalizePlayerCount(msg.playerCount);
  if (client.seatIndex == null || client.seatIndex < 0 || seatIndexForClient(room, client.clientId) < 0) {
    assignSeat(room, client);
    sendSeatAssigned(room, client, 'join-order');
    broadcastRoom(room, { type: 'roomPresence', seats: room.seats.map((s, i) => s ? { seatIndex: i, clientId: s.clientId, name: s.name } : null) }, client);
  }
  if (msg.type === 'ping') { wsSend(client.socket, { type: 'pong', server: true, time: Date.now() }); return; }
  if (msg.type === 'englishJoin' || msg.type === 'join' || msg.type === 'englishHello' || msg.type === 'englishSeatRequest') {
    sendSeatAssigned(room, client, msg.type);
    return;
  }
  if (msg.state && (msg.type === 'englishNewGame' || msg.type === 'englishState' || msg.type === 'englishPlace')) {
    const allowed = canClientUpdateRoom(room, client, msg);
    if (!allowed.ok) {
      wsSend(client.socket, { type: 'actionRejected', server: true, reason: allowed.reason, seatIndex: client.seatIndex, roomId: room.id, time: Date.now() });
      if (room.state) wsSend(client.socket, { type: 'englishState', server: true, reason: 'authoritative-resync', state: stampRoomState(room, structuredClone(room.state)), time: Date.now() });
      return;
    }
    room.updateSeq++;
    room.state = stampRoomState(room, structuredClone(msg.state));
    broadcastRoom(room, { type: 'englishState', reason: msg.reason || msg.type, state: stampRoomState(room, structuredClone(room.state)) });
    return;
  }
  // Unknown messages are deliberately not rebroadcast. The room server is authoritative for game state only.
}
function handleEnglishRoomUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const url = new URL(req.url, 'http://localhost');
  const roomId = (url.pathname.split('/').filter(Boolean)[1] || 'english');
  const room = getEnglishRoom(roomId);
  const accept = wsAcceptKey(key);
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    'Access-Control-Allow-Origin: *',
    '', ''
  ].join('\r\n'));
  const client = { id: 'ws' + englishWsConnSeq++, socket, room, clientId: '', name: '', seatIndex: -1, buffer: Buffer.alloc(0), connectedAt: Date.now() };
  room.clients.add(client);
  socket.on('data', chunk => {
    try { parseWsFrames(client, chunk, text => handleEnglishRoomMessage(room, client, text)); }
    catch { try { room.clients.delete(client); } catch {} wsClose(socket); }
  });
  socket.on('close', () => { room.clients.delete(client); cleanupRoom(room); });
  socket.on('error', () => { room.clients.delete(client); cleanupRoom(room); });
}

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CHARS = Number(process.env.MAX_CHARS || 180);
const LINK_TIMEOUT_MS = Number(process.env.LINK_TIMEOUT_MS || 3500);
const LT_TIMEOUT_MS = Number(process.env.LT_TIMEOUT_MS || 5000);
const HF_TIMEOUT_MS = Number(process.env.HF_TIMEOUT_MS || 25000);
const HF_MODEL_SCAN_TIMEOUT_MS = Number(process.env.HF_MODEL_SCAN_TIMEOUT_MS || 20000);
// v96: game acceptability keeps Strict Link Grammar + LanguageTool as the base truth.
// External acceptability is used as a primary veto only; secondary model rejects are advisory to avoid false NG.
// Reason suggestions are verified with the same game gate and redundant time-adverb stacking is rejected.
const HF_SCAN_MODELS = (process.env.HF_SCAN_MODELS || 'textattack/roberta-base-CoLA,abdulmatinomotoso/English_Grammar_Checker,agentlans/snowflake-arctic-xs-grammar-classifier,nikolasmoya/c4-binary-english-grammar-checker,pszemraj/electra-small-discriminator-CoLA,textattack/bert-base-uncased-CoLA,EstherT/sentence-acceptability').split(',').map(s => s.trim()).filter(Boolean);
const ACCEPTABILITY_HF_ENABLED = !/^false|0|off$/i.test(String(process.env.ACCEPTABILITY_HF_ENABLED || 'true'));
// v99: HF/CoLA系の外部acceptability分類器は短い初級文（例: be + adjective）をfalse rejectするため、
// ゲーム成立のvetoには使わない。必要な場合だけ環境変数で明示ON。
const ACCEPTABILITY_HF_GAME_GATE_ENABLED = !/^false|0|off$/i.test(String(process.env.ACCEPTABILITY_HF_GAME_GATE_ENABLED || 'true')); // v103: external acceptability API is the game veto by default; no local sentence-shape hardcoding
const ACCEPTABILITY_HF_MODEL = process.env.ACCEPTABILITY_HF_MODEL || 'abdulmatinomotoso/English_Grammar_Checker';
// v74: add a second external classifier gate that only rejects when it returns a clear unacceptable verdict.
// This is not a sentence/word rule; it is an additional HF model vote.
const ACCEPTABILITY_HF_SECONDARY_ENABLED = !/^false|0|off$/i.test(String(process.env.ACCEPTABILITY_HF_SECONDARY_ENABLED || 'true'));
const ACCEPTABILITY_HF_SECONDARY_MODEL = process.env.ACCEPTABILITY_HF_SECONDARY_MODEL || 'textattack/roberta-base-CoLA';
const ACCEPTABILITY_HF_SECONDARY_REJECT_MIN_CONF = Math.max(0, Math.min(1, Number(process.env.ACCEPTABILITY_HF_SECONDARY_REJECT_MIN_CONF || 0.70)));
const ACCEPTABILITY_HF_FAIL_CLOSED = /^true|1|on$/i.test(String(process.env.ACCEPTABILITY_HF_FAIL_CLOSED || 'false')); // unavailable external model fails open unless explicitly requested
const LOCAL_POS_SEMANTIC_GATE_ENABLED = /^true|1|on$/i.test(String(process.env.LOCAL_POS_SEMANTIC_GATE_ENABLED || 'false')); // v103: default off. Do not reject sentences by hand-written JS/POS patterns.
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
const REASON_FINAL_HF_TIMEOUT_MS = Math.max(2500, Number(process.env.REASON_FINAL_HF_TIMEOUT_MS || 6500)); // v58: 理由表示候補の外部HF分類器1件ごとの安全弁。HF Chatは使わない。
const REASON_FINAL_HF_PARALLEL = Math.max(1, Math.min(12, Number(process.env.REASON_FINAL_HF_PARALLEL || 8))); // v58: 表示候補確認の同時実行数。成立判定上限ではなく外部I/O隔離の粒度。
const REASON_EXTERNAL_VERIFY_MAX_PER_DEPTH = Math.max(1, Math.min(24, Number(process.env.REASON_EXTERNAL_VERIFY_MAX_PER_DEPTH || 12))); // v59: 各手数depthで外部分類器に出す表示候補窓。ローカル文法ジャッジではなく、HFに投げる順番を制御する。
const REASON_LIGHT_CANDIDATE_WINDOW_PER_DEPTH = Math.max(1, Math.min(64, Number(process.env.REASON_LIGHT_CANDIDATE_WINDOW_PER_DEPTH || 28))); // v63: streamingで見る最大候補数。文法判定ではなく、外部判定へ回す探索量の安全弁。
const REASON_ACTION_BUCKET_QUOTA = Math.max(1, Math.min(12, Number(process.env.REASON_ACTION_BUCKET_QUOTA || 6))); // v63: action/source別に順番を見る件数。文法判定ではなく外部判定順序の公平性確保。
const REASON_STREAMING_SOFT_DEADLINE_MS = Math.max(5000, Math.min(26000, Number(process.env.REASON_STREAMING_SOFT_DEADLINE_MS || 23500))); // v63: job全体30秒タイムアウト前に理由結果を安全に返すためのsoft deadline。
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
  // v104: サーバ側の理由/判定処理タイムアウトを撤廃。
  // 旧実装は Promise.race で遅い外部I/Oを失敗扱いにし、batch結果に error を混ぜていた。
  return promise;
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
  const wm = normalizeWordMetaList(diagnostics.reasonWordMetaMap || diagnostics.wordMetaMap || diagnostics.allWordMeta || []).map(m => [m.w, m.pos]).slice(0, 260);
  const sig = JSON.stringify({ board, hand, deck, wm });
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
    reasonDeckCandidates: uniqueWordsFromArray(diagnostics.reasonDeckCandidates || diagnostics.reasonCandidates || diagnostics.deckCandidates || [], 220),
    reasonWordMetaMap: normalizeWordMetaList(diagnostics.reasonWordMetaMap || diagnostics.wordMetaMap || diagnostics.allWordMeta || [])
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

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 0) {
  // v104: API判定経路のfetchタイムアウトを撤廃。
  // 関数名は互換維持。timeoutMsは受け取るがAbortには使わない。
  const r = await fetch(url, options);
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

function normalizeWordMetaList(wordMeta) {
  if (!Array.isArray(wordMeta)) return [];
  return wordMeta.map(m => {
    if (!m || typeof m !== 'object') return null;
    const w = String(m.w || m.word || '').trim();
    const pos = Array.isArray(m.pos) ? m.pos.map(x => String(x || '').trim()).filter(Boolean) : [];
    if (!w) return null;
    return { w, pos };
  }).filter(Boolean);
}
function normalizeReasonWordMetaMap(input) {
  let src = input;
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch { src = []; }
  }
  const list = Array.isArray(src) ? src : (src && typeof src === 'object' ? Object.values(src) : []);
  const map = new Map();
  for (const m of normalizeWordMetaList(list)) {
    const k = m.w.toLowerCase();
    if (!map.has(k) || (map.get(k).pos || []).length < m.pos.length) map.set(k, m);
  }
  return map;
}
function wordMetaFromMapForWords(words, diagnostics = {}) {
  const map = normalizeReasonWordMetaMap(diagnostics.reasonWordMetaMap || diagnostics.wordMetaMap || diagnostics.allWordMeta || []);
  if (!map.size) return normalizeWordMetaList(diagnostics.wordMeta || []);
  return canonicalGameWords(words || []).map(w => {
    const found = map.get(String(w).toLowerCase());
    return found ? { w, pos:[...(found.pos || [])] } : { w, pos:[] };
  }).filter(x => x.w);
}
function hasMetaPos(m, pos) { return Array.isArray(m?.pos) && m.pos.includes(pos); }
function hasAnyMetaPos(m, poses) { return Array.isArray(m?.pos) && poses.some(p => m.pos.includes(p)); }
function applyGameSemanticGate(text, acceptability, options = {}) {
  // v103: Do not use hand-written JS/POS grammar rules as the game judge.
  // The final game gate is Link Grammar + LanguageTool + external acceptability API.
  // This hook remains only for explicit local debugging when LOCAL_POS_SEMANTIC_GATE_ENABLED=true.
  if (!LOCAL_POS_SEMANTIC_GATE_ENABLED) return acceptability;
  if (!(acceptability?.ok && acceptability?.gameOk !== false && acceptability?.type === 'complete_sentence')) return acceptability;
  const meta = normalizeWordMetaList(options.wordMeta);
  if (!meta.length) return acceptability;
  const rejectByPos = (kind, displayKind, noteJa, noteEn) => ({
    ok:false,
    gameOk:false,
    type:kind,
    method:(acceptability.method || 'strict-link-grammar-plus-languagetool') + '+game-semantic-pos-gate',
    reason:noteEn || noteJa || kind,
    sentenceType:'not_complete_sentence',
    utteranceType:kind,
    displayKind,
    jaHint:'',
    noteJa,
    noteEn,
    gate:'game-semantic-pos-metadata-gate-v98',
    hfUsed:false,
    languageToolBlocking:false,
    semanticGateSource:'client-word-pos-metadata',
    baseAcceptability:acceptability
  });

  const timeWords = meta.filter(m => m.pos.includes('advTime')).map(m => m.w);
  if (timeWords.length >= 2) {
    return rejectByPos(
      'semantic_overlap',
      '時間表現の重複',
      `advTimeカード（${timeWords.join(' / ')}）が重複しています。ゲームの成立候補としては扱いません。`,
      `Redundant advTime cards: ${timeWords.join(', ')}`
    );
  }

  // v98: 単語名ではなくカードのposメタデータだけを見る。
  // 先頭が ing/ving で、その後ろが独立した finite clause に見える候補は、
  // 「eating I am hungry today」のような、補完候補として不自然な前置き断片を落とす。
  // これは eating/hungry/I などの個別語ハードコードではない。
  if (meta.length >= 3 && hasAnyMetaPos(meta[0], ['ving','ing'])) {
    const tail = meta.slice(1);
    const tailStartsWithSubject = hasAnyMetaPos(tail[0], ['subj','pron']);
    const tailHasFinite = tail.slice(1).some(m => hasAnyMetaPos(m, ['be','bePast','modal','verb','verbWant']));
    if (tailStartsWithSubject && tailHasFinite) {
      return rejectByPos(
        'dangling_ing_before_clause',
        'ing断片の前置き',
        'ingカードが、すでに主語＋定動詞を持つ文の前に断片として付いています。ゲームの成立候補としては扱いません。',
        'A leading ing card is attached before an independent finite clause.'
      );
    }
  }
  return acceptability;
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
    // v74: if primary model accepts, ask a second external classifier as an additional veto.
    // This is a two-model OR-rejection / AND-acceptance gate; no sentence-specific rule is used.
    let secondaryGate = null;
    if (ACCEPTABILITY_HF_SECONDARY_ENABLED && ACCEPTABILITY_HF_SECONDARY_MODEL && ACCEPTABILITY_HF_SECONDARY_MODEL !== ACCEPTABILITY_HF_MODEL) {
      const skey = `${ACCEPTABILITY_HF_SECONDARY_MODEL}::${src}`;
      const scached = hfAcceptabilityCache.get(skey);
      if (scached) {
        hfAcceptabilityStats.cacheHits++;
        secondaryGate = { ...scached, cached:true };
      } else if (ACCEPTABILITY_HF_DAILY_MAX > 0 && hfAcceptabilityStats.calls >= ACCEPTABILITY_HF_DAILY_MAX) {
        hfAcceptabilityStats.unavailable++;
        secondaryGate = { checked:false, ok:true, available:false, enabled:true, model:ACCEPTABILITY_HF_SECONDARY_MODEL, reason:'daily HF acceptability limit reached before secondary gate', dailyMax:ACCEPTABILITY_HF_DAILY_MAX, failOpen:true, secondary:true };
      } else {
        hfAcceptabilityStats.calls++;
        const ssummary = await callHfInferenceModel(ACCEPTABILITY_HF_SECONDARY_MODEL, src);
        const sjudgement = inferAcceptabilityFromHfSummary(ssummary);
        if (!sjudgement.ok || sjudgement.acceptable === null) {
          hfAcceptabilityStats.unavailable++;
          secondaryGate = { checked:true, ok:true, available:false, enabled:true, model:ACCEPTABILITY_HF_SECONDARY_MODEL, judgement:sjudgement, reason:sjudgement.error || sjudgement.reason || 'secondary unknown HF output', failOpen:true, secondary:true };
        } else if (sjudgement.acceptable === false && Number(sjudgement.confidence || 0) >= ACCEPTABILITY_HF_SECONDARY_REJECT_MIN_CONF) {
          hfAcceptabilityStats.rejected++;
          secondaryGate = { checked:true, ok:false, available:true, enabled:true, model:ACCEPTABILITY_HF_SECONDARY_MODEL, judgement:sjudgement, reason:`secondary acceptability rejected by ${ACCEPTABILITY_HF_SECONDARY_MODEL}`, failOpen:false, secondary:true, minRejectConfidence:ACCEPTABILITY_HF_SECONDARY_REJECT_MIN_CONF };
        } else {
          hfAcceptabilityStats.accepted++;
          secondaryGate = { checked:true, ok:true, available:true, enabled:true, model:ACCEPTABILITY_HF_SECONDARY_MODEL, judgement:sjudgement, reason:sjudgement.acceptable === false ? 'secondary reject confidence below threshold; fail-open' : 'secondary acceptability accepted', failOpen:false, secondary:true, minRejectConfidence:ACCEPTABILITY_HF_SECONDARY_REJECT_MIN_CONF };
        }
        hfAcceptabilityCache.set(skey, secondaryGate);
      }
    }
    if (secondaryGate?.ok === false) {
      // v96: secondary classifiers such as CoLA often reject short beginner sentences
      // like "I am happy today" even when Link Grammar + LanguageTool + primary model accept them.
      // Treat secondary reject as diagnostic only. Primary reject above remains a real veto.
      value = {
        checked:true,
        ok:true,
        available:true,
        enabled:true,
        model:`${ACCEPTABILITY_HF_MODEL}+${ACCEPTABILITY_HF_SECONDARY_MODEL}`,
        judgement,
        primaryHfAcceptability:{ checked:true, ok:true, available:true, enabled:true, model:ACCEPTABILITY_HF_MODEL, judgement, reason:'primary acceptability accepted', failOpen:false },
        secondaryHfAcceptability:secondaryGate,
        reason:'primary accepted; secondary reject treated as advisory v96',
        failOpen:false,
        dualGate:true,
        secondaryAdvisoryReject:true
      };
    } else {
      hfAcceptabilityStats.accepted++;
      value = {
        checked:true,
        ok:true,
        available:true,
        enabled:true,
        model: secondaryGate ? `${ACCEPTABILITY_HF_MODEL}+${ACCEPTABILITY_HF_SECONDARY_MODEL}` : ACCEPTABILITY_HF_MODEL,
        judgement,
        primaryHfAcceptability:{ checked:true, ok:true, available:true, enabled:true, model:ACCEPTABILITY_HF_MODEL, judgement, reason:'primary acceptability accepted', failOpen:false },
        secondaryHfAcceptability:secondaryGate,
        reason: secondaryGate ? 'dual acceptability accepted' : 'acceptability accepted',
        failOpen:false,
        dualGate:!!secondaryGate
      };
    }
  }
  hfAcceptabilityCache.set(key, value);
  trimHfAcceptabilityCache();
  return { ...value, cached:false };
}


async function hfAcceptabilityGateBatch(texts) {
  resetHfAcceptabilityStatsIfNeeded();
  const srcs = (texts || []).map(x => normalizeText(x)).filter(Boolean);
  const out = Array(srcs.length).fill(null);
  const toFetch = [];
  const fetchIndex = [];
  for (let i = 0; i < srcs.length; i++) {
    const key = `${ACCEPTABILITY_HF_MODEL}::${srcs[i]}`;
    const cached = hfAcceptabilityCache.get(key);
    if (cached) {
      hfAcceptabilityStats.cacheHits++;
      out[i] = { ...cached, cached:true };
    } else {
      toFetch.push(srcs[i]);
      fetchIndex.push(i);
    }
  }
  if (!toFetch.length) return out;
  if (!ACCEPTABILITY_HF_ENABLED) {
    for (const idx of fetchIndex) {
      hfAcceptabilityStats.skipped++;
      out[idx] = { checked:false, ok:true, available:false, enabled:false, model:ACCEPTABILITY_HF_MODEL, reason:'hf-acceptability-disabled', failOpen:!ACCEPTABILITY_HF_FAIL_CLOSED };
    }
    return out;
  }
  if (!HF_TOKEN) {
    for (const idx of fetchIndex) {
      hfAcceptabilityStats.unavailable++;
      out[idx] = { checked:false, ok:!ACCEPTABILITY_HF_FAIL_CLOSED, available:false, enabled:true, model:ACCEPTABILITY_HF_MODEL, reason:'HF_TOKEN is not set', failOpen:!ACCEPTABILITY_HF_FAIL_CLOSED };
    }
    return out;
  }
  let allowed = toFetch.length;
  if (ACCEPTABILITY_HF_DAILY_MAX > 0) allowed = Math.max(0, Math.min(allowed, ACCEPTABILITY_HF_DAILY_MAX - hfAcceptabilityStats.calls));
  const fetchNow = toFetch.slice(0, allowed);
  const fetchNowIndex = fetchIndex.slice(0, allowed);
  const quotaBlockedIndex = fetchIndex.slice(allowed);
  for (const idx of quotaBlockedIndex) {
    hfAcceptabilityStats.unavailable++;
    out[idx] = { checked:false, ok:!ACCEPTABILITY_HF_FAIL_CLOSED, available:false, enabled:true, model:ACCEPTABILITY_HF_MODEL, reason:'daily HF acceptability limit reached', dailyMax:ACCEPTABILITY_HF_DAILY_MAX, failOpen:!ACCEPTABILITY_HF_FAIL_CLOSED };
  }
  if (fetchNow.length) {
    hfAcceptabilityStats.calls += fetchNow.length;
    const batch = await callHfInferenceModelBatch(ACCEPTABILITY_HF_MODEL, fetchNow);
    const summaries = Array.isArray(batch.summaries) ? batch.summaries : [];
    for (let j = 0; j < fetchNow.length; j++) {
      const idx = fetchNowIndex[j];
      const summary = summaries[j] || { model:ACCEPTABILITY_HF_MODEL, ok:false, error:batch.error || 'missing batch item' };
      const judgement = inferAcceptabilityFromHfSummary(summary);
      let value;
      if (!judgement.ok || judgement.acceptable === null) {
        hfAcceptabilityStats.unavailable++;
        value = { checked:true, ok:!ACCEPTABILITY_HF_FAIL_CLOSED, available:false, enabled:true, model:ACCEPTABILITY_HF_MODEL, judgement, reason: judgement.error || judgement.reason || 'unknown HF batch output', failOpen:!ACCEPTABILITY_HF_FAIL_CLOSED, batch:true };
      } else if (judgement.acceptable === false) {
        hfAcceptabilityStats.rejected++;
        value = { checked:true, ok:false, available:true, enabled:true, model:ACCEPTABILITY_HF_MODEL, judgement, reason:`acceptability rejected by ${ACCEPTABILITY_HF_MODEL}`, failOpen:false, batch:true };
      } else {
        hfAcceptabilityStats.accepted++;
        value = { checked:true, ok:true, available:true, enabled:true, model:ACCEPTABILITY_HF_MODEL, judgement, reason:'acceptability accepted', failOpen:false, batch:true };
      }
      hfAcceptabilityCache.set(`${ACCEPTABILITY_HF_MODEL}::${fetchNow[j]}`, value);
      out[idx] = { ...value, cached:false };
    }
    trimHfAcceptabilityCache();
  }
  return out;
}

function applyHfAcceptabilityToLocalAcceptability(baseAccept, hfGate) {
  if (!(baseAccept?.ok && baseAccept?.gameOk !== false && baseAccept?.type === 'complete_sentence')) return baseAccept;
  if (!hfGate?.checked && hfGate?.ok !== false) {
    return { ...baseAccept, method:'strict-link-grammar-plus-languagetool-plus-hf-grammar-gate', gate:'strict-link-grammar-languagetool-hf-unchecked-open', hfUsed:false, hfAcceptability:hfGate };
  }
  // v95: 外部APIが未設定/枠切れ/到達不可のときは、その文をNGにしない。
  // 明確に available な外部判定が reject した時だけvetoする。
  if (hfGate?.ok === false && hfGate?.available === false) {
    return { ...baseAccept, method:'strict-link-grammar-plus-languagetool-plus-hf-grammar-gate', gate:'strict-link-grammar-languagetool-hf-unavailable-open-v96', hfUsed:false, hfAcceptability:hfGate };
  }
  if (hfGate?.ok === false) {
    // v103: available external acceptability API rejection is a real game veto.
    // No sentence-specific or POS-pattern hardcoding is used here.
    const msg = hfGate?.judgement?.reason || hfGate?.reason || 'External grammar classifier rejected this sentence.';
    return {
      ok:false,
      gameOk:false,
      type:'external_acceptability_rejected',
      method:'strict-link-grammar-plus-languagetool-plus-external-acceptability-veto',
      reason:msg,
      sentenceType:'not_complete_sentence',
      utteranceType:'external_acceptability_rejected',
      displayKind:'外部API判定NG',
      jaHint:'',
      noteJa:`外部英文判定APIがNGにしました: ${msg}`,
      noteEn:msg,
      gate:'strict-link-grammar-languagetool-external-acceptability-veto-v103',
      hfUsed:true,
      hfAcceptability:hfGate,
      hfModel:hfGate?.model || ACCEPTABILITY_HF_MODEL,
      baseAcceptability:baseAccept
    };
  }
  return { ...baseAccept, method:'strict-link-grammar-plus-languagetool-plus-hf-accepted', gate:'strict-link-grammar-languagetool-hf-accepted', hfUsed:!!hfGate?.checked, hfAcceptability:hfGate, hfModel:hfGate?.model || ACCEPTABILITY_HF_MODEL };
}

async function evaluateGameTextExact(text, options = {}) {
  const src = normalizeText(text);
  const parsed = await runLinkParser(src);
  let ltGate = null;
  if (strictLinkGrammarGameOk(parsed)) ltGate = await languageToolErrorGate(src);
  let acceptability = applyGameSemanticGate(src, localAcceptabilityFromLinkParserAndLt(src, parsed, ltGate), options);
  let hfGate = null;
  if (ACCEPTABILITY_HF_GAME_GATE_ENABLED && acceptability.ok && acceptability.gameOk !== false && acceptability.type === 'complete_sentence') {
    hfGate = await hfAcceptabilityGate(src);
    acceptability = applyHfAcceptabilityToLocalAcceptability(acceptability, hfGate);
  }
  return { text:src, parsed, languageTool:ltGate, hfAcceptability:hfGate, acceptability, ok:!!acceptability.ok, gameOk:!!(acceptability.ok && acceptability.gameOk !== false && acceptability.type === 'complete_sentence') };
}

async function evaluateGameTextLightForReason(text, options = {}) {
  const src = normalizeText(text);
  const parsed = await runLinkParser(src);
  let ltGate = null;
  if (strictLinkGrammarGameOk(parsed)) ltGate = await languageToolErrorGate(src);
  const acceptability = applyGameSemanticGate(src, localAcceptabilityFromLinkParserAndLt(src, parsed, ltGate), options);
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

let __linkParserSeq = 0;

// v119: link-parser高速化。
// 旧版は1文ごとに `link-parser` をspawnしていたため、辞書/ライブラリ初期化が毎回0.7〜1.0秒乗っていた。
// 既定は常駐プロセス1本をstdin/stdoutで使い回す。挙動確認や切り戻し用に LINK_PARSER_MODE=oneshot で旧方式へ戻せる。
// v120: persistent常駐はRender/Linux環境でstdoutがEOFまで返らず固まる可能性があるため、既定は安定版oneshotへ戻す。
// v121: 高速化はpersistentではなく、/check-and-translate-batch内で複数文を1回spawnへまとめて渡すoneshot-batch方式にする。
//       parserは処理後に終了するため、v119のようなstdout待ち停止を避ける。
const LINK_PARSER_MODE = String(process.env.LINK_PARSER_MODE || 'oneshot').toLowerCase();
const LINK_PARSER_IDLE_MS = Math.max(20, Number(process.env.LINK_PARSER_IDLE_MS || 80));
const LINK_PARSER_FALLBACK_IDLE_MS = Math.max(300, Number(process.env.LINK_PARSER_FALLBACK_IDLE_MS || 1500));
const LINK_PARSER_TIMEOUT_MS = Math.max(3000, Number(process.env.LINK_PARSER_TIMEOUT_MS || 15000));
const LINK_PARSER_BATCH_MODE = String(process.env.LINK_PARSER_BATCH_MODE || 'oneshot-batch').toLowerCase();
// v123: 256だと最大盤面で19spawn。既定1024にして最大盤面でも約5spawnに減らす。
const LINK_PARSER_BATCH_MAX = Math.max(1, Number(process.env.LINK_PARSER_BATCH_MAX || 1024));
// v123: batch parse失敗時の単体fallbackは旧遅延を再発させるため既定OFF。
const LINK_PARSER_BATCH_SINGLE_FALLBACK = String(process.env.LINK_PARSER_BATCH_SINGLE_FALLBACK || 'off').toLowerCase() === 'on';
const LINK_PARSER_CACHE_MAX = Math.max(0, Number(process.env.LINK_PARSER_CACHE_MAX || 1000));
const LINK_PARSER_ARGS = ['en', '-batch', '-verbosity=0', '-graphics=0', '-null=0', '-islands-ok=0', '-spell=0'];
const linkParserCache = new Map();

function cloneLinkParserResult(x) {
  return x ? { ...x, cacheHit: !!x.cacheHit } : x;
}
function parseLinkParserResult(out, err, code = 0) {
  const hardError = /\+\+\+\+\+ error/i.test(out) || /No complete linkages found/i.test(out) || code !== 0;
  const m = out.match(/Found\s+(\d+)\s+linkages/i);
  const linkages = m ? Number(m[1]) : (hardError ? 0 : 1);
  const ok = !hardError && linkages > 0;
  return {
    ok,
    fullParse: ok,
    strictLinkGrammar: ok,
    linkages,
    nullCount: 0,
    stdout: String(out || '').slice(0, 1800),
    stderr: String(err || '').slice(0, 1000),
    code
  };
}
function linkParserOutputLooksComplete(out, err) {
  const s = String(out || '') + '\n' + String(err || '');
  return /Found\s+\d+\s+linkages/i.test(s) || /No complete linkages found/i.test(s) || /\+\+\+\+\+ error/i.test(s);
}
function rememberLinkParserCache(key, value) {
  if (!LINK_PARSER_CACHE_MAX) return;
  if (linkParserCache.has(key)) linkParserCache.delete(key);
  linkParserCache.set(key, { ...value, cacheHit:false });
  while (linkParserCache.size > LINK_PARSER_CACHE_MAX) linkParserCache.delete(linkParserCache.keys().next().value);
}

function runLinkParserOneShot(lpInput, lpId, lpStartedAt) {
  return new Promise((resolve) => {
    const beforeSpawnAt = Date.now();
    const p = spawn('link-parser', LINK_PARSER_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
    const spawnReturnMs = Date.now() - beforeSpawnAt;
    const pid = p.pid || null;
    let out = '';
    let err = '';
    let firstStdoutMs = null;
    let firstStderrMs = null;
    let wroteMs = null;
    let endedMs = null;

    p.stdout.on('data', d => {
      if (firstStdoutMs === null) firstStdoutMs = Date.now() - lpStartedAt;
      out += d.toString();
    });
    p.stderr.on('data', d => {
      if (firstStderrMs === null) firstStderrMs = Date.now() - lpStartedAt;
      err += d.toString();
    });
    p.on('error', e => {
      const lpMemEnd = process.memoryUsage();
      console.log('[link-parser-end]', {
        id: lpId, pid, mode:'oneshot', ms: Date.now() - lpStartedAt, spawnReturnMs, wroteMs, endedMs,
        firstStdoutMs, firstStderrMs, ok: false, code: -1, error: String(e.message || e).slice(0, 300),
        rssMB: Math.round(lpMemEnd.rss / 1024 / 1024), heapUsedMB: Math.round(lpMemEnd.heapUsed / 1024 / 1024)
      });
      resolve({ ok:false, fullParse:false, strictLinkGrammar:false, linkages:0, nullCount:0, stdout:'', stderr:String(e.message || e), code:-1 });
    });
    p.on('close', code => {
      const parsed = parseLinkParserResult(out, err, code);
      const lpMemEnd = process.memoryUsage();
      console.log('[link-parser-end]', {
        id: lpId, pid, mode:'oneshot', ms: Date.now() - lpStartedAt, spawnReturnMs, wroteMs, endedMs,
        firstStdoutMs, firstStderrMs, ok: parsed.ok, code, linkages: parsed.linkages, stdoutBytes: out.length, stderrBytes: err.length,
        rssMB: Math.round(lpMemEnd.rss / 1024 / 1024), heapUsedMB: Math.round(lpMemEnd.heapUsed / 1024 / 1024)
      });
      resolve(parsed);
    });
    p.stdin.write(lpInput + '\n');
    wroteMs = Date.now() - lpStartedAt;
    p.stdin.end();
    endedMs = Date.now() - lpStartedAt;
  });
}

const persistentLinkParser = {
  proc: null,
  startingAt: 0,
  queue: [],
  active: null,
  bootOut: '',
  bootErr: ''
};
function stopPersistentLinkParser(reason = '') {
  const p = persistentLinkParser.proc;
  persistentLinkParser.proc = null;
  persistentLinkParser.bootOut = '';
  persistentLinkParser.bootErr = '';
  try { if (p && !p.killed) p.kill('SIGKILL'); } catch {}
  if (persistentLinkParser.active) {
    const a = persistentLinkParser.active;
    persistentLinkParser.active = null;
    try { clearTimeout(a.idleTimer); clearTimeout(a.timeoutTimer); } catch {}
    a.resolve({ ok:false, fullParse:false, strictLinkGrammar:false, linkages:0, nullCount:0, stdout:'', stderr:'persistent link-parser stopped: '+reason, code:-1 });
  }
}
function ensurePersistentLinkParser() {
  if (persistentLinkParser.proc && !persistentLinkParser.proc.killed) return persistentLinkParser.proc;
  persistentLinkParser.startingAt = Date.now();
  const p = spawn('link-parser', LINK_PARSER_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
  persistentLinkParser.proc = p;
  persistentLinkParser.bootOut = '';
  persistentLinkParser.bootErr = '';
  p.stdout.on('data', d => onPersistentLinkParserData('stdout', d));
  p.stderr.on('data', d => onPersistentLinkParserData('stderr', d));
  p.on('error', e => {
    console.warn('[link-parser-persistent-error]', String(e.message || e));
    stopPersistentLinkParser(String(e.message || e));
  });
  p.on('close', code => {
    console.warn('[link-parser-persistent-close]', { code });
    stopPersistentLinkParser('closed code '+code);
    setTimeout(drainPersistentLinkParserQueue, 10);
  });
  return p;
}
function onPersistentLinkParserData(stream, d) {
  const s = d.toString();
  const a = persistentLinkParser.active;
  if (!a) {
    if (stream === 'stdout') persistentLinkParser.bootOut += s;
    else persistentLinkParser.bootErr += s;
    return;
  }
  const now = Date.now();
  if (stream === 'stdout') {
    if (a.firstStdoutMs === null) a.firstStdoutMs = now - a.startedAt;
    a.out += s;
  } else {
    if (a.firstStderrMs === null) a.firstStderrMs = now - a.startedAt;
    a.err += s;
  }
  schedulePersistentSettle(a);
}
function schedulePersistentSettle(a) {
  try { clearTimeout(a.idleTimer); } catch {}
  const complete = linkParserOutputLooksComplete(a.out, a.err);
  const wait = complete ? LINK_PARSER_IDLE_MS : LINK_PARSER_FALLBACK_IDLE_MS;
  a.idleTimer = setTimeout(() => finishPersistentItem(0, complete ? 'marker-idle' : 'fallback-idle'), wait);
}
function finishPersistentItem(code = 0, reason = 'done') {
  const a = persistentLinkParser.active;
  if (!a) return;
  persistentLinkParser.active = null;
  try { clearTimeout(a.idleTimer); clearTimeout(a.timeoutTimer); } catch {}
  const parsed = parseLinkParserResult(a.out, a.err, code);
  const lpMemEnd = process.memoryUsage();
  console.log('[link-parser-end]', {
    id: a.lpId,
    pid: persistentLinkParser.proc?.pid || null,
    mode:'persistent',
    finishReason: reason,
    queueLeft: persistentLinkParser.queue.length,
    ms: Date.now() - a.startedAt,
    spawnReturnMs: a.spawnReturnMs,
    wroteMs: a.wroteMs,
    endedMs: a.endedMs,
    firstStdoutMs: a.firstStdoutMs,
    firstStderrMs: a.firstStderrMs,
    ok: parsed.ok,
    code,
    linkages: parsed.linkages,
    stdoutBytes: a.out.length,
    stderrBytes: a.err.length,
    rssMB: Math.round(lpMemEnd.rss / 1024 / 1024),
    heapUsedMB: Math.round(lpMemEnd.heapUsed / 1024 / 1024)
  });
  a.resolve(parsed);
  setImmediate(drainPersistentLinkParserQueue);
}
function drainPersistentLinkParserQueue() {
  if (persistentLinkParser.active || !persistentLinkParser.queue.length) return;
  const item = persistentLinkParser.queue.shift();
  const p = ensurePersistentLinkParser();
  if (!p || !p.stdin || p.killed || p.stdin.destroyed) {
    item.resolve({ ok:false, fullParse:false, strictLinkGrammar:false, linkages:0, nullCount:0, stdout:'', stderr:'persistent link-parser unavailable', code:-1 });
    setImmediate(drainPersistentLinkParserQueue);
    return;
  }
  const now = Date.now();
  const spawnReturnMs = p.pid ? Math.max(0, now - (persistentLinkParser.startingAt || now)) : null;
  persistentLinkParser.active = {
    ...item,
    out:'', err:'', firstStdoutMs:null, firstStderrMs:null, spawnReturnMs,
    wroteMs:null, endedMs:null, idleTimer:null, timeoutTimer:null
  };
  const a = persistentLinkParser.active;
  a.timeoutTimer = setTimeout(() => {
    console.warn('[link-parser-persistent-timeout]', { id:a.lpId, timeoutMs:LINK_PARSER_TIMEOUT_MS });
    stopPersistentLinkParser('timeout');
    setImmediate(drainPersistentLinkParserQueue);
  }, LINK_PARSER_TIMEOUT_MS);
  try {
    p.stdin.write(item.lpInput + '\n');
    a.wroteMs = Date.now() - item.startedAt;
    a.endedMs = a.wroteMs;
  } catch (e) {
    finishPersistentItem(-1, 'write-error:'+String(e.message || e).slice(0, 120));
  }
}
function runLinkParserPersistent(lpInput, lpId, lpStartedAt) {
  return new Promise((resolve) => {
    persistentLinkParser.queue.push({ lpInput, lpId, startedAt:lpStartedAt, resolve });
    drainPersistentLinkParserQueue();
  });
}

async function runLinkParser(text) {
  const lpId = ++__linkParserSeq;
  const lpStartedAt = Date.now();
  const lpInput = terminalSentence(text);
  const cacheKey = lpInput.toLowerCase();
  const cached = linkParserCache.get(cacheKey);
  if (cached) {
    const lpMem = process.memoryUsage();
    console.log('[link-parser-cache-hit]', {
      id: lpId,
      len: lpInput.length,
      text: lpInput.slice(0, 160),
      rssMB: Math.round(lpMem.rss / 1024 / 1024),
      heapUsedMB: Math.round(lpMem.heapUsed / 1024 / 1024)
    });
    return { ...cloneLinkParserResult(cached), cacheHit:true };
  }
  const lpMemStart = process.memoryUsage();
  console.log('[link-parser-start]', {
    id: lpId,
    len: lpInput.length,
    text: lpInput.slice(0, 160),
    mode: LINK_PARSER_MODE === 'oneshot' ? 'oneshot' : 'persistent',
    queue: persistentLinkParser.queue.length + (persistentLinkParser.active ? 1 : 0),
    rssMB: Math.round(lpMemStart.rss / 1024 / 1024),
    heapUsedMB: Math.round(lpMemStart.heapUsed / 1024 / 1024)
  });
  let parsed;
  if (LINK_PARSER_MODE === 'oneshot') parsed = await runLinkParserOneShot(lpInput, lpId, lpStartedAt);
  else parsed = await runLinkParserPersistent(lpInput, lpId, lpStartedAt);
  if (parsed && parsed.code !== -1) rememberLinkParserCache(cacheKey, parsed);
  return parsed;
}


function parseLinkParserBatchResult(out, err, code = 0, count = 0) {
  const src = String(out || '') + '\n' + String(err || '');
  const markers = [];
  const re = /(Found\s+\d+\s+linkages|No complete linkages found|\+\+\+\+\+ error[^\n]*)/ig;
  let m;
  while ((m = re.exec(src)) !== null) markers.push({ index:m.index, text:m[0] });
  if (markers.length !== count) return null;
  const results = [];
  for (let i = 0; i < count; i++) {
    const start = i === 0 ? 0 : markers[i - 1].index;
    const end = i + 1 < markers.length ? markers[i + 1].index : src.length;
    const block = src.slice(start, end);
    results.push(parseLinkParserResult(block, '', code));
  }
  return results;
}

function runLinkParserOneShotBatchRaw(lpInputs, batchId, startedAt) {
  return new Promise((resolve) => {
    const beforeSpawnAt = Date.now();
    const p = spawn('link-parser', LINK_PARSER_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
    const spawnReturnMs = Date.now() - beforeSpawnAt;
    const pid = p.pid || null;
    let out = '';
    let err = '';
    let firstStdoutMs = null;
    let firstStderrMs = null;
    let wroteMs = null;
    let endedMs = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (p && !p.killed) p.kill('SIGKILL'); } catch {}
      resolve({ ok:false, error:'link-parser batch timeout', out, err, code:-1, pid, spawnReturnMs, wroteMs, endedMs, firstStdoutMs, firstStderrMs });
    }, LINK_PARSER_TIMEOUT_MS);
    p.stdout.on('data', d => {
      if (firstStdoutMs === null) firstStdoutMs = Date.now() - startedAt;
      out += d.toString();
    });
    p.stderr.on('data', d => {
      if (firstStderrMs === null) firstStderrMs = Date.now() - startedAt;
      err += d.toString();
    });
    p.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok:false, error:String(e.message || e), out, err, code:-1, pid, spawnReturnMs, wroteMs, endedMs, firstStdoutMs, firstStderrMs });
    });
    p.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok:true, out, err, code, pid, spawnReturnMs, wroteMs, endedMs, firstStdoutMs, firstStderrMs });
    });
    p.stdin.write(lpInputs.join('\n') + '\n');
    wroteMs = Date.now() - startedAt;
    p.stdin.end();
    endedMs = Date.now() - startedAt;
  });
}

async function runLinkParserBatch(texts) {
  const inputs = texts.map(t => terminalSentence(t));
  const results = new Array(inputs.length);
  const missing = [];
  for (let i = 0; i < inputs.length; i++) {
    const key = inputs[i].toLowerCase();
    const cached = linkParserCache.get(key);
    if (cached) results[i] = { ...cloneLinkParserResult(cached), cacheHit:true };
    else missing.push(i);
  }
  if (!missing.length) return results;
  if (LINK_PARSER_BATCH_MODE === 'off') {
    for (const i of missing) results[i] = await runLinkParser(inputs[i]);
    return results;
  }

  for (let pos = 0; pos < missing.length; pos += LINK_PARSER_BATCH_MAX) {
    const idxs = missing.slice(pos, pos + LINK_PARSER_BATCH_MAX);
    const batchInputs = idxs.map(i => inputs[i]);
    const batchId = ++__linkParserSeq;
    const startedAt = Date.now();
    const memStart = process.memoryUsage();
    console.log('[link-parser-batch-start]', {
      id: batchId,
      count: batchInputs.length,
      mode:'oneshot-batch',
      rssMB: Math.round(memStart.rss / 1024 / 1024),
      heapUsedMB: Math.round(memStart.heapUsed / 1024 / 1024)
    });
    const raw = await runLinkParserOneShotBatchRaw(batchInputs, batchId, startedAt);
    let parsedMany = raw.ok ? parseLinkParserBatchResult(raw.out, raw.err, raw.code, batchInputs.length) : null;
    const memEnd = process.memoryUsage();
    console.log('[link-parser-batch-end]', {
      id: batchId,
      count: batchInputs.length,
      ms: Date.now() - startedAt,
      pid: raw.pid || null,
      parseOk: !!parsedMany,
      code: raw.code,
      error: raw.error || '',
      spawnReturnMs: raw.spawnReturnMs,
      wroteMs: raw.wroteMs,
      endedMs: raw.endedMs,
      firstStdoutMs: raw.firstStdoutMs,
      firstStderrMs: raw.firstStderrMs,
      stdoutBytes: String(raw.out || '').length,
      stderrBytes: String(raw.err || '').length,
      rssMB: Math.round(memEnd.rss / 1024 / 1024),
      heapUsedMB: Math.round(memEnd.heapUsed / 1024 / 1024)
    });
    if (!parsedMany) {
      // v123: ここで全件runLinkParser()へ戻すと、Renderログに[link-parser-start]が連発し高速化が消える。
      // 既定では単体fallbackしない。必要な場合だけ LINK_PARSER_BATCH_SINGLE_FALLBACK=on で旧挙動へ戻す。
      if (LINK_PARSER_BATCH_SINGLE_FALLBACK) {
        console.warn('[link-parser-batch-fallback-single-enabled]', { id:batchId, count:idxs.length });
        for (const i of idxs) results[i] = await runLinkParser(inputs[i]);
      } else {
        console.warn('[link-parser-batch-no-single-fallback]', { id:batchId, count:idxs.length, reason:'parseOk false' });
        for (const i of idxs) {
          results[i] = { ok:false, fullParse:false, strictLinkGrammar:false, linkages:0, nullCount:0, stdout:String(raw.out||'').slice(0,1800), stderr:String(raw.err||raw.error||'batch parse failed'), code:raw.code ?? -1, batchParseFailed:true };
        }
      }
      continue;
    }
    for (let j = 0; j < idxs.length; j++) {
      const i = idxs[j];
      results[i] = parsedMany[j];
      if (results[i] && results[i].code !== -1) rememberLinkParserCache(inputs[i].toLowerCase(), results[i]);
    }
  }
  return results;
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


function normalizeHfBatchSummaries(model, data, inputs, meta = {}) {
  const srcs = (inputs || []).map(x => normalizeText(x));
  let rows = [];
  if (Array.isArray(data) && data.length === srcs.length) {
    rows = data;
  } else if (Array.isArray(data) && srcs.length === 1) {
    rows = [data];
  } else {
    rows = srcs.map(() => data);
  }
  return srcs.map((inputUsed, idx) => summarizeHfOutput(model, rows[idx], { ...meta, inputUsed, batchIndex: idx, batch: true }));
}

async function callHfInferenceModelBatch(model, texts) {
  const srcs = (texts || []).map(x => normalizeText(x)).filter(Boolean);
  if (!srcs.length) return { ok:true, model, provider:'hf-inference', summaries:[] };
  if (!HF_TOKEN) return { ok:false, model, provider:'hf-inference', error:'HF_TOKEN is not set', summaries: srcs.map(inputUsed => ({ model, ok:false, error:'HF_TOKEN is not set', inputUsed, batch:true })) };
  const path = hfModelPath(model);
  const urls = [
    `https://router.huggingface.co/hf-inference/models/${path}`,
    `https://api-inference.huggingface.co/models/${path}`
  ];
  const kind = hfModelKind(model);
  // v56: reason用の浅い外部判定。分類器に配列inputsを1回で渡す。
  // ローカルの助動詞/動詞リストでは判定しない。
  const payload = kind === 'classification'
    ? { inputs: srcs, options: { wait_for_model: true } }
    : { inputs: srcs, options: { wait_for_model: true }, parameters: { max_new_tokens: 80 } };
  const attempts = [];
  for (const endpoint of urls) {
    try {
      const data = await fetchJsonWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${HF_TOKEN}`,
          'content-type': 'application/json',
          'accept': 'application/json'
        },
        body: JSON.stringify(payload)
      }, REASON_FINAL_HF_TIMEOUT_MS);
      return { ok:true, model, provider:'hf-inference', endpoint, kind, summaries: normalizeHfBatchSummaries(model, data, srcs, { kind, endpoint }) };
    } catch (e) {
      attempts.push({ endpoint, kind, error:String(e.message || e), status:e.status || null, body:e.body || null });
    }
  }
  return { ok:false, model, kind, provider:'hf-inference', error:'all HF batch inference endpoints failed', attempts, summaries: srcs.map(inputUsed => ({ model, ok:false, kind, provider:'hf-inference', error:'all HF batch inference endpoints failed', inputUsed, attempts, batch:true })) };
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
    labelMapping = 'generic default mapping: LABEL_1=acceptable';
  } else if (topLabel === 'label_0') {
    acceptable = false; reason = 'generic-label_0-assumed-unacceptable';
    labelMapping = 'generic default mapping: LABEL_0=unacceptable';
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

function parseWordMetaQuery(raw) {
  if (!raw) return [];
  try { return normalizeWordMetaList(JSON.parse(String(raw))); } catch { return []; }
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


function reasonLocalPrefilter(sentence) {
  // v58: 撤去済み。ローカルの助動詞/動詞リストで候補を捨てない。
  // 浅い候補可否は実績ある外部HF分類器だけに投げる。HF Chatは使わない。
  return { ok:true, reason:'removed-v65-dual-hf-acceptability-gate' };
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
  let lightWindowChecks = 0;
  const finalHfCandidateTexts = [];
  const finalHfRejectedTexts = [];
  const finalHfAcceptedTexts = [];
  const finalHfSuppressedTexts = [];
  const lightAcceptedTexts = [];
  const orderedCandidatePreview = [];
  let depth1TimeBudgetHit = false;
  let streamingSoftDeadlineHit = false;
  const checked = new Map();

  async function isGood(sentence) {
    const t = normalizeText(sentence).replace(/[.!?]+$/,'');
    const k = t.toLowerCase();
    if (!t || k === originalKey) return false;
    if (checked.has(k)) return checked.get(k);
    checks++;

    // v56: ローカル文法リストの前処理は使わない。浅い候補判定は外部HF batchへ渡す。

    // v48+: 候補全部にいきなり /check 相当(HF込み)をかけない。
    // まず軽い LG + LanguageTool だけでふるいにかける。
    // v95: 理由補完候補は、採点と同じゲームAPIゲートで最終確認する。
    // v80はLink Grammar + LanguageToolだけのlight判定で候補を表示したため、
    // `I am Japanese need` のような変な補完が「英文になります」と出た。
    const candidateWords = canonicalGameWords(t.split(/\s+/));
    const candidateWordMeta = wordMetaFromMapForWords(candidateWords, diagnostics);
    const light = await withReasonTimeout(evaluateGameTextExact(t, { strictGameGate:true, acceptabilityModelGate:true, wordMeta:candidateWordMeta }), REASON_CANDIDATE_TIMEOUT_MS + 4500, `reason game-gate candidate ${t}`);
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

    // v80: ここでゲームAPI系の軽量判定を通った候補は、表示候補として扱う。
    // HF最終フィルタは使わない。
    const value = {
      ok:true,
      stage:'light-accepted-awaiting-hf-display-filter-v55',
      parsed:light.parsed,
      languageTool:light.languageTool,
      acceptability:light.acceptability,
      hfAcceptability:{ checked:false, skipped:true, reason:'HF is deferred until the candidate is about to be displayed v55' },
      text:t
    };
    checked.set(k, value);
    return value;
  }

  async function verifyReasonDisplayCandidate(lightResult) {
    const t = normalizeText(lightResult?.text || '').replace(/[.!?]+$/,'');
    if (!t || !lightResult?.ok) return { ok:false, stage:'display-filter-no-light-candidate', text:t };
    const finalOk = !!(lightResult.acceptability?.ok && lightResult.acceptability?.gameOk !== false && lightResult.acceptability?.type === 'complete_sentence');
    return {
      ok: finalOk,
      stage: finalOk ? 'strict-link-grammar-accepted-for-reason-display-v80' : 'strict-link-grammar-rejected-for-reason-display-v80',
      text:t,
      parsed:lightResult.parsed,
      languageTool:lightResult.languageTool,
      acceptability:lightResult.acceptability,
      hfAcceptability:{ checked:false, skipped:true, reason:'reason display uses same game API gate v96' }
    };
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

  function makeSuggestionFromFinal(op, final) {
    return {
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
    };
  }

  async function runLevel(ops, depthLabel = 1, opts = {}) {
    // v63:
    // - v61はdepth1を先にstreamingし続けたため、depth2候補(I am Japanese now 等)に入る前にsoft deadline近くまで消費した。
    // - v63はdepth1に小さいtime sliceを持たせ、depth2補完へ必ず進む。
    // - ローカル文法判定・助動詞リスト判定・特定文accept/rejectは使わない。
    // - 判定は Link Grammar + LanguageTool のゲームAPI系判定だけ。HF最終フィルタは使わない。
    const sourceRank = { hand:0, board:1, deck:2 };
    const actionRank = { 'add-left':0, 'add-right':1, 'add-two-left':2, 'add-two-right':3, replace:4, reorder:5, delete:6 };
    const rankedOps = (ops || [])
      .map((op, i) => ({ op, originalIndex:i, sentence:op.sentence || uniqueSentence(op.words) }))
      .filter(x => x.sentence && x.sentence.toLowerCase() !== originalKey)
      .sort((a,b) =>
        (sourceRank[a.op.source] ?? 9) - (sourceRank[b.op.source] ?? 9) ||
        (actionRank[a.op.action] ?? 9) - (actionRank[b.op.action] ?? 9) ||
        Math.abs(String(a.sentence || '').split(/\s+/).filter(Boolean).length - 4) - Math.abs(String(b.sentence || '').split(/\s+/).filter(Boolean).length - 4) ||
        a.originalIndex - b.originalIndex
      );

    const bucketOrder = [
      // v80: 左側追加を先に6件消費すると、I like + apples のような右追加候補が
      // depth1の少量チェック枠に入らず、理由探索が「待ち/未発見」に見える。
      // 文や単語の固定ではなく、同じ手札候補を右追加→左追加の順に探索するだけ。
      'hand:add-right', 'hand:add-left',
      // 2枚追加も同様に、英文の続きを作る候補を先に見てから前置補完を見る。
      'hand:add-two-right', 'hand:add-two-left',
      'hand:replace', 'hand:reorder',
      'board:add-left', 'board:add-right',
      'deck:add-left', 'deck:add-right',
      'deck:replace', 'board:replace',
      'any:reorder', 'any:delete'
    ];
    const buckets = new Map();
    for (const item of rankedOps) {
      const key = `${item.op.source || 'any'}:${item.op.action || 'other'}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(item);
      const anyKey = `any:${item.op.action || 'other'}`;
      if (!buckets.has(anyKey)) buckets.set(anyKey, []);
      buckets.get(anyKey).push(item);
    }

    const seenSentences = new Set();
    const ordered = [];
    function addItem(item) {
      const k = String(item?.sentence || '').toLowerCase();
      if (!k || seenSentences.has(k) || ordered.length >= REASON_LIGHT_CANDIDATE_WINDOW_PER_DEPTH) return false;
      seenSentences.add(k); ordered.push(item); return true;
    }
    for (const key of bucketOrder) {
      let n = 0;
      for (const item of (buckets.get(key) || [])) {
        if (addItem(item)) n++;
        if (n >= REASON_ACTION_BUCKET_QUOTA || ordered.length >= REASON_LIGHT_CANDIDATE_WINDOW_PER_DEPTH) break;
      }
      if (ordered.length >= REASON_LIGHT_CANDIDATE_WINDOW_PER_DEPTH) break;
    }
    for (const item of rankedOps) {
      if (ordered.length >= REASON_LIGHT_CANDIDATE_WINDOW_PER_DEPTH) break;
      addItem(item);
    }
    lightWindowChecks += ordered.length;
    if (orderedCandidatePreview.length < 80) {
      for (const item of ordered.slice(0, 20)) {
        orderedCandidatePreview.push({ depth: depthLabel, action:item.op.action, source:item.op.source, sentence:item.sentence });
      }
    }
    const levelStartedAt = Date.now();
    const levelTimeBudgetMs = Number(opts.timeBudgetMs || 0);
    const levelCheckBudget = Number(opts.checkBudget || 0);
    let levelChecks = 0;

    async function verifyAcceptedLight(item, light) {
      const candidateText = normalizeText(light?.text || item?.sentence || '').replace(/[.!?]+$/,'');
      if (finalHfCandidateTexts.length < 80) finalHfCandidateTexts.push(candidateText);
      const finalOk = !!(light?.acceptability?.ok && light?.acceptability?.gameOk !== false && light?.acceptability?.type === 'complete_sentence');
      if (!finalOk) {
        finalHfRejected++;
        if (finalHfRejectedTexts.length < 80) finalHfRejectedTexts.push(candidateText);
        return null;
      }
      const final = {
        ...light,
        text:candidateText,
        ok:true,
        stage:'same-game-api-gate-accepted-for-reason-display-v96',
        hfAcceptability:{ checked:false, skipped:true, reason:'reason display uses same game API gate v96' }
      };
      if (finalHfAcceptedTexts.length < 80) finalHfAcceptedTexts.push(candidateText);
      return makeSuggestionFromFinal(item.op, final);
    }

    // 逐次streaming。並列で詰め込まず、OK候補が出たら即return。
    for (const item of ordered) {
      if ((Date.now() - startedAt) > REASON_STREAMING_SOFT_DEADLINE_MS) { streamingSoftDeadlineHit = true; break; }
      if (levelTimeBudgetMs && (Date.now() - levelStartedAt) > levelTimeBudgetMs) { if (depthLabel === 1) depth1TimeBudgetHit = true; break; }
      if (levelCheckBudget && levelChecks >= levelCheckBudget) { if (depthLabel === 1) depth1TimeBudgetHit = true; break; }
      levelChecks++;
      let light = null;
      try {
        light = await isGood(item.sentence);
      } catch (e) {
        light = null;
      }
      if (!light || !light.ok) continue;
      if (lightAcceptedTexts.length < 80) lightAcceptedTexts.push(light.text);
      const suggestion = await verifyAcceptedLight(item, light);
      if (suggestion) return [suggestion];
    }
    return [];
  }

  const oneStepOps = buildOneStepOps();
  // v63: depth1だけで時間を使い切らない。まず少量だけ見て、depth2補完へ進める。
  let suggestions = await runLevel(oneStepOps, 1, { timeBudgetMs: 9000, checkBudget: 18 });
  let exploredDepth = 1;
  let twoStepOpsCount = 0;
  if (!suggestions.length) {
    const twoStepOps = buildTwoStepOps();
    twoStepOpsCount = twoStepOps.length;
    suggestions = await runLevel(twoStepOps, 2, { timeBudgetMs: 16000, checkBudget: 28 });
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
    return {
      ok:false,
      status:'no_verified_suggestion',
      retryable:false,
      error:'reason exploration found no verified completing path',
      method:'strict-link-grammar-oracle-exploration-v80-right-first-no-hf-no-local-fallback',
      suggestions:[],
      rawReason:{
        exploration:true,
        exhaustive:true,
        stagedReason:true,
        strictExplorationOnly:true,
        text:src,
        words,
        checks,
        elapsedMs: Date.now() - startedAt,
        exploredDepth,
        oneStepOpsCount: oneStepOps.length,
        twoStepOpsCount,
        boardCandidates:board,
        handCandidates:hand,
        deckCandidateCount:deck.length
      }
    };
  }
  return {
    ok:true,
    method:'strict-link-grammar-oracle-exploration-v80-right-first-no-hf-no-local-fallback',
    model:'none',
    observedStructure: top ? 'nearest successful path found by strict Link Grammar API exploration' : 'no successful path found in staged finite candidate set',
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
      hfOnlyAfterLightAccept:false,
      hfNetworkSkippedInReason:true,
      hfFinalDisplayFilter:false,
      externalShallowJudge:'disabled-reason-uses-strict-link-grammar-api-only-v80',
      localGrammarPrefilter:false,
      hfChatUsed:false,
      externalVerifyMaxPerDepth:REASON_EXTERNAL_VERIFY_MAX_PER_DEPTH,
      lightCandidateWindowPerDepth:REASON_LIGHT_CANDIDATE_WINDOW_PER_DEPTH, actionBucketQuota:REASON_ACTION_BUCKET_QUOTA,
      lightWindowChecks,
      externalVerifyParallel:REASON_FINAL_HF_PARALLEL, streamingSoftDeadlineMs:REASON_STREAMING_SOFT_DEADLINE_MS,
      finalHfChecks,
      finalHfRejected,
      finalHfSuppressed,
      finalHfCandidateTexts,
      finalHfAcceptedTexts,
      finalHfRejectedTexts,
      finalHfSuppressedTexts,
      lightAcceptedTexts,
      orderedCandidatePreview,
      depth1TimeBudgetHit,
      streamingSoftDeadlineHit,
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
  // v79: no local grammar templates/case hacks and no local diagnostic reason text.
  // Return only explanations backed by the exploration result; otherwise let the job fail/unavailable.
  return await explainByExploration(text, diagnostics);
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
  const ev = await evaluateGameTextExact(checkedText, { strictGameGate: reasonMeta.strictGameGate === true, acceptabilityModelGate: reasonMeta.acceptabilityModelGate === true, wordMeta: reasonMeta.wordMeta });
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
  const reasonDisabled = !!(reasonMeta.reasonDisabled || reasonMeta.disableReasonJob || reasonMeta.reasonMode === 'none');
  if (!gameOk && !reasonDisabled) {
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
    ok, gameOk, type, kind: (ACCEPTABILITY_HF_GAME_GATE_ENABLED || reasonMeta.strictGameGate === true || reasonMeta.acceptabilityModelGate === true) ? 'Strict Link Grammar + LanguageTool + external acceptability API gate v103' : 'Strict Link Grammar + LanguageTool Gate v103' ,
    sentenceType: gameOk ? (acceptability.sentenceType || 'complete_sentence') : (acceptability.sentenceType || type),
    reason: gameOk ? '' : (acceptability.noteJa || acceptability.reason || reasonExplain?.explanationJa || reasonExplain?.explanationEn || ''),
    reasonSource: gameOk ? '' : (reasonDisabled ? 'reason-job-disabled-for-bulk-scan' : (acceptability.languageToolBlocking ? 'languagetool-error-gate' : (acceptability.hfUsed ? 'hf-grammar-classifier-gate' : (reasonExplain?.ok ? reasonExplain.method : 'reason-job-pending')))),
    reasonStatus: gameOk ? 'none' : (reasonDisabled ? 'none' : (reasonJob?.status || 'pending')),
    reasonJobId: gameOk ? '' : (reasonDisabled ? '' : (reasonJob?.id || '')),
    reasonExplain, proof,
    fullParse: parsed.fullParse, strictLinkGrammar: parsed.strictLinkGrammar,
    linkages: parsed.linkages, nullCount: parsed.nullCount, stdout: parsed.stdout, stderr: parsed.stderr, code: parsed.code,
    acceptability, languageTool: ev.languageTool, hfAcceptability: ev.hfAcceptability, ja: translation?.ja || '', translation
  };
}


async function evaluateGameTextExactWithParsed(text, parsed, options = {}) {
  const src = normalizeText(text);
  let ltGate = null;
  if (strictLinkGrammarGameOk(parsed)) ltGate = await languageToolErrorGate(src);
  let acceptability = applyGameSemanticGate(src, localAcceptabilityFromLinkParserAndLt(src, parsed, ltGate), options);
  let hfGate = null;
  if (ACCEPTABILITY_HF_GAME_GATE_ENABLED && acceptability.ok && acceptability.gameOk !== false && acceptability.type === 'complete_sentence') {
    hfGate = await hfAcceptabilityGate(src);
    acceptability = applyHfAcceptabilityToLocalAcceptability(acceptability, hfGate);
  }
  return { text:src, parsed, languageTool:ltGate, hfAcceptability:hfGate, acceptability, ok:!!acceptability.ok, gameOk:!!(acceptability.ok && acceptability.gameOk !== false && acceptability.type === 'complete_sentence') };
}

async function checkSentenceWithParsed(text, parsed, withTranslate = false, reasonMeta = {}) {
  const originalText = normalizeText(text);
  const proof = noAutocorrectProof(originalText);
  const checkedText = originalText;
  const ev = await evaluateGameTextExactWithParsed(checkedText, parsed, { strictGameGate: reasonMeta.strictGameGate === true, acceptabilityModelGate: reasonMeta.acceptabilityModelGate === true, wordMeta: reasonMeta.wordMeta });
  const acceptability = ev.acceptability;
  const ok = !!acceptability.ok;
  const type = acceptability.type || (ok ? 'complete_sentence' : 'invalid');
  const gameOk = !!(ok && acceptability.gameOk !== false && type === 'complete_sentence');
  let translation = null;
  let reasonExplain = null;
  let reasonJob = null;
  if (gameOk && acceptability.jaHint) translation = { ok:true, ja:acceptability.jaHint, source:'contextual-short-answer' };
  else if (gameOk && withTranslate) translation = await translateToJapanese(checkedText);
  const reasonDisabled = !!(reasonMeta.reasonDisabled || reasonMeta.disableReasonJob || reasonMeta.reasonMode === 'none');
  if (!gameOk && !reasonDisabled) {
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
    ok, gameOk, type, kind: (ACCEPTABILITY_HF_GAME_GATE_ENABLED || reasonMeta.strictGameGate === true || reasonMeta.acceptabilityModelGate === true) ? 'Strict Link Grammar + LanguageTool + external acceptability API gate v103' : 'Strict Link Grammar + LanguageTool Gate v103' ,
    sentenceType: gameOk ? (acceptability.sentenceType || 'complete_sentence') : (acceptability.sentenceType || type),
    reason: gameOk ? '' : (acceptability.noteJa || acceptability.reason || reasonExplain?.explanationJa || reasonExplain?.explanationEn || ''),
    reasonSource: gameOk ? '' : (reasonDisabled ? 'reason-job-disabled-for-bulk-scan' : (acceptability.languageToolBlocking ? 'languagetool-error-gate' : (acceptability.hfUsed ? 'hf-grammar-classifier-gate' : (reasonExplain?.ok ? reasonExplain.method : 'reason-job-pending')))),
    reasonStatus: gameOk ? 'none' : (reasonDisabled ? 'none' : (reasonJob?.status || 'pending')),
    reasonJobId: gameOk ? '' : (reasonDisabled ? '' : (reasonJob?.id || '')),
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
  return { id: String(item?.id ?? i), text, words: words || text.split(/\s+/).filter(Boolean), wordMeta: Array.isArray(item?.wordMeta) ? item.wordMeta : [] };
}

async function checkSentenceBatch(req) {
  const raw = await readBody(req);
  let j = {};
  try { j = JSON.parse(raw || '{}'); } catch { j = {}; }
  const input = Array.isArray(j?.candidates) ? j.candidates : [];
  // v104: 一括判定の240件上限を撤廃。フロントが作った候補を全件API判定する。
  const max = input.length;
  const seen = new Map();
  for (let i = 0; i < input.length && seen.size < max; i++) {
    const item = normalizeCandidateItem(input[i], i);
    if (!item.text) continue;
    const key = item.text.toLowerCase();
    if (!seen.has(key)) seen.set(key, item);
  }
  const items = [...seen.values()];
  const results = [];
  const concurrency = Math.max(1, Math.min(Number(process.env.BATCH_CONCURRENCY || 64), 512));
  const startedAt = Date.now();
  const memStart = process.memoryUsage();
  console.log('[batch-start]', {
    input: input.length,
    unique: items.length,
    concurrency,
    env: process.env.BATCH_CONCURRENCY || null,
    linkParserBatchMode: LINK_PARSER_BATCH_MODE,
    rssMB: Math.round(memStart.rss / 1024 / 1024),
    heapUsedMB: Math.round(memStart.heapUsed / 1024 / 1024)
  });
  // v121: Link Grammarだけ先にoneshot-batchでまとめて処理する。
  // 常駐は使わず、1回spawn→複数文投入→stdin終了→stdout確定、なので停止リスクを避ける。
  const preParsed = await runLinkParserBatch(items.map(x => x.text));
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const ix = next++;
      const item = items[ix];
      try {
        const checked = await checkSentenceWithParsed(item.text, preParsed[ix], j.translate !== false && j.withTranslate !== false, { reasonPriorityEpoch: j.reasonPriorityEpoch || j.reasonEpoch || Date.now(), reasonPrioritySeq: Number(item.id || 0), words:item.words, wordMeta:item.wordMeta, reasonBoardCandidates:j.reasonBoardCandidates || j.boardCandidates || [], reasonHandCandidates:j.reasonHandCandidates || j.handCandidates || [], reasonDeckCandidates:j.reasonDeckCandidates || j.reasonCandidates || j.deckCandidates || [], strictGameGate: j.strictGameGate === true || j.acceptabilityModelGate === true, acceptabilityModelGate: j.acceptabilityModelGate === true, reasonDisabled: j.reasonDisabled===true || j.disableReasonJob===true || j.reasonMode==='none' });
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
  const memEnd = process.memoryUsage();
  console.log('[batch-end]', {
    input: input.length,
    unique: items.length,
    concurrency,
    ms: Date.now() - startedAt,
    rssMB: Math.round(memEnd.rss / 1024 / 1024),
    heapUsedMB: Math.round(memEnd.heapUsed / 1024 / 1024)
  });
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
        mode:'link-grammar-plus-languagetool-error-gate-v122-oneshot-batch-prefix-rescue',
        linkParserMode: LINK_PARSER_MODE,
        linkParserQueue: persistentLinkParser.queue.length + (persistentLinkParser.active ? 1 : 0),
        linkParserCacheSize: linkParserCache.size,
        linkParserBatchMode: LINK_PARSER_BATCH_MODE,
        linkParserBatchMax: LINK_PARSER_BATCH_MAX, linkParserBatchSingleFallback: LINK_PARSER_BATCH_SINGLE_FALLBACK,
        hfChatModel: HF_CHAT_MODEL,
        hfChatUrl: HF_CHAT_URL,
        hfTokenPresent: !!HF_TOKEN,
        reasonProvider:'strict-link-grammar-languagetool-hf-grammar-gate-v72-no-auto-reason-enqueue',
        quotaFree:true,
        hfDisabledForReason:true,
        hfDisabledForAcceptability:!ACCEPTABILITY_HF_ENABLED,
        hfAcceptabilityGameGateEnabled: ACCEPTABILITY_HF_GAME_GATE_ENABLED,
        hfAcceptabilityModel: ACCEPTABILITY_HF_MODEL,
        hfAcceptabilitySecondaryEnabled: ACCEPTABILITY_HF_SECONDARY_ENABLED,
        hfAcceptabilitySecondaryModel: ACCEPTABILITY_HF_SECONDARY_MODEL,
        hfAcceptabilitySecondaryRejectMinConfidence: ACCEPTABILITY_HF_SECONDARY_REJECT_MIN_CONF,
        hfAcceptabilityFailClosed: ACCEPTABILITY_HF_FAIL_CLOSED,
        hfAcceptabilityDailyMax: ACCEPTABILITY_HF_DAILY_MAX,
        hfAcceptabilityStats,
        hfAcceptabilityCacheSize: hfAcceptabilityCache.size,
        hfAcceptabilityCacheKeyPolicy:'exact-text-case-sensitive-v45',
        reasonExplorePolicy:'depth-timeslice-action-bucket-plus-external-classifier-v65-dual-hf-gate',
        browserQueryContext:true, reasonHfNetworkDisabled:true, reasonDisplayHfFilter:false, reasonExternalShallowJudge:'disabled-reason-uses-strict-link-grammar-api-only-v80', reasonLocalPrefilterEnabled:false, reasonFinalHfTimeoutMs:REASON_FINAL_HF_TIMEOUT_MS, reasonFinalHfParallel:REASON_FINAL_HF_PARALLEL, reasonExternalVerifyMaxPerDepth:REASON_EXTERNAL_VERIFY_MAX_PER_DEPTH, reasonLightCandidateWindowPerDepth:REASON_LIGHT_CANDIDATE_WINDOW_PER_DEPTH, reasonActionBucketQuota:REASON_ACTION_BUCKET_QUOTA, reasonStreamingSoftDeadlineMs:REASON_STREAMING_SOFT_DEADLINE_MS,
        acceptanceGate: ACCEPTABILITY_HF_GAME_GATE_ENABLED ? 'strict-link-grammar-plus-languagetool-plus-hf-grammar-gate' : 'strict-link-grammar-plus-languagetool-only-game-gate',
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
      let acceptability = applyGameSemanticGate(src, localAcceptabilityFromLinkParserAndLt(src, parsed, lt), {});
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


function parseBenchmarkSamples(url) {
  const rawSamples = [];
  for (const v of url.searchParams.getAll('sample')) rawSamples.push(v);
  for (const v of url.searchParams.getAll('text')) rawSamples.push(v);
  const joined = url.searchParams.get('samples') || '';
  if (joined) {
    for (const part of joined.split(/\s*\|\|\s*|\s*\n\s*/).map(x => x.trim()).filter(Boolean)) rawSamples.push(part);
  }
  const cleaned = [];
  const seen = new Set();
  for (const x of rawSamples) {
    const t = normalizeText(x);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    cleaned.push(t);
    if (cleaned.length >= 24) break;
  }
  return cleaned;
}

async function diagnoseCustomBenchmark(url) {
  const scanAll = url.searchParams.get('scan') === '1';
  const model = url.searchParams.get('model') || '';
  let samples = parseBenchmarkSamples(url);
  if (samples.length === 0) {
    samples = [];
    return { ok:false, version:'v74-custom-benchmark-requires-samples', error:'missing samples', note:'Pass sample=... repeatedly or samples=a||b||c. No built-in sentence samples are used.' };
  }
  const results = [];
  for (const sample of samples) {
    results.push(await diagnoseAcceptabilityWithModels(sample, model, scanAll));
  }
  const matrix = results.map(r => {
    const judgements = r?.hfDiagnostic?.judgements || [];
    return {
      text: r.text,
      baseGameOk: !!(r.baseGate?.ok && r.baseGate?.gameOk !== false && r.baseGate?.type === 'complete_sentence'),
      languageToolBlocking: !!r.baseGate?.languageToolBlocking,
      rejectedBy: judgements.filter(j => j.ok && j.acceptable === false).map(j => ({ model:j.model, confidence:j.confidence, reason:j.reason, top:j.top })).slice(0, 10),
      acceptedBy: judgements.filter(j => j.ok && j.acceptable === true).map(j => ({ model:j.model, confidence:j.confidence, reason:j.reason, top:j.top })).slice(0, 10),
      unavailable: judgements.filter(j => !j.ok || j.acceptable === null).map(j => ({ model:j.model, error:j.error || '', reason:j.reason || '' })).slice(0, 10)
    };
  });
  return {
    ok:true,
    version:'v74-custom-benchmark-no-built-in-samples',
    note:'diagnostic only; /check is unchanged. Use scan=1 to compare all HF_SCAN_MODELS. Use sample=... repeatedly or samples=a||b||c for custom cases.',
    model:model || (scanAll ? 'HF_SCAN_MODELS' : 'textattack/roberta-base-CoLA'),
    scanAll,
    samples,
    matrix,
    results
  };
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

    if (url.pathname === '/diagnose-custom-benchmark' || url.pathname === '/diagnose-model-custom' || url.pathname === '/diagnose-modal-benchmark') {
      return send(res, 200, await diagnoseCustomBenchmark(url));
    }
    if (url.pathname === '/diagnose-model-benchmark') {
      return send(res, 200, await diagnoseCustomBenchmark(url));
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
        reasonProvider:'strict-link-grammar-languagetool-hf-grammar-gate-v74-no-local-grammar-hardcode',
        quotaFree:true,
        hfDisabledForReason:true,
        hfDisabledForAcceptability:!ACCEPTABILITY_HF_ENABLED,
        hfAcceptabilityGameGateEnabled: ACCEPTABILITY_HF_GAME_GATE_ENABLED,
        hfAcceptabilityModel: ACCEPTABILITY_HF_MODEL,
        hfAcceptabilitySecondaryEnabled: ACCEPTABILITY_HF_SECONDARY_ENABLED,
        hfAcceptabilitySecondaryModel: ACCEPTABILITY_HF_SECONDARY_MODEL,
        hfAcceptabilitySecondaryRejectMinConfidence: ACCEPTABILITY_HF_SECONDARY_REJECT_MIN_CONF,
        hfAcceptabilityFailClosed: ACCEPTABILITY_HF_FAIL_CLOSED,
        hfAcceptabilityDailyMax: ACCEPTABILITY_HF_DAILY_MAX,
        hfAcceptabilityStats,
        hfAcceptabilityCacheSize: hfAcceptabilityCache.size,
        hfAcceptabilityCacheKeyPolicy:'exact-text-case-sensitive-v45',
        reasonExplorePolicy:'depth-timeslice-action-bucket-plus-external-classifier-v65-dual-hf-gate',
        browserQueryContext:true, reasonHfNetworkDisabled:true, reasonDisplayHfFilter:false, reasonExternalShallowJudge:'disabled-reason-uses-strict-link-grammar-api-only-v80', reasonLocalPrefilterEnabled:false, reasonFinalHfTimeoutMs:REASON_FINAL_HF_TIMEOUT_MS, reasonFinalHfParallel:REASON_FINAL_HF_PARALLEL, reasonExternalVerifyMaxPerDepth:REASON_EXTERNAL_VERIFY_MAX_PER_DEPTH, reasonLightCandidateWindowPerDepth:REASON_LIGHT_CANDIDATE_WINDOW_PER_DEPTH, reasonActionBucketQuota:REASON_ACTION_BUCKET_QUOTA, reasonStreamingSoftDeadlineMs:REASON_STREAMING_SOFT_DEADLINE_MS,
        acceptanceGate: ACCEPTABILITY_HF_GAME_GATE_ENABLED ? 'strict-link-grammar-plus-languagetool-plus-hf-grammar-gate' : 'strict-link-grammar-plus-languagetool-only-game-gate',
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
        reasonDeckCandidates: wordsFromQuery(url, ['reasonDeckCandidates','reasonCandidates','deckCandidates','deck','deckWords'], 220),
        reasonWordMetaMap: parseWordMetaQuery(url.searchParams.get('wordMetaMap') || url.searchParams.get('reasonWordMetaMap') || '')
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

    if (url.pathname === '/reason-job-context') {
      const text = await getTextFromReq(req, url);
      if (!text) return send(res, 400, { ok:false, error:'empty text' });
      const diagnostics = {
        judgeSource:'displayed-reject-reason-job-context-v96-same-game-api-gate',
        strictGameGate: url.searchParams.get('strictGameGate') === '1' || url.searchParams.get('acceptabilityModelGate') === '1',
        acceptabilityModelGate: url.searchParams.get('acceptabilityModelGate') === '1',
        reasonBoardCandidates: wordsFromQuery(url, ['reasonBoardCandidates','boardCandidates','board','boardWords'], 80),
        reasonHandCandidates: wordsFromQuery(url, ['reasonHandCandidates','handCandidates','hand','handWords'], 80),
        reasonDeckCandidates: wordsFromQuery(url, ['reasonDeckCandidates','reasonCandidates','deckCandidates','deck','deckWords'], 220),
        reasonWordMetaMap: parseWordMetaQuery(url.searchParams.get('wordMetaMap') || url.searchParams.get('reasonWordMetaMap') || '')
      };
      const job = enqueueReasonJob(normalizeText(text), diagnostics);
      return send(res, 200, { ok:true, text: normalizeText(text), contextReceived: diagnostics, next:`/reason-result?id=${job?.id || ''}`, ...publicReasonJob(job) });
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
        wordMeta: Array.isArray(body.wordMeta) ? body.wordMeta : [],
        reasonWordMetaMap: Array.isArray(body.reasonWordMetaMap) ? body.reasonWordMetaMap : (Array.isArray(body.wordMetaMap) ? body.wordMetaMap : parseWordMetaQuery(url.searchParams.get('wordMetaMap') || url.searchParams.get('reasonWordMetaMap') || '')),
        reasonBoardCandidates: body.reasonBoardCandidates || body.boardCandidates || queryBoardCandidates,
        reasonHandCandidates: body.reasonHandCandidates || body.handCandidates || queryHandCandidates,
        reasonDeckCandidates: body.reasonDeckCandidates || body.reasonCandidates || body.deckCandidates || queryDeckCandidates,
        reasonDisabled: body.reasonDisabled === true || body.disableReasonJob === true || body.reasonMode === 'none' || url.searchParams.get('reasonMode') === 'none' || url.searchParams.get('reasonDisabled') === '1',
        reasonMode: body.reasonMode || url.searchParams.get('reasonMode') || ''
      };
      return send(res, 200, await checkSentence(text, url.pathname === '/check-and-translate', reasonMeta));
    }
    return send(res, 404, { ok:false, error:'not found' });
  } catch (e) {
    return send(res, 500, { ok:false, error:String(e.message || e), status:e.status || null, body:e.body || null });
  }
});

server.on('upgrade', (req, socket) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/room/')) return handleEnglishRoomUpgrade(req, socket);
  } catch {}
  try { socket.destroy(); } catch {}
});

server.listen(PORT, () => console.log(`Strict Link Grammar + LanguageTool v120 oneshot rollback API listening on ${PORT}`));
