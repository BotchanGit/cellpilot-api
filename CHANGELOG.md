# Changelog

The API is versioned by its base path (`/v1`). Within a version it only grows: entries here add
fields, events, features or clarifications, and never remove or change the meaning of anything
documented. Tools are versioned with the repository.

## Unreleased

First public release of the CellPilot Device API v1.

- The specification (`spec/device-api.md`, with a Chinese translation), OpenAPI 3.1 description
  and JSON Schema for every event-stream frame.
- The backend guide in English and Chinese (`docs/`).
- `tools/api-check.mjs`: conformance checker with read-only, write, dial, simulation-hook and
  pairing modes; every response and frame validated against the schemas.
- `tools/mock-backend.mjs`: the smallest conforming backend, with the simulation hooks.
- `tools/test-relay.mjs`: a local push relay that checks enrolment and signatures, opens sealed
  pushes, and can be told to refuse.
- `fixtures/number-rules.json`: phone-number cases shared by the reference backend and the app.
