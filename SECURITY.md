# Security

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: the **Security** tab of
this repository → **Report a vulnerability**. Include what you found, how to reproduce it, and
what an attacker could do with it.

In scope:

- The protocol in `spec/`: pairing, tokens, rate limiting, the push envelope, relay enrolment and
  request signing.
- The push relay at `https://push.cellpilot.dev`: anything that lets one account reach another's
  phones, read a push, or exhaust another account's quota.
- The tools in `tools/`.

Problems in a particular backend belong to that backend's authors.

## Testing against the relay

Use `tools/test-relay.mjs` locally. Do not load-test, scan or fuzz `push.cellpilot.dev`.
