<p align="center">
  <img src="assets/logo.png" width="128" height="128" alt="CellPilot">
</p>

<h1 align="center">CellPilot 设备 API</h1>

<p align="center">
  CellPilot iPhone App 与驱动你的蜂窝模块的后端之间的开放契约。
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <a href="spec/device-api.zh-CN.md"><img alt="API v1" src="https://img.shields.io/badge/API-v1-1f6feb"></a>
  <a href="spec/openapi.zh-CN.yaml"><img alt="OpenAPI 3.1" src="https://img.shields.io/badge/OpenAPI-3.1-6ba539"></a>
  <a href="tools/"><img alt="Node 22+" src="https://img.shields.io/badge/tools-Node%2022%2B%2C%20no%20dependencies-339933"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-lightgrey"></a>
</p>

---

CellPilot 是一个 iPhone App，它把一个插着 SIM 卡的蜂窝模块——接在 Mac 上的 4G 模块、家里服务器上的
调制解调器——变成一条装在口袋里的电话线路：双向通话、短信、答录机、联系人，App 关着时也有推送通知。

App 不直接和模块对话，而是连接一个**后端**：你在模块旁边运行的程序，通过 HTTP 和 WebSocket 把模块暴露
出来。这个仓库包含编写后端所需的一切——规范、机器可读的 schema、每个接口都带示例的指南，以及不用 App
就能检查后端的工具。

通话和短信的路径上没有我们的任何服务器。CellPilot 运营的唯一服务是[推送中转](#推送中转)，它是可选的，
按设计不读它转发的内容。

## 整体结构

```mermaid
flowchart LR
    app["CellPilot App<br/>（iPhone）"]
    backend["你的后端"]
    module["蜂窝模块<br/>+ SIM 卡"]
    relay["CellPilot 推送中转"]
    apns["Apple 推送<br/>通知服务"]

    app <-->|"HTTP + WebSocket<br/>局域网、VPN 或隧道"| backend
    backend <-->|"AT 命令、音频"| module
    backend -.->|"封装后的推送"| relay
    relay -.-> apns -.-> app
```

App 和后端配对一次，之后通过后端列出的任意端点连接它：局域网地址、Tailscale 名称、Cloudflare
Tunnel、反向代理。通话和短信在两者之间直接传输。推送用只有 App 和后端持有的密钥封装，中转只负责转发，读不到内容。

## 仓库内容

| 路径 | 内容 |
| --- | --- |
| [`spec/device-api.md`](spec/device-api.md) | **规范（英文）。** 最终依据：其他任何文件与它不一致时，以它为准。 |
| [`spec/device-api.zh-CN.md`](spec/device-api.zh-CN.md) | 规范的中文版。 |
| [`spec/openapi.yaml`](spec/openapi.yaml) | 所有路由和对象，OpenAPI 3.1。[`openapi.json`](spec/openapi.json) 内容相同，供工具读取；[`openapi.zh-CN.yaml`](spec/openapi.zh-CN.yaml) 是中文译本。 |
| [`spec/events.schema.json`](spec/events.schema.json) | 事件流上的每一种帧，JSON Schema 2020-12。 |
| [`docs/`](docs/) | 后端指南，[英文](docs/index.html)和[中文](docs/zh-CN.html)两版：每个接口一节，含参数、示例和注意事项。 |
| [`tools/api-check.mjs`](tools/api-check.mjs) | 合规检查：每个响应和帧都对照 schema 检查。 |
| [`tools/mock-backend.mjs`](tools/mock-backend.mjs) | App 能用的最小后端，单个文件。 |
| [`tools/test-relay.mjs`](tools/test-relay.mjs) | 本地模拟的推送中转。 |
| [`fixtures/number-rules.json`](fixtures/number-rules.json) | 电话号码如何保存、识别和显示，写成一张用例表。 |

工具只需要 Node.js 22 或更新版本，没有其他依赖。指南是普通 HTML，用浏览器打开 `docs/zh-CN.html` 即可。

## 快速上手

在两个终端里分别启动模拟后端并检查它：

```sh
node tools/mock-backend.mjs --port 8799 --code 123456
```

```sh
TOKEN=$(curl -s -X POST http://127.0.0.1:8799/v1/pair -d '{"code":"123456","name":"api-check"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')

node tools/api-check.mjs --url http://127.0.0.1:8799 --token "$TOKEN" \
  --write --to +15555550101 --dial --sim --code 123456
```

不应出现 `FAIL`（`skip` 表示模拟后端没有声明的特性）。想在手机上看看这个模拟后端：在 App 里按地址添加后端
（`http://<你电脑的局域网地址>:8799`），输入它打印出来的配对码。

## 编写后端

1. **先读核心部分。** [`spec/device-api.zh-CN.md`](spec/device-api.zh-CN.md) 列出每个后端必须实现的
   内容：发现、配对、状态、通话及其音频帧、通话记录、短信和事件流。[指南](docs/zh-CN.html)逐个讲解每个接口。
2. **从能跑的东西开始。** 读 `tools/mock-backend.mjs`，或者改造你已有的项目。先接模拟设备：有了模拟
   接口（`POST /_sim/sms`、`/_sim/call` 等），检查工具才能触发来信、来电这些事件。
3. **检查。** `tools/api-check.mjs` 默认只读，对插着真 SIM 卡的后端运行也安全。对模拟设备加上
   `--write --dial --sim --code`，会实际测试发短信、拨号、来信来电、notify 和确认、音频以及重新配对。
4. **能做到的特性再声明。** 后端在 `GET /v1` 里声明支持哪些特性，App 只显示这些。不声明永远没问题。
5. **号码要处理对。** 用 [`fixtures/number-rules.json`](fixtures/number-rules.json) 跑一遍你的号码处理，
   让后端对每个号码的理解和 App 一致。
6. **最后加推送：** 通过 App 在中转登记，并用 `tools/test-relay.mjs` 在本地测试整条推送路径，包括中转可能给出的每一种拒绝。

### 特性

核心部分是必须的，其余都是可选的，由后端自行声明。

| 特性 | 增加的能力 |
| --- | --- |
| *核心* | 配对、状态、带音频的通话、通话记录、会话和短信、事件流 |
| `push` | App 关着时经中转推送通知，来电用 VoIP 推送 |
| `notify` | 推送前先问在线的客户端，App 开着的手机不会收到两次通知 |
| `snapshot` | 客户端需要保存的全部内容，同一版本，一次请求取回 |
| `contacts` | 后端保存的联系人，按号码匹配 |
| `search` | 短信全文搜索 |
| `trash` | 删除的会话先进回收站，可以恢复 |
| `voicemail` | 答录机：接听无人接的来电并录音 |
| `transcription` | 留言的实时转写和按需转写 |
| `screening` | 把响铃中的来电交给答录机，也能再接回来 |
| `settings` | 用户可以在 App 里修改的后端设置 |
| `security` | 设备防篡改检查和告警 |
| `log` | 后端的事件日志，按读者的语言显示 |
| `places` | 号码归属地和运营商 |
| `portal` | 后端自己的网页，在 App 里打开 |

## 推送中转

后端没法直接唤醒 App；Apple 只接受持有 App 密钥的一方发来的推送。CellPilot 在
`https://push.cellpilot.dev` 运营一个中转，替登记过的后端转发推送。每条推送都用从客户端令牌派生的密钥
封装，合规后端发出的内容中转读不到；除了单独的角标数，未封装的推送一律拒绝。后端通过 App 登记，挂在用户的"通过 Apple
登录"身份下，只能推送到这个用户自己的手机。协议、签名和测试向量见规范的"推送"一节。

## 兼容性

v1 只增不改。文档里写了的东西不会删除，含义也不会改变；新内容以可选字段、新事件类型和新特性的形式加入。
客户端忽略不认识的内容，后端也一样。做不到这一点的改动会是 v2，使用单独的基础路径。

## 参考后端

`cellpilotd` 是一个跑在 macOS 上、驱动 USB 4G 模块的 Node.js 后端，是 App 测试所用的参考实现。它没有公开，
提到它只是为了让规范能说明一个真实后端的做法；规范里说 `cellpilotd` 怎么做时，说的是规则之内的一种选择，不是要求。

## 参与贡献

规范里的疑问、写得不清楚的地方和错误，欢迎提 issue，见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题——
协议、中转或工具里的——请按 [SECURITY.md](SECURITY.md) 报告，不要公开提 issue。

## 许可证

[MIT](LICENSE)。规范、schema、指南和工具都可以用来编写任何后端，开源或闭源都可以。

CellPilot 名称和图标不在许可范围内。你可以说明自己的后端可以配合 CellPilot 使用，但不能用这个名称为它命名，
或让人以为它出自 CellPilot；[`assets/`](assets/) 里的图标也不能用在你自己的项目里。
