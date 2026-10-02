# Contributing

Thank you for helping make the CellPilot Device API clearer.

## What helps most

- **A passage you had to guess at.** If building a backend left you unsure what a rule means or
  what a backend should answer, open an issue quoting the section. Places where builders had to
  guess are treated as bugs in the specification.
- **A contradiction** between `spec/device-api.md`, the OpenAPI description, the event schema,
  the guide or the tools. The specification is normative; the others are fixed to match it.
- **A tool that is wrong:** `api-check` failing a conforming backend or passing a broken one,
  `test-relay` refusing what the real relay accepts, `mock-backend` departing from the spec.
- **A number the rules read wrongly:** add the case, its SIM home and what you expected.

## Pull requests

Small, focused pull requests are easiest to review. When a change touches the rules, change the
English specification first; the Chinese translation, the schemas and the guide follow it.
`spec/openapi.json` is `spec/openapi.yaml` in JSON form: a change to one belongs in both.

Before sending one:

```sh
node tools/mock-backend.mjs --port 8799 --code 123456 &
TOKEN=$(curl -s -X POST http://127.0.0.1:8799/v1/pair -d '{"code":"123456"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')
node tools/api-check.mjs --url http://127.0.0.1:8799 --token "$TOKEN" --write --to +15555550101 --dial --sim --code 123456
```

## Compatibility

Version 1 only grows. A proposal that removes something, changes a field's type or meaning, or
makes something optional required belongs to a future version.

## Conduct

Be kind and specific. Assume the other person is trying to build something that works.
