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

## What to expect

Reports are handled on a best-effort basis. There is no bug bounty and no guaranteed response
time; we will acknowledge a report when we can and tell you what we decide to do about it.

## Good faith

Test only with `tools/test-relay.mjs` or with your own accounts and devices. Do not access,
change or delete other people's data, do not disrupt the relay or anyone's use of it, and give us
reasonable time to fix a problem before you disclose it.

## Reporting abuse or legal concerns

Misuse of CellPilot, or anything in the product or these documents that conflicts with laws or
regulations, goes to **abuse@cellpilot.dev**, not to the vulnerability form. We cooperate with the
authorities and rectify the problem, and if necessary change, restrict or shut down the feature or
service concerned. See [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md).

---

## 中文

**报告漏洞：** 请不要公开提 issue，通过本仓库 GitHub 页面的 **Security** → **Report a vulnerability** 私下报告，写明发现了什么、如何复现、攻击者能借此做什么。范围包括 `spec/` 中的协议、推送中转 `https://push.cellpilot.dev` 和 `tools/` 中的工具；具体某个后端的问题请找其作者。

**可以期待什么：** 我们尽力处理报告，但没有漏洞赏金，也不保证响应时间；能确认时会确认收到，并告诉你我们决定如何处理。

**善意原则：** 只用 `tools/test-relay.mjs` 或你自己的账号和设备测试。不要访问、修改或删除他人的数据，不要干扰中转或任何人对它的使用，并在公开之前给我们合理的修复时间。不要对 `push.cellpilot.dev` 做压力测试、扫描或模糊测试。

**举报滥用或法律问题：** CellPilot 被滥用，或产品、本文档中有任何与法律法规相抵触的内容，请发送至 **abuse@cellpilot.dev**，不要用漏洞报告表单。我们会配合有关部门并予以整改，必要时变更、限制或关闭相关功能或服务。见 [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md)。
