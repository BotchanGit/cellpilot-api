# Notices · 声明

[English](#english) · [简体中文](#中文)

## English

### Trademarks

The CellPilot name and logo belong to the CellPilot project owner and are not covered by the
[license](LICENSE).

Apple, iPhone, iOS, CallKit, TestFlight, Bonjour, Keychain and Sign in with Apple are trademarks
of Apple Inc. Tailscale, Cloudflare, ngrok, ZeroTier, WireGuard, Quectel, China Mobile, Optus and
the other product, service and company names in this repository belong to their respective
owners. They are named only to describe compatibility or to give examples. Naming them implies
no affiliation with, endorsement by or sponsorship from any of them. 3GPP specifications are cited
by number for reference; 3GPP is a registered mark of its Organizational Partners.

### Third-party data

Phone-number classification in the specification follows the conventions of
[libphonenumber](https://github.com/google/libphonenumber) (Apache License 2.0). This repository
includes no libphonenumber code or data files. The cases in `fixtures/number-rules.json` were
written for this project.

All phone numbers in this repository are examples. Some are well-known test numbers or the
numbers of public services; do not call or text any of them.

### Encryption

The specification and tools use standard, published algorithms — AES-256-GCM, HKDF-SHA256,
Ed25519, and TLS — through the cryptography built into Node.js, and their source is publicly
available here. You are responsible for complying with the export, import and use regulations on
encryption that apply to you.

## 中文

### 商标

CellPilot 名称和图标归 CellPilot 项目所有者所有，不在[许可证](LICENSE)的授权范围内。

Apple、iPhone、iOS、CallKit、TestFlight、Bonjour、钥匙串（Keychain）和"通过 Apple 登录"（Sign in with
Apple）是 Apple Inc. 的商标。Tailscale、Cloudflare、ngrok、ZeroTier、WireGuard、Quectel（移远通信）、
China Mobile（中国移动）、Optus，以及本仓库中出现的其他产品、服务和公司名称，归各自的所有者所有。提到它们只是为了说明兼容性或举例，
不表示与其中任何一方存在关联，也不表示得到其认可或赞助。3GPP 规范仅按编号引用以供参考；3GPP 是其组织伙伴的注册标志。

### 第三方数据

规范中对电话号码的分类遵循 [libphonenumber](https://github.com/google/libphonenumber)（Apache License 2.0）的约定。
本仓库不包含 libphonenumber 的任何代码或数据文件。`fixtures/number-rules.json` 中的用例是为本项目编写的。

本仓库中的所有电话号码都是示例。其中一些是众所周知的测试号码或公共服务号码；请不要拨打或向它们发送短信。

### 加密

规范和工具使用标准的公开算法——AES-256-GCM、HKDF-SHA256、Ed25519 和 TLS——通过 Node.js 内置的加密功能实现，源代码在此公开。
你有责任遵守适用于你的加密技术出口、进口和使用方面的法规。
