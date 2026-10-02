#!/usr/bin/env node
/**
 * A local stand-in for the CellPilot push relay, for testing a backend's push path without the real
 * relay or Apple. It checks what the relay checks — the enrolment proof, every request's signature,
 * the timestamp window, nonce replay, that pushes are sealed — and opens each sealed payload with the
 * paired client's token, the way the app does, so you can see exactly what would reach the phone.
 *
 *   node tools/test-relay.mjs [--port 18780] [--client-token <token>]… [--state <file>]
 *
 * Point the backend's relay base URL at http://127.0.0.1:<port> (a test override; the real relay is
 * https://push.cellpilot.dev), then enrol it from the app or by POST /v1/push/enrol with any grant
 * of 16 to 200 characters. The grant "expired-grant-for-testing" is refused, as an expired one would be.
 *
 * Client tokens open the sealed payloads. Give them at start, or add them once paired:
 *   curl -X POST http://127.0.0.1:18780/_tokens -d '{"token":"<client token>"}'
 * --state keeps enrolled backends in a file, so restarting the relay does not un-enrol them.
 *
 * To see how the backend handles the relay's refusals, set the next answers:
 *   curl -X POST http://127.0.0.1:18780/_next -d '{"answer":"quota"}'     # once
 *   curl -X POST http://127.0.0.1:18780/_next -d '{"answer":"quota","times":5}'
 *   curl -X POST http://127.0.0.1:18780/_next -d '{"on":"enrol","answer":"grant"}'
 * push answers: not-enrolled (401), suspended / not-entitled (402), unbound (403), quota / rate
 * (429), gone (410), apns (502), unreachable (500); enrol answers: grant / proof (401), rate (429),
 * unreachable (500); ok (back to normal).
 *
 * Pushes the relay would pass but that break the spec's rules for what the app shows (category,
 * collapse id, sound, interruption level, the sealed fields) are passed too, with "warnings" on
 * their log line. One JSON line per request on stdout. Node >= 22, no dependencies.
 */
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
let port = 18780;
let stateFile = null;
const keys = [];
// The push key, as both ends derive it: HKDF-SHA256 over SHA-256 of the client token.
const addToken = (t) => keys.push(Buffer.from(crypto.hkdfSync('sha256', crypto.createHash('sha256').update(t).digest(), Buffer.from('cellpilot'), Buffer.from('push-v1'), 32)));
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--client-token') addToken(argv[++i]);
  else if (argv[i] === '--state') stateFile = argv[++i];
  else { console.error('usage: node tools/test-relay.mjs [--port 18780] [--client-token <token>]… [--state <file>]'); process.exit(2); }
}
const daemons = new Map(); // id -> public key
if (stateFile && fs.existsSync(stateFile)) for (const [id, k] of Object.entries(JSON.parse(fs.readFileSync(stateFile, 'utf8')))) daemons.set(id, k);
const saveDaemons = () => { if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries(daemons), null, 2)); };
const nonces = new Set();
let next = { on: 'push', answer: 'ok', times: 0 };

// The relay's answers, body and all (the quota is an example value).
const ANSWERS = {
  'not-enrolled': [401, { error: 'not authorized' }],
  suspended: [402, { error: 'account suspended' }],
  'not-entitled': [402, { error: 'not entitled' }],
  unbound: [403, { error: 'token not bound to this daemon' }],
  quota: [429, { error: 'daily quota reached', quota: 1000 }],
  rate: [429, { error: 'rate limited' }],
  gone: [410, { error: 'token gone', gone: true, reason: 'BadDeviceToken' }],
  apns: [502, { error: 'apns refused', status: 400, reason: 'BadTopic' }],
  unreachable: [500, { error: 'relay error' }],
};
const ENROL_ANSWERS = {
  grant: [401, { error: 'grant not accepted' }],
  proof: [401, { error: 'proof not accepted' }],
  rate: [429, { error: 'too many requests' }],
  unreachable: [500, { error: 'relay error' }],
};

// What the app expects of each alert category (spec/device-api.md, *Envelope*): collapse id prefix, sound,
// interruption level, and the sealed data fields.
const CATEGORIES = {
  sms: { collapse: /^sms-\d+$/, sound: 'default', level: 'active', fields: ['peer', 'messageId'] },
  call: { collapse: /^call-\d+$/, sound: 'ringtone.caf', level: 'time-sensitive', fields: ['number', 'callId'] },
  'missed-call': { collapse: /^call-\d+$/, sound: 'default', level: 'active', fields: ['number', 'callId'] },
  voicemail: { collapse: /^(call|voicemail)-\d+$/, sound: 'default', level: 'active', fields: ['voicemailId', 'number', 'callId'] },
  security: { collapse: /^alert-\d+$/, sound: 'default', level: 'time-sensitive', fields: ['alertId'] },
};

/** Spec rules the relay itself does not enforce but the app relies on; [] when the push follows them. */
function warnings(type, b, collapseId, inner) {
  const w = [];
  const badgeOnly = type === 'alert' && b.aps && !b.e;
  if ((badgeOnly || type === 'voip') && collapseId !== undefined) w.push(`a ${badgeOnly ? 'badge-only' : 'VoIP'} push has no collapseId`);
  if (type === 'voip' && inner) {
    if (inner.type === 'end') { if (!Number.isInteger(inner.callId) || typeof inner.reason !== 'string') w.push('a VoIP end seals { type: "end", callId, reason }'); }
    else for (const k of ['callId', 'number', 'name', 'place']) if (!(k in inner)) w.push(`a VoIP push seals ${k}`);
  }
  if (type !== 'alert' || badgeOnly) return w;
  const a = b.aps, cat = CATEGORIES[a.category];
  if (a['mutable-content'] !== 1) w.push('aps.mutable-content must be 1, or the app cannot open e');
  if (!cat) return [...w, `aps.category ${JSON.stringify(a.category)} is not one of ${Object.keys(CATEGORIES).join(', ')}`];
  if (a.category !== 'call' && !Number.isInteger(a.badge)) w.push('every alert push but a ringing call\'s carries aps.badge');
  if (a.sound !== cat.sound) w.push(`aps.sound is ${JSON.stringify(a.sound)}, ${a.category} uses "${cat.sound}"`);
  if (a['interruption-level'] !== cat.level) w.push(`aps.interruption-level is ${JSON.stringify(a['interruption-level'])}, ${a.category} uses "${cat.level}"`);
  if (!cat.collapse.test(collapseId ?? '')) w.push(`collapseId ${JSON.stringify(collapseId)} does not fit ${a.category} (${cat.collapse.source})`);
  if (inner) {
    if (inner.category !== a.category) w.push(`the sealed category ${JSON.stringify(inner.category)} differs from aps.category`);
    for (const k of ['title', 'body']) if (typeof inner[k] !== 'string') w.push(`the sealed ${k} is missing`);
    for (const k of cat.fields) if (!(k in inner)) w.push(`the sealed payload lacks ${k}`);
  }
  return w;
}

const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const reply = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const pubKey = (b64) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' });

function open(sealed) {
  const raw = Buffer.from(sealed, 'base64url');
  for (const key of keys) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(raw.length - 16));
      return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'));
    } catch { /* not this client's */ }
  }
  return null;
}

/** The relay passes only what it cannot read; null when the body is acceptable, else why not. */
function unsealed(type, b) {
  if (!b || typeof b !== 'object') return 'body is not an object';
  const ks = Object.keys(b).sort().join(',');
  if (type === 'alert' && ks === 'aps' && Object.keys(b.aps).join(',') === 'badge') return Number.isInteger(b.aps.badge) && b.aps.badge >= 0 && b.aps.badge <= 99999 ? null : 'bad badge';
  if (typeof b.e !== 'string' || b.e.length < 16 || b.e.length > 4000) return 'e is missing or the wrong size';
  if (type === 'voip') return ks === 'e,v' ? null : `a VoIP push carries only e and v, not ${ks}`;
  if (type !== 'alert') return `type ${type}`;
  if (ks !== 'aps,e,v') return `an alert push carries aps, e and v, not ${ks}`;
  const a = b.aps.alert;
  if (!a || a.title !== 'CellPilot' || typeof a.body !== 'string' || a.body.length > 40) return 'aps.alert must be { title: "CellPilot", body: at most 40 characters }';
  const extra = Object.keys(b.aps).filter((k) => !['alert', 'sound', 'category', 'interruption-level', 'mutable-content', 'thread-id', 'badge'].includes(k));
  return extra.length ? `aps keys not allowed: ${extra.join(', ')}` : null;
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = JSON.parse(text || '{}'); } catch { log({ path: req.url, error: 'invalid json' }); return reply(res, 400, { error: 'json' }); }
  const path = new URL(req.url, 'http://x').pathname;

  if (req.method === 'POST' && path === '/_next') {
    const on = body.on ?? 'push';
    const table = on === 'enrol' ? ENROL_ANSWERS : on === 'push' ? ANSWERS : null;
    if (!table) return reply(res, 400, { error: 'on: push or enrol' });
    if (!table[body.answer] && body.answer !== 'ok') return reply(res, 400, { error: `${on} answers: ${Object.keys(table).join(', ')}, ok` });
    next = { on, answer: body.answer, times: body.answer === 'ok' ? 0 : Number(body.times ?? 1) };
    log({ control: next });
    return reply(res, 200, next);
  }
  if (req.method === 'POST' && path === '/_tokens') {
    if (typeof body.token !== 'string' || !body.token) return reply(res, 400, { error: 'token' });
    addToken(body.token);
    log({ control: 'client token added', clientTokens: keys.length });
    return reply(res, 200, { clientTokens: keys.length });
  }

  if (req.method === 'POST' && path === '/v1/daemons') {
    const { grant, publicKey, proof, label } = body;
    if (next.on === 'enrol' && next.times > 0) {
      next.times--;
      const [status, answer] = ENROL_ANSWERS[next.answer];
      log({ path, ok: false, forced: next.answer, status });
      return reply(res, status, answer);
    }
    if (!grant || !proof || Buffer.from(publicKey || '', 'base64').length !== 32) { log({ path, ok: false, why: 'grant, publicKey and proof' }); return reply(res, 400, { error: 'grant, publicKey and proof' }); }
    let proven = false;
    try { proven = crypto.verify(null, Buffer.from(`cellpilot-enrol\n${grant}`), pubKey(publicKey), Buffer.from(proof, 'base64')); } catch { /* malformed */ }
    if (!proven) { log({ path, ok: false, why: 'proof not accepted' }); return reply(res, 401, { error: 'proof not accepted' }); }
    if (grant === 'expired-grant-for-testing') { log({ path, ok: false, why: 'grant not accepted' }); return reply(res, 401, { error: 'grant not accepted' }); }
    // The same key enrolling again keeps its id.
    let id = [...daemons].find(([, k]) => k === publicKey)?.[0];
    id ??= `d_${crypto.randomBytes(9).toString('base64url')}`;
    daemons.set(id, publicKey);
    saveDaemons();
    log({ path, ok: true, daemonId: id, label });
    return reply(res, 200, { daemonId: id });
  }

  // Everything else is signed: METHOD, path, timestamp, nonce and the body's SHA-256, one per line.
  const id = req.headers['x-relay-key'], ts = req.headers['x-relay-ts'], nonce = req.headers['x-relay-nonce'], sig = req.headers['x-relay-sig'];
  const why = (() => {
    if (!id || !ts || !nonce || !sig) return 'a x-relay-* header is missing';
    if (String(nonce).length > 64) return 'nonce longer than 64 characters';
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 120) return 'timestamp more than 120 s from the relay\'s clock';
    const key = daemons.get(id);
    if (!key) return 'unknown daemon id (enrol first)';
    const digest = crypto.createHash('sha256').update(text).digest('hex');
    let good = false;
    try { good = crypto.verify(null, Buffer.from(`${req.method}\n${path}\n${ts}\n${nonce}\n${digest}`), pubKey(key), Buffer.from(sig, 'base64')); } catch { /* malformed */ }
    if (!good) return 'signature does not verify';
    if (nonces.has(`${id}:${nonce}`)) return 'nonce seen before (a replay)';
    nonces.add(`${id}:${nonce}`);
    return null;
  })();
  if (why) { log({ path, ok: false, why }); return reply(res, 401, { error: 'not authorized', why }); }

  if (req.method === 'POST' && path === '/v1/push') {
    const { token, type, collapseId } = body;
    if (next.on === 'push' && next.times > 0) {
      next.times--;
      const [status, answer] = ANSWERS[next.answer];
      log({ path, ok: false, forced: next.answer, status, type, collapseId });
      return reply(res, status, answer);
    }
    const bad = unsealed(type, body.body);
    if (bad) { log({ path, ok: false, type, why: bad, body: body.body }); return reply(res, 400, { error: 'only sealed pushes are relayed' }); }
    const inner = body.body.e ? open(body.body.e) : null;
    const warn = warnings(type, body.body, collapseId, inner);
    log({ path, ok: true, type, token: String(token).slice(0, 12), collapseId, clear: body.body.aps ?? null, v: body.body.v, opened: body.body.e ? inner ?? 'does not open with any client token (add one: POST /_tokens)' : '(badge only)', ...(warn.length ? { warnings: warn } : {}) });
    return reply(res, 200, { ok: true });
  }
  log({ path, method: req.method, ok: true, note: 'other signed call' });
  return reply(res, 200, {});
}).listen(port, '127.0.0.1', () => log({ listening: port, clientTokens: keys.length }));
