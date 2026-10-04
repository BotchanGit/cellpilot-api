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

## Licensing of contributions

By sending a contribution — a pull request, a patch, a case or text in an issue — you agree that
it is licensed under this repository's [MIT License](LICENSE), and you confirm that you have the
right to submit it. Do not include real phone numbers, tokens, keys, message content or other
personal data: use the example numbers already in the repository (such as `+15555550101`) and
made-up content.

Contributions that would facilitate unlawful use — bulk sending, automated dialling, changing the
caller ID, SIM pools or rotation, receiving verification codes for others — will not be accepted.
See [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md).

### 贡献的许可

提交贡献——pull request、补丁、issue 中的用例或文字——即表示你同意它按本仓库的 [MIT 许可证](LICENSE) 授权，并确认你有权提交它。
请不要包含真实的电话号码、token、密钥、短信内容或其他个人数据：请使用仓库中已有的示例号码（如 `+15555550101`）和编造的内容。

会便利违法使用的贡献——群发、自动拨号、更改主叫号码、SIM 卡池或轮换、替他人接收验证码——不会被接受。见 [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md)。

## Compatibility

We intend version 1 only to grow. A proposal that removes something, changes a field's type or meaning, or
makes something optional required belongs to a future version.

## Conduct

Be kind and specific. Assume the other person is trying to build something that works.
