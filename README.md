<p align="center">
  <img src="assets/logo.png" width="128" height="128" alt="CellPilot">
</p>

<h1 align="center">CellPilot Device API</h1>

<p align="center">
  The open contract between the CellPilot iPhone app and the backend that drives your cellular module.
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="spec/device-api.md"><img alt="API v1" src="https://img.shields.io/badge/API-v1-1f6feb"></a>
  <a href="spec/openapi.yaml"><img alt="OpenAPI 3.1" src="https://img.shields.io/badge/OpenAPI-3.1-6ba539"></a>
  <a href="tools/"><img alt="Node 22+" src="https://img.shields.io/badge/tools-Node%2022%2B%2C%20no%20dependencies-339933"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-lightgrey"></a>
</p>

---

CellPilot is an iPhone app that turns a cellular module with a SIM card — a 4G module on a Mac,
a modem on a home server — into a phone line you carry in your pocket: calls with two-way audio,
SMS, an answering machine, contacts, and push notifications when the app is closed.

The app does not talk to the module. It talks to a **backend**: a program you run next to the
module that exposes it over HTTP and a WebSocket. This repository is everything needed to write
one — the specification, machine-readable schemas, a guide with an example for every route, and
tools that check a backend without the app.

No server of ours is in the path of a call or a message. The one service CellPilot runs, the
[push relay](#push-relay), is optional and built not to read what it carries.

## How it fits together

```mermaid
flowchart LR
    app["CellPilot app<br/>(iPhone)"]
    backend["Your backend"]
    module["Cellular module<br/>+ SIM"]
    relay["CellPilot push relay"]
    apns["Apple Push<br/>Notification service"]

    app <-->|"HTTP + WebSocket<br/>LAN, VPN or tunnel"| backend
    backend <-->|"AT commands, audio"| module
    backend -.->|"sealed pushes"| relay
    relay -.-> apns -.-> app
```

The app pairs with the backend once, then reaches it through whatever endpoints the backend
lists: a LAN address, a Tailscale name, a Cloudflare Tunnel, a reverse proxy. Calls and messages
travel between the two directly. Pushes are sealed with a key only the app and the backend hold,
so the relay forwards them without being able to read them.

## What is in this repository

| Path | What it is |
| --- | --- |
| [`spec/device-api.md`](spec/device-api.md) | **The specification.** Normative: where anything else disagrees, this wins. |
| [`spec/device-api.zh-CN.md`](spec/device-api.zh-CN.md) | The specification in Chinese. |
| [`spec/openapi.yaml`](spec/openapi.yaml) | Every route and object, OpenAPI 3.1. [`openapi.json`](spec/openapi.json) is the same for tools; [`openapi.zh-CN.yaml`](spec/openapi.zh-CN.yaml) is a translation. |
| [`spec/events.schema.json`](spec/events.schema.json) | Every frame on the event stream, JSON Schema 2020-12. |
| [`docs/`](docs/) | The backend guide, in [English](docs/index.html) and [Chinese](docs/zh-CN.html): one entry per route with parameters, examples and pitfalls. |
| [`tools/api-check.mjs`](tools/api-check.mjs) | Conformance checker: every response and frame against the schemas. |
| [`tools/mock-backend.mjs`](tools/mock-backend.mjs) | The smallest backend the app works with, in one file. |
| [`tools/test-relay.mjs`](tools/test-relay.mjs) | A local stand-in for the push relay. |
| [`fixtures/number-rules.json`](fixtures/number-rules.json) | How phone numbers are stored, read and shown, as a table of cases. |

The tools need Node.js 22 or later and nothing else. The guide is plain HTML: open
`docs/index.html` in a browser.

## Quick start

Run the mock backend and check it, in two terminals:

```sh
node tools/mock-backend.mjs --port 8799 --code 123456
```

```sh
TOKEN=$(curl -s -X POST http://127.0.0.1:8799/v1/pair -d '{"code":"123456","name":"api-check"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')

node tools/api-check.mjs --url http://127.0.0.1:8799 --token "$TOKEN" \
  --write --to +15555550101 --dial --sim --code 123456
```

No line should read `FAIL` (`skip` marks a feature the mock does not declare). To see the mock from the phone, add a backend in the app by its
address (`http://<your computer's LAN address>:8799`) and enter the code it prints.

## Building a backend

1. **Read the core.** [`spec/device-api.md`](spec/device-api.md) lists what every backend must
   implement: discovery, pairing, status, the call and its audio frames, the call history,
   messages, and the event stream. The [guide](docs/index.html) walks through each route.
2. **Start from something that works.** Read `tools/mock-backend.mjs`, or adapt a project you
   already have. Build against a simulated device first: the simulation hooks
   (`POST /_sim/sms`, `/_sim/call`, …) let the checker make things happen.
3. **Check it.** `tools/api-check.mjs` is read-only by default and safe against a real SIM.
   With a simulated device, `--write --dial --sim --code` exercises sending, calling, arrivals,
   notify and acknowledgements, audio, and re-pairing.
4. **Add features as you can honestly offer them.** A backend declares what it supports in
   `GET /v1`; the app shows only those. Undeclared is always fine.
5. **Get numbers right.** Run your number handling against
   [`fixtures/number-rules.json`](fixtures/number-rules.json) so your backend reads every number
   the way the app does.
6. **Add push** last: enrol on the relay through the app, and test the whole path locally with
   `tools/test-relay.mjs`, including every refusal the relay can give.

### Features

The core is required. Everything else is optional and declared by the backend.

| Feature | Adds |
| --- | --- |
| *core* | Pairing, status, calls with audio, call history, conversations and messages, the event stream |
| `push` | Notifications through the relay when the app is closed, VoIP pushes for incoming calls |
| `notify` | Asking live clients before pushing, so a phone with the app open is not notified twice |
| `snapshot` | Everything a client keeps, at one version, in one request |
| `contacts` | Contacts kept by the backend, matched to numbers |
| `search` | Full-text search over messages |
| `trash` | Deleted conversations kept for restoring |
| `voicemail` | An answering machine that picks up unanswered calls and records them |
| `transcription` | Live and on-demand transcripts of voicemail |
| `screening` | Sending a ringing call to the answering machine, and taking it back |
| `settings` | Backend settings the user can change from the app |
| `security` | Tamper checks on the device, and alerts |
| `log` | The backend's event log, in the reader's language |
| `places` | Where a number is from, and its carrier |
| `portal` | A web page of the backend's own, opened inside the app |

## Push relay

The app cannot be woken by a backend directly; Apple only accepts pushes from the holder of the
app's key. CellPilot runs a relay at `https://push.cellpilot.dev` that forwards pushes for
enrolled backends. Every push is sealed with a key derived from the client's token, so the relay
cannot read what a conforming backend sends, and it refuses anything sent in the clear but a bare badge count. A backend is enrolled
from the app, under the user's Sign in with Apple identity, and can reach only that user's
phones. The protocol, signatures and test vectors are in the specification under *Push*.

## Compatibility

Version 1 only grows. Nothing documented is removed or changes meaning; new things arrive as
optional fields, new event types and new features. Clients ignore what they do not know, and so
do backends. A change that cannot keep this promise would be version 2, on its own base path.

## Reference backend

`cellpilotd`, a Node.js backend for a USB 4G module on macOS, is the reference implementation the
app is tested against. It is not published; it is named only so the specification can say what
one real backend chooses. Where it says what `cellpilotd` does, that is one choice within the
rules, not a requirement.

## Contributing

Questions, unclear passages and mistakes in the specification are welcome as issues; see
[CONTRIBUTING.md](CONTRIBUTING.md). Security problems — in the protocol, the relay or the tools —
go through [SECURITY.md](SECURITY.md), not public issues.

## License

[MIT](LICENSE). The specification, schemas, guide and tools may be used to build any backend,
open or closed.

The CellPilot name and logo are not covered by the license. You may say that your backend works
with CellPilot, but not name it, or present it, as if it came from CellPilot, and the logo in
[`assets/`](assets/) may not be used in your own project.
