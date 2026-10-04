# CellPilot Device API v1

The CellPilot app is a client. It connects to a *backend*: a program that controls a cellular
device (a module with a SIM card) and exposes it through this API. The reference backend,
`cellpilotd`, runs on a Mac with a USB module; any other program that implements the API can be
used in its place. The app does not care what the backend is, where it runs, or how it is reached.
Where this document says what `cellpilotd` does, it describes the reference backend's choice
within the rules, which the app is tested against.

The API is the whole contract. Calls and messages need no CellPilot account and pass through no
server of ours, and the app does nothing that is not in this document. The one
service CellPilot operates, the push relay, is optional and built not to read what it carries (see *Push*).

**This file is the specification.** [openapi.yaml](openapi.yaml) defines the routes and shapes
([openapi.json](openapi.json) is the same, generated for tools; [openapi.zh-CN.yaml](openapi.zh-CN.yaml)
is a translation), and [events.schema.json](events.schema.json) every frame on the event stream.
The backend guide, in English and Chinese, is a readable companion derived from this file; it
adds no rules of its own. Where any of them disagrees with this file, this file wins. This file covers what OpenAPI cannot: the event stream, the audio frames, pairing, push,
the relay, and what a backend must implement.

## Terms

| Term | Meaning |
| --- | --- |
| **device** | The cellular hardware the backend controls: the module and its SIM. One backend, one device. |
| **backend** | The program implementing this API. `cellpilotd` is one; yours may be another. |
| **client** | One installation of the CellPilot app, known to the backend by a token. |
| **endpoint** | One way to reach the backend: a base URL plus optional headers. A backend may have several. |
| **peer** | The other party's phone number, as the network delivered it or the user typed it, less grouping (see *Numbers*). |

## Conventions

- Base path `/v1`. Every route in this document is relative to it.
- JSON in both directions, `Content-Type: application/json; charset=utf-8`. Keys are camelCase.
  Booleans are booleans. Times are ISO 8601 in UTC (`2026-09-25T08:14:03.120Z`) and end in `At`.
  Durations carry their unit (`durationS`, `expiresInS`).
- A request body is read as JSON whatever its `Content-Type`; no body is `{}`; a body that is not
  JSON, or JSON that is not an object (an array, a string, `null`), is `400 invalid_request`
  (without `details`). Unknown request fields are ignored. A backend may refuse a body past a size
  of its choosing with `413 invalid_request` (`cellpilotd`: 8 MB).
- An unknown path, and a known one asked with a method it does not take, are `404 not_found`
  (after authentication); there is no `405`.
- Every successful response is a JSON object. A collection sits under a named key
  (`{ "messages": [...] }`); a singleton is the object itself. Actions return the resource they
  changed; deletions return `{}`.
- Every field of an object is present; one that is unknown, does not apply, or belongs to a
  feature the backend does not declare (`place` without `places`, `name` and `contactId` without
  `contacts`) is `null`, and an empty list is `[]`. Only the fields listed as optional (under
  *Discovery and features*, and those this file marks optional) may be left out.
- Ids are positive integers, a newer record having a larger one. An id in the path that is not a
  non-negative integer is `400 invalid_request` with `details.field: "id"`.
- Paging is by id: `?beforeId=<id>&limit=<n>` returns items with an id below `beforeId`, newest
  (largest id) first. `limit` defaults to 100 and is clamped to 1–500 rather than refused; a
  `beforeId` or `limit` that is not a number is ignored. A page shorter than `limit` is the last
  one. A route that names its own default and cap (search 50/200, log 200/1000) uses those.
- Errors are `{ "error": { "code", "message", "details"? } }`. `code` is stable and is what a
  client acts on; `message` is for people, in the reader's language. `details` sits inside
  `error`; for a bad field `details.field` names it, nested fields joined with dots
  (`"voicemail.answerAfterS"`). Authentication comes before routing: an unknown path without a
  token is `401`, not `404`. Codes:

  | HTTP | code | when |
  | --- | --- | --- |
  | 400 | `invalid_request` | A field is missing or malformed (`details.field` names it), or the body is not a JSON object. |
  | 401 | `unauthorized` | No token, or not one the backend knows; a wrong pairing code. |
  | 403 | `forbidden` | The token is valid but may not do this. |
  | 404 | `not_found` | No such resource, or no such route. |
  | 404 | `feature_unavailable` | The route belongs to a feature this backend does not declare. |
  | 409 | `conflict` | The action does not fit the current state (answering with no call, transcribing while one runs). |
  | 410 | `signed_out` | The client was unpaired or revoked. The app forgets its token and shows the pairing screen. |
  | 413 | `invalid_request` | The body is larger than the backend takes. |
  | 429 | `rate_limited` | Too many failed attempts from this source. `Retry-After` (seconds) is set. |
  | 500 | `internal` | Anything else, the module refusing a command included (see *The call*). |
  | 502 | `upstream_failed` | `POST /v1/push/enrol` only: the relay refused the enrolment or could not be reached. |
  | 503 | `device_unavailable` | The device is not attached or not ready. |

- Language: the client sends `X-Lang: en` or `X-Lang: zh` on every request and on the event
  stream. A value starting with `zh` (`zh-Hans`) is Chinese; anything else is English. Every
  human-readable string the backend produces (error messages, event text, security check text,
  alert titles, place names, a call's `endReason`, a message's `error`) is in the reader's
  language: for a request, `X-Lang`, else the `lang` on the client's record, else English; on the
  event stream, the `lang` on the record of the client the socket belongs to, so the same event
  can go out in two languages. A record several clients read keeps the cause, not a sentence, and
  is worded for each reader. Data the user typed, numbers, and names are never translated.

## Authentication

Every request except `GET /v1`, `GET /v1/ping` and `POST /v1/pair` carries the client token:
`Authorization: Bearer <client token>`, or `X-CellPilot-Token: <client token>` on an endpoint
whose `tokenHeader` says so (a proxy there keeps `Authorization` for itself). A backend accepts
either; when both are sent, `X-CellPilot-Token` is the one read (the other is the proxy's). The
token identifies one client installation and is
obtained by pairing (below), whatever the backend.

A backend should store only a hash of the token. No token, or one it never issued, is
`401 unauthorized`; a token it revoked, or one whose client unpaired itself, is `410 signed_out`
so the app can let go of it — the backend keeps the hash to recognise it. After a pairing with the
same `uid` (below) the old token is simply unknown: `401`. The app treats a `401` or `410` on a token
that worked before the same way: it forgets the token and everything it cached and shows the
pairing screen.

## Compatibility

Version 1 of this API only grows. Within it:

- Nothing documented here is removed or changes meaning, and no field changes type.
- New things arrive as new optional fields, new event types, or new features a backend declares.
  Anything a backend can leave out, the app does without — see the tables under *Discovery and
  features*.
- Clients ignore fields, event types and features they do not know; backends ignore request
  fields they do not know. Neither side may fail on something new.
- Error `code`s are stable. A new one may be added; a client treats an unknown code by its HTTP
  status.

A change that cannot keep these promises would be version 2, with its own base path (`/v2`), and
the app would keep speaking v1 to backends that have not moved.

## Discovery and features

`GET /v1` needs no token and describes the backend:

```json
{
  "api": "cellpilot-device-api",
  "version": 1,
  "backend": { "name": "cellpilotd", "version": "0.1.0" },
  "features": ["push", "contacts", "search", "trash", "voicemail", "transcription",
               "settings", "security", "log", "places", "screening", "portal", "snapshot", "notify"]
}
```

The core is required of every backend. Everything else is a *feature*: a backend declares the
ones it has, and the app shows only those. A route of an undeclared feature answers
`404 feature_unavailable`.

The list says what the backend can do *now*, not what it could do configured differently: a
feature declared and then not delivered is a button that fails. When a setting changes it (the
answering machine switched off, say), the backend sends a `features` event with the new list, and
`hello` carries the list too.

| Feature | Adds | Notes |
| --- | --- | --- |
| *(core)* | `GET /v1`, `/ping`, `/pair`, `/status`, `/client`, `/call` and its actions, `/calls`, `/conversations`, `/messages`, the event stream, audio frames | Without these the app is not a phone. |
| `push` | `POST /v1/client/push-tokens`, `DELETE /v1/client/push-tokens/{token}`, `GET /v1/push`, `POST /v1/push/enrol` | The app registers its APNs tokens; the backend pushes through the CellPilot relay, which the app enrols it on. |
| `contacts` | `/contacts` | People with names and numbers, kept by the backend; see *Contacts*. |
| `search` | `GET /v1/messages/search` | Full-text search over messages. |
| `trash` | `/trash`, `POST /v1/messages/{id}/trash` | Deleted conversations are kept for restoring. Without it, deletion is final. |
| `voicemail` | `/voicemails`, `settings.voicemail`, the `voicemail` event | The backend answers unanswered calls and records them; see *The answering machine*. Declared when the backend *can* do it: with the answering machine switched off in the settings it stays declared (the recordings and the setting remain), and only `screening` goes. |
| `transcription` | `POST /v1/voicemails/{id}/transcribe`, `settings.transcription`, live transcript in the `voicemail` event | Requires `voicemail`. Declared when transcription can be done (in `cellpilotd`: the speech models are installed), whatever its switch. |
| `settings` | `GET/PATCH /v1/settings` | User-changeable backend settings. |
| `security` | `/security`, `status.security`, the `security` event | The backend watches its device for tampering and reports checks and alerts. |
| `log` | `GET /v1/log`, the `log` event | The backend's event log, in the client's language. |
| `places` | `place` and `carrier` fields | Where a number is from, in the client's language. |
| `screening` | `POST /v1/call/screen`, `POST /v1/call/claim` | Let the backend take a call (voicemail) and take it back. Declared with `voicemail` *and* the answering machine switched on (`settings.voicemail.enabled`). Without it a call cannot be moved between phones either. |
| `portal` | `POST /v1/portal/session` | The backend has a web UI the app can open. |
| `snapshot` | `GET /v1/snapshot`, `rev` on `hello` and on events, the `rev` event | Everything a client keeps, at one version, in one request; see *Event stream*. Without it the app reads each list on its own at every connection. |
| `notify` | the `notify` event and the client's `ack` | The backend asks live clients before it pushes; see *Presence and `notify`*. Without it the backend just pushes, and a phone with the app open shows the banner itself. |

Some fields and routes are optional, and the app does without them (this is the one list; the
guide repeats it):

| Field or route | Without it |
| --- | --- |
| `pushTokens` on `GET /v1/client` (with `push`) | The app registers its tokens at every refresh instead of only the missing ones. |
| `seen` on call records, `POST /v1/calls/{id}/seen` | Missed calls are not counted as unseen and opening one marks nothing. |
| `badge` on `hello` and the `badge` event | The app counts the icon badge from the lists at each refresh. |
| `problem` on `GET /v1/push` (with `push`) | When pushes do not get through, the user is not told why. |

A backend is checked against all of this with `tools/api-check.mjs` (see *Testing*).

## Client and endpoints

`GET /v1/client` tells a client who it is and how to reach the backend:

```json
{
  "client": { "id": 31, "name": "iPhone 17", "lang": "en" },
  "endpoints": [
    { "id": "lan", "label": "Local network", "url": "http://my-mac.local:9400", "priority": 0 },
    { "id": "tailscale", "label": "Tailscale", "url": "http://my-mac.tail1234.ts.net:9401", "priority": 1 },
    { "id": "cloudflare", "label": "Cloudflare Tunnel", "url": "https://app.example.com", "priority": 2,
      "headers": { "CF-Access-Client-Id": "…", "CF-Access-Client-Secret": "…" } }
  ]
}
```

With `push`, it may also carry `pushTokens: [{ "token", "kind": "alert"|"voip" }]`, the tokens the
backend holds for this client. The app registers a token only when it is missing from that list,
so a refresh sends none when nothing changed. A backend that leaves the field out gets every token
again at each refresh, and should treat a token it already holds as no change.

An endpoint is a base URL, a label to show, a priority (lower is preferred), and what it takes
to get through whatever sits in front of the backend on that path:

| Field | What it does |
| --- | --- |
| `headers` | Added to every request and to the event stream connection through this endpoint: a tunnel's service token, a proxy's credentials. |
| `tokenHeader` | `"X-CellPilot-Token"` when a proxy on this path takes `Authorization` for itself (Basic auth, an SSO gateway). The client then sends its token as `X-CellPilot-Token: <token>` and leaves `Authorization` to the proxy. Absent: `Authorization: Bearer <token>`. |
| `tlsPin` | SHA-256 of the server's certificate (DER), base64: the client trusts that certificate for this endpoint whoever issued it, and refuses any other. For a self-signed certificate. Hex, with or without colons, is read too. |
| `clientCertificate` | `{ "p12", "password" }`: a PKCS#12 bundle (base64) the client presents when the server asks for a client certificate (mutual TLS). |
| `vpn` | The VPN the phone has to be on to reach this endpoint, named as people know it (`"Tailscale"`). The app says so when the endpoint does not answer. |

The list may carry secrets (a service token, a certificate's password); the app keeps it in the
Keychain. That is all the app knows about how it reaches the backend: a VPN, a tunnel, a port
forward, a mesh network, or a plain LAN address all look the same. The backend lists whatever
it has, and the list is the backend's alone: the app takes it at pairing, asks for it again every
time it opens, and follows the `client` event in between.

### Remote access

Whatever carries the connection, two things must get through it:

- **WebSocket.** `GET /v1/events` is upgraded to a WebSocket and kept open; without it the app
  only refreshes when opened, with no live messages or calls. A proxy must pass the upgrade
  (`Upgrade` and `Connection` headers) and allow idle connections of at least 30 seconds: the
  backend pings every 10.
- **Your token.** In `Authorization: Bearer`, or in `X-CellPilot-Token` when the endpoint says so.
  A backend accepts it in either.

| Path | `url` | Also set |
| --- | --- | --- |
| Local network | `http://host.local:9400` | — |
| Tailscale, ZeroTier, WireGuard | the address on that network (`http://mac.tail1234.ts.net:9401`) | `vpn` |
| Tailscale Funnel | its `https://….ts.net` address | — |
| Cloudflare Tunnel with Access | the public hostname | `headers`: `CF-Access-Client-Id`, `CF-Access-Client-Secret` (a Service Auth policy) |
| frp, ngrok, or a hosted tunnel | the public HTTP(S) address it gives | `headers` the tunnel asks for (ngrok: `ngrok-skip-browser-warning`) |
| Port forward or IPv6, trusted certificate | `https://home.example.com:8443` | — |
| Port forward or IPv6, self-signed certificate | `https://203.0.113.7:8443` | `tlsPin` |
| Reverse proxy with Basic auth | the proxy's address | `headers.Authorization` = `Basic …`, `tokenHeader` |
| Reverse proxy asking for a client certificate | the proxy's address | `clientCertificate` |
| SSO gateway (Authelia, Authentik, oauth2-proxy) | the gateway's address | a rule that lets `/v1` through with an API token in `headers`, and `tokenHeader` when that token uses `Authorization` |

A path that needs an interactive login in a browser cannot be used by the app, and neither can
one that needs software of its own on the phone besides a VPN app (frp's `stcp`/`xtcp`).

The app connects through the best endpoint that answers, by priority: endpoints better than the
one in use keep trying to open the event stream, so the app moves up as soon as a better path
appears; worse ones are left closed until the path in use fails. Audio frames carry a sequence
number, so a frame arriving twice while paths change hands is played once. When the list changes
the backend sends a `client` event and the app reconnects as needed. `GET /v1/ping` answers
`{ "ok": true }` at once, without a token and without touching anything: the app's settings page
uses it to show how each path is doing, every 30 seconds while it is open.

`PATCH /v1/client` updates the client's own name, language and installation id: `name` is
trimmed and cut to 60 characters, and empty or not a string is `400` (`details.field: "name"`);
`uid` must be a UUID (`400`, `"uid"`); a `lang` that is not a string starting with `zh` is English.
It answers like `GET /v1/client` and sends the same to that client's sockets as a `client` event
(its labels may now be in another language). `DELETE /v1/client` unpairs it: the backend forgets
the token and any push tokens, closes the client's sockets, and answers `410 signed_out` to
anything that still presents it.

The `client` event carries `{ "client", "endpoints" }` — `GET /v1/client` without `pushTokens` — and
goes only to that client's own sockets, its endpoint labels in that client's language.

## Pairing and unpairing

Pairing is how a client gets its token, and there is one way to do it whatever the backend is.

### Finding the backend

A backend on the local network publishes `_cellpilot._tcp` over Bonjour, with TXT records
`api=1` and `path=/`; the app lists what it finds. Any backend can instead be reached by an
address the user types: a host and port on the LAN, or a full URL for one reached remotely.
The address only has to serve `POST /v1/pair`; after pairing the app uses the endpoint list.

### The exchange

The backend hands the user something to type into the app: `cellpilotd` shows a six-digit
code in its console, another backend may hand out a token of its own from wherever it manages
clients. The app sends it, with what it knows about itself, to `POST /v1/pair`:

```json
{ "code": "482913", "name": "iPhone 17", "platform": "ios", "lang": "zh", "uid": "9C2F…-…" }
```

and the backend answers with the token that will authenticate the client from now on, the
client record, and the endpoint list:

```json
{ "token": "…", "client": { "id": 31, "name": "iPhone 17", "lang": "zh" }, "endpoints": […] }
```

Rules a backend must keep:

- `code` is a string (missing or not a string: `400`, `"code"`, which is not a failed attempt and
  spends nothing); the backend decides what it accepts. What it hands out should be
  short-lived and single-use where it is short, like a six-digit code (recommended: five
  minutes, one valid code at a time, spent by the pairing it makes; `cellpilotd` also drops any
  non-digit, so `482 913` works). A backend whose "code" is already a long secret may simply
  return it as the token.
- The token is shown once, here. The backend stores only a hash of it and can never show it
  again; a lost token means pairing again.
- `name` is trimmed and cut to 60 characters (empty or not a string: `"iPhone"`); a `lang` that is
  not a string starting with `zh` is English.
- `uid` is the app installation's identity (`identifierForVendor`), a UUID; anything else is
  ignored. The same `uid` pairing again replaces the earlier client record — same id, new token,
  old token now unknown (`401`), the sockets opened with it closed — rather than adding a second
  one; a backend without `uid` support treats every pairing as new.
- `endpoints` is the only way the app reaches the backend from now on (an empty list makes it
  keep the address it paired with), so it holds at least one address the phone can reach, one
  that stays right: a Bonjour name rather than a DHCP address. Labels are in the client's language.
- Failures answer `401 unauthorized` and are rate-limited by source address; a code must not be
  guessable by trying. What counts as a failure: a wrong pairing code, and a token the backend does
  not know — each distinct value once, so a stale token retried is not a new guess. No credential
  at all, and a revoked token (`410`), are not failures. Recommended: five failures from one
  address in ten minutes block it for fifteen; any successful authentication from the address
  clears its count. While a source is blocked, only what would be another guess is refused,
  with `429` and without counting: an unknown token, a wrong pairing code, a wrong portal code.
  A token that works, the right pairing code, and a revoked token (still `410`) are answered as
  ever, so a block cannot lock out the phones behind a shared proxy address. Every `429` —
  the event stream's upgrade refusal included — carries `Retry-After`, the seconds the block has left.
- A backend may refuse `POST /v1/pair` on some listeners. `cellpilotd` accepts it on the local
  network only, so its six-digit code is never exposed to the Internet.

### What the app does with it

It stores the token, the client record and the endpoints, then behaves as paired: it connects
through the best endpoint, registers its push tokens if the backend has `push`, reports its
language and name with `PATCH /v1/client`, and asks for `GET /v1/client` on every launch and
return to the foreground so a changed endpoint list is picked up.

### Unpairing

Either side can end a pairing.

- **From the app:** `DELETE /v1/client`. The backend forgets the token and every push token
  registered under it, and drops the client (it is the client's own decision; nothing needs
  reviewing later). The app then forgets the token, endpoints, cached content and push key.
- **From the backend:** the backend revokes the client (in `cellpilotd`, from the console).
  From then on every request with that token — including the event stream upgrade — answers
  `410 signed_out`. The app, on the first `410`, forgets the token and everything it cached
  and shows the pairing screen; the backend may keep the revoked record until the client has
  been told, then let it go. The backend closes the client's open sockets (any close code will
  do — the app does not read it); the app reconnects (after 1 s, doubling to 15 s), the upgrade is
  refused, and its next HTTP request gets the `410`.

A `401` on a token that worked before is treated the same way by the app: a backend that has
forgotten a client for any reason ends up with the client forgetting it too.

## Status

`GET /v1/status` is what the app shows on its front page and is also the `hello` of the event
stream:

```json
{
  "backend": { "name": "cellpilotd", "version": "0.1.0", "uptimeS": 86400 },
  "device": {
    "connected": true,
    "identity": { "manufacturer": "Quectel", "model": "EC20F", "firmware": "…", "imei": "…", "imsi": "…", "iccid": "…", "ownNumber": "+8613800138000" },
    "sim": "ready",
    "signal": { "rssi": 22, "dbm": -69 },
    "registration": "registered",
    "operator": "CHINA MOBILE",
    "rat": "FDD LTE",
    "band": "LTE BAND 3",
    "volte": true,
    "smsStorage": { "used": 3, "total": 255 },
    "home": { "country": "CN", "areaCode": "010" },
    "location": { "country": "CN" },
    "updatedAt": "2026-09-25T08:14:03.120Z"
  },
  "call": null,
  "holder": null,
  "audio": { "ready": true, "active": false },
  "security": { "ok": true, "checkedAt": "…", "unacknowledged": 0, "checks": [] }
}
```

`device` is `null` when there is no device (none attached, or it has gone); an object with
`connected: false` is one found but still starting, or going away (`cellpilotd` sends one such
`status` event before it lets go). Inside it, `connected`, `sim`, `signal` (each value `null` when
unknown), `registration` and `updatedAt` are always there; anything unknown is `null`.
`identity`, `band` and `smsStorage` are optional. `audio.ready` says the backend can carry call
audio at all; `audio.active` that it is exchanging frames with the holder now. A backend with no
call audio reports `ready: false` and never sends `audio`; calls still connect, and the app says
there is no sound. `security` is present only with the `security` feature. `home` is the SIM's
home — the country that issued it (ISO 3166-1 alpha-2), from the IMSI's country code (MCC), or
without one from the country code of an own number entered by hand with `+` — and the area code
its own number belongs to (`null` when the backend cannot place the number), as
dialled nationally: with the trunk prefix where the country writes it as part of the code (a `0`:
`"0571"`, `"010"`), without where it does not (North America's `1`: `"212"`). It is what a number is read in
(*Numbers*), `areaCode` reading a local landline of the SIM's own area; neither is ever added to a
number. `location` is the country of the network the device is registered on, from that network's
MCC (the SIM's own country when it is registered nowhere), for display; it plays no part in reading numbers. Both are always
objects and each part is `null` when the backend cannot tell.

The `status` event carries `device` alone; the call, the holder and the audio have events of their own.

## The call

There is at most one call. `GET /v1/call` returns `{ "call", "holder" }`; `call` is `null` when
idle, otherwise:

```json
{ "id": 812, "state": "active", "direction": "in", "number": "+8613812345678",
  "place": "Hangzhou, Zhejiang · China Mobile", "startedAt": "…", "answeredAt": "…" }
```

`state` is one of `incoming`, `dialing`, `alerting`, `active`, `held`, `disconnecting`.
`number` is `null` for a withheld number (or while not yet known); a number that arrives after the
call has started fills in `number` and the record's `peer`, with a `call` event. `id` is the call's
record in the history, made when the call starts. `holder` is the client whose audio is connected to the
call (`{ "clientId", "name" }`), or `null` when nobody's is: while it rings, while the answering
machine has it, and once it ends. Every change, the holder's included, is a `call` event.

Actions, each answering `{ "call", "holder" }`. Their errors are checked in the order written
for each; with no device, `currentCall` is idle, so a check against the call comes before the
device's `503` where it is listed first:

- `POST /v1/call/dial` `{ "number" }`: grouping is stripped (*Numbers*), then it must be 1–32 of
  `0-9*#` with an optional leading `+` (`400`, `"number"`); any call at all, a ringing one
  included, is `409`; no device, `503`. The number goes to the network as typed; the dialling
  client becomes the holder.
- `POST /v1/call/answer`: answers the ringing call; the answering client becomes the holder.
  While the answering machine has the call it works as `claim`. Neither (no device included):
  `409`.
- `POST /v1/call/hangup`: ends the call or declines the ringing one, from any client. With no
  device it is `503`; with no call, `200` and nothing happens.
- `POST /v1/call/dtmf` `{ "digits" }`: 1–32 of `0-9*#` (`400`, `"digits"`); no `active` call
  (no device included) is `409`.
- With `screening`, `POST /v1/call/screen`: hands the ringing call to the answering machine; with
  nothing to screen (no ringing call, the machine switched off or already on a call) a plain
  hangup. And `POST /v1/call/claim`: the call moves to this client, which becomes the holder —
  the answering machine stops recording and leaves the line, a call held by another phone moves
  over, and a call still ringing is answered. No call is `409`.

When the module itself refuses a command — an `ERROR` to dialling or answering — the action
answers `500 internal` with the module's reply in the message, and the call it was for is over by
then: a refused dial leaves a `failed` record (or `busy`/`no-answer` when the module said so) and
no holder. `hangup` and `dtmf` answer `200` even when the module refuses them, since there is
nothing a client could do differently.

| | No device | Wrong state | Bad input | Module refuses |
| --- | --- | --- | --- | --- |
| `dial` | `503` | `409` (any call) | `400` `"number"` | `500` |
| `answer` | `409` (nothing rings) | `409` | — | `500` |
| `hangup` | `503` | `200`, nothing happens | — | `200` |
| `dtmf` | `409` (no active call) | `409` | `400` `"digits"` | `200` |

A second call arriving during one (call waiting) is not in the API: `cellpilotd` reports nothing
of it, and the network and the module deal with it.

### The history

`GET /v1/calls` is the history, newest first and paged, including calls still going on. A
record (`CallRecord`) is made when a call starts and written at three moments:

| When | Written |
| --- | --- |
| it starts (an incoming call rings, or the module takes a dial) | `outcome: "in-progress"`, `startedAt`; `answeredAt`, `endedAt`, `durationS` `null` |
| it connects | `outcome: "answered"`, `answeredAt`; when the answering machine picks up, `"voicemail"` |
| it ends | `endedAt`; `durationS` from connecting to the end in whole seconds, rounded (from the machine's pickup for one it took, also after a take-over, whose `answeredAt` stays the pickup), `null` if it never connected; the final `outcome` below |

| `outcome` | Meaning |
| --- | --- |
| `in-progress` | Not connected yet. |
| `answered` | Connected and still going on; never a final value. |
| `completed` | Connected and ended, whoever hung up. |
| `voicemail` | The answering machine took it and kept a message. A call a client took over from the machine (`claim`, or `answer` while it records) becomes `answered` and ends `completed`. |
| `missed` | Incoming and never connected: the caller gave up, it was declined, nobody answered — or the answering machine took it and got no message (*The answering machine*). `seen` becomes `false`. |
| `busy`, `no-answer` | Outgoing, the far end busy or not answering, when the module says so; a backend that cannot tell records `failed`. |
| `failed` | Outgoing and never connected for any other reason, the caller hanging up before an answer included; `endReason` says why when the network did. |
| `rejected` | Incoming and declined. Optional: `cellpilotd` records a declined call as `missed`; the app shows `rejected` as declined. |

A record left open when the backend restarts or the device goes away is closed then: never
connected (`in-progress`) is `failed`; `answered` is `completed`, ended then, its duration up to
then; `voicemail` stays `voicemail`, ended then, if the machine kept a message, and is
`missed` (`answeredAt` and `durationS` `null`) if not — a recording a restart cut off is lost. `endReason` is `null` unless the outcome is
`failed`. `peer` is `""` for a withheld number. The app shows `answered` and `completed` alike,
counts `missed` and `voicemail` as missed, and `in-progress` as going on.

The `calls` event (the newest page; its length is the backend's — `cellpilotd` sends 50) goes out
when a record ends, is seen or deleted, or a contact's name changes; not when a call starts or
connects, which the `call` event covers. `place`/`carrier` come with the `places` feature, and
`seen` is `false` for a missed call that nobody has opened yet; every other record is `seen: true` from the start — outgoing, answered, and
a voicemail with a message, which counts through its `heard` instead. `POST /v1/calls/{id}/seen` marks it seen for every client — `200` also when it
already was, `404 not_found` for no such record — and sends `calls` when `seen` changed; the app
calls it only for records with `seen: false` and ignores a failure. `DELETE /v1/calls/{id}` is
`404 not_found` for no such record; a record of a call still going on may be deleted too, and the
call then leaves none.

## Messages

Conversations are grouped by peer — the exact string (*Numbers* says how one person keeps one
peer). `GET /v1/conversations` lists them, not paged, newest first by the id of their last
message (`lastAt` is that message's `createdAt`), with the last message, the count of unread incoming messages, the contact name if any and the place if known.
`GET /v1/conversations/{peer}/messages` pages through one (`{peer}` URL-encoded, matched exactly; a
peer with no messages is `200` with an empty list). `POST /v1/conversations/{peer}/read` clears the
unread count — `200` also for a peer with nothing unread or no messages.

`POST /v1/messages` (`{ "to", "text" }`) sends. `to` is stripped of grouping and must then be 3–20
digits with an optional leading `+` (`400`, `"to"`); `text` is any non-empty string, split into
parts by the backend as needed (`400`, `"text"`); then no device is `503`, and nothing is recorded. It
answers `{ "message": { … } }`: the message, `direction: "out"`, `read: true`, in state `pending` —
or, if the backend waits for the module, already `sent` or `failed` (`cellpilotd` waits); the app
takes either. Events: `message` when it is recorded (`pending`), `message` again when it is sent
or fails (with `error`), then `conversations`. A message still sending when the backend restarts
or the device goes away becomes `failed`.

`DELETE /v1/conversations/{peer}` moves the conversation to the trash with the `trash` feature,
and deletes it for good without — `200` also for a peer with no messages; the history of calls with
the peer is left alone. `DELETE /v1/messages/{id}` deletes one message for good, trash or no
trash (one already in the trash too); `POST /v1/messages/{id}/trash`, with `trash`, moves one into
the trash (the app uses it for verification codes it has already used). Either is `404` for no
such message, and the latter also for one already in the trash.

A long incoming message is one record from its first part: each part sends a `message` event —
the same `id`, `body` assembled so far, `parts: { "received", "total" }` — and the last one
(`received` equal to `total`) is followed by `conversations` and the push; only then is it
notified. `parts` stays on the record once complete. Until then it is a message like any other:
in the conversation list (its body so far as `lastBody`), in search, in the unread count and the
badge.

`GET /v1/messages/search?q=` (with `search`) finds messages not in the trash whose body or peer
contains `q` as typed — a substring match, case-insensitive for ASCII letters, `%` and `_` taken
literally — newest first; `limit` defaults to 50, at most 200; an empty `q` answers `[]`.

The trash holds messages. `GET /v1/trash` lists one conversation per peer with messages in it,
summarised from those messages — so a peer can be in both lists — always with `unread: 0`.
Trashed messages are not in `/conversations/{peer}/messages`, search or the badge, and nothing
reads them one by one: they are restored or purged by peer. `POST /v1/trash/restore` and
`POST /v1/trash/purge` take `{ "peers": [...] }` (empty is `400`; past 500 only the first 500 are
done): restore puts all of a peer's trashed messages back, purge deletes them for good and leaves
the peer's live messages alone. A trashed message may be purged once it is 30 days old (`cellpilotd` purges when it starts). Each of these sends a
`conversations` event with `trash`.

A message is `{ "id", "direction": "in"|"out", "peer", "body", "status": "pending"|"sent"|"failed"|"received",
"createdAt", "deviceTime", "parts", "error", "read" }`, every field present: `deviceTime` is the
time the network stamped on an incoming message (`null` for an outgoing one, or none given),
`parts` is `{ "received", "total" }` for a message of several parts and `null` for one of one,
`error` says why a `failed` one failed and is `null` otherwise.

## Contacts (feature `contacts`)

A contact is a person: a name in two parts and the numbers that reach them.

```json
{ "id": 7, "firstName": "小明", "lastName": "王", "name": "王小明", "numbers": ["+8613800138000", "057123456789"] }
```

`GET /v1/contacts` lists them by display name (case-insensitive; equal names in the order they
were created); `POST /v1/contacts` creates
one and `PUT /v1/contacts/{id}` replaces one whole — a field left out is empty — both answering
`{ "contact" }`; `DELETE /v1/contacts/{id}` removes it. Names are trimmed and cut to 80
characters. `numbers` holds up to 20 (`400`, `"numbers"`); each is kept in its stored form
(*Numbers*), cut to 32 characters, and one with no digit at all is dropped — none is refused for
its shape; the same stored number twice in one contact is kept once (an exact match:
`+8613800138000` and `13800138000` are both kept), the limit counting what was sent. A name or a number is required (`400`, `"firstName"`). A number belongs to one contact:
giving the same string to another takes it from the first. Every change sends `contacts`, then
`conversations` and `calls`, whose names may have changed.

Two rules make every client and backend agree, and a backend must apply both:

- **Display name.** `name` is computed by the backend: when either part is written in a
  Chinese, Japanese or Korean script the family name comes first with no space (王小明);
  otherwise the given name comes first with a space (John Smith); one part alone is shown as it
  is, and no name at all is `""`. Everything that names a peer — `Conversation.name`, push
  titles, CallKit — uses it.
- **Number matching.** The network writes a number one way and a person types it another, so
  a contact is found by its digits, not by the string: keep only digits, drop a leading `00`,
  then drop every leading zero; two numbers are the same when the keys are equal or one is the
  tail of the other and the shorter has at least seven digits. `+86 138 0013 8000`,
  `13800138000` and `013800138000` are one number; a short service number never matches the
  end of a long one. `Conversation.contactId`, `CallRecord.contactId` and `Call.contactId` are
  filled this way; when numbers of several contacts match, `cellpilotd` takes the one stored first.

## Numbers

A number with a country code is read by that country's rules; one without, by the rules of the
SIM's home country; what neither reads is shown as one run of digits.

**Stored as it came.** A number is kept exactly as the user typed it or the network delivered
it, less its grouping: the digits, a leading `+`, and the `*` and `#` of a USSD code stay; spaces,
dashes, dots and brackets go. Nothing is ever added — no country code, no area code — and that
holds for the device's own number too, read from the SIM or typed. A value with no digit at all
(`"anonymous"`, a withheld caller) is no number: `""` — except an SMS sender, which can be a name
(`CMBCHINA`): that is kept as it came, trimmed, and is a conversation of its own (matched exactly;
the matching rule never joins it to anything). `Message.peer`, `Conversation.peer`,
`CallRecord.peer`, `Voicemail.peer`, `Call.number`, a contact's `numbers` and `ownNumber` are all
stored forms. `dial`'s `number` and `send`'s `to` are stripped of grouping before their checks, and
go to the network as typed.

**One person, one conversation.** A new message or call is filed under a peer already on file —
in the messages or the calls — when it is the same number by the matching rule (*Contacts*): that
exact peer if it is there, otherwise the most recently active match. Otherwise it is filed under
the number as it came. So `+8613800138000` from the network and `13800138000` as typed end up in
one conversation, and a `{peer}` the app holds stays valid.

**Read, never rewritten.** Reading a number only says what it is — for the place line under it
(`place`, `carrier`) and for the app to group its digits on screen. It follows how networks and
people write numbers: a call from abroad, and every call while the SIM roams, arrives with `+` or
`00` and its country code (3GPP TS 23.081 §1.2.1: the number shown to a roaming subscriber is in
international format); only callers from the SIM's own country arrive nationally, and only
landlines of the SIM's own area without their area code; and a user knows where the SIM is from
and writes numbers the same way. A country code or area code that is not there is never assumed,
but for that one local case. Corrupted caller ids and typos are not catered for.

1. **`+` or `00` and a country code**: read in that country (some networks deliver an
   international caller as `0085261234567`); a trunk zero typed after the code is not part of the
   number (`+86 (0)571 2345 6789` reads as `+8657123456789`, and is stored as `+86057123456789`). A number that country issues is
   international; a hotline of that country is a hotline, read and grouped by its rules
   (`+86 400 123 4567`, `+1 800-555-0199` — shown `+1 800-555-0199`, its place that country's);
   anything else is unresolved (`+61 8765 4321`, a Melbourne landline without its area code).
2. **Three to six digits**: a short code (`110`, `10086`, `95533`). A USSD string (`*100#`) too.
3. **Anything else** is read in the SIM's home country (`device.home.country`) alone: a full
   national number — a mobile, or a landline with its area code, with or without the area code's
   trunk zero (`13800138000`, `057123456789`, `57123456789`) — is international; a hotline of
   that country (`4001234567`) is a service number; then, on a Chinese SIM, `106` followed by 5 to
   17 digits is an SMS **gateway** sender (libphonenumber has no rule for these; on a Hangzhou SIM
   `10690000` is a gateway, not a local landline); then, digits that are a landline with
   `device.home.areaCode` in front (and do not start with the trunk prefix) are a local landline of
   the SIM's own area (on a Hangzhou SIM `23456789` reads as `+8657123456789`, with its place, the
   stored number staying `23456789`). Otherwise it is **unresolved** —
   including a country code written without `+` or `00` (`8613001300000`), and anything when the
   SIM's home is not known.

Where the device is, and the phone's own region, play no part. Only international and service
numbers have a place line, a hotline's from its own country; gateway and unresolved ones have none
rather than a guess. The tables that say what a country issues, and how its numbers are grouped,
are libphonenumber's (`+1` numbers belong to the territory that issues them — Canada and the
others — and are grouped the way the United States writes them). The app shows an international
number by grouping its stored digits the way its country writes them — national stays national
(an area code typed without its zero shown without it: `571 2345 6789`), `+` stays international,
`00` and a country code are shown with `+` (`0085261234567` → `+852 6123 4567`; stored and dialled
as they came), a trunk zero after a country code is not shown (`+61 412 345 678`), and a local
landline is grouped as the whole number would be but shown without the area code
(`23456789` → `2345 6789`). Short codes, gateway senders and unresolved numbers are one run of
digits. The rules are written out as a table of cases in `fixtures/number-rules.json`
(what is stored, what it reads as, how it is shown, its place), which the reference backend
and the app are both tested against; a backend of your own can run the same table.

## The answering machine (feature `voicemail`)

The machine picks up a call that rang `settings.voicemail.answerAfterS` seconds unanswered
(`reason: "no-answer"`; not when it is switched off), or one a client handed it with `screen`
(`reason: "declined"`). It picks up only with call audio flowing; without it — the audio path
failed to start — the backend hangs up instead, and the call is a missed one. The call is then
`active` with `holder: null` and its record `voicemail`.
Once recording starts it sends `{ "type": "voicemail", "recording": true, "peer", "reason",
"transcript": "" }`; with transcription, one more per recognised piece, `transcript` being the
whole text so far and `delta` the new part. It ends when the caller hangs up, at `maxSeconds`
(the backend hangs up), or when a client takes the call over; then `recording: false` and the
final `transcript` (`""` without transcription, never `null`, in the event; the saved voicemail's
`transcript` is `null` when nothing was transcribed). Call audio failing while the machine
records ends the recording there: the backend keeps what came before and hangs up.

A recording becomes a voicemail (`voicemails` event, `voicemail` push) only when it holds a
message: sound above the line's own noise, or, where it was transcribed, words. Anything else — a
recording under a second, or silence however long — is no message: nothing of it is kept, and the
call ends as a missed one, its record `missed` with `answeredAt` and `durationS` `null` and `seen`
`false`, with a `missed-call` push ("Missed call · no message left"). A take-over keeps what was
recorded as a voicemail if it holds a message, sends neither push, and the call goes on as an
answered one, its `answeredAt` still the machine's pickup. `peer` is `""` for a withheld number.
When the call ends while the machine records, `call` (`null`) and `calls` come first and the
`voicemail` with `recording: false`, then `voicemails`, after.

`GET /v1/voicemails` lists the newest (up to 200 in `cellpilotd`), `?peer=` matching exactly.
Fetching a recording (`GET /v1/voicemails/{id}/audio`, `audio/wav`) the first time marks it
heard and sends `voicemails`. `POST /v1/voicemails/{id}/transcribe` (`language`: `auto`, `zh`,
`yue`, `en`, `ja`, `ko`) works whenever `transcription` is declared, whatever its switch; one
runs at a time (`409`); it answers `{ "transcript", "language" }` with the language asked for, and
sets the voicemail's `transcriptLanguage` to it (`auto` included) — a live transcript's is `null`.

## Settings (feature `settings`)

`GET /v1/settings` and `PATCH /v1/settings` (a partial object; it answers the whole). Switching the
machine off (`voicemail.enabled: false`) also switches transcription off, and transcription cannot
be switched on while it is off (asking is not an error: `enabled` stays `false`). Each of `voicemail` and `transcription` present in a `PATCH` is
applied and sends a `features` event (moving `rev`), even when nothing in it changed; `ownNumber`
present sends a `status` event; then every `PATCH`, `{}` included, sends a bare `rev`, so a client
always takes a snapshot after one. The parts are applied in that order, each checked as it comes:
a `400` on a later one leaves the earlier ones applied. `ownNumber` is the SIM's number when the SIM has one, else the
one typed (`ownNumberSource` says which); `PATCH` takes any value with a digit, stored as it came,
and `null`, `""` or a value with no digit clears the typed one. A value out of range is `400` with the dotted field
(`"voicemail.maxSeconds"`, `"transcription.fallbackLanguage"`); `fallbackLanguage` is one of
`zh`, `yue`, `en`, `ja`, `ko`.

## Security (feature `security`)

`GET /v1/security` answers `{ "state", "alerts" }`, the alerts unacknowledged ones unless
`?all=true`; the `security` event and `hello` carry the unacknowledged ones. A check reports the
state now (`ok`, a line of `text`, and `severity` — `warning` or `critical` — only when it fails):
acknowledging an alert does not make a check pass. `state.ok` is `false` while any alert is
unacknowledged, whatever the checks say now; `unacknowledged` counts them. A condition already
failing when the backend starts raises its alert at the first check that sees it, unless that alert
was raised before the restart. `POST /v1/security/alerts/{id}/ack` acknowledges one (`200` also when
it already was; no such alert is `404`), `POST /v1/security/alerts/ack` all.

## Log (feature `log`)

`GET /v1/log` pages through the backend's log, newest first (`limit` 200 by default, at most 1000),
and the `log` event carries each new entry: `{ "id", "at", "level": "info"|"warn"|"error",
"category": "security"|"activity"|"devices"|"system", "code", "text" }`. `text` is worded in the
reader's language and is what the app shows; it filters by `category` and marks `warn` and
`error`. `code` is the backend's own, stable within it; `cellpilotd`'s include `sms.received`,
`sms.sent`, `call.incoming`, `call.ended`, `voicemail.saved`, `device.paired`, `device.revoked`,
`auth.failed`, `auth.blocked`, `pairing.badCode`, `security.alert`, `push.failed`,
`push.recovered`, `module.connected`, `module.disconnected`, `settings.voicemail`. A backend may use
any codes; the app does not act on them.

## Event stream

`GET /v1/events` upgrades to a WebSocket. It authenticates like any request, with the token
header — the app always sends it, so a backend need not accept a token in the query string.
The app sends `X-Lang` and `?lang=` too; the events of a client's socket are worded in
the `lang` on that client's record (which the app keeps current with `PATCH /v1/client`), not by
those. It honours the endpoint's extra headers. A refused upgrade is a bare HTTP status (`401`,
`410`, `429` with `Retry-After`) and a closed connection; a `GET` without the upgrade is
`404 not_found` once authenticated. Every frame is defined in [events.schema.json](events.schema.json).
The server speaks first:

```json
{ "type": "hello", "backend": {…}, "features": […], "status": {…the status object…}, "badge": 3, "rev": "munlb97h.15" }
```

`type`, `backend` (`{ "name", "version", "uptimeS" }`), `features` and `status` are required.
`badge` is optional, `rev` comes with `snapshot`, and a backend with `security` may add `alerts`
(the unacknowledged ones, as `GET /v1/security` lists them).
A backend may send more fields of its own, and clients ignore what they do not know.

With the `snapshot` feature, `rev` is the version of everything a client keeps: this run of the backend, a dot, and a counter
that every change to messages, conversations, calls, contacts, voicemails, alerts, features or
settings moves on by one. Each event that carries such a change carries the new `rev`; a change no
event carries (settings) arrives as `{ "type": "rev", "rev" }` alone. A client that holds state at
`rev` needs nothing when `hello` says the same. Otherwise — a different run, a counter more than
one step on, or a bare `rev` event — it fetches `GET /v1/snapshot`: every list, the settings, the
alerts, its own record (`client`, with `pushTokens`), the push state and the badge, at one `rev`,
in one request. That is the app's only refresh; there is no polling.

What moves `rev`, and the event that carries the new one: a message recorded or changing status
(`message`); the conversation list or the trash (`conversations`); the history (`calls`); contacts
(`contacts`); the recordings (`voicemails`); the checks' findings or the alerts (`security`); the
feature list (`features`); the settings and a change of the push `problem` (a bare `rev`). Nothing
else does: not `status`, `call`, `audio`, a live `voicemail`, `log`, `badge`, `client` or `notify`,
nor registering a push token, nor an enrolment on the relay (the app that enrolled has the
answer) — unless the enrolment clears a push `problem`, which is that problem's change. A
`PATCH /v1/settings` moves it once per `voicemail` or `transcription` object in the body (a
`features` event each, sent even if the list is the same), then once more with the bare `rev`
(*Settings*). The snapshot's `calls` is the newest page of 100. The rule behind it: `rev` is one counter for every client, so every step must reach every
socket — an event sent to one client only must not move it, or the others see a gap and fetch a
snapshot for nothing.

A backend without `snapshot` leaves `rev` out. The app then reads everything again at each
connection, one request per list (`/status`, `/conversations`, `/calls`, and `/trash`,
`/contacts`, `/voicemails`, `/settings`, `/security` as declared, then `/client`), and applies
the events that follow as they come. That is always correct, only slower.

Then, as things happen, one JSON text frame per event:

| `type` | Fields | When |
| --- | --- | --- |
| `status` | `device` | The device's state changed (signal, registration, SIM, attach/detach; `device` may be `null`). |
| `call` | `call`, `holder` | The call or its holder changed. Sent at every transition, including to `null`. |
| `audio` | `active` | The backend started (`true`: its audio path is up for the call, which can be before it connects) or stopped exchanging audio frames with the holder. The app turns its microphone and speaker on at `true`. |
| `message` | `message` | A message arrived (each part of a long one), an outgoing one was recorded, or it changed status. |
| `conversations` | `conversations`, `trash`? | The conversation list changed (new message, read, deleted, restored). |
| `contacts` | `contacts` | The contact list changed. |
| `calls` | `calls` | The history changed; carries the newest page (see *The history*). |
| `voicemail` | `peer`, `reason`: `no-answer`\|`declined`, `recording`, `transcript`, `delta`? | The answering machine is recording (`recording: true`, `transcript` the whole text so far, `delta` the new part) or finished; see *The answering machine*. |
| `voicemails` | `voicemails` | The recording list changed. |
| `security` | `state`, `alerts`, `alert`? | What the checks found changed, or an alert was raised (`alert` is the new one) or acknowledged. `alerts` are the unacknowledged ones. |
| `client` | `client`, `endpoints` | The client's record or the endpoint list changed. Only to that client's sockets. |
| `features` | `features` | What the backend can do changed; the same list as `GET /v1`. |
| `log` | `event` | One log entry, with the `log` feature. |
| `rev` | `rev` | Something clients keep changed that no event carries (settings): fetch a snapshot. |
| `badge` | `badge` | The app icon's count changed: unread incoming messages not in the trash + records with `seen: false` + unheard voicemails + unacknowledged alerts. |
| `notify` | `id`, `kind`, `callId`?, `reason`? | Something that may call for a notification; only to one client's sockets, which answers with `ack` (below). |

Unknown types must be ignored, so a backend may add its own. Which happening sends which events,
notifies and pushes is one table: *From a happening to events and pushes*.

A client may hold several sockets at once, one per endpoint; they are one client. Every event goes
to each of them.

### Presence and `notify` (feature `notify`)

The backend pings every socket every 10 seconds (WebSocket ping frames) and closes one that has
not answered within 20 — a pong or any JSON text frame from it counts; audio frames do not. What
stays open is a client that is really there. Before it pushes, it
hands the thing to each client that has a live socket, and pushes only to those that do not say
they showed it:

```json
{ "type": "notify", "id": "sms-42", "kind": "sms" }
```

The client answers once per `id` and `kind`, on the socket it came in on, naming both (a call's id is shared by `call`, `call-end` and `missed`, each its own question):

```json
{ "type": "ack", "id": "sms-42", "kind": "sms", "state": "foreground" }
```

`foreground` means the app is on screen and showed it itself — nothing is pushed. `background`,
or no answer within 5 seconds (1.5 for a call), and that client gets the push. A client with no
live socket is not asked; one with no push token is asked all the same, and then has nothing to
push. `id` is `call-<id>`, `sms-<id>`, `alert-<id>` (`voicemail-<id>` for a voicemail with no call
record), the same as the push's collapse id, so a client shows each once whichever road brings it.
`kind` is `call` (a ringing call, only to clients without a VoIP token — those get the VoIP push
at once — with `callId`), `missed`, `voicemail`, `sms`, `alert`, or `call-end`.

**The ringing stops.** When the call leaves `incoming`, `reason` is `answered` if a client answered
it; `unanswered` if the answering machine took it (`screen` included), the caller gave up or
nobody answered; `declined` if it ended unanswered within 15 seconds of a client's `hangup`.
`call-end` (with `callId` and `reason`) goes to every client that was sent a VoIP push for the
call, except the one that answered, declined, or sent it to the machine (with `screen`, within
the same 15 seconds). Any `ack` —
`foreground` or `background` — means that client took its call screen down; one that does not
answer within 1.5 seconds, or has no live socket, gets the VoIP "end" push. A client whose system
never showed the call (Focus held it back) may send that `ack` before it is asked, as soon as it
knows; it is then neither asked nor pushed when the ringing stops — an end push would have to be
reported as a call again, and Focus lets a second call from the same number through.

An `ack` is the only JSON a client sends.

## Audio frames

Call audio travels on the event stream as binary frames, in both directions, only while the
connected client is the holder. The format is raw PCM: 16-bit little-endian, 8 kHz, mono,
20 ms per frame (320 bytes of samples). A backend sends downlink as the audio comes, one frame
every 20 ms, not in bursts.

```
downlink (backend → client)   0x01 | seq hi | seq lo | 320 bytes PCM
uplink   (client → backend)   0x02 | seq hi | seq lo | 320 bytes PCM
```

`seq` is a 16-bit big-endian counter that wraps; each direction keeps its own. A receiver
compares with serial arithmetic: `d = (seq − last) mod 65536`, `last` being the newest frame it
played; `d == 0` is a frame already seen (the same frame can arrive through two endpoints) and
`d > 32768` an older one, both dropped; `1 ≤ d ≤ 32768` is new. A backend sends downlink only to the
holder — the same frame, same `seq`, to each of its sockets — and accepts uplink only from it,
dropping anything else; the app sends uplink as it captures it, one frame every 20 ms. Uplink frames that are silent do not claim
anything; the backend may use signal level to decide which of several sockets of the same
client is live.

## From a happening to events and pushes

The one table of what each happening sends. "rev" marks an event that moves it (with
`snapshot`). Notify and push columns apply with `notify` and `push`; without `notify` the backend
pushes straight away. The push columns name the category and collapse id of *Push*; excluded
clients are asked nothing and pushed nothing.

| Happening | Events (to every socket) | `notify` kind (wait) | Push | Excluded |
| --- | --- | --- | --- | --- |
| A message arrives (a long one: once complete) | `message` rev (also per part, each part maybe moving `badge`), `conversations` rev, `badge` | `sms` (5 s) | alert `sms`, `sms-<id>` | — |
| An outgoing message is recorded | `message` rev (`pending`) | — | — | — |
| It is sent or fails | `message` rev, `conversations` rev | — | — | — |
| A call starts ringing (number known, or 2 s) | `call` | `call` (1.5 s), clients without a VoIP token | VoIP at once to clients with a VoIP token; alert `call`, `call-<id>`, to the others not on screen | — |
| It stops ringing | `call` | `call-end` (1.5 s), clients sent a VoIP push | VoIP "end" to those not acknowledging | the client that answered, declined, or sent it to the machine |
| It connects, or the holder changes | `call` (and `audio` when the path comes up) | — | — | — |
| It ends | `call` (`null`), `calls` rev; if missed `badge` | missed only: `missed` (5 s) | missed only: alert `missed-call`, `call-<id>` | — |
| The machine records | `voicemail` (no rev) | — | — | — |
| A voicemail is saved | `voicemails` rev, `badge` | `voicemail` (5 s) | alert `voicemail`, `call-<id>` (`voicemail-<id>` without a record) | none; not sent at all when a client took the call over |
| The machine got no message | `calls` rev, `badge` | `missed` (5 s) | alert `missed-call`, `call-<id>` | — |
| An alert is raised | `security` rev (with `alert`), `badge` | `alert` (5 s) | alert `security`, `alert-<id>` | — |
| Checks' findings change, an alert is acknowledged | `security` rev | — | — | — |
| A setting changes (`PATCH /v1/settings`) | `features` rev per `voicemail`/`transcription` object, `status` if `ownNumber`, then `rev` | — | — | — |
| The push problem changes | `rev` | — | — | — |
| A conversation is read, a call seen, a voicemail heard, something deleted or restored | `conversations` / `calls` / `voicemails` rev; `badge` if the count moved | — | badge-only, to clients without a live socket, if the count moved | clients with a live socket |
| A contact changes | `contacts` rev, `conversations` rev, `calls` rev | — | — | — |
| The device's state changes | `status` | — | — | — |
| A client's record or the endpoints change | `client`, to that client only | — | — | — |

Within a row the events go in the order listed, every socket getting them in that order; `notify`
frames follow the events, and pushes follow the answers to them. A call the answering machine took
ends in two rows: *It ends* (`call` `null`, `calls`), then *A voicemail is saved* or *The machine got
no message*. A take-over sends `call` (the new holder) and `calls` (`answered`) before the
machine's `voicemail` with `recording: false`.

## Push (feature `push`)

The app cannot be woken by the backend directly; Apple Push Notification service (APNs) does
that, and only the holder of the app's APNs key can send through it. CellPilot operates a relay
for backends: `https://push.cellpilot.dev`, whose two routes a backend uses are defined below
(*The relay*). The relay is built not to see a number or a message: every push a conforming
backend sends is sealed for the one app that will open it, and the relay refuses anything in the
clear but a bare badge count (it checks the shape, not the wording of the 40 characters in the
clear). It does see what delivery needs: the APNs token, the account, the backend's id and label,
and when each push is sent. Which happening pushes what is in
*From a happening to events and pushes*.

### Registration

The app calls `POST /v1/client/push-tokens` with `{ "token", "kind": "alert"|"voip", "environment": "sandbox"|"production" }`
at every launch, for tokens missing from `pushTokens`; `token` is 32–200 hexadecimal digits, and
bad values are `400` with the field. A
backend keeps them by token, with the client and kind: the same token again is no change, from
another client it moves to that client, and a client may hold several of a kind (all are pushed
to). They go when the relay says one is gone and when the client unpairs or is revoked. The
backend has no use for `environment` when it pushes through the relay, which knows each token's. `DELETE /v1/client/push-tokens/{token}` takes one back (only the client's own; `200` also for a
token it does not hold): the app does it with its VoIP token
when the user turns the system call screen off, since iOS shows every VoIP push as a call. A
backend with no VoIP token for a client sends it calls as ordinary alerts.

### Envelope

The key is derived from the client token both sides already have, so nothing extra is
exchanged:

```
key = HKDF-SHA256(ikm = SHA-256(token), salt = "cellpilot", info = "push-v1", length = 32)
```

where `token` is the client token as UTF-8 and `ikm` is the 32 raw hash bytes (the backend
stores the hex hash; use its bytes). Test vector: token `test-token-abc123` gives key
`be1588bb645dc5912eb961418ef2143b6bf623f1c0e85e1ec038ae43a16b179e`.

The payload is a JSON object, UTF-8, encrypted with AES-256-GCM under a fresh 12-byte nonce, no
additional data, 16-byte tag, and sent as `nonce ‖ ciphertext ‖ tag` in base64url (no padding) in
the field `e`, alongside `v: 1`. Test vector: with that key, nonce `000102030405060708090a0b` and
the payload `{"title":"妈妈","body":"晚点到","category":"sms","peer":"+8613812345678","messageId":42}`,
`e` is `AAECAwQFBgcICQoLU1I1IUCqNYHuNp5_qSu3qSwweGAE5VyXJ_TwCp-GcL5m6DybdH4HHDt64o6eXWsbDznzcsffdWh3t8DQRojwIgS7r0kXDQgFnpiIjGPrtgCePtq-5JEeETZIwNa0edO7mMBOz7BYBIq9BgQnCw`.

An **alert** push is what the phone shows for a message, a missed call, a voicemail or a
security alert. In the clear it says nothing:

```json
{ "aps": { "alert": { "title": "CellPilot", "body": "New message" }, "sound": "default",
           "category": "sms", "interruption-level": "active", "mutable-content": 1 },
  "e": "…", "v": 1 }
```

The clear text says only what kind of thing arrived; the app's notification extension replaces
it with the sealed contents, `{ "title", "body", "category", …data }`, worded in the client's
language, `category` the same as `aps.category`. These are the only five categories, and the
app routes a tap by them and by the field names:

| What | `category` | sealed `title` / `body` | sealed data | collapse id | `interruption-level` | `sound` |
| --- | --- | --- | --- | --- | --- | --- |
| A message | `sms` | the peer's name or number / the text, cut to 240 characters with `…` | `peer`, `messageId` | `sms-<id>` | `active` | `default` |
| A ringing call, to a client without a VoIP token | `call` | "Incoming call" / the caller (name, number, or "No caller ID") | `number` (`null` if withheld), `callId` | `call-<id>` | `time-sensitive` | `ringtone.caf` |
| A missed call | `missed-call` | the caller / "Missed call" ("Missed call · no message left" when the machine took it and got no message) | `number`, `callId` | `call-<id>` | `active` | `default` |
| A voicemail | `voicemail` | the caller / e.g. "Missed call · voicemail 18 sec" | `voicemailId`, `number`, `callId` | `call-<id>` (`voicemail-<id>` without a record) | `active` | `default` |
| A security alert | `security` | "Security alert: " + its title / the first line of its detail | `alertId` | `alert-<id>` | `time-sensitive` | `default` |

`mutable-content: 1` is required: it is what lets the extension open `e`. The relay passes an
alert only as exactly `aps`, `e` and `v`: `aps.alert.title` `"CellPilot"`, `aps.alert.body` a string
of at most 40 characters (its wording is free — `cellpilotd` uses `New message`, `Incoming call`,
`Missed call`, `New voicemail`, `Security alert`, or 新消息, 来电, 未接来电, 新留言, 安全告警), `aps`
holding only `alert`, `sound`, `category`, `interruption-level`, `mutable-content`, `thread-id` and
`badge` (an integer 0–99999), and `e` 16–4000 characters long. Everything in `aps` travels in the
clear: put nothing in the alert's body or in `thread-id` that names a person or quotes a message.

Every alert push but a ringing call's carries the icon count as `aps.badge`: unread incoming messages not in the trash
+ records with `seen: false` + unheard voicemails + unacknowledged alerts, the same number as
`hello`, the `badge` event and the snapshot's `badge`. When something is read on one client,
clients without a live socket get `{ "aps": { "badge": n } }` alone — nothing sealed, nothing
shown, no collapse id; iOS reads the count from nowhere else. Changes within 300 ms are sent once
(the `badge` event too),
and only when the count differs from the one last sent — one count for the whole backend, set by
any push or `badge` event to any client, starting from the count when the backend started.

A **VoIP** push rings the phone through CallKit for an incoming call, sent as soon as the
number is known (or after two seconds without one, a withheld number). It has exactly `e` and
`v`, no `aps`, and seals `{ "callId", "number", "name", "place": { "en", "zh" } }`: `number` `null`
when withheld, `name` the contact's display name or `null`, `place` always an object, each
language `null` when unknown (both, without `places`). It
must only ever be sent for a call that is actually ringing — iOS makes the app report a call for
every VoIP push — and the relay sends it so it is never delivered late. A client sent one gets no
`call` alert and no `notify` for that call. When the call stops ringing, a client that did not
acknowledge `call-end` (see *Presence and `notify`*) gets one more, sealing
`{ "type": "end", "callId", "reason" }`; the app reports it and ends it at once. Without `type`
the app would take it for a new call.

### Through the relay

A backend sends the finished APNs body to the relay's `POST /v1/push`, signed with its own
Ed25519 key. To be allowed to, it has to be *enrolled* under an account on the relay — the
user's Sign in with Apple identity, which the app handles. The app does the introduction:

1. The user signs in with Apple in the app, which binds the phone's own APNs tokens to that
   account on the relay, so a backend reaches only the phones of the account it is enrolled under.
2. The app asks the backend how it pushes: `GET /v1/push` answers
   `{ "mode": "none" | "relay" | "direct", "relay": { "url", "daemonId" } | null, "problem"? }`.
   `none`: no way to push yet; `relay`: enrolled. (`direct` is reserved; a backend reports `none`
   or `relay`.)
   `problem` (optional) says why pushes are not getting through, so the phone can tell its owner:
   `{ "code", "at", "quota"? }`, where `code` is `suspended`, `not-entitled`, `quota` (with the
   daily `quota`), `rate`, `not-enrolled`, `unbound`, `apns` or `unreachable`, and `at` is when it
   began — a later refusal for the same reason does not move it. `quota` is the relay's daily
   limit, with `quota` only. It is `null` or absent once a push gets through; nothing is retried on
   a timer, every push is tried, so the first that gets through after a suspension, an
   entitlement or the day's quota is restored clears it. A backend with `snapshot` moves `rev`
   when it changes; the same object is the snapshot's `push`. The app shows it in Settings and
   rebinds its tokens on the relay itself when the code is `unbound`.
3. If the mode is `none`, the app gets a one-time grant from the relay (ten minutes) and hands it
   to the backend: `POST /v1/push/enrol { "relayUrl", "grant" }`. The backend enrols on the relay
   (`POST /v1/daemons`, below) and answers with its new push state. From then on it pushes
   through the relay, which lets it reach the phones of that account and no others. `relayUrl` is
   `https://host[:port]`, no path, a trailing `/` dropped (`400`, `"relayUrl"`); `grant` is 16–200 characters (`400`,
   `"grant"`). A relay that refuses, or does not answer in 15 seconds, is `502 upstream_failed`,
   its status and `error` in the message. Enrolling again with the same key keeps the `daemonId`.
   The backend keeps `relayUrl` as given (less surrounding spaces and a trailing `/`) and reports it as `relay.url`; one pointed at a test relay
   instead (*Testing*) reports the address it actually uses.

### The relay

Two routes, both JSON, at the relay's address (`https://push.cellpilot.dev`, no path).

**`POST /v1/daemons`** — enrol. Not signed: the grant is the credential.

```json
{ "grant": "…", "publicKey": "<32 raw bytes, base64>", "proof": "<signature, base64>", "label": "my-backend" }
```

`proof` is the Ed25519 signature of `cellpilot-enrol\n` + grant with the key's private half — a
public key is no secret, and without it anyone could file someone else's backend under their own
account. `label` is optional (cut to 60 characters). It answers `200 { "daemonId": "d_…" }`; the
same key enrolled again keeps its id (and moves to the grant's account). Refusals:
`400 {"error":"grant, publicKey and proof"}` (missing, or a key that is not 32 bytes),
`401 {"error":"proof not accepted"}`, `401 {"error":"grant not accepted"}` (unknown, expired or
spent), `429 {"error":"too many requests"}` (too many enrolments from one address). Nothing else is
needed: once enrolled, the backend reaches every phone that account has bound.

**`POST /v1/push`** — signed (below).

```json
{ "token": "<the phone's APNs token>", "type": "alert", "body": { "aps": { … }, "e": "…", "v": 1 }, "collapseId": "sms-42" }
```

`type` is `alert` (badge-only included) or `voip`; `body` is the APNs body exactly as *Envelope*
describes, which the relay checks (only sealed bodies, and a badge alone, pass); `collapseId` is
optional, the first 64 characters used, and left out for a badge alone and for VoIP. The relay
picks the APNs environment from the token's binding and sets topic, push type, priority (5 for a
badge alone, else 10) and expiry (an hour for an alert, 0 for VoIP) itself: a backend never
sends `environment` or APNs headers.

**The relay's answers** to `POST /v1/push`: `200 {"ok": true}` clears `problem`; otherwise
`{ "error", …}`, mapped as follows (a body with `gone: true` means the token is gone whatever the
status — forget it):

| HTTP | `error` | `problem.code` |
| --- | --- | --- |
| 400 | `only sealed pushes are relayed`, `body is not JSON` | none: fix the push |
| 401 | `not authorized` (signature, key id, clock or nonce) | `not-enrolled` |
| 402 | `account suspended` / `not entitled` | `suspended` / `not-entitled` |
| 403 | `token not bound to this daemon` | `unbound` |
| 410 | `token gone`, with `gone: true`, `reason` | none: forget the token |
| 429 | `daily quota reached`, with `quota` / `rate limited` (the hourly limit) | `quota` / `rate` |
| 502 | `apns refused`, with `status`, `reason` | `apns` |
| other 5xx, no answer in 15 s | | `unreachable` |

The texts are matched loosely: a `402` whose `error` contains `suspended` is `suspended`, any other
`not-entitled`; a `429` whose `error` contains `daily quota` is `quota`, any other `rate`.

Only pushes the relay actually sends on to Apple count against the account's hourly and daily
limits, whose values the relay's answers give; a refused one — for any reason, the quota and the hourly limit included —
costs nothing. **`not-enrolled`** means the relay no longer knows the backend's key, which
nothing on the backend's side can mend: the backend lets its enrolment go, so `GET /v1/push`
reports `mode: "none"`, `relay: null`, `problem: { "code": "not-enrolled", … }`, and the next app
that refreshes enrols it again — with the same key, which gets the same `daemonId` back.

**Signing.** Every request but `POST /v1/daemons` carries `x-relay-key` (the `daemonId`),
`x-relay-ts` (Unix seconds, within 120 of the relay's clock), `x-relay-nonce` (any string up to
64 characters, unused for five minutes) and `x-relay-sig`: the Ed25519 signature of
`METHOD\nPATH\nTS\nNONCE\nhex(SHA-256(body))` — the path as requested, the digest of the exact
bytes sent in lowercase hex, no trailing newline. Signatures, the public key (32 raw bytes) and
the enrolment `proof` are base64; base64url is read too. Test vector: seed `0102…1f20` (32 bytes,
01 to 20 hex), public key `ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=`; `POST /v1/push` at ts
`1790770000`, nonce `3q2-7w1Kd9Qx-AbC`, the badge-only body
`{"token":"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90","type":"alert","body":{"aps":{"badge":3}}}`
(digest `065d25e89916ae08f52cd6c65ba9508da35dd470de4027dab38c885283849446`) signs to
`P91OJuJl8PoiJA7jfXOXwJHoATCvpfJEJvUAvKBQLKwgzhYkZ2jqNiV1bCKO0mYQe2+hjn6D+/y1MzUfz7XIAQ==`; the
grant `Zm9vYmFyLWdyYW50LWV4YW1wbGU` gives the proof
`jbf6tkqSPJdAcRo0aVjEQ1nGJYXrNVw4dE66yUTdO7uiVmqUfh3dPp8zsVF9nng/CjwWrHfMv4mgrBIezsFpBA==`.

**Testing.** `tools/test-relay.mjs` stands in for the relay; see *Testing*.

## Portal (feature `portal`)

`POST /v1/portal/session` answers `{ "url", "expiresInS", "cookies"?: [{ "name", "value" }] }`.
The app opens `url` in a web view, sending the endpoint's headers with it and setting any
cookies given. What the page is, is the backend's business; `cellpilotd` shows its dashboard, and
its `url` carries a code that opens it once, within `expiresInS` (60).

## What a backend must implement

Core, in this order of usefulness:

1. `GET /v1`, `GET /v1/ping`, `POST /v1/pair`, bearer authentication with `401`/`410` semantics.
2. `GET /v1/client` with its endpoints, `PATCH`, `DELETE`.
3. `GET /v1/status`; the event stream with `hello`, `status`, `call`, `audio`.
4. `GET /v1/call`, `dial`, `answer`, `hangup`, `dtmf`; audio frames both ways.
5. `GET /v1/calls`, `DELETE /v1/calls/{id}`, the `calls` event.
6. Conversations and messages: list, page, send, read, delete; the `message` and
   `conversations` events.

Then any features it can honestly declare. `openapi.yaml` is the definitive list of routes and
shapes.

## Testing

Everything here can be checked without the app, with the tools in this repository (Node 22 or
later, no dependencies).

**`tools/api-check.mjs`** checks a running backend against the core and whatever features it
declares, every response and event frame field by field against `openapi.json` and
`events.schema.json`. By default it only reads: it never dials, answers, sends a message or
changes a setting, so it is safe against a backend with a real SIM. The rest is for a backend
with a simulated device only, and `--dial`, `--sim` and `--code` each go with `--write`:

| Option | Adds |
| --- | --- |
| `--write --to <number>` | Sends an SMS and follows the event stream: `message` pending then final, `conversations` only after, `rev` one step at a time. |
| `--dial` | A call to `--to`: the record while it lasts, the holder, hanging up, the finished record; with `--sim`, audio frames both ways. |
| `--sim [--from <number>]` | Drives the simulation hooks (below): an SMS and two calls arrive, checking `message`, `conversations`, `badge`, `notify` and `ack`, answering, audio frames, and a missed call's record. |
| `--code <code>` | Pairs a throwaway client with the backend's reusable test code: pairing again makes the old token `401`, signing out makes it `410`. |

```sh
node tools/api-check.mjs --url http://192.168.1.10:9400 --token <a paired client's token>
node tools/api-check.mjs --url http://127.0.0.1:8799 --token <token> --write --to +15555550101 --dial --sim --code 123456   # simulated device only
```

It prints one line per check (`ok`, `FAIL`, or `skip`) and exits non-zero when anything failed.

**Simulation hooks.** A backend with a simulated device can offer these, outside `/v1`, without a
token, and only to its own machine (loopback). They are a convention for tests, not part of the
API: the app never calls them, and a backend driving a real device must not offer them.

| Hook | Body | What happens |
| --- | --- | --- |
| `POST /_sim/sms` | `{ "from", "text" }` | An SMS arrives. |
| `POST /_sim/call` | `{ "from" }` (`null`: withheld) | A call rings. |
| `POST /_sim/hangup` | `{}` | The far end hangs up; a call still ringing is then missed. |
| `POST /_sim/answer` | `{}` | The far end answers the outgoing call. Optional: a simulator may answer by itself. |

Each answers `200 {}`, or `409` when it does not fit (a call already up).

**`tools/test-relay.mjs`** stands in for the push relay. It checks what the relay checks — the
enrolment proof, every signature, the clock, nonces, that pushes are sealed — opens each sealed
payload with the client tokens it is given, and flags what the relay would pass but the app
relies on (category, collapse id, sound, interruption level, the sealed fields). Point the
backend's relay address at it (an override for tests: `POST /v1/push/enrol` itself takes https
only) and tell it what to answer next:

```sh
node tools/test-relay.mjs --port 18780 --state relay-state.json
curl -X POST http://127.0.0.1:18780/_tokens -d '{"token":"<client token>"}'        # once paired
curl -X POST http://127.0.0.1:18780/_next -d '{"answer":"quota","times":3}'         # the next three pushes
curl -X POST http://127.0.0.1:18780/_next -d '{"on":"enrol","answer":"grant"}'      # the next enrolment
```

Push answers: `not-enrolled`, `suspended`, `not-entitled`, `unbound`, `quota`, `rate`, `gone`,
`apns`, `unreachable`; enrolment answers: `grant`, `proof`, `rate`, `unreachable`; `ok` goes back
to normal. The grant `expired-grant-for-testing` is always refused.

**`tools/mock-backend.mjs`** is the smallest backend the app works with: the core and nothing
else, in one file with no dependencies, calls and messages simulated, with the simulation hooks.
Read it as a starting point, or pair the app with it to see a core-only backend from the phone:

```sh
node tools/mock-backend.mjs --port 8799 [--code 123456] [--incoming]   # prints the pairing code
```

**`fixtures/number-rules.json`** holds the cases of *Numbers*: what is stored, what
it reads as, how it is shown, its place.
