#!/usr/bin/env node
/**
 * Checks a running backend against the CellPilot Device API (spec/): the core, and each
 * feature the backend declares. Every response and every event frame it sees is checked against
 * spec/openapi.json and spec/events.schema.json, field by field. Read-only by default: it
 * never dials, answers, hangs up, sends a message, marks anything read or changes a setting: it is
 * designed not to change anything, so it can be run against a backend with a real SIM.
 *
 *   node tools/api-check.mjs --url http://192.168.1.10:9400 --token <client token>
 *        [--header "CF-Access-Client-Id: …"]… [--lang en|zh] [--json] [--schemas <dir>]
 *        [--write --to <number> [--dial] [--sim [--from <number>]] [--code <pairing code>]]
 *
 * --write is for a backend with a SIMULATED device only — never one with a real SIM: it sends an
 * SMS to --to and follows the event stream (message, conversations, rev in single steps); with
 * --dial it also places a call to --to, hangs it up, and checks the call events and its record.
 * --sim drives the backend's simulation hooks (POST /_sim/sms, /_sim/call, /_sim/hangup,
 * /_sim/answer; spec/device-api.md, *Testing*) to check what happens when something arrives: the message
 * and call events, notify and ack, badge, audio frames both ways, a missed call's record.
 * --code takes the backend's reusable test pairing code and checks pairing again (the old token
 * becomes 401), signing out (the token becomes 410), with a throwaway client.
 *
 * One line per check: ok, FAIL or skip. Exits 1 when anything failed, 2 on bad arguments.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = { url: '', token: '', lang: 'en', headers: {}, json: false, tokenHeader: null, write: false, to: '', dial: false, sim: false, from: '+15555550142', code: '', schemas: '' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--url') opt.url = args[++i] ?? '';
  else if (a === '--token') opt.token = args[++i] ?? '';
  else if (a === '--lang') opt.lang = args[++i] ?? 'en';
  else if (a === '--json') opt.json = true;
  else if (a === '--write') opt.write = true;
  else if (a === '--to') opt.to = args[++i] ?? '';
  else if (a === '--dial') opt.dial = true;
  else if (a === '--sim') opt.sim = true;
  else if (a === '--from') opt.from = args[++i] ?? '';
  else if (a === '--code') opt.code = args[++i] ?? '';
  else if (a === '--schemas') opt.schemas = args[++i] ?? '';
  // An endpoint whose tokenHeader is set: the token goes in that header, Authorization is left alone.
  else if (a === '--token-header') opt.tokenHeader = args[++i] ?? 'X-CellPilot-Token';
  else if (a === '--header') {
    const h = args[++i] ?? '';
    const at = h.indexOf(':');
    if (at < 1) usage(`bad header: ${h}`);
    opt.headers[h.slice(0, at).trim()] = h.slice(at + 1).trim();
  } else if (a === '-h' || a === '--help') usage();
  else usage(`unknown argument: ${a}`);
}
if (!opt.url || !opt.token) usage('--url and --token are required');
if ((opt.write || opt.dial) && !opt.to) usage('--write and --dial need --to <number>');
if ((opt.dial || opt.sim || opt.code) && !opt.write) usage('--dial, --sim and --code go with --write');
const origin = opt.url.replace(/\/+$/, '');
const base = origin + '/v1';

/** The client token, where the endpoint wants it. */
function tokenHeaders() {
  return opt.tokenHeader ? { [opt.tokenHeader]: opt.token } : { Authorization: `Bearer ${opt.token}` };
}

function usage(problem) {
  if (problem) console.error(problem);
  console.error('usage: node tools/api-check.mjs --url <endpoint> --token <client token> [--token-header X-CellPilot-Token] [--header "K: V"]… [--lang en|zh] [--json] [--schemas <dir>] [--write --to <number> [--dial] [--sim [--from <number>]] [--code <pairing code>]]');
  process.exit(2);
}

// ---- reporting --------------------------------------------------------------------------------

const results = [];
function report(status, name, detail = '') {
  results.push({ status, name, detail });
  if (!opt.json) console.log(`${status.padEnd(4)}  ${name}${detail ? ` — ${detail}` : ''}`);
}
/** Runs one check; a thrown Error is its failure. Returns what the check returned. */
async function check(name, fn) {
  try {
    const r = await fn();
    report('ok', name, typeof r === 'string' ? r : '');
    return r;
  } catch (e) {
    report('FAIL', name, e instanceof Error ? e.message : String(e));
    return undefined;
  }
}
const skip = (name, why) => report('skip', name, why);

// ---- schemas ----------------------------------------------------------------------------------

class Bad extends Error {}
function must(cond, what) { if (!cond) throw new Bad(what); }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const REV = /^[^.\s]+\.\d+$/;

// The schemas: spec/ beside tools/, or --schemas <dir>.
const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = opt.schemas || path.join(here, '..', 'spec');
const docs = {};
for (const [name, file] of [['openapi', 'openapi.json'], ['events', 'events.schema.json']]) {
  try { docs[name] = JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8')); } catch (e) { usage(`cannot read ${path.join(schemaDir, file)} (${e.message}); pass --schemas <the folder holding openapi.json>`); }
}

/** "openapi.json#/components/…" or "#/…" within `doc`: the schema and the document it lives in. */
function deref(ref, doc) {
  const [file, pointer = ''] = ref.split('#');
  const d = file === 'openapi.json' ? 'openapi' : file === 'events.schema.json' ? 'events' : doc;
  let node = docs[d];
  for (const part of pointer.split('/').filter(Boolean)) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (node === undefined) throw new Error(`schema reference ${ref} does not resolve`);
  return [node, d];
}

const TYPES = {
  null: (v) => v === null, boolean: (v) => typeof v === 'boolean', integer: isInt, number: (v) => typeof v === 'number',
  string: isStr, array: Array.isArray, object: isObj,
};

/** Every way `v` departs from `schema` (JSON Schema 2020-12, the part the API's schemas use), as "where: what". */
function departures(v, schema, where, doc = 'openapi', out = []) {
  if (out.length > 8 || schema === true || schema === undefined) return out;
  if (schema.$ref) { const [sub, d] = deref(schema.$ref, doc); departures(v, sub, where, d, out); }
  for (const sub of schema.allOf ?? []) departures(v, sub, where, doc, out);
  // oneOf is read as anyOf: the API's uses are "a shape or null", never ambiguous on purpose.
  for (const key of ['oneOf', 'anyOf']) {
    if (!schema[key]) continue;
    const tries = schema[key].map((sub) => departures(v, sub, where, doc, []));
    // Name what is wrong with the shape, not that it is not null.
    const telling = v === null ? tries : tries.filter((t, i) => JSON.stringify(schema[key][i]) !== '{"type":"null"}');
    if (!tries.some((t) => t.length === 0)) out.push(...(telling.length ? telling : tries).reduce((a, b) => (b.length < a.length ? b : a)));
  }
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => TYPES[t]?.(v))) { out.push(`${where} is ${JSON.stringify(v)?.slice(0, 60)}, expected ${types.join(' or ')}`); return out; }
  }
  if ('const' in schema && JSON.stringify(v) !== JSON.stringify(schema.const)) out.push(`${where} is ${JSON.stringify(v)?.slice(0, 40)}, expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push(`${where} is ${JSON.stringify(v)?.slice(0, 40)}, not one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (isStr(v)) {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) out.push(`${where} "${v.slice(0, 40)}" does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && !ISO.test(v)) out.push(`${where} "${v.slice(0, 40)}" is not an ISO 8601 date-time`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) out.push(`${where} is ${v}, below ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) out.push(`${where} is ${v}, above ${schema.maximum}`);
  }
  if (isObj(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) out.push(`${where}.${k} is missing (every field is present; null when it does not apply)`);
    const props = schema.properties ?? {};
    for (const [k, sub] of Object.entries(props)) if (k in v) departures(v[k], sub, `${where}.${k}`, doc, out);
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const k of Object.keys(v)) {
        if (k in props) continue;
        if (schema.additionalProperties === false) out.push(`${where}.${k} is not a field of this object`);
        else departures(v[k], schema.additionalProperties, `${where}.${k}`, doc, out);
      }
    }
  }
  if (Array.isArray(v) && schema.items) v.slice(0, 50).forEach((x, i) => departures(x, schema.items, `${where}[${i}]`, doc, out));
  return out;
}
/** Throws when `v` does not match; `schema` is a schema or a reference string. */
function conform(v, schema, where, doc = 'openapi') {
  const found = departures(v, typeof schema === 'string' ? { $ref: schema } : schema, where, doc);
  must(found.length === 0, found.slice(0, 4).join('; ') + (found.length > 4 ? ` (and ${found.length - 4} more)` : ''));
}
const S = (name) => `openapi.json#/components/schemas/${name}`;

/** The 200 response schema openapi.json gives for a route ("/calls/{id}"). */
function responseSchema(method, route) {
  const op = docs.openapi.paths?.[route]?.[method.toLowerCase()];
  if (!op) throw new Error(`openapi.json has no ${method} ${route}`);
  let r = op.responses?.['200'];
  if (r?.$ref) r = deref(r.$ref, 'openapi')[0];
  return r?.content?.['application/json']?.schema ?? null;
}

/** An event frame against events.schema.json, by its type; a type the schema does not know is let through, as the app does. */
function frameDepartures(f, where = `${f?.type ?? '?'} event`) {
  if (!isObj(f) || !isStr(f.type)) return [`${where} has no type`];
  const def = docs.events.$defs?.[f.type];
  return def ? departures(f, def, where, 'events') : [];
}

/** Fields of features the backend does not declare are null (place without places, name and contactId without contacts). */
function undeclaredNull(obj, where, has) {
  if (!isObj(obj)) return;
  if (!has('places') && 'place' in obj) must(obj.place === null, `${where}.place is ${JSON.stringify(obj.place)}; without places it is null`);
  if (!has('contacts')) for (const k of ['name', 'contactId']) if (k in obj) must(obj[k] === null, `${where}.${k} is ${JSON.stringify(obj[k])}; without contacts it is null`);
}

// ---- HTTP -------------------------------------------------------------------------------------

async function get(path, { auth = true } = {}) {
  const headers = { Accept: 'application/json', 'X-Lang': opt.lang, ...opt.headers };
  if (auth) Object.assign(headers, tokenHeaders());
  const res = await fetch(base + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return { status: res.status, type: res.headers.get('content-type') ?? '', body, text };
}
/** Any method, with a JSON body (or a raw string), answering { status, body, headers }. */
async function call(method, path, body) {
  const headers = { Accept: 'application/json', 'X-Lang': opt.lang, ...opt.headers, ...tokenHeaders() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed, text };
}
/** A 200 JSON object matching openapi.json's response for the route (the path less its query, or `route`). */
async function ok(path, route = path.split('?')[0]) {
  const r = await get(path);
  must(r.status !== 403, `GET ${path} answered 403: use a paired client's token`);
  must(r.status === 200, `GET ${path} answered ${r.status}${r.body?.error?.code ? ` ${r.body.error.code}` : ''}`);
  must(/application\/json/i.test(r.type), `GET ${path} is not JSON (${r.type || 'no content-type'})`);
  must(isObj(r.body), `GET ${path} is not a JSON object`);
  const schema = responseSchema('GET', route === '' ? '/' : route);
  if (schema) conform(r.body, schema, `GET ${route || '/'}`);
  return r.body;
}
function errorEnvelope(r, status, codes) {
  must(r.status === status, `answered ${r.status}, expected ${status}`);
  must(isObj(r.body) && isObj(r.body.error), 'body is not { error: { code, message } }');
  conform(r.body, { $ref: '#/components/schemas/Error' }, 'error body');
  must(codes.includes(r.body.error.code), `error.code is ${r.body.error.code}, expected ${codes.join(' or ')}`);
}

// ---- the checks -------------------------------------------------------------------------------

const FEATURES = ['push', 'portal', 'contacts', 'search', 'trash', 'voicemail', 'transcription', 'settings', 'security', 'log', 'places', 'screening', 'snapshot', 'notify'];
const firstFew = (list, n = 20) => list.slice(0, n);

async function main() {
  if (!opt.json) console.log(`Checking ${base}\n`);

  const discovery = await check('discovery: GET /v1 without a token', async () => {
    const r = await get('', { auth: false });
    must(r.status === 200 && isObj(r.body), `answered ${r.status}`);
    conform(r.body, responseSchema('GET', '/'), 'discovery');
    return `${r.body.backend.name} ${r.body.backend.version}`;
  });
  if (!discovery) { finish(); return; }
  const declared = new Set((await get('', { auth: false })).body.features);
  const has = (f) => declared.has(f);
  const unknown = [...declared].filter((f) => !FEATURES.includes(f));
  report('ok', 'features declared', [...declared].join(', ') || '(none)');
  if (unknown.length) report('ok', 'features unknown to this checker (ignored by the app)', unknown.join(', '));
  if (has('transcription') && !has('voicemail')) report('FAIL', 'features: transcription requires voicemail');

  await check('ping: GET /v1/ping without a token', async () => {
    const r = await get('/ping', { auth: false });
    must(r.status === 200 && r.body?.ok === true, `answered ${r.status} ${r.text.slice(0, 60)}`);
  });

  await check('auth: a request without a token is 401 unauthorized', async () => {
    errorEnvelope(await get('/status', { auth: false }), 401, ['unauthorized']);
  });
  await check('errors: an unknown route is 404 with the error envelope', async () => {
    errorEnvelope(await get('/api-check-no-such-route'), 404, ['not_found']);
  });

  // Conventions any route follows. None of these can change anything: each request is malformed.
  await check('conventions: a path id that is not a whole number is 400 with details.field "id"', async () => {
    const r = await call('DELETE', '/calls/api-check-not-an-id');
    errorEnvelope(r, 400, ['invalid_request']);
    must(r.body.error.details?.field === 'id', `details.field is ${JSON.stringify(r.body.error.details?.field)}`);
  });
  await check('conventions: a limit that is not a number is ignored', async () => {
    const r = await get('/calls?limit=api-check');
    must(r.status === 200, `answered ${r.status}`);
  });
  await check('conventions: a body that is not JSON is 400 invalid_request', async () => {
    errorEnvelope(await call('POST', '/messages', '{api-check'), 400, ['invalid_request']);
  });
  await check('conventions: a JSON body that is not an object is 400 invalid_request', async () => {
    errorEnvelope(await call('POST', '/messages', '[]'), 400, ['invalid_request']);
  });
  await check('conventions: a missing field is 400 with details.field naming it', async () => {
    const r = await call('POST', '/messages', { to: '', text: '' });
    errorEnvelope(r, 400, ['invalid_request']);
    must(['to', 'text'].includes(r.body.error.details?.field), `details.field is ${JSON.stringify(r.body.error.details?.field)}`);
  });

  let myClientId;
  const status = await check('status: GET /v1/status', async () => {
    const s = await ok('/status');
    if (s.call) undeclaredNull(s.call, 'status.call', has);
  });
  if (status === undefined && results.at(-1)?.detail?.includes('401')) {
    report('FAIL', 'the token was refused; the remaining checks need a paired client token');
    finish(); return;
  }

  await check('client: GET /v1/client', async () => {
    const c = await ok('/client');
    myClientId = c.client.id;
    const n = c.endpoints.length ? `${c.endpoints.length} endpoint(s)` : 'no endpoints (the app keeps the address it paired with)';
    return c.pushTokens ? `${n}, pushTokens present` : `${n}, no pushTokens (optional)`;
  });

  await check('call: GET /v1/call', async () => { await ok('/call'); });

  await check('calls: GET /v1/calls?limit=20', async () => {
    const b = await ok('/calls?limit=20');
    must(b.calls.length <= 20, `returned ${b.calls.length} records for limit=20`);
    for (let i = 1; i < b.calls.length; i++) must(b.calls[i - 1].id > b.calls[i].id, 'records are not newest first');
    firstFew(b.calls).forEach((c, i) => {
      undeclaredNull(c, `calls[${i}]`, has);
      must(c.answeredAt ? isInt(c.durationS) || c.outcome === 'in-progress' || c.outcome === 'answered' : c.durationS === null, `calls[${i}].durationS ${c.durationS} does not fit answeredAt ${c.answeredAt}`);
    });
    return `${b.calls.length} record(s)`;
  });

  let peer;
  await check('conversations: GET /v1/conversations', async () => {
    peer = (await get('/conversations')).body?.conversations?.[0]?.peer;
    const b = await ok('/conversations');
    firstFew(b.conversations).forEach((c, i) => undeclaredNull(c, `conversations[${i}]`, has));
    peer = b.conversations[0]?.peer;
    return `${b.conversations.length} conversation(s)`;
  });
  if (peer) {
    await check('messages: GET /v1/conversations/{peer}/messages?limit=5', async () => {
      const b = await ok(`/conversations/${encodeURIComponent(peer)}/messages?limit=5`, '/conversations/{peer}/messages');
      must(b.messages.length <= 5, `returned ${b.messages.length} messages for limit=5`);
      for (let i = 1; i < b.messages.length; i++) must(b.messages[i - 1].id > b.messages[i].id, 'messages are not newest first');
    });
  } else skip('messages: GET /v1/conversations/{peer}/messages', 'no conversation to read');

  // Features: each declared one answers in shape; an undeclared one answers feature_unavailable.
  const featureRoute = {
    contacts: ['/contacts', '/contacts'],
    search: ['/messages/search?q=a&limit=1', '/messages/search'],
    trash: ['/trash', '/trash'],
    voicemail: ['/voicemails', '/voicemails'],
    settings: ['/settings', '/settings'],
    security: ['/security', '/security'],
    log: ['/log?limit=5', '/log'],
    push: ['/push', '/push'],
  };
  for (const [feature, [path, route]] of Object.entries(featureRoute)) {
    if (has(feature)) {
      await check(`${feature}: GET /v1${path}`, async () => { await ok(path, route); });
    } else {
      await check(`${feature}: undeclared, GET /v1${path} is 404 feature_unavailable or not_found`, async () => {
        errorEnvelope(await get(path), 404, ['feature_unavailable', 'not_found']);
      });
    }
  }

  let snapRev;
  if (has('snapshot')) {
    await check('snapshot: GET /v1/snapshot', async () => {
      const s = await ok('/snapshot');
      must(REV.test(s.rev), `rev ${s.rev} is not "<run>.<counter>"`);
      must([...declared].every((f) => s.features.includes(f)) && s.features.length === declared.size, 'snapshot.features differs from GET /v1');
      const nullWithout = { contacts: 'contacts', settings: 'settings', security: 'security', push: 'push' };
      for (const [k, f] of Object.entries(nullWithout)) {
        if (has(f)) must(s[k] !== null, `snapshot.${k} is null although ${f} is declared`);
        else must(s[k] === null, `snapshot.${k} is not null without ${f}`);
      }
      if (!has('trash')) must(s.trash.length === 0, 'snapshot.trash is not [] without trash');
      if (!has('voicemail')) must(s.voicemails.length === 0, 'snapshot.voicemails is not [] without voicemail');
      snapRev = s.rev;
      return `rev ${s.rev}, badge ${s.badge}`;
    });
  } else skip('snapshot', 'not declared; the app reads list by list');

  await check('events: GET /v1/events says hello first', async () => {
    const hello = await firstFrame();
    must(hello.type === 'hello', `the first frame is ${hello.type}`);
    const bad = frameDepartures(hello);
    must(bad.length === 0, bad.slice(0, 4).join('; '));
    if (has('snapshot')) {
      must(isStr(hello.rev) && REV.test(hello.rev), 'hello.rev is missing or not "<run>.<counter>" while snapshot is declared');
      if (snapRev) must(hello.rev.split('.')[0] === snapRev.split('.')[0], `hello.rev ${hello.rev} is from another run than the snapshot's ${snapRev}`);
    }
    return hello.rev ? `rev ${hello.rev}` : 'no rev';
  });

  if (has('notify') && !opt.sim) skip('notify', 'declared; asks and acks are checked with --write --sim, around a message and a call that arrive');
  if (opt.write) await writeChecks({ has, myClientId });
  finish();
}

// ---- --write: a simulated backend only ----------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The event stream, kept open: text frames and binary (audio) frames collected as they come. */
async function openStream(token = null) {
  const frames = [];
  const audio = [];
  const headers = { 'X-Lang': opt.lang, ...opt.headers, ...(token ? (opt.tokenHeader ? { [opt.tokenHeader]: token } : { Authorization: `Bearer ${token}` }) : tokenHeaders()) };
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/events`, { headers });
  ws.binaryType = 'arraybuffer';
  let closed = null;
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') { try { frames.push(JSON.parse(ev.data)); } catch { frames.push({ type: '(not JSON)' }); } }
    else audio.push(new Uint8Array(ev.data));
  });
  ws.addEventListener('close', (ev) => { closed = ev.code; });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Bad('the WebSocket did not open'))); });
  const waitFor = async (pred, what, ms = 8000, from = 0) => {
    const until = Date.now() + ms;
    for (;;) {
      const f = frames.slice(from).find(pred);
      if (f) return f;
      if (Date.now() > until) throw new Bad(`no ${what} event within ${ms / 1000} s`);
      await sleep(100);
    }
  };
  return { frames, audio, waitFor, send: (obj) => ws.send(typeof obj === 'string' || obj instanceof Uint8Array ? obj : JSON.stringify(obj)), close: () => ws.close(), closed: () => closed };
}

/** POST /_sim/<cmd> on the backend's own origin (the spec's simulation hooks). */
async function sim(cmd, body = {}) {
  const res = await fetch(`${origin}/_sim/${cmd}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  await res.text();
  must(res.status === 200, `POST /_sim/${cmd} answered ${res.status}; --sim needs the simulation hooks (spec/device-api.md, *Testing*)`);
}

/** A downlink audio frame: 323 bytes, direction 0x01. An uplink one is the same with 0x02. */
const isDownlink = (b) => b.length === 323 && b[0] === 0x01;
function uplink(seq) {
  const b = new Uint8Array(323);
  b[0] = 0x02; b[1] = (seq >> 8) & 0xff; b[2] = seq & 0xff;
  for (let i = 0; i < 160; i++) { const v = Math.round(3000 * Math.sin((2 * Math.PI * 440 * (seq * 160 + i)) / 8000)); b[3 + 2 * i] = v & 0xff; b[4 + 2 * i] = (v >> 8) & 0xff; }
  return b;
}

async function writeChecks({ has, myClientId }) {
  const stream = await openStream().catch((e) => { report('FAIL', 'write: event stream', e.message); return null; });
  if (!stream) return;
  const badge = () => stream.frames[0]?.badge !== undefined; // badge is optional; one that sends it on hello keeps it current
  try {
    await stream.waitFor((f) => f.type === 'hello', 'hello');
    const hello = stream.frames[0];
    const audioReady = hello.status?.audio?.ready === true;

    // An outgoing message.
    let sent;
    await check(`write: POST /v1/messages to ${opt.to} answers { message }`, async () => {
      const r = await call('POST', '/messages', { to: opt.to, text: 'api-check --write test message' });
      must(r.status === 200 && isObj(r.body?.message), `answered ${r.status} ${r.text.slice(0, 80)}`);
      conform(r.body, responseSchema('POST', '/messages'), 'POST /messages');
      must(['pending', 'sent', 'failed'].includes(r.body.message.status), `status is ${r.body.message.status}`);
      sent = r.body.message;
      return `id ${sent.id}, ${sent.status}`;
    });
    if (sent) {
      await check('write: a message event carries it', async () => { await stream.waitFor((f) => f.type === 'message' && f.message?.id === sent.id, 'message'); });
      await check('write: it reaches a final status, then a conversations event', async () => {
        const at = stream.frames.findIndex((x) => x.type === 'message' && x.message?.id === sent.id && x.message.status !== 'pending');
        const f = at >= 0 ? stream.frames[at] : await stream.waitFor((x) => x.type === 'message' && x.message?.id === sent.id && x.message.status !== 'pending', 'final message', 15000).catch(() => null);
        must(f || sent.status !== 'pending', 'still pending after 15 s');
        const from = Math.max(0, stream.frames.indexOf(f));
        await stream.waitFor((x) => x.type === 'conversations' && x.conversations?.some((c) => c.peer === sent.peer), 'conversations (after the final status)', 5000, from);
      });
      await check('write: no conversations event while the message is only pending', async () => {
        const pendingAt = stream.frames.findIndex((x) => x.type === 'message' && x.message?.id === sent.id);
        const finalAt = stream.frames.findIndex((x) => x.type === 'message' && x.message?.id === sent.id && x.message.status !== 'pending');
        if (pendingAt < 0 || finalAt < 0 || stream.frames[pendingAt].message.status !== 'pending') return 'not observable (sent at once)';
        must(!stream.frames.slice(pendingAt, finalAt).some((x) => x.type === 'conversations'), 'a conversations event came between pending and the final status (the list moves when it is sent or fails)');
      });
      await check('write: GET the conversation lists it', async () => {
        const b = await ok(`/conversations/${encodeURIComponent(sent.peer)}/messages?limit=5`, '/conversations/{peer}/messages');
        must(b.messages.some((m) => m.id === sent.id), 'not in the newest five');
      });
    }

    if (opt.dial) {
      let callId;
      await check(`write: POST /v1/call/dial ${opt.to}`, async () => {
        const r = await call('POST', '/call/dial', { number: opt.to });
        must(r.status === 200 && isObj(r.body), `answered ${r.status} ${r.text.slice(0, 80)}`);
        conform(r.body, responseSchema('POST', '/call/dial'), 'POST /call/dial');
        must(isObj(r.body.call), 'call is null after dialling');
        must(r.body.holder?.clientId === myClientId, `holder is ${JSON.stringify(r.body.holder)}, expected this client (${myClientId})`);
        callId = r.body.call.id;
        return `call ${callId}, ${r.body.call.state}`;
      });
      if (callId !== undefined) {
        await check('write: the call is on the history while it lasts, in-progress', async () => {
          const b = await ok('/calls?limit=5');
          const rec = b.calls.find((c) => c.id === callId);
          must(rec, `no record ${callId} during the call`);
          must(['in-progress', 'answered'].includes(rec.outcome), `outcome is ${rec.outcome}`);
        });
        if (opt.sim) {
          await check('write: the far end answers (POST /_sim/answer, or by itself): call active', async () => {
            // /_sim/answer is optional: a simulator that answers outgoing calls by itself needs none.
            const res = await fetch(`${origin}/_sim/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }).catch(() => null);
            await res?.text();
            await stream.waitFor((f) => f.type === 'call' && f.call?.id === callId && f.call.state === 'active', 'active call', 10_000);
            return res?.status === 200 ? 'answered through the hook' : 'answered by the simulator';
          });
          if (audioReady) await audioChecks(stream, 'the outgoing call');
          else skip('write: audio frames on the outgoing call', 'status.audio.ready is false');
        } else await sleep(3000);
        await check('write: POST /v1/call/hangup ends it', async () => {
          const r = await call('POST', '/call/hangup');
          must(r.status === 200, `answered ${r.status}`);
          await stream.waitFor((f) => f.type === 'call' && f.call === null, 'call ending');
        });
        await check('write: a calls event carries the finished record', async () => {
          const f = await stream.waitFor((x) => x.type === 'calls' && x.calls?.some((c) => c.id === callId && c.outcome !== 'in-progress' && c.outcome !== 'answered'), 'calls');
          const rec = f.calls.find((c) => c.id === callId);
          must(rec.endedAt, 'endedAt is missing');
          must(rec.answeredAt ? isInt(rec.durationS) : rec.durationS === null, `durationS ${rec.durationS} does not fit answeredAt ${rec.answeredAt}`);
          if (opt.sim) must(rec.outcome === 'completed', `outcome is ${rec.outcome}, expected completed (it was answered)`);
          return rec.outcome;
        });
      }
    }

    if (opt.sim) await arrivalChecks(stream, { has, myClientId, audioReady, badge: badge() });

    await check('write: every event frame matches events.schema.json', async () => {
      const bad = stream.frames.flatMap((f, i) => frameDepartures(f, `frame ${i} (${f?.type})`));
      must(bad.length === 0, bad.slice(0, 4).join('; ') + (bad.length > 4 ? ` (and ${bad.length - 4} more)` : ''));
      return `${stream.frames.length} frame(s)`;
    });
    await check('write: fields of undeclared features are null in every frame', async () => {
      for (const [i, f] of stream.frames.entries()) {
        if (f.type === 'message') undeclaredNull(f.message, `frame ${i} message`, has);
        if (f.type === 'call' && f.call) undeclaredNull(f.call, `frame ${i} call`, has);
        if (f.type === 'calls') (f.calls ?? []).forEach((c, k) => undeclaredNull(c, `frame ${i} calls[${k}]`, has));
        if (f.type === 'conversations') (f.conversations ?? []).forEach((c, k) => undeclaredNull(c, `frame ${i} conversations[${k}]`, has));
      }
    });
    if (has('snapshot')) {
      await check('write: rev moves one step per change, in this run', async () => {
        const [run, n0] = String(hello.rev).split('.');
        const revs = stream.frames.slice(1).map((f) => f.rev).filter(Boolean);
        must(revs.length > 0, 'no event carried a rev');
        let last = Number(n0);
        for (const r of revs) {
          const [rr, n] = r.split('.');
          must(rr === run, `rev ${r} is from another run than ${hello.rev}`);
          must(Number(n) === last || Number(n) === last + 1, `rev jumped from ${run}.${last} to ${r}`);
          last = Number(n);
        }
        return `${hello.rev} → ${run}.${last}`;
      });
    }
  } finally {
    stream.close();
  }
  if (opt.code) await pairingChecks();
}

/** With a call active and this client holding it: downlink frames come, uplink frames are taken. */
async function audioChecks(stream, which) {
  await check(`write: audio frames on ${which}: downlink comes, 323 bytes, direction 0x01, sequence counting up`, async () => {
    const from = stream.audio.length;
    const until = Date.now() + 3000;
    while (stream.audio.length - from < 10 && Date.now() < until) await sleep(50);
    const got = stream.audio.slice(from);
    must(got.length >= 10, `${got.length} binary frame(s) in 3 s; a holder gets one every 20 ms`);
    const bad = got.find((b) => !isDownlink(b));
    must(!bad, `a frame of ${bad?.length} bytes, first byte ${bad?.[0]}`);
    const seq = got.map((b) => (b[1] << 8) | b[2]);
    for (let i = 1; i < seq.length; i++) must(((seq[i] - seq[i - 1]) & 0xffff) > 0 && ((seq[i] - seq[i - 1]) & 0xffff) < 0x8000, `sequence went from ${seq[i - 1]} to ${seq[i]}`);
    return `${got.length} frame(s)`;
  });
  await check(`write: uplink frames on ${which} are taken without closing the socket`, async () => {
    for (let k = 0; k < 25; k++) { stream.send(uplink(k)); await sleep(20); }
    await sleep(300);
    must(stream.closed() === null, `the socket closed (code ${stream.closed()})`);
  });
}

/** What happens when an SMS or a call arrives, driven through the simulation hooks. */
async function arrivalChecks(stream, { has, myClientId, audioReady, badge }) {
  const ack = (n) => stream.send({ type: 'ack', id: n.id, kind: n.kind, state: 'foreground' });

  // An SMS arrives.
  const text = `api-check incoming ${Date.now() % 100000}`;
  let from = stream.frames.length;
  const smsSent = await check(`write: POST /_sim/sms from ${opt.from}`, () => sim('sms', { from: opt.from, text }).then(() => 'sent'));
  if (smsSent) {
    let msg;
    await check('write: the arrival is a message event, direction in, received, unread', async () => {
      const f = await stream.waitFor((x) => x.type === 'message' && x.message?.body === text, 'message', 8000, from);
      msg = f.message;
      must(msg.direction === 'in' && msg.status === 'received' && msg.read === false, `direction ${msg.direction}, status ${msg.status}, read ${msg.read}`);
    });
    await check('write: a conversations event lists it', async () => {
      await stream.waitFor((x) => x.type === 'conversations' && x.conversations?.some((c) => msg && c.peer === msg.peer && c.lastBody === text), 'conversations', 5000, from);
    });
    if (badge) await check('write: a badge event follows the arrival', async () => { await stream.waitFor((x) => x.type === 'badge', 'badge', 3000, from); });
    if (has('notify')) {
      await check('write: notify asks this client about the message (kind sms, id sms-<message id>); ack answered', async () => {
        const n = await stream.waitFor((x) => x.type === 'notify' && x.kind === 'sms', 'notify sms', 5000, from);
        must(msg && n.id === `sms-${msg.id}`, `notify id is ${n.id}, expected sms-${msg?.id}`);
        ack(n);
      });
    }
  }

  // A call arrives and this client answers it.
  from = stream.frames.length;
  let callId;
  const rang = await check(`write: POST /_sim/call from ${opt.from}: the call rings (state incoming)`, async () => {
    await sim('call', { from: opt.from });
    const f = await stream.waitFor((x) => x.type === 'call' && x.call?.state === 'incoming', 'incoming call', 8000, from);
    callId = f.call.id;
    must(f.call.direction === 'in', `direction ${f.call.direction}`);
    return `call ${callId}`;
  });
  if (rang) {
    if (has('notify')) {
      await check('write: notify asks about the ringing call (kind call, its callId); ack answered', async () => {
        const n = await stream.waitFor((x) => x.type === 'notify' && x.kind === 'call', 'notify call', 3000, from);
        must(n.callId === callId, `callId ${n.callId}, expected ${callId}`);
        ack(n);
      });
    }
    await check('write: POST /v1/call/answer: active, this client holds it', async () => {
      const r = await call('POST', '/call/answer');
      must(r.status === 200, `answered ${r.status} ${r.text.slice(0, 80)}`);
      conform(r.body, responseSchema('POST', '/call/answer'), 'POST /call/answer');
      must(r.body.call?.state === 'active', `state ${r.body.call?.state}`);
      must(r.body.holder?.clientId === myClientId, `holder ${JSON.stringify(r.body.holder)}, expected this client (${myClientId})`);
    });
    const recAnswered = await ok('/calls?limit=5').then((b) => b.calls.find((c) => c.id === callId)).catch(() => null);
    await check('write: the record says answered while the call lasts', async () => {
      must(recAnswered, `no record ${callId}`);
      must(recAnswered.outcome === 'answered' && recAnswered.answeredAt, `outcome ${recAnswered.outcome}, answeredAt ${recAnswered.answeredAt}`);
    });
    if (audioReady) await audioChecks(stream, 'the incoming call');
    else skip('write: audio frames on the incoming call', 'status.audio.ready is false');
    const before = stream.frames.length;
    await check('write: POST /_sim/hangup, the far end hangs up: call null, the record completed', async () => {
      await sim('hangup');
      await stream.waitFor((x) => x.type === 'call' && x.call === null, 'call ending', 8000, before);
      const f = await stream.waitFor((x) => x.type === 'calls' && x.calls?.some((c) => c.id === callId && c.endedAt), 'calls', 5000, before);
      const rec = f.calls.find((c) => c.id === callId);
      must(rec.outcome === 'completed' && isInt(rec.durationS), `outcome ${rec.outcome}, durationS ${rec.durationS}`);
    });
  }

  // A call arrives and nobody answers: the caller gives up.
  from = stream.frames.length;
  let missedId;
  const rang2 = await check('write: a second call rings and the caller hangs up before anyone answers', async () => {
    await sim('call', { from: opt.from });
    const f = await stream.waitFor((x) => x.type === 'call' && x.call?.state === 'incoming', 'incoming call', 8000, from);
    missedId = f.call.id;
    const n = has('notify') ? await stream.waitFor((x) => x.type === 'notify' && x.kind === 'call', 'notify call', 3000, from).catch(() => null) : null;
    if (n) ack(n);
    await sleep(1500);
    await sim('hangup');
    return `call ${missedId}`;
  });
  if (rang2) {
    await check('write: its record is missed, durationS null, answeredAt null', async () => {
      const f = await stream.waitFor((x) => x.type === 'calls' && x.calls?.some((c) => c.id === missedId && c.endedAt), 'calls', 8000, from);
      const rec = f.calls.find((c) => c.id === missedId);
      must(rec.outcome === 'missed' && rec.durationS === null && rec.answeredAt === null, `outcome ${rec.outcome}, durationS ${rec.durationS}, answeredAt ${rec.answeredAt}`);
      if ('seen' in rec) must(rec.seen === false, `seen is ${rec.seen}; a missed call is unseen until opened`);
      return 'seen' in rec ? 'seen: false' : 'no seen field (optional)';
    });
    if (badge) await check('write: a badge event follows the missed call', async () => { await stream.waitFor((x) => x.type === 'badge', 'badge', 3000, from); });
    if (has('notify')) {
      await check('write: notify asks about the missed call (kind missed, id call-<id>); ack answered', async () => {
        const n = await stream.waitFor((x) => x.type === 'notify' && x.kind === 'missed', 'notify missed', 6000, from);
        must(n.id === `call-${missedId}`, `id ${n.id}, expected call-${missedId}`);
        ack(n);
      });
    }
  }
}

/** Pairing again replaces a client's token (the old one 401); signing out makes it 410. A throwaway client. */
async function pairingChecks() {
  const uid = crypto.randomUUID().toUpperCase(); // the app sends identifierForVendor, a UUID; anything else is ignored
  const pair = async () => {
    const res = await fetch(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lang': opt.lang, ...opt.headers }, body: JSON.stringify({ code: opt.code, name: 'api-check', lang: opt.lang, uid, platform: 'ios' }), signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch {}
    must(res.status === 200, `POST /pair answered ${res.status} ${text.slice(0, 80)}`);
    conform(body, responseSchema('POST', '/pair'), 'POST /pair');
    return body;
  };
  const asToken = (token) => fetch(`${base}/client`, { headers: { 'X-Lang': opt.lang, ...opt.headers, ...(opt.tokenHeader ? { [opt.tokenHeader]: token } : { Authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(10_000) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => undefined) }));
  let first, second;
  await check('pair: POST /v1/pair with --code answers { token, client, endpoints }', async () => { first = await pair(); return `client ${first.client.id}`; });
  if (!first) return;
  await check('pair: pairing again with the same uid keeps the client id; the old token becomes 401', async () => {
    second = await pair().catch((e) => { throw new Bad(`${e.message} (the code must stay valid after use: the backend's fixed test code)`); });
    must(second.client.id === first.client.id, `client id ${second.client.id}, expected ${first.client.id}`);
    const old = await asToken(first.token);
    errorEnvelope(old, 401, ['unauthorized']);
  });
  const token = second?.token ?? first.token;
  await check('pair: DELETE /v1/client signs out; the token then answers 410 signed_out', async () => {
    const res = await fetch(`${base}/client`, { method: 'DELETE', headers: { 'X-Lang': opt.lang, ...opt.headers, ...(opt.tokenHeader ? { [opt.tokenHeader]: token } : { Authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(10_000) });
    must(res.status === 200, `DELETE /client answered ${res.status}`);
    errorEnvelope(await asToken(token), 410, ['signed_out']);
  });
}

/** Opens the event stream, returns the first frame parsed, and closes. */
function firstFrame() {
  return new Promise((resolve, reject) => {
    const wsUrl = `${base.replace(/^http/, 'ws')}/events?lang=${opt.lang}`;
    let ws;
    try {
      // Node's WebSocket (undici) takes headers as a non-standard option.
      ws = new WebSocket(wsUrl, { headers: { 'X-Lang': opt.lang, ...opt.headers, ...tokenHeaders() } });
    } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { ws.close(); reject(new Bad('no frame within 5 s')); }, 5000);
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return; // audio frames are binary; hello is text
      clearTimeout(timer);
      ws.close();
      try { resolve(JSON.parse(ev.data)); } catch { reject(new Bad('first text frame is not JSON')); }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Bad('the WebSocket did not open (token, path or headers)')); });
    ws.addEventListener('close', (ev) => { clearTimeout(timer); reject(new Bad(`closed before hello (code ${ev.code})`)); });
  });
}

function finish() {
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const passed = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  if (opt.json) console.log(JSON.stringify({ base, passed, failed, skipped, results }, null, 2));
  else console.log(`\n${passed} ok, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
