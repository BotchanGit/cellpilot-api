#!/usr/bin/env node
/**
 * A fake backend that implements only the core of the CellPilot Device API (spec/) and
 * declares no features. It exists to prove that the app and tools/api-check.mjs work with the
 * smallest backend someone could build themselves: no snapshot, notify, push, contacts, trash,
 * voicemail, settings, security, log, places, search, screening or portal.
 *
 *   node tools/mock-backend.mjs [--port 8799] [--host 0.0.0.0] [--incoming] [--code 123456] [--history 250] [--token-header]
 *                                 [--tls <dir>] [--mtls <dir>]
 *
 * Nothing is real: there is no device, calls are a timer-driven state machine, sent messages go
 * nowhere, and every piece of state lives in memory and is gone on exit. The console shows a
 * six-digit pairing code (single-use; a new one is printed after each pairing). --incoming makes
 * a fake SMS arrive every 60 s so the event stream can be watched. Simulated happenings, typed on
 * stdin or posted from this machine to the spec's simulation hooks (spec/device-api.md, *Testing*):
 *   sms <from> <text>    POST /_sim/sms {"from","text"}   an SMS arrives
 *   call [<from>]        POST /_sim/call {"from"}         a call rings (20 s, then missed); the app can answer it
 *   hangup               POST /_sim/hangup                the far end hangs up
 *   answer               POST /_sim/answer                the far end answers the outgoing call now
 * Outgoing calls are otherwise answered after 2 s.
 * Node >= 22, no dependencies: the WebSocket for GET /v1/events is done by hand (RFC 6455).
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = { port: 8799, host: '0.0.0.0', incoming: false, code: null, history: 0, tokenHeader: false, tls: null, mtls: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--port') opt.port = Number(args[++i]);
  else if (a === '--host') opt.host = args[++i] ?? '';
  else if (a === '--incoming') opt.incoming = true;
  // A fixed pairing code that stays valid after use, for automated tests such as api-check --code.
  else if (a === '--code') opt.code = args[++i] ?? '';
  // That many older calls under the seeded ones, to page through (the oldest is with +15555550150).
  else if (a === '--history') opt.history = Number(args[++i]);
  // The endpoints it lists ask for the token in X-CellPilot-Token, as behind a proxy that keeps
  // Authorization for itself: the app must follow.
  else if (a === '--token-header') opt.tokenHeader = true;
  // HTTPS on port + 1 with server.crt / server.key from <dir> (self-signed): the endpoint it lists
  // pins that certificate. Pairing stays on plain HTTP at the port, where the app can reach it.
  else if (a === '--tls') opt.tls = args[++i] ?? '';
  // The HTTPS listener also asks for a client certificate signed by <dir>/ca.crt, and the
  // endpoint carries <dir>/client.p12 with the password in <dir>/client.password.
  else if (a === '--mtls') opt.mtls = args[++i] ?? '';
  else if (a === '-h' || a === '--help') usage();
  else usage(`unknown argument: ${a}`);
}
if (!Number.isInteger(opt.port) || opt.port < 1 || opt.port > 65535 || !opt.host) usage('bad --port or --host');
if (opt.code !== null && !/^\d{6}$/.test(opt.code)) usage('--code must be six digits');
if (!Number.isInteger(opt.history) || opt.history < 0 || opt.history > 5000) usage('--history must be 0 to 5000');

function usage(problem) {
  if (problem) console.error(problem);
  console.error('usage: node tools/mock-backend.mjs [--port 8799] [--host 0.0.0.0] [--incoming] [--code 123456] [--history 250] [--token-header] [--tls <dir>] [--mtls <dir>]');
  process.exit(problem ? 2 : 0);
}

const BACKEND = { name: 'mock-backend', version: '0.1.0' };
const FEATURES = [];
const startedAt = Date.now();
const iso = (t = Date.now()) => new Date(t).toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- endpoints --------------------------------------------------------------------------------

/** What GET /v1/client lists: the address(es) this process listens on, LAN first. */
function listEndpoints() {
  const wildcard = opt.host === '0.0.0.0' || opt.host === '::';
  if (!wildcard) return [{ id: 'direct', label: 'Mock backend', url: `http://${opt.host.includes(':') ? `[${opt.host}]` : opt.host}:${opt.port}`, priority: 0 }];
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n, i) => ({ id: i ? `lan${i}` : 'lan', label: 'Local network', url: `http://${n.address}:${opt.port}`, priority: i }));
  return [...lan, { id: 'loopback', label: 'This machine', url: `http://127.0.0.1:${opt.port}`, priority: lan.length }];
}
const tlsFiles = opt.tls ? { cert: fs.readFileSync(path.join(opt.tls, 'server.crt')), key: fs.readFileSync(path.join(opt.tls, 'server.key')) } : null;
const mtlsFiles = opt.mtls ? {
  ca: fs.readFileSync(path.join(opt.mtls, 'ca.crt')),
  p12: fs.readFileSync(path.join(opt.mtls, 'client.p12')).toString('base64'),
  password: fs.readFileSync(path.join(opt.mtls, 'client.password'), 'utf8').trim(),
} : null;
/** With --tls the only endpoint is the HTTPS one, pinned (and with --mtls, with its client certificate). */
function secureEndpoints() {
  const pin = crypto.createHash('sha256').update(new crypto.X509Certificate(tlsFiles.cert).raw).digest('base64');
  const host = opt.host === '0.0.0.0' || opt.host === '::' ? '127.0.0.1' : opt.host;
  return [{
    id: 'secure', label: 'Mock backend (TLS)', url: `https://${host}:${opt.port + 1}`, priority: 0, tlsPin: pin,
    ...(mtlsFiles ? { clientCertificate: { p12: mtlsFiles.p12, password: mtlsFiles.password } } : {}),
  }];
}
const endpoints = (tlsFiles ? secureEndpoints() : listEndpoints()).map((e) => (opt.tokenHeader ? { ...e, tokenHeader: 'X-CellPilot-Token' } : e));

// ---- clients and pairing ----------------------------------------------------------------------

const clients = new Map(); // id -> { id, name, lang, platform, uid, tokenHash }
const tokens = new Map(); // token hash -> client id
const revoked = new Set(); // token hashes that answer 410 signed_out: unpaired, not replaced
let nextClientId = 1;
let pairingCode = newCode();

function newCode() { return opt.code ?? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }
function showCode(why) { console.log(`[pair] ${why}: pairing code ${pairingCode}`); }
const clientView = (c) => ({ id: c.id, name: c.name, lang: c.lang });
// Labels are in the reader's language, as every generated text is.
const LABELS_ZH = { 'Local network': '本地网络', 'This machine': '本机', 'Mock backend': '模拟后端', 'Mock backend (TLS)': '模拟后端（TLS）' };
const endpointsFor = (lang) => endpoints.map((e) => (lang === 'zh' ? { ...e, label: LABELS_ZH[e.label] ?? e.label } : e));
const clientConfig = (c) => ({ client: clientView(c), endpoints: endpointsFor(c.lang) });
/** Any tag starting "zh" (zh, zh-Hans, zh-HK) is Chinese; everything else English. */
const isUuid = (v) => typeof v === 'string' && /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(v);
const asLang = (v) => (typeof v === 'string' && v.toLowerCase().startsWith('zh') ? 'zh' : 'en');

/** The client's token stops working: 410 when it was signed out, unknown (401) when pairing again replaced it. */
function retire(client, signedOut) {
  if (!client.tokenHash) return;
  tokens.delete(client.tokenHash);
  if (signedOut) revoked.add(client.tokenHash);
  for (const s of sockets) if (s.clientId === client.id) s.close(1000, 'signed out');
}

// ---- seed data --------------------------------------------------------------------------------

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const now0 = Date.now();
const messages = []; // oldest first; ids ascend with time
let nextMessageId = 1;
function addMessage(direction, peer, body, at, read) {
  // Every field is present: no device time, no parts (single-part only), no error.
  const m = { id: nextMessageId++, direction, peer, body, status: direction === 'in' ? 'received' : 'sent', createdAt: iso(at), deviceTime: null, parts: null, error: null, read };
  messages.push(m);
  return m;
}
addMessage('in', '+15555550101', 'Hey, are we still on for lunch?', now0 - 2 * DAY, true);
addMessage('out', '+15555550101', 'Yes, 12:30 at the usual place.', now0 - 2 * DAY + 5 * MIN, true);
addMessage('in', '+15555550101', 'Great, see you there.', now0 - 2 * DAY + 7 * MIN, true);
addMessage('in', '+15555550101', 'Running 10 minutes late, sorry!', now0 - 20 * MIN, false);
addMessage('out', '+15555550102', 'Did the package arrive?', now0 - 5 * HOUR, true);
addMessage('in', '+15555550102', 'It did, thanks.', now0 - 4 * HOUR, true);
addMessage('out', '+15555550102', 'Good to hear.', now0 - 4 * HOUR + 2 * MIN, true);
addMessage('in', '+15555550103', 'Your verification code is 482913.', now0 - 3 * HOUR, false);
addMessage('in', '+15555550103', 'Do not share this code with anyone.', now0 - 3 * HOUR + 1000, false);

const calls = []; // oldest first
let nextCallId = 1;
function addCall(direction, peer, startAt, answeredAfterS, lengthS, outcome) {
  const answeredAt = answeredAfterS === null ? null : startAt + answeredAfterS * 1000;
  const endedAt = (answeredAt ?? startAt) + lengthS * 1000;
  const r = {
    id: nextCallId++, direction, peer, contactId: null, startedAt: iso(startAt), answeredAt: answeredAt === null ? null : iso(answeredAt),
    endedAt: iso(endedAt), outcome, durationS: answeredAt === null ? null : lengthS, endReason: null, place: null, carrier: null,
  };
  calls.push(r);
  return r;
}
for (let k = opt.history; k > 0; k--) {
  addCall(k % 2 ? 'in' : 'out', k === opt.history ? '+15555550150' : '+15555550160', now0 - (4 + k) * HOUR - 3 * DAY, 5, 40 + k, 'completed');
}
addCall('out', '+15555550101', now0 - 3 * DAY, 6, 184, 'completed');
addCall('in', '+15555550102', now0 - 2 * DAY, 4, 62, 'completed');
addCall('out', '+15555550103', now0 - DAY, null, 30, 'no-answer');
addCall('in', '+15555550105', now0 - 8 * HOUR, null, 3, 'missed'); // declined: a declined call is a missed one
addCall('in', '+15555550104', now0 - 90 * MIN, null, 25, 'missed');

// ---- derived views ----------------------------------------------------------------------------

function conversationList() {
  const byPeer = new Map();
  for (const m of messages) {
    // name, contactId and place belong to features this backend does not declare: null.
    const c = byPeer.get(m.peer) ?? { peer: m.peer, name: null, contactId: null, place: null, lastBody: '', lastAt: '', lastDirection: 'in', unread: 0 };
    c.lastBody = m.body; c.lastAt = m.createdAt; c.lastDirection = m.direction;
    if (m.direction === 'in' && !m.read) c.unread++;
    byPeer.set(m.peer, c);
  }
  return [...byPeer.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/** Newest first, ids below beforeId, at most limit. */
function page(list, { beforeId, limit }) {
  const out = [];
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) if (beforeId === undefined || list[i].id < beforeId) out.push(list[i]);
  return out;
}

let signalRssi = 22;
function device() {
  return {
    connected: true,
    identity: { manufacturer: 'Mock', model: 'MOCK-1', firmware: 'mock-0.1.0', imei: '000000000000000', imsi: '001010000000000', iccid: '8900100000000000000', ownNumber: '+15555550100' },
    sim: 'ready',
    signal: { rssi: signalRssi, dbm: -113 + 2 * signalRssi },
    registration: 'registered',
    operator: 'Mock Mobile',
    rat: 'FDD LTE',
    band: 'LTE BAND 3',
    volte: true,
    smsStorage: { used: 0, total: 255 },
    home: { country: 'US', areaCode: null },
    location: { country: 'US' },
    updatedAt: iso(),
  };
}
const backendInfo = () => ({ ...BACKEND, uptimeS: Math.floor((Date.now() - startedAt) / 1000) });
// No audio is ever carried, so audio.ready is honestly false.
const statusObject = () => ({ backend: backendInfo(), device: device(), call, holder, audio: { ready: false, active: false } });

// ---- the call ---------------------------------------------------------------------------------

let call = null; // { id, state, direction, number, contactId, place, startedAt, answeredAt }
let holder = null; // { clientId, name }
let callTimers = [];
const callState = () => ({ call, holder });

/** A call's record exists from its first ring, in-progress; the calls event follows only when it ends. */
function startCall(direction, number) {
  call = { id: nextCallId++, state: direction === 'in' ? 'incoming' : 'dialing', direction, number, contactId: null, place: null, startedAt: iso(), answeredAt: null };
  calls.push({ id: call.id, direction, peer: number ? peerFor(number) : '', contactId: null, startedAt: call.startedAt, answeredAt: null, endedAt: null, outcome: 'in-progress', durationS: null, endReason: null, place: null, carrier: null });
  broadcast({ type: 'call', ...callState() });
}

function setCallState(state, extra = {}) {
  call = { ...call, state, ...extra };
  if (state === 'active') {
    const r = calls.find((c) => c.id === call.id);
    if (r) Object.assign(r, { answeredAt: call.answeredAt, outcome: 'answered' });
  }
  broadcast({ type: 'call', ...callState() });
}

/** `outcome` when the call never connected: missed for an incoming one (declined too), failed when the caller hung up first. */
function endCall(unanswered) {
  for (const t of callTimers) clearTimeout(t);
  callTimers = [];
  const end = Date.now();
  const answered = call.answeredAt ? Date.parse(call.answeredAt) : null;
  const r = calls.find((c) => c.id === call.id);
  if (r) Object.assign(r, {
    endedAt: iso(end),
    outcome: answered ? 'completed' : unanswered ?? (call.direction === 'in' ? 'missed' : 'failed'),
    durationS: answered ? Math.round((end - answered) / 1000) : null,
  });
  call = null; holder = null;
  broadcast({ type: 'call', ...callState() });
  broadcast({ type: 'calls', calls: page(calls, { limit: 50 }) });
}

// ---- errors -----------------------------------------------------------------------------------

const TEXT = {
  invalid_request: { en: 'The request is missing a field or has a malformed one.', zh: '请求缺少字段或字段格式不对。' },
  invalid_json: { en: 'The body is not valid JSON.', zh: '请求体不是有效的 JSON。' },
  too_large: { en: 'The body is too large.', zh: '请求体太大。' },
  unauthorized: { en: 'No valid token.', zh: '没有有效的令牌。' },
  bad_code: { en: 'That pairing code is not valid.', zh: '配对码无效。' },
  not_found: { en: 'Not found.', zh: '未找到。' },
  feature_unavailable: { en: 'This backend does not offer that feature.', zh: '此后端不提供该功能。' },
  conflict: { en: 'That does not fit the current call state.', zh: '与当前通话状态不符。' },
  signed_out: { en: 'This client was signed out; pair again.', zh: '此客户端已退出，请重新配对。' },
  rate_limited: { en: 'Too many failed attempts; try again later.', zh: '失败次数过多，请稍后再试。' },
  internal: { en: 'Something went wrong.', zh: '出错了。' },
};
class ApiError extends Error {
  constructor(status, code, { text = code, details, headers } = {}) {
    super(code);
    Object.assign(this, { status, code, text, details, headers });
  }
}
const invalid = (field) => new ApiError(400, 'invalid_request', { details: { field } });
/** A number as stored: as typed, less grouping — digits, a leading "+", "*" and "#". Nothing is added. */
const stored = (raw) => [...raw.trim()].reduce((out, ch) => (/[0-9*#]/.test(ch) || (ch === '+' && out === '') ? out + ch : out), '');
/** The digits that identify a number: "00" and trunk zeros off. */
const numberKey = (raw) => raw.replace(/\D/g, '').replace(/^00/, '').replace(/^0+/, '');
/** Same number written two ways: equal keys, or one the tail of the other with at least seven digits. */
function sameNumber(a, b) {
  const ka = numberKey(a), kb = numberKey(b);
  if (!ka || !kb) return false;
  const [short, long] = ka.length < kb.length ? [ka, kb] : [kb, ka];
  return ka === kb || (short.length >= 7 && long.endsWith(short));
}
/** One person, one conversation: a number written another way goes under the peer already on file. */
function peerFor(number) {
  const known = [...messages.map((m) => m.peer), ...calls.map((c) => c.peer)].filter(Boolean);
  return known.includes(number) ? number : known.reverse().find((p) => sameNumber(p, number)) ?? number;
}
const notFound = () => new ApiError(404, 'not_found');
const conflict = () => new ApiError(409, 'conflict');

function errorBody(e, lang) {
  const error = { code: e.code, message: (TEXT[e.text] ?? TEXT.internal)[lang] };
  if (e.details) error.details = e.details;
  return { error };
}

// ---- HTTP -------------------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new ApiError(413, 'invalid_request', { text: 'too_large' });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let body;
  try { body = JSON.parse(text); } catch { throw new ApiError(400, 'invalid_request', { text: 'invalid_json' }); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_request', { text: 'invalid_json' });
  return body;
}

/** beforeId and limit: a value that is not a whole number is taken as absent; limit is clamped to 1–500. */
function paging(url) {
  const q = url.searchParams;
  const int = (name) => (/^\d+$/.test(q.get(name) ?? '') ? Number(q.get(name)) : undefined);
  return { beforeId: int('beforeId'), limit: Math.max(1, Math.min(int('limit') ?? 100, 500)) };
}

// ---- rate limiting ------------------------------------------------------------------------------
// Per source address: 5 distinct wrong values (pairing codes, unknown tokens) within 10 minutes block
// it for 15. The block stops only guesses: a token that works, the right code and a revoked token
// are answered as usual. A success clears the count. Every 429 carries Retry-After.
const guard = new Map(); // address -> { tries: Map<value hash, time>, blockedUntil }
const entry = (ip) => guard.get(ip) ?? guard.set(ip, { tries: new Map(), blockedUntil: 0 }).get(ip);
const blocked = (ip) => entry(ip).blockedUntil > Date.now();
const tooMany = (ip) => new ApiError(429, 'rate_limited', { headers: { 'Retry-After': String(Math.max(1, Math.ceil((entry(ip).blockedUntil - Date.now()) / 1000))) } });
function guess(ip, value) {
  const e = entry(ip);
  if (blocked(ip)) throw tooMany(ip);
  for (const [k, t] of e.tries) if (Date.now() - t > 10 * MIN) e.tries.delete(k);
  e.tries.set(sha256(value), Date.now());
  if (e.tries.size >= 5) { e.blockedUntil = Date.now() + 15 * MIN; e.tries.clear(); throw tooMany(ip); }
}
const succeeded = (ip) => entry(ip).tries.clear();

/** The client a request's token names; 401 for none or an unknown one, 410 for a revoked one. Headers only. */
function authenticate(req) {
  const ip = req.socket.remoteAddress ?? '?';
  // Either header carries the token: X-CellPilot-Token where a proxy keeps Authorization.
  const own = typeof req.headers['x-cellpilot-token'] === 'string' ? req.headers['x-cellpilot-token'].trim() : '';
  const header = req.headers.authorization ?? '';
  const token = own || (/^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? '');
  // With --token-header, a token in Authorization is refused, so a client that ignores the
  // endpoint's tokenHeader shows up at once. A deliberate departure from the spec (a backend
  // accepts either header), for testing clients; without the flag both are accepted.
  if (opt.tokenHeader && !own && token) throw new ApiError(401, 'unauthorized');
  if (!token) throw new ApiError(401, 'unauthorized');
  const hash = sha256(token);
  const client = clients.get(tokens.get(hash));
  if (client) { succeeded(ip); return client; }
  if (revoked.has(hash)) throw new ApiError(410, 'signed_out');
  guess(ip, token);
  throw new ApiError(401, 'unauthorized');
}

/** Routes of features this backend does not declare: 404 feature_unavailable. */
const FEATURE_ROUTES = [
  /^\/snapshot$/, /^\/contacts(\/.*)?$/, /^\/messages\/search$/, /^\/messages\/[^/]+\/trash$/, /^\/trash(\/.*)?$/,
  /^\/voicemails(\/.*)?$/, /^\/settings$/, /^\/security(\/.*)?$/, /^\/log$/, /^\/push(\/.*)?$/,
  /^\/client\/push-tokens(\/.*)?$/, /^\/portal\/session$/, /^\/call\/(screen|claim)$/,
];

function peerParam(raw) {
  let peer;
  try { peer = decodeURIComponent(raw); } catch { throw invalid('peer'); }
  if (!peer) throw invalid('peer');
  return peer;
}
const idParam = (raw) => {
  if (!/^\d+$/.test(raw)) throw invalid('id');
  return Number(raw);
};

async function route(req, res, url, path, lang) {
  const m = req.method;

  // No token needed.
  if (path === '' || path === '/') {
    if (m !== 'GET') throw notFound();
    return send(res, 200, { api: 'cellpilot-device-api', version: 1, backend: BACKEND, features: FEATURES });
  }
  if (path === '/ping') {
    if (m !== 'GET') throw notFound();
    return send(res, 200, { ok: true });
  }
  if (path === '/pair') {
    if (m !== 'POST') throw notFound();
    return pair(req, res);
  }

  const client = authenticate(req);
  if (FEATURE_ROUTES.some((r) => r.test(path))) throw new ApiError(404, 'feature_unavailable');
  let seg;

  if (path === '/client') {
    if (m === 'GET') return send(res, 200, clientConfig(client));
    if (m === 'PATCH') {
      const b = await readJson(req);
      if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim())) throw invalid('name');
      if (b.uid !== undefined && !isUuid(b.uid)) throw invalid('uid');
      if (b.name !== undefined) client.name = b.name.trim().slice(0, 60);
      if (b.lang !== undefined) client.lang = asLang(b.lang);
      if (b.uid !== undefined) client.uid = b.uid.toUpperCase();
      sendTo(client.id, { type: 'client', ...clientConfig(client) });
      return send(res, 200, clientConfig(client));
    }
    if (m === 'DELETE') {
      retire(client, true);
      clients.delete(client.id);
      console.log(`[pair] client ${client.id} (${client.name}) unpaired itself`);
      return send(res, 200, {});
    }
    throw notFound();
  }

  if (path === '/status' && m === 'GET') return send(res, 200, statusObject());
  if (path === '/call' && m === 'GET') return send(res, 200, callState());

  if ((seg = /^\/call\/(dial|answer|hangup|dtmf)$/.exec(path)) && m === 'POST') {
    const action = seg[1];
    const b = await readJson(req);
    if (action === 'dial') {
      const number = typeof b.number === 'string' ? stored(b.number) : '';
      if (!/^\+?[0-9*#]{1,32}$/.test(number)) throw invalid('number');
      if (call) throw conflict();
      holder = { clientId: client.id, name: client.name };
      startCall('out', number);
      callTimers.push(setTimeout(() => call && setCallState('alerting'), 1000));
      callTimers.push(setTimeout(() => call && setCallState('active', { answeredAt: iso() }), 2000));
    } else if (action === 'answer') {
      if (!call || call.state !== 'incoming') throw conflict();
      holder = { clientId: client.id, name: client.name };
      setCallState('active', { answeredAt: iso() });
    } else if (action === 'hangup') {
      if (call) endCall();
    } else {
      if (typeof b.digits !== 'string' || !/^[0-9*#]{1,32}$/.test(b.digits)) throw invalid('digits');
      if (!call || call.state !== 'active') throw conflict();
      console.log(`[call] DTMF ${b.digits} (simulated)`);
    }
    return send(res, 200, callState());
  }

  if (path === '/calls' && m === 'GET') return send(res, 200, { calls: page(calls, paging(url)) });
  if ((seg = /^\/calls\/([^/]+)$/.exec(path)) && m === 'DELETE') {
    const id = idParam(seg[1]);
    const at = calls.findIndex((c) => c.id === id);
    if (at < 0) throw notFound();
    calls.splice(at, 1);
    broadcast({ type: 'calls', calls: page(calls, { limit: 100 }) });
    return send(res, 200, {});
  }

  if (path === '/conversations' && m === 'GET') return send(res, 200, { conversations: conversationList() });
  if ((seg = /^\/conversations\/([^/]+)\/messages$/.exec(path)) && m === 'GET') {
    const peer = peerParam(seg[1]);
    return send(res, 200, { messages: page(messages.filter((x) => x.peer === peer), paging(url)) });
  }
  if ((seg = /^\/conversations\/([^/]+)\/read$/.exec(path)) && m === 'POST') {
    const peer = peerParam(seg[1]);
    let changed = false;
    for (const x of messages) if (x.peer === peer && !x.read) { x.read = true; changed = true; }
    if (changed) broadcastConversations();
    return send(res, 200, {});
  }
  if ((seg = /^\/conversations\/([^/]+)$/.exec(path)) && m === 'DELETE') {
    const peer = peerParam(seg[1]);
    const before = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].peer === peer) messages.splice(i, 1);
    if (messages.length !== before) broadcastConversations();
    return send(res, 200, {});
  }

  if (path === '/messages' && m === 'POST') {
    const b = await readJson(req);
    const to = typeof b.to === 'string' ? stored(b.to) : '';
    if (!/^\+?[0-9]{3,20}$/.test(to)) throw invalid('to');
    if (typeof b.text !== 'string' || !b.text.length) throw invalid('text');
    // Answered as pending, as the spec says; "sent" follows on the event stream. Nothing leaves.
    const msg = addMessage('out', peerFor(to), b.text, Date.now(), true);
    msg.status = 'pending';
    // Recorded: a message event only; the conversation list moves when it is sent or fails.
    broadcast({ type: 'message', message: msg });
    setTimeout(() => {
      if (!messages.includes(msg)) return;
      msg.status = 'sent';
      broadcast({ type: 'message', message: msg });
      broadcastConversations();
    }, 300);
    console.log(`[sms] pretended to send to ${b.to}: ${JSON.stringify(b.text).slice(0, 60)}`);
    return send(res, 200, { message: msg });
  }
  if ((seg = /^\/messages\/([^/]+)$/.exec(path)) && m === 'DELETE') {
    const id = idParam(seg[1]);
    const at = messages.findIndex((x) => x.id === id);
    if (at < 0) throw notFound();
    messages.splice(at, 1);
    broadcastConversations();
    return send(res, 200, {});
  }

  throw notFound();
}

async function pair(req, res) {
  const ip = req.socket.remoteAddress ?? '?';
  const b = await readJson(req);
  if (typeof b.code !== 'string') throw invalid('code');
  const code = b.code.replace(/\D/g, '');
  const ok = code.length === pairingCode.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pairingCode));
  if (!ok) {
    guess(ip, code);
    throw new ApiError(401, 'unauthorized', { text: 'bad_code' });
  }
  succeeded(ip);
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : 'iPhone';
  const uid = isUuid(b.uid) ? b.uid.toUpperCase() : null; // anything but a UUID is ignored
  // The same installation pairing again replaces its record: same id, new token, old token dead.
  let client = uid ? [...clients.values()].find((c) => c.uid === uid) : undefined;
  if (client) retire(client, false);
  else { client = { id: nextClientId++ }; clients.set(client.id, client); }
  const token = crypto.randomBytes(32).toString('base64url');
  Object.assign(client, { name, lang: asLang(b.lang), platform: typeof b.platform === 'string' ? b.platform.slice(0, 20) : 'ios', uid, tokenHash: sha256(token) });
  tokens.set(client.tokenHash, client.id);
  pairingCode = newCode();
  console.log(`[pair] paired client ${client.id} (${name})`);
  showCode('code used, new one');
  return send(res, 200, { token, ...clientConfig(client) });
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const lang = asLang(req.headers['x-lang'] ?? url.searchParams.get('lang'));
  res.on('finish', () => console.log(`${req.method} ${url.pathname}${url.search} ${res.statusCode}`));
  try {
    if (url.pathname.startsWith('/_sim/')) return await simHook(req, res, url.pathname.slice(6));
    if (url.pathname !== '/v1' && !url.pathname.startsWith('/v1/')) throw notFound();
    await route(req, res, url, url.pathname.slice(3), lang);
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(500, 'internal');
    if (!(e instanceof ApiError)) console.error(e);
    if (!res.headersSent) send(res, err.status, errorBody(err, lang), err.headers);
  }
}
const server = http.createServer(handle);

// ---- event stream (RFC 6455 by hand) ----------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sockets = new Set();

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

class EventSocket {
  constructor(socket, clientId) {
    Object.assign(this, { socket, clientId, buf: Buffer.alloc(0), alive: true, lastPong: Date.now(), closed: false });
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.gone());
    socket.on('error', () => this.gone());
  }
  send(obj) { this.raw(frame(0x1, Buffer.from(JSON.stringify(obj)))); }
  raw(buf) { if (!this.closed && this.socket.writable) this.socket.write(buf); }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0); p.write(reason, 2);
    this.raw(frame(0x8, p));
    this.closed = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
  gone() { this.closed = true; sockets.delete(this); }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { this.close(1009, 'too big'); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      const payload = Buffer.from(this.buf.subarray(off + (masked ? 4 : 0), need));
      if (masked) {
        const key = this.buf.subarray(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      }
      this.buf = this.buf.subarray(need);
      this.onFrame(opcode, payload);
    }
  }
  onFrame(opcode, payload) {
    if (opcode === 0x8) { this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000); return; }
    if (opcode === 0x9) { this.raw(frame(0xA, payload)); return; }
    if (opcode === 0xA) { this.lastPong = Date.now(); return; }
    // Text (an `ack`, which only matters with `notify`), binary uplink audio, continuations: read and dropped.
  }
}

function upgrade(req, socket) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const lang = asLang(req.headers['x-lang'] ?? url.searchParams.get('lang'));
  const refuse = (err) => {
    const body = JSON.stringify(errorBody(err, lang));
    const extra = Object.entries(err.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.end(`HTTP/1.1 ${err.status} ${http.STATUS_CODES[err.status]}\r\n${extra}Content-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    console.log(`GET ${url.pathname} (upgrade) ${err.status}`);
  };
  let client;
  try {
    if (url.pathname !== '/v1/events') throw notFound();
    client = authenticate(req);
  } catch (e) { refuse(e instanceof ApiError ? e : new ApiError(500, 'internal')); return; }
  const key = req.headers['sec-websocket-key'];
  if (req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !(req.headers.upgrade ?? '').toLowerCase().includes('websocket')) {
    refuse(invalid('sec-websocket-key')); return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new EventSocket(socket, client.id);
  sockets.add(ws);
  console.log(`GET /v1/events 101 (client ${client.id})`);
  ws.send({ type: 'hello', backend: backendInfo(), features: FEATURES, status: statusObject() });
}
server.on('upgrade', upgrade);
const secure = tlsFiles
  ? https.createServer({ ...tlsFiles, ...(mtlsFiles ? { ca: mtlsFiles.ca, requestCert: true, rejectUnauthorized: true } : {}) }, handle)
  : null;
secure?.on('upgrade', upgrade);

function broadcast(event) { for (const s of sockets) s.send(event); }
function sendTo(clientId, event) { for (const s of sockets) if (s.clientId === clientId) s.send(event); }
function broadcastConversations() { broadcast({ type: 'conversations', conversations: conversationList() }); }

// Presence: a ping every 10 s; a socket silent for 20 s is closed.
setInterval(() => {
  for (const s of sockets) {
    if (Date.now() - s.lastPong > 20_000) { s.close(1001, 'no pong'); continue; }
    s.raw(frame(0x9, Buffer.alloc(0)));
  }
}, 10_000).unref();

// The signal wanders a little now and then, so a `status` event shows up.
setInterval(() => {
  signalRssi = Math.max(10, Math.min(31, signalRssi + crypto.randomInt(-2, 3)));
  broadcast({ type: 'status', device: device() });
}, 45_000).unref();

if (opt.incoming) {
  const bodies = ['Are you around?', 'Call me when you can.', 'Your code is 135790.', 'On my way.', 'Thanks!'];
  setInterval(() => {
    const peers = ['+15555550101', '+15555550102', '+15555550103', '+15555550106'];
    const msg = addMessage('in', peers[crypto.randomInt(peers.length)], bodies[crypto.randomInt(bodies.length)], Date.now(), false);
    console.log(`[sms] fake incoming from ${msg.peer}: ${msg.body}`);
    broadcast({ type: 'message', message: msg });
    broadcastConversations();
  }, 60_000);
}

// ---- simulated happenings ------------------------------------------------------------------------

function simulate(cmd, a = {}) {
  if (cmd === 'sms') {
    if (typeof a.from !== 'string' || !a.from || typeof a.text !== 'string' || !a.text) return 'sms needs from and text';
    const msg = addMessage('in', peerFor(a.from), a.text, Date.now(), false);
    broadcast({ type: 'message', message: msg });
    broadcastConversations();
  } else if (cmd === 'call') {
    if (call) return 'a call is already up';
    // A withheld caller (from null) rings with an empty number.
    startCall('in', a.from === null ? '' : stored(typeof a.from === 'string' ? a.from : '+15555550107'));
    callTimers.push(setTimeout(() => call?.state === 'incoming' && endCall('missed'), 20_000));
  } else if (cmd === 'hangup') {
    if (call) endCall();
  } else if (cmd === 'answer') {
    if (!call || call.direction !== 'out' || call.state === 'active') return 'no outgoing call waiting to be answered';
    for (const t of callTimers) clearTimeout(t);
    callTimers = [];
    setCallState('active', { answeredAt: iso() });
  } else return 'unknown';
  return null;
}

/** POST /_sim/<sms|call|hangup|answer>, from this machine only. */
async function simHook(req, res, cmd) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  if (!local || req.method !== 'POST') throw notFound();
  const why = simulate(cmd, await readJson(req));
  if (why === 'unknown') throw notFound();
  if (why) throw new ApiError(409, 'conflict');
  return send(res, 200, {});
}

// The same happenings typed on stdin: sms <from> <text> · call [<from>] · hangup · answer
process.stdin.setEncoding('utf8');
let pendingLine = '';
process.stdin.on('data', (chunk) => {
  pendingLine += chunk;
  for (let at; (at = pendingLine.indexOf('\n')) >= 0;) {
    const [cmd, ...rest] = pendingLine.slice(0, at).trim().split(/\s+/);
    pendingLine = pendingLine.slice(at + 1);
    if (!cmd) continue;
    const args = cmd === 'sms' ? { from: rest[0], text: rest.slice(1).join(' ') } : cmd === 'call' ? (rest[0] ? { from: rest[0] } : {}) : {};
    const why = simulate(cmd, args);
    if (why === 'unknown') console.log('commands: sms <from> <text> · call [<from>] · hangup · answer');
    else if (why) console.log(`[sim] ${why}`);
  }
});

// ---- start ------------------------------------------------------------------------------------

secure?.listen(opt.port + 1, opt.host, () => console.log(`  https on ${opt.port + 1}${mtlsFiles ? ' (client certificate required)' : ''}`));
server.listen(opt.port, opt.host, () => {
  console.log(`mock-backend ${BACKEND.version} listening on ${opt.host}:${opt.port} (core only, no features)`);
  for (const e of endpoints) console.log(`  endpoint ${e.id.padEnd(8)} ${e.url}`);
  if (opt.incoming) console.log('  a fake SMS arrives every 60 s');
  showCode('ready');
});
const stop = () => { for (const s of sockets) s.close(1001, 'going away'); server.close(); setTimeout(() => process.exit(0), 200).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
