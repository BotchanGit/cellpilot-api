# CellPilot 设备 API v1

CellPilot App 是一个客户端。它连接一个*后端*：一个控制蜂窝设备（插着 SIM 卡的模块）并通过本 API 把它暴露出来的程序。参考后端 `cellpilotd` 跑在接着 USB 模块的 Mac 上；任何实现了本 API 的程序都可以替代它。App 不关心后端是什么、跑在哪里、怎么连过去。本文说 `cellpilotd` 怎么做时，说的是参考后端在规则之内的选择，App 就是对着它测试的。

这份 API 就是 App 与后端之间的全部契约：对后端，App 只使用本文描述的内容。通话和短信不需要 CellPilot 账号；它们在 App 与后端之间直接传输，不经由我们的任何服务器承载。CellPilot 运营的唯一服务是推送中转，它是可选的。开启推送时，关于新短信、来电或留言的通知会经过中转，它是端到端加密的，中转按设计无法解密（见"推送"）。此外，App 还会和中转通信，用于登录、绑定推送 token、获取登记许可，以及在用户打开"共享使用数据"时发送诊断信息，详见[隐私政策](../docs/privacy.html)。

**本文件（及英文版 device-api.md）就是规范。** [openapi.yaml](openapi.yaml) 定义路由和形态（[openapi.json](openapi.json) 内容相同，是为工具生成的；[openapi.zh-CN.yaml](openapi.zh-CN.yaml) 是译本），[events.schema.json](events.schema.json) 定义事件流上的每一帧。后端指南有中英文两版，是从本文派生的易读版本，不另加任何规则。它们和本文不一致时，以本文为准（中英文不一致时以英文版 device-api.md 为准）。本文讲 OpenAPI 描述不了的部分：事件流、音频帧、配对、推送、中转，以及后端必须实现什么。

## 预期用途与限制

CellPilot 面向一个人用自己的 SIM 卡、在自己的设备上使用：一条自己持有的线路，从自己的 iPhone 上使用。设计也守着这一点：

- 一个后端驱动一台设备、一张 SIM 卡。
- 一条短信发给一个收件人，而且是用户自己发的。
- 没有办法设置主叫号码：来电显示的是网络给这张 SIM 卡的号码。
- 中转把一个后端登记在一个人的 Apple 账号下，只把它的推送送到这个账号的手机上。
- 有 `security` 时，后端会就设备被篡改的迹象向用户告警；具体做哪些检查（例如 SIM 卡或模块被更换）由后端决定。

后端不得加入群发、自动拨号、更改主叫号码或轮换 SIM 卡的功能。CellPilot 的使用受[合法使用条款](../ACCEPTABLE_USE.md)约束。

CellPilot 不能替代电话服务，不能依赖它拨打紧急电话：通话依赖互联网连接、后端、模块和运营商；紧急呼叫从模块所在地发出，可能接到错误的急救中心，对方看到的也是错误的位置。请使用普通电话。

CellPilot 仅为合法用途而制作。我们遵守法律法规，不认可、不支持、也不协助任何违法活动。如果你发现问题——滥用，或产品、本文档中有任何与法律法规相抵触的内容——请立即通过 abuse@cellpilot.dev 告诉我们。我们会配合有关部门并予以整改，必要时变更、限制或关闭相关功能或服务。

## 术语

| 术语 | 含义 |
| --- | --- |
| **设备（device）** | 后端控制的蜂窝硬件：模块和它的 SIM 卡。一个后端对应一台设备。 |
| **后端（backend）** | 实现本 API 的程序。`cellpilotd` 是一个，你写的可以是另一个。 |
| **客户端（client）** | CellPilot App 的一个安装实例，后端用 token 识别它。客户端是 SIM 卡持有人自己的设备；本 API 不是为多人共用一条线路而设计的。 |
| **端点（endpoint）** | 到达后端的一条路：一个基础 URL 加可选的请求头。一个后端可以有多个。 |
| **对方（peer）** | 对方的电话号码，按网络送来或用户输入的样子，去掉分隔符（见“号码”）。 |

## 约定

- 基础路径 `/v1`。本文所有路由都相对于它。
- 双向都是 JSON，`Content-Type: application/json; charset=utf-8`。键用 camelCase。布尔就是布尔。时间用 UTC 的 ISO 8601（`2026-09-25T08:14:03.120Z`），以 `At` 结尾。时长带单位（`durationS`、`expiresInS`）。
- 请求体不管 `Content-Type` 是什么都按 JSON 读；没有请求体就是 `{}`；不是合法 JSON，或是 JSON 但不是对象（数组、字符串、`null`），是 `400 invalid_request`（不带 `details`）。不认识的请求字段忽略。后端可以拒绝超过它自定大小的请求体，回 `413 invalid_request`（`cellpilotd`：8 MB）。
- 不存在的路径，以及存在的路径用了它不接受的方法，都是 `404 not_found`（在鉴权之后）；没有 `405`。
- 每个成功响应都是一个 JSON 对象。集合放在同名键下（`{ "messages": [...] }`）；单体资源就是对象本身。动作返回它改动的资源；删除返回 `{}`。
- 对象的字段总是带上，不知道、不适用、或属于后端没声明的特性（没有 `places` 时的 `place`，没有 `contacts` 时的 `name`、`contactId`）的写 `null`，空列表写 `[]`。只有列为可选的字段（“发现与特性”下面的表，以及本文标为可选的）可以不带。
- id 是正整数，新记录的 id 比旧的大。路径里的 id 不是非负整数时回 `400 invalid_request`，`details.field` 为 `"id"`。
- 分页按 id：`?beforeId=<id>&limit=<n>` 返回 id 小于 `beforeId` 的条目，id 大的（新的）在前。`limit` 默认 100，超出范围不报错，夹到 1–500；`beforeId` 或 `limit` 不是数字时当作没带。一页比 `limit` 短就是最后一页。自己写了默认值和上限的路由（搜索 50/200、日志 200/1000）以它为准。
- 错误统一为 `{ "error": { "code", "message", "details"? } }`。`code` 是稳定的机器码，客户端据此行事；`message` 给人看，使用读者的语言。`details` 放在 `error` 里面；字段不对时 `details.field` 写字段名，嵌套字段用点连接（`"voicemail.answerAfterS"`）。先鉴权再找路由：不带 token 请求不存在的路径回 `401` 而不是 `404`。码表：

  | HTTP | code | 何时 |
  | --- | --- | --- |
  | 400 | `invalid_request` | 字段缺失或格式不对（`details.field` 指出是哪个），或请求体不是 JSON 对象。 |
  | 401 | `unauthorized` | 没有 token，或后端不认识这个 token；配对码不对。 |
  | 403 | `forbidden` | token 有效，但不允许做这件事。 |
  | 404 | `not_found` | 没有这个资源，或没有这条路由。 |
  | 404 | `feature_unavailable` | 这条路由属于本后端没有声明的特性。 |
  | 409 | `conflict` | 动作与当前状态不符（没有来电却接听、转写正在进行中又发起一次）。 |
  | 410 | `signed_out` | 客户端已被解除配对或撤销。App 会丢弃 token 回到配对页。 |
  | 413 | `invalid_request` | 请求体超过后端接受的大小。 |
  | 429 | `rate_limited` | 这个来源失败次数过多。带 `Retry-After`（秒）。 |
  | 500 | `internal` | 其它任何情况，包括模块拒绝了命令（见“通话”）。 |
  | 502 | `upstream_failed` | 只用于 `POST /v1/push/enrol`：中转拒绝了登记或连不上。 |
  | 503 | `device_unavailable` | 设备没接上或没准备好。 |

- 语言：客户端在每个请求和事件流上发 `X-Lang: en` 或 `X-Lang: zh`。以 `zh` 开头的（`zh-Hans`）是中文，其他都是英文。后端产生的一切给人看的文字（错误信息、事件文本、安全检查文本、告警标题、归属地、通话的 `endReason`、短信的 `error`）用读者的语言：请求用 `X-Lang`，没有就用客户端记录里的 `lang`，再没有用英文；事件流用这条连接所属客户端记录里的 `lang`，所以同一个事件可以用两种语言发出。几个客户端共读的记录保存原因而不是一句话，按每个读者生成文字。用户输入的内容、号码、名字永远不翻译。

## 鉴权

除 `GET /v1`、`GET /v1/ping`、`POST /v1/pair` 外的每个请求都带客户端 token：`Authorization: Bearer <客户端 token>`；端点的 `tokenHeader` 指定时改为 `X-CellPilot-Token: <客户端 token>`（那条路上的代理自己要用 `Authorization`）。后端两种都要认；两个都带时读 `X-CellPilot-Token`（另一个是代理的）。token 标识一个客户端安装实例，不论后端是什么，都通过配对（见下）获得。

后端应只保存 token 的哈希。没有 token、或不是它发出的 token，回 `401 unauthorized`；它撤销的、或客户端自己解除配对的 token，回 `410 signed_out`，让 App 能放手——后端为此保留哈希来认出它。同一 `uid` 重新配对（见下）之后，旧 token 就是不认识的：`401`。之前能用的 token 收到 `401` 或 `410`，App 处理一样：忘掉 token 和所有缓存，回到配对页。

## 兼容性

我们打算让 API 第 1 版只增不改。在这一版里：

- 这里写下的东西不会删除、不会改变含义，字段不会换类型。
- 新东西以新的可选字段、新的事件类型、或后端可声明的新特性出现。后端可以不实现的，App 都能没有它照常工作——见“发现与特性”下的两张表。
- 客户端忽略不认识的字段、事件类型和特性；后端忽略不认识的请求字段。任何一方都不能因为新东西而出错。
- 错误 `code` 是稳定的。可以新增；客户端遇到不认识的 code 按 HTTP 状态处理。

做不到这些承诺的改动会是第 2 版，有自己的基础路径（`/v2`），App 会继续用 v1 和还没升级的后端对话。

但在安全、法律、Apple 平台规则或中转运营需要时，我们仍可能变更或撤回某些内容；这类变更会在更新日志（`CHANGELOG.md`）中公布。这里的任何内容都不是对持续兼容或持续可用的保证。

## 发现与特性

`GET /v1` 不需要 token，描述这个后端：

```json
{
  "api": "cellpilot-device-api",
  "version": 1,
  "backend": { "name": "cellpilotd", "version": "0.1.0" },
  "features": ["push", "contacts", "search", "trash", "voicemail", "transcription",
               "settings", "security", "log", "places", "screening", "portal", "snapshot", "notify"]
}
```

核心部分每个后端都必须实现。其余都是*特性*：后端声明自己有的，App 只显示这些。未声明特性的路由返回 `404 feature_unavailable`。

列表说的是后端*此刻*能做什么，而不是换个配置能做什么：声明了却做不到的特性就是一个点了会失败的按钮。设置改变了它（比如关掉答录机）时，后端发 `features` 事件带上新列表；`hello` 里也带这个列表。

| 特性 | 增加 | 说明 |
| --- | --- | --- |
| *（核心）* | `GET /v1`、`/ping`、`/pair`、`/status`、`/client`、`/call` 及其动作、`/calls`、`/conversations`、`/messages`、事件流、音频帧 | 没有这些就不是电话。 |
| `push` | `POST /v1/client/push-tokens`、`DELETE /v1/client/push-tokens/{token}`、`GET /v1/push`、`POST /v1/push/enrol` | App 登记 APNs token；后端经 CellPilot 中转推送，由 App 替它在中转登记。 |
| `contacts` | `/contacts` | 后端保存的联系人，有姓名和多个号码；见“联系人”。 |
| `search` | `GET /v1/messages/search` | 短信全文搜索。 |
| `trash` | `/trash`、`POST /v1/messages/{id}/trash` | 删除的会话留在回收站可恢复。没有它删除即永久。 |
| `voicemail` | `/voicemails`、`settings.voicemail`、`voicemail` 事件 | 后端替接无人接听的来电并录音；见“答录机”。后端*有能力*时就声明：设置里关掉答录机仍然声明（留言和设置还在），只撤掉 `screening`。 |
| `transcription` | `POST /v1/voicemails/{id}/transcribe`、`settings.transcription`、`voicemail` 事件里的实时转写 | 依赖 `voicemail`。能转写时就声明（`cellpilotd`：语音模型装好了），与转写开关无关。 |
| `settings` | `GET/PATCH /v1/settings` | 用户可改的后端设置。 |
| `security` | `/security`、`status.security`、`security` 事件 | 后端监视设备是否被篡改，报告检查项和告警。 |
| `log` | `GET /v1/log`、`log` 事件 | 后端事件日志，使用客户端的语言。 |
| `places` | `place` 和 `carrier` 字段 | 号码归属地，使用客户端的语言。 |
| `screening` | `POST /v1/call/screen`、`POST /v1/call/claim` | 让后端先接（答录）再由客户端接管。有 `voicemail` *并且*答录机开关打开（`settings.voicemail.enabled`）时声明。没有它，通话也不能在手机之间转移。 |
| `portal` | `POST /v1/portal/session` | 后端有一个 App 可以打开的网页界面。 |
| `snapshot` | `GET /v1/snapshot`、`hello` 和事件上的 `rev`、`rev` 事件 | 客户端保存的一切，同一个版本，一个请求拿完；见“事件流”。没有它，App 每次连上都逐个列表去读。 |
| `notify` | `notify` 事件和客户端的 `ack` | 后端推送前先问在线的客户端；见“在线状态与 `notify`”。没有它后端直接推送，App 开着的手机自己显示横幅。 |

有些字段和路由是可选的，App 没有它们也能用（只此一份清单，指南照抄）：

| 字段或路由 | 没有时 |
| --- | --- |
| `GET /v1/client` 的 `pushTokens`（有 `push` 时） | App 每次刷新都登记全部 token，而不是只登记缺的。 |
| 通话记录的 `seen`、`POST /v1/calls/{id}/seen` | 未接来电不算未看，打开也不标记任何东西。 |
| `hello` 的 `badge` 和 `badge` 事件 | App 每次刷新时按手上的列表自己算角标。 |
| `GET /v1/push` 的 `problem`（有 `push` 时） | 推送发不出去时，用户看不到原因。 |

用 `tools/api-check.mjs` 检查一个后端是否符合上述约定（见“测试”）。

## 客户端与端点

`GET /v1/client` 告诉客户端它是谁、怎么连到后端：

```json
{
  "client": { "id": 31, "name": "iPhone 17", "lang": "zh" },
  "endpoints": [
    { "id": "lan", "label": "本地网络", "url": "http://my-mac.local:9400", "priority": 0 },
    { "id": "tailscale", "label": "Tailscale", "url": "http://my-mac.tail1234.ts.net:9401", "priority": 1 },
    { "id": "cloudflare", "label": "Cloudflare Tunnel", "url": "https://app.example.com", "priority": 2,
      "headers": { "CF-Access-Client-Id": "…", "CF-Access-Client-Secret": "…" } }
  ]
}
```

有 `push` 特性时可以带 `pushTokens: [{ "token", "kind": "alert"|"voip" }]`，即后端为这个客户端持有的推送 token。App 只在列表里缺某个 token 时才登记，所以没有变化时刷新一个都不发。不带这个字段的后端每次刷新都会收到全部 token，应当把已持有的 token 视为没有变化。

一个端点就是基础 URL、显示名、优先级（越小越优先），以及穿过这条路上挡在后端前面的东西所需要的：

| 字段 | 作用 |
| --- | --- |
| `headers` | 经此端点的每个请求和事件流连接都带上：隧道的服务令牌、代理的凭据。 |
| `tokenHeader` | 这条路上的代理自己要用 `Authorization`（基本认证、单点登录网关）时填 `"X-CellPilot-Token"`。客户端就把 token 放在 `X-CellPilot-Token: <token>` 里，`Authorization` 留给代理。不填：`Authorization: Bearer <token>`。 |
| `tlsPin` | 服务端证书（DER）的 SHA-256，base64：客户端对这个端点只信任这张证书，不论谁签发的，别的一律拒绝。用于自签名证书。也接受十六进制，带不带冒号都行。 |
| `clientCertificate` | `{ "p12", "password" }`：服务端要求客户端证书（双向 TLS）时，客户端出示的 PKCS#12 证书包（base64）。 |
| `vpn` | 手机要连着哪个虚拟组网（VPN）才能到这个端点，写大家熟悉的名字（`"Tailscale"`）。端点连不上时 App 会提示。 |

列表里可能有密钥（服务令牌、证书密码），App 把它存在钥匙串里。App 对"怎么连到后端"知道的仅此而已：虚拟组网（如 Tailscale、WireGuard）或内网穿透、端口映射、局域网地址，看起来都一样。后端列出它有的，而且列表只由后端决定：App 在配对时拿到，每次打开时再取一次，中间跟随 `client` 事件。

### 远程访问

不论用什么方式连，有两样东西必须能穿过去：

- **WebSocket。** `GET /v1/events` 升级成 WebSocket 并一直保持；没有它 App 只在打开时刷新，收不到实时的短信和来电。代理必须放行升级（`Upgrade` 和 `Connection` 头），并允许至少 30 秒的空闲连接：后端每 10 秒 ping 一次。
- **你的 token。** 放在 `Authorization: Bearer` 里，端点指定时放在 `X-CellPilot-Token` 里。后端两处都要认。

| 方式 | `url` | 还要填 |
| --- | --- | --- |
| 局域网 | `http://主机名.local:9400` | — |
| Tailscale、ZeroTier、WireGuard | 在那个网络里的地址（`http://mac.tail1234.ts.net:9401`） | `vpn` |
| Tailscale Funnel | 它给的 `https://….ts.net` 地址 | — |
| Cloudflare Tunnel + Access | 公网域名 | `headers`：`CF-Access-Client-Id`、`CF-Access-Client-Secret`（Service Auth 策略） |
| frp、ngrok 等内网穿透服务 | 它给的公网 HTTP(S) 地址 | 隧道要求的 `headers`（ngrok：`ngrok-skip-browser-warning`） |
| 端口映射或 IPv6，正规证书 | `https://home.example.com:8443` | — |
| 端口映射或 IPv6，自签名证书 | `https://203.0.113.7:8443` | `tlsPin` |
| 反向代理 + 基本认证 | 代理的地址 | `headers.Authorization` = `Basic …`，以及 `tokenHeader` |
| 反向代理要求客户端证书 | 代理的地址 | `clientCertificate` |
| 单点登录网关（Authelia、Authentik、oauth2-proxy） | 网关的地址 | 一条规则让 `/v1` 凭 `headers` 里的 API 令牌通过；令牌用 `Authorization` 时再加 `tokenHeader` |

需要在浏览器里交互登录的路径 App 用不了；除了虚拟组网 App 之外还要在手机上装别的软件的路径（frp 的 `stcp`/`xtcp`）也用不了。这里的"VPN"指连回你自己家庭网络的私有网络，不是用来访问你所在地被屏蔽网站的服务；请遵守你所在地关于网络接入的法律法规。

App 按优先级经有响应的最优端点连接：比当前更优的端点会持续尝试打开事件流，一旦通了就立即换上去；更差的保持关闭，直到当前这条断掉。音频帧带序号，切换过程中同一帧到两次只放一次。列表变化时后端发 `client` 事件，App 按需重连。`GET /v1/ping` 立即回 `{ "ok": true }`，不要 token，也不碰任何东西：App 的设置页用它显示每条路的情况，页面开着时每 30 秒一次。

`PATCH /v1/client` 更新客户端自己的名字、语言和安装标识：`name` 去掉首尾空白、截到 60 个字符，空的或不是字符串回 `400`（`details.field: "name"`）；`uid` 必须是 UUID（`400`，`"uid"`）；`lang` 不是以 `zh` 开头的字符串就是英文。响应同 `GET /v1/client`，并把同样的内容作为 `client` 事件发给这个客户端的连接（端点显示名可能换了语言）。`DELETE /v1/client` 解除配对：后端忘掉 token 和推送 token，关闭这个客户端的连接，之后再拿这个 token 请求一律返回 `410 signed_out`。

`client` 事件带 `{ "client", "endpoints" }`——即不含 `pushTokens` 的 `GET /v1/client`——只发给这个客户端自己的连接，端点显示名用它的语言。

## 配对与解除配对

配对是客户端拿到 token 的方式，不论后端是什么，只有这一种。

### 找到后端

局域网里的后端通过 Bonjour 发布 `_cellpilot._tcp`，TXT 记录 `api=1` 和 `path=/`，App 列出找到的。任何后端也可以由用户输入地址来找到：局域网上的主机和端口，或者远程可达的完整 URL。这个地址只需要提供 `POST /v1/pair`；配对之后 App 用的是端点列表。

### 交换

后端给用户一样东西输入 App：`cellpilotd` 在控制台显示六位配对码，别的后端可以从自己管理客户端的地方发一个 token。App 把它连同自己的信息发到 `POST /v1/pair`：

```json
{ "code": "482913", "name": "iPhone 17", "platform": "ios", "lang": "zh", "uid": "9C2F…-…" }
```

后端返回从此用来鉴权的 token、客户端记录和端点列表：

```json
{ "token": "…", "client": { "id": 31, "name": "iPhone 17", "lang": "zh" }, "endpoints": […] }
```

后端必须遵守的规则：

- `code` 是字符串（缺失或不是字符串：`400`，`"code"`，不算一次失败尝试，也不消耗任何东西）；接受什么由后端决定。发出去的东西如果很短（比如六位码），就应该短时有效、一次性使用（推荐：5 分钟有效，同一时间只有一个有效的码，配对成功即作废；`cellpilotd` 还会去掉非数字字符，`482 913` 也算对）。后端的"code"本身已经是长密钥的，直接把它作为 token 返回即可。
- token 只在这里给一次。后端只保存它的哈希，以后再也不能显示；token 丢了就重新配对。
- `name` 去掉首尾空白、截到 60 个字符（空的或不是字符串用 `"iPhone"`）；`lang` 不是以 `zh` 开头的字符串就是英文。
- `uid` 是 App 安装实例的标识（`identifierForVendor`），一个 UUID；不是 UUID 就忽略。同一 `uid` 再次配对是替换之前的客户端记录（id 不变，token 换新，旧 token 从此不认识，回 `401`，用它开的连接被关闭），不是新增；不支持 `uid` 的后端把每次配对都当作新的。
- `endpoints` 是 App 此后连到后端的唯一途径（列表为空时它才沿用配对时的地址），所以至少要有一条手机连得上、长期不变的地址：用 Bonjour 名而不是 DHCP 地址。显示名用客户端的语言。
- 失败返回 `401 unauthorized`，并按来源地址限速；配对码不能靠猜出来。算失败的：错的配对码，以及后端不认识的 token——每个不同的值只算一次，同一个旧 token 反复重试不算新的猜测。完全没带凭据、已撤销的 token（`410`）不算。推荐：同一地址 10 分钟内 5 次失败就封 15 分钟；这个地址有一次鉴权成功就清零计数。封禁期间只拒绝会构成又一次猜测的请求，回 `429` 且不再计数：不认识的 token、错的配对码、错的网页入口码。能用的 token、正确的配对码、已撤销的 token（仍回 `410`）照常处理，所以封禁不会把共用一个代理地址的手机都挡在外面。每个 `429`——包括事件流升级被拒——都带 `Retry-After`，即封禁还剩的秒数。
- 后端可以在某些监听上拒绝 `POST /v1/pair`。`cellpilotd` 只在局域网上接受，因此不接受来自公网的配对。

### App 拿到之后

保存 token、客户端记录和端点，然后按已配对的方式工作：经最优端点连接，后端有 `push` 就登记推送 token，用 `PATCH /v1/client` 报告语言和名字，每次启动和回到前台都 `GET /v1/client` 一次，端点列表变了就跟上。

### 解除配对

两边都可以结束配对。

- **从 App：** `DELETE /v1/client`。后端忘掉这个 token 和它名下登记的所有推送 token，并删掉这个客户端（这是客户端自己的决定，之后没什么需要审查的）。App 随后忘掉 token、端点、缓存内容和推送密钥。
- **从后端：** 后端撤销这个客户端（`cellpilotd` 在控制台操作）。此后凡是带这个 token 的请求，包括事件流的升级请求，一律返回 `410 signed_out`。App 收到第一个 `410` 就忘掉 token 和所有缓存，回到配对页；后端可以把被撤销的记录留到客户端已被告知为止，然后放掉。后端关闭这个客户端已开着的连接（关闭码随意，App 不看）；App 会重连（1 秒起，加倍，最多 15 秒），升级被拒绝，下一次 HTTP 请求就收到 `410`。

之前能用的 token 收到 `401`，App 也按同样方式处理：后端不管出于什么原因忘了一个客户端，客户端最终也会忘了它。

## 状态

`GET /v1/status` 是 App 首页显示的内容，也是事件流的 `hello`：

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

没有设备（没接，或已经断开）时 `device` 为 `null`；对象而 `connected: false` 表示找到了设备但还在启动，或正在断开（`cellpilotd` 放手前会发一次这样的 `status` 事件）。对象里 `connected`、`sim`、`signal`（各值不知道时为 `null`）、`registration`、`updatedAt` 总是有；不知道的都写 `null`。`identity`、`band`、`smsStorage` 可选。`audio.ready` 表示后端能传通话音频；`audio.active` 表示此刻正在和 holder 交换音频帧。没有通话音频的后端报告 `ready: false`，从不发 `audio`；电话照样能接通，App 会提示没有声音。`security` 只在有 `security` 特性时出现。`home` 是 SIM 卡的归属：发行国家或地区（ISO 3166-1 两位码），取自 IMSI 的国家码（MCC），没有 IMSI 时取手填的、带 `+` 的本机号码的国家码；以及本机号码所属的区号（后端判断不出这个号码属于哪里时为 `null`），按国内拨号写法：这个国家把长途前缀写进区号的就带上（`0`：`"0571"`、`"010"`），不写的就不带（北美的 `1`：`"212"`）。号码就在它里面读（见“号码”），`areaCode` 用来认出 SIM 本地的固话；两者都不会加到任何号码上。`location` 是设备当前注册网络所属的国家，取自那个网络的 MCC（哪里都没注册时用 SIM 的国家），只用于显示，和读号码无关。两者总是对象，各部分不知道时为 `null`。

`status` 事件只带 `device`；通话、holder 和音频各有自己的事件。

## 通话

任何时刻最多一通电话。`GET /v1/call` 返回 `{ "call", "holder" }`；空闲时 `call` 为 `null`，否则：

```json
{ "id": 812, "state": "active", "direction": "in", "number": "+8613812345678",
  "place": "浙江 杭州 · 中国移动", "startedAt": "…", "answeredAt": "…" }
```

`state` 是 `incoming`、`dialing`、`alerting`、`active`、`held`、`disconnecting` 之一。隐藏号码（或还不知道号码）时 `number` 为 `null`；通话开始之后才到的号码，填进 `number` 和记录的 `peer`，并发 `call` 事件。`id` 是这通电话在通话记录里的记录，通话开始时就建立。`holder` 是音频接在这通电话上的客户端（`{ "clientId", "name" }`），没有则为 `null`：响铃时、答录机在接时、结束后。每次变化（包括 holder 变化）都发 `call` 事件。

动作，都返回 `{ "call", "holder" }`。各自的错误按写出的顺序检查；没有设备时当前通话是空闲，所以列在前面的通话检查会先于设备的 `503`：

- `POST /v1/call/dial` `{ "number" }`：先去掉分隔符（见“号码”），之后必须是 1–32 个 `0-9*#`，可带开头的 `+`（`400`，`"number"`）。只要有通话（包括响铃中的来电）就是 `409`；没有设备 `503`。号码按输入的样子交给网络；拨打的客户端成为 holder。
- `POST /v1/call/answer`：接听响铃中的来电，接听的客户端成为 holder。答录机在接时等同 `claim`。两者都不是（包括没有设备）：`409`。
- `POST /v1/call/hangup`：挂断通话或拒接来电，任何客户端都可以。没有设备是 `503`；没有通话是 `200`，什么都不做。
- `POST /v1/call/dtmf` `{ "digits" }`：1–32 个 `0-9*#`（`400`，`"digits"`）；没有 `active` 的通话（包括没有设备）是 `409`。
- 有 `screening` 时，`POST /v1/call/screen`：把响铃中的来电交给答录机；没什么可交（没有响铃的来电、答录机关着或已在接）时等同挂断。`POST /v1/call/claim`：通话转到这个客户端，它成为 holder——答录机停止录音并让出线路，另一台手机上的通话转过来，还在响铃的来电被接听。没有通话是 `409`。

模块本身拒绝了命令——拨号或接听回了 `ERROR`——时，动作回 `500 internal`，message 里是模块的回复，而且这时那通电话已经结束：被拒的拨号留下一条 `failed` 记录（模块说了忙或无人接听时为 `busy`/`no-answer`），没有 holder。`hangup` 和 `dtmf` 即使被模块拒绝也回 `200`，因为客户端换个做法也没用。

| | 没有设备 | 状态不对 | 输入不对 | 模块拒绝 |
| --- | --- | --- | --- | --- |
| `dial` | `503` | `409`（有任何通话） | `400` `"number"` | `500` |
| `answer` | `409`（没有响铃） | `409` | — | `500` |
| `hangup` | `503` | `200`，什么都不做 | — | `200` |
| `dtmf` | `409`（没有 active 通话） | `409` | `400` `"digits"` | `200` |

通话中又来的第二通电话（呼叫等待）不在 API 里：`cellpilotd` 什么都不报告，由网络和模块处理。

### 通话记录

`GET /v1/calls` 是通话记录，最新在前，可翻页，包括还在进行的通话。一条记录（`CallRecord`）在通话开始时建立，在三个时刻写：

| 时刻 | 写什么 |
| --- | --- |
| 开始（来电开始响铃，或模块接受了拨号） | `outcome: "in-progress"`、`startedAt`；`answeredAt`、`endedAt`、`durationS` 为 `null` |
| 接通 | `outcome: "answered"`、`answeredAt`；答录机接起时为 `"voicemail"` |
| 结束 | `endedAt`；`durationS` 从接通到结束，四舍五入到整秒（答录机接的从它接起算，被接管后也是，`answeredAt` 仍是答录机接起的时刻），没接通为 `null`；下表的最终 `outcome` |

| `outcome` | 含义 |
| --- | --- |
| `in-progress` | 还没接通。 |
| `answered` | 接通了、还在通话；不会是最终值。 |
| `completed` | 接通过、已结束，不论谁挂断。 |
| `voicemail` | 答录机接了并留下了留言。客户端从答录机手里接过来的（`claim`，或录音中 `answer`）改为 `answered`，结束为 `completed`。 |
| `missed` | 来电，一直没接通：对方放弃、被拒接、无人接听——或者答录机接了但没有留言（见“答录机”）。`seen` 变为 `false`。 |
| `busy`、`no-answer` | 去电，模块报对方忙或无人接听；分辨不出的后端记为 `failed`。 |
| `failed` | 去电因其他原因没接通，包括接通前自己挂断；网络给了原因时 `endReason` 说明。 |
| `rejected` | 来电被拒接。可选：`cellpilotd` 把拒接记为 `missed`；App 把 `rejected` 显示为已拒接。 |

后端重启或设备断开时仍未结束的记录在那一刻收尾：没接通的（`in-progress`）为 `failed`；`answered` 为 `completed`，结束时间为那一刻，时长算到那一刻；`voicemail` 如果答录机留下了留言，仍是 `voicemail`，结束时间为那一刻；没有留言则为 `missed`（`answeredAt` 和 `durationS` 为 `null`）——被重启打断的录音会丢失。`endReason` 只在 `failed` 时有值。隐藏号码的 `peer` 为 `""`。App 把 `answered` 和 `completed` 显示得一样，把 `missed` 和 `voicemail` 算作未接，`in-progress` 显示为进行中。

`calls` 事件（最新一页，条数由后端定——`cellpilotd` 是 50）在记录结束、被看过、被删除、联系人改名时发；通话开始和接通时不发，那由 `call` 事件负责。有 `places` 特性时带 `place`/`carrier`；`seen` 对还没有人打开过的未接来电（或答录机接了但录到不足 1 秒的来电）为 `false`；其他记录一开始就是 `seen: true`——去电、接通的，以及有留言的答录（它通过留言的 `heard` 计数）。`POST /v1/calls/{id}/seen` 把它标为所有客户端都已看——已经看过也回 `200`，没有这条记录回 `404 not_found`——`seen` 真的变了才发 `calls`；App 只对 `seen: false` 的记录调用，失败就忽略。`DELETE /v1/calls/{id}` 没有这条记录回 `404 not_found`；进行中的通话的记录也可以删，那通电话结束后就没有记录。

## 短信

会话按对方号码分组——按字符串完全相同（“号码”一节说明一个人怎样保持一个 peer）。`GET /v1/conversations` 列出会话，不分页，按最后一条短信的 id 新的在前（`lastAt` 是那条短信的 `createdAt`），带最后一条、收到的未读条数、联系人名（如有）和归属地（如知）。`GET /v1/conversations/{peer}/messages` 翻阅一个会话（`{peer}` URL 编码、精确匹配；没有短信的 peer 回 `200` 和空列表）。`POST /v1/conversations/{peer}/read` 清未读——没有未读或没有短信的 peer 也回 `200`。

`POST /v1/messages`（`{ "to", "text" }`）发送。`to` 去掉分隔符后必须是 3–20 位数字，可带开头的 `+`（`400`，`"to"`）；`text` 是任何非空字符串，需要时由后端分段（`400`，`"text"`）；然后没有设备是 `503`，不记录。返回 `{ "message": { … } }`：这条短信，`direction: "out"`、`read: true`，状态 `pending`——后端如果等模块发完再回，就已经是 `sent` 或 `failed`（`cellpilotd` 会等）；App 两种都接受。事件：记下时发 `message`（`pending`），发出或失败时再发 `message`（失败带 `error`），然后 `conversations`。后端重启或设备断开时还没发完的短信变为 `failed`。

`DELETE /v1/conversations/{peer}` 有 `trash` 特性时把会话移入回收站，没有则永久删除——没有短信的 peer 也回 `200`；和这个号码的通话记录不动。`DELETE /v1/messages/{id}` 永久删除一条短信，不管有没有回收站（已在回收站里的也一样）；`POST /v1/messages/{id}/trash`（有 `trash` 时）把一条移入回收站（App 用它把用户不再需要的单条短信放进回收站）。没有这条短信时都是 `404`，后者对已在回收站里的也是。

收到的长短信从第一段起就是一条记录：每到一段发一次 `message` 事件——同一个 `id`，`body` 是目前拼好的，`parts: { "received", "total" }`——最后一段（`received` 等于 `total`）之后才发 `conversations` 并推送；到这时才通知。收齐后 `parts` 仍留在记录上。在那之前它和别的短信一样：在会话列表里（目前的正文作为 `lastBody`）、在搜索里、在未读数和角标里。

`GET /v1/messages/search?q=`（有 `search` 时）查找不在回收站里、正文或号码包含 `q` 的短信——子串匹配，ASCII 字母不分大小写，`%` 和 `_` 按字面——新的在前；`limit` 默认 50、最多 200；`q` 为空回 `[]`。

回收站装的是短信。`GET /v1/trash` 对每个有短信在回收站里的 peer 列一项，按这些短信汇总——所以一个 peer 可以同时出现在两个列表里——`unread` 总是 `0`。回收站里的短信不出现在 `/conversations/{peer}/messages`、搜索和角标里，也没有逐条读取的接口：按 peer 恢复或清除。`POST /v1/trash/restore` 和 `POST /v1/trash/purge` 带 `{ "peers": [...] }`（空的是 `400`；超过 500 个只处理前 500 个）：恢复把这个 peer 在回收站里的短信全部放回，清除把它们永久删除，不动这个 peer 在会话列表里的短信。移入回收站满 30 天的可以清除（`cellpilotd` 在启动时清除）。这些操作都发带 `trash` 的 `conversations` 事件。

一条短信是 `{ "id", "direction": "in"|"out", "peer", "body", "status": "pending"|"sent"|"failed"|"received", "createdAt", "deviceTime", "parts", "error", "read" }`，每个字段都有：`deviceTime` 是网络给收到的短信打的时间（发出的短信、或网络没给时为 `null`），`parts` 对分几段的短信是 `{ "received", "total" }`、对一段的为 `null`，`error` 说明 `failed` 的为什么失败，其他为 `null`。

## 联系人（特性 `contacts`）

联系人是一个人：分成两部分的姓名，以及能找到这个人的号码。

```json
{ "id": 7, "firstName": "小明", "lastName": "王", "name": "王小明", "numbers": ["+8613800138000", "057123456789"] }
```

`GET /v1/contacts` 按显示名排序（不分大小写；同名按建立的先后）；`POST /v1/contacts` 新建、`PUT /v1/contacts/{id}` 整体替换——没带的字段就是空——都返回 `{ "contact" }`；`DELETE /v1/contacts/{id}` 删除。姓名去掉首尾空白、截到 80 个字符。`numbers` 最多 20 个（`400`，`"numbers"`）；每个按保存形式存（见“号码”）、截到 32 个字符，一个数字都没有的丢掉——不因格式拒绝任何号码；同一个联系人里同一个保存形式出现两次只留一个（精确匹配：`+8613800138000` 和 `13800138000` 都保留），上限按发来的个数算。姓名和号码至少要有一样（`400`，`"firstName"`）。一个号码只属于一个联系人：同一个字符串给了另一个人，前一个人就没有了。每次变化发 `contacts`，再发 `conversations` 和 `calls`（上面的名字可能变了）。

两条规则让所有客户端和后端一致，后端必须都实现：

- **显示名。** `name` 由后端算出：姓或名任一部分是中日韩文字时，姓在前、不加空格（王小明）；否则名在前、空格分隔（John Smith）；只有一部分时原样显示，都没有时为 `""`。所有给对方起名的地方（`Conversation.name`、推送标题、CallKit）都用它。
- **号码匹配。** 网络写号码是一种写法，人输入是另一种，所以联系人按数字而不是按字符串查找：只留数字，去掉开头的 `00`，再去掉开头所有的 0；两个键相等，或者一个是另一个的尾部且较短的至少七位，就是同一个号码。`+86 138 0013 8000`、`13800138000`、`013800138000` 是同一个号码；短号永远不会误配到长号的尾部。`Conversation.contactId`、`CallRecord.contactId`、`Call.contactId` 就是这样填的；几个联系人的号码都匹配时，`cellpilotd` 取最早存入的那个。

## 号码

带国家码的按那个国家或地区的规则分析；没有国家码的按 SIM 卡归属国家或地区的规则分析；都分析不出来就是一串数字。

**按来时的样子保存。** 号码完全按用户输入或网络送来的样子保存，只去掉分隔符：数字、开头的 `+`、USSD 码里的 `*` 和 `#` 保留；空格、横线、点、括号去掉。什么都不添加——不加国家码、不加区号——设备自己的号码（从 SIM 读到的或手填的）也一样。一个数字都没有的值（`"anonymous"`、隐藏号码）不是号码：`""`——短信发件人除外，它可以是名字（`EXAMPLECO`）：按来时的样子保存（去掉首尾空白），自成一个会话（精确匹配，匹配规则不会把它并到别处）。`Message.peer`、`Conversation.peer`、`CallRecord.peer`、`Voicemail.peer`、`Call.number`、联系人的 `numbers` 和 `ownNumber` 都是保存形式。`dial` 的 `number` 和发短信的 `to` 先去掉分隔符再校验，按输入的样子交给网络。

**一个人，一个会话。** 新的短信或通话如果按匹配规则（见“联系人”）和已有的某个 peer（短信或通话记录里的）是同一个号码，就归到那个 peer 下：有完全相同的就用它，否则用最近活跃的那个匹配项。都没有就按来时的样子归档。所以网络送来的 `+8613800138000` 和手输的 `13800138000` 落在同一个会话里，App 手上的 `{peer}` 一直有效。

**只读，不改写。** 读一个号码只是说明它是什么——用于号码下面的归属地行（`place`、`carrier`），以及 App 在屏幕上给数字分组。它跟着网络和人写号码的习惯走：从国外打来的电话，以及 SIM 漫游时的每一通来电，都带着 `+` 或 `00` 和国家码（3GPP TS 23.081 §1.2.1：给漫游用户显示的号码是国际格式）；只有与 SIM 同一国家或地区的来电按国内写法到达，只有 SIM 本地的固话不带区号；用户知道自己的 SIM 是哪里的，写号码也是这个习惯。号码里没有的国家码、区号从不假设，只有那一种本地的情况例外。传坏的来电号码和用户的笔误不在考虑之内。

1. **`+` 或 `00` 加国家码**：在那个国家或地区里读（有些网络把国际来电送成 `0085261234567`）；国家码后面多打的长途 0 不算号码的一部分（`+86 (0)571 2345 6789` 读作 `+8657123456789`，保存为 `+86057123456789`）。那个国家或地区发放的号码是国际号码；那里的热线是热线，按它的规则读和分组（`+86 400 123 4567`、`+1 800-555-0199`——显示为 `+1 800-555-0199`，归属地是那个国家或地区）；其他的算未解析（`+61 8765 4321`，没带区号的墨尔本固话）。
2. **三到六位数字**：短号（`110`、`10086`、`95533`）。USSD 串（`*100#`）也算。
3. **其他一切**只在 SIM 的归属国家或地区（`device.home.country`）里读：完整的国内号码——手机号，或带区号的固话，区号带不带长途 0 都行（`13800138000`、`057123456789`、`57123456789`）——是国际号码；那里的热线（`4001234567`）是服务号；然后，中国卡上，`106` 后跟 5 到 17 位数字是短信**网关**号（libphonenumber 没有这类规则；杭州卡上的 `10690000` 是网关号，不是本地固话）；然后，前面加上 `device.home.areaCode` 就是固话（且不以长途前缀开头）的数字，是 SIM 本地的固话（杭州卡上的 `23456789` 读作 `+8657123456789`，有归属地，保存的号码仍是 `23456789`）。否则算**未解析**——包括没写 `+` 或 `00` 的国家码（`8613001300000`），以及不知道 SIM 归属时的一切。

设备在哪里、手机自己的地区，都不起作用。只有国际号码和服务号有归属地行，热线的归属地按它自己的国家或地区查；网关号和未解析的号码没有，不去猜。判断一个国家或地区发放哪些号码、怎样分组，用的是 libphonenumber 的表（`+1` 号码归发放它的地区——加拿大等——分组用美国的写法）。App 显示国际号码时按它所属国家或地区的写法给保存下来的数字分组——国内写法仍是国内写法（区号少打了 0 就不显示 0：`571 2345 6789`），`+` 仍是国际写法，`00` 加国家码显示成 `+`（`0085261234567` → `+852 6123 4567`；保存和拨出仍是原样），国家码后面的长途 0 不显示（`+61 412 345 678`），本地固话按完整号码分组、但不显示区号（`23456789` → `2345 6789`）。短号、网关号和未解析的号码显示成一串数字。规则以用例表的形式写在 `fixtures/number-rules.json`（保存成什么、读成什么、怎么显示、归属地），参考后端和 app 都按这张表测试；你自己写的后端也可以跑同一张表。

## 答录机（特性 `voicemail`）

响铃 `settings.voicemail.answerAfterS` 秒没人接的来电（`reason: "no-answer"`；开关关着时不接），或客户端用 `screen` 交过来的来电（`reason: "declined"`），由答录机接起。只有通话音频在流动时它才接；没有音频（音频通路没能启动）时后端直接挂断，这通电话算未接。接起后通话为 `active`、`holder: null`，记录为 `voicemail`。开始录音时发 `{ "type": "voicemail", "recording": true, "peer", "reason", "transcript": "" }`；有转写时每识别出一段再发一次，`transcript` 是到目前为止的全文，`delta` 是新增部分。对方挂断、录满 `maxSeconds`（后端挂断）、或客户端接过去时结束，发 `recording: false` 和最终的 `transcript`（事件里没有转写为 `""`，从不为 `null`；保存下来的留言什么都没转写出来时 `transcript` 为 `null`）。录音过程中通话音频故障，录音就在那里结束：后端保留之前录到的部分，然后挂断。

录音只有含有留言内容时才成为一条留言（`voicemails` 事件、`voicemail` 推送）：有高于线路本底噪声的声音，或者转写出了文字（有转写时）。其他情况——不满 1 秒，或者不论多长都是静音——都不算留言：录音一点不保留，这通电话按未接结束，记录为 `missed`，`answeredAt` 和 `durationS` 为 `null`，`seen` 为 `false`，并推送 `missed-call`（"未接来电 · 未留言"）。被接过去时，已录的部分含有留言内容才保存为留言，两种推送都不发，通话按已接通继续，`answeredAt` 仍是答录机接起的时刻。隐藏号码的 `peer` 为 `""`。答录机录音中通话结束时，先发 `call`（`null`）和 `calls`，之后才发 `recording: false` 的 `voicemail`，再发 `voicemails`。

**录音与同意。** 对来电者录音、转写录音并让用户实时收听，视来电者和用户所在地的法律，可能需要告知来电者或取得其同意。后端应当播放问候语，说明来电由答录机接听并会被录音。遵守当地法律是后端运行者的责任。录音和转写保存在后端上。

`GET /v1/voicemails` 列出最新的（`cellpilotd` 最多 200 条），`?peer=` 精确匹配。第一次取录音（`GET /v1/voicemails/{id}/audio`，`audio/wav`）时标为已听并发 `voicemails`。`POST /v1/voicemails/{id}/transcribe`（`language`：`auto`、`zh`、`yue`、`en`、`ja`、`ko`）只要声明了 `transcription` 就能用，与开关无关；同一时间只转一条（`409`）；返回 `{ "transcript", "language" }`，`language` 是请求的语言，并把留言的 `transcriptLanguage` 设为它（包括 `auto`）——实时转写的为 `null`。

## 设置（特性 `settings`）

`GET /v1/settings` 和 `PATCH /v1/settings`（部分对象；返回全部）。关掉答录机（`voicemail.enabled: false`）同时关掉转写，答录机关着时转写打不开（这样请求不算错：`enabled` 仍为 `false`）。`PATCH` 里出现的 `voicemail`、`transcription` 每个都会被应用并发一个 `features` 事件（推进 `rev`），即使里面什么都没变；出现 `ownNumber` 时发 `status` 事件；然后每次 `PATCH`（包括 `{}`）都发一个单独的 `rev`，所以客户端改完设置总会读一次快照。各部分按这个顺序应用，逐个检查：后面某部分回 `400` 时，前面的已经生效。`ownNumber` 在 SIM 有号码时是 SIM 的，否则是手填的（`ownNumberSource` 说明来源）；`PATCH` 接受任何带数字的值，按来时的样子保存，`null`、`""` 或不带数字的值清掉手填的。超出范围的值回 `400`，字段名用点连接（`"voicemail.maxSeconds"`、`"transcription.fallbackLanguage"`）；`fallbackLanguage` 是 `zh`、`yue`、`en`、`ja`、`ko` 之一。

## 安全（特性 `security`）

`GET /v1/security` 返回 `{ "state", "alerts" }`，告警默认只列未确认的，`?all=true` 才全给；`security` 事件和 `hello` 带的是未确认的。检查项报告的是现在的状态（`ok`、一行 `text`，以及只在不通过时才有的 `severity`——`warning` 或 `critical`）：确认告警不会让检查项变正常。只要还有未确认的告警，`state.ok` 就是 `false`，不管检查项现在怎么说；`unacknowledged` 是它们的个数。后端启动时已经存在的问题，在第一次看到它的检查时产生告警，除非这条告警在重启前已经产生过。`POST /v1/security/alerts/{id}/ack` 确认一条（已确认过的也回 `200`；没有这条告警回 `404`），`POST /v1/security/alerts/ack` 确认全部。

## 日志（特性 `log`）

`GET /v1/log` 翻阅后端的日志，新的在前（`limit` 默认 200，最多 1000），`log` 事件带每条新日志：`{ "id", "at", "level": "info"|"warn"|"error", "category": "security"|"activity"|"devices"|"system", "code", "text" }`。`text` 用读者的语言，App 显示的就是它；App 按 `category` 筛选，标出 `warn` 和 `error`。`code` 由后端自定，在它内部稳定；`cellpilotd` 的包括 `sms.received`、`sms.sent`、`call.incoming`、`call.ended`、`voicemail.saved`、`device.paired`、`device.revoked`、`auth.failed`、`auth.blocked`、`pairing.badCode`、`security.alert`、`push.failed`、`push.recovered`、`module.connected`、`module.disconnected`、`settings.voicemail`。后端可以用任何 code；App 不据此行事。

## 事件流

`GET /v1/events` 升级为 WebSocket。鉴权和普通请求一样，用 token 请求头——App 总是带上它，所以后端不必接受放在查询串里的令牌。App 也会带 `X-Lang` 和 `?lang=`；但一个客户端连接上的事件用这个客户端记录里的 `lang`（App 用 `PATCH /v1/client` 保持它是最新的），不看这两个。端点的附加请求头同样生效。拒绝升级时只回一个 HTTP 状态（`401`、`410`、带 `Retry-After` 的 `429`）并关闭连接；鉴权通过但没有升级的 `GET` 回 `404 not_found`。每一帧都定义在 [events.schema.json](events.schema.json)。服务端先说话：

```json
{ "type": "hello", "backend": {…}, "features": […], "status": {…状态对象…}, "badge": 3, "rev": "munlb97h.15" }
```

`type`、`backend`（`{ "name", "version", "uptimeS" }`）、`features`、`status` 必须有。`badge` 可选，`rev` 随 `snapshot` 特性出现，有 `security` 特性的后端可以带 `alerts`（未确认的告警，同 `GET /v1/security` 默认列出的）。后端可以加自己的字段，客户端忽略不认识的。

有 `snapshot` 特性时，`rev` 是客户端所保存的一切的版本：后端这次运行的编号、一个点、一个计数器。短信、会话、通话、联系人、留言、告警、功能或设置每变一次，计数器加一。带着这类变化的事件都附上新的 `rev`；没有事件承载的变化（设置）单独以 `{ "type": "rev", "rev" }` 送达。客户端手上的状态版本和 `hello` 一样就什么都不用拉。否则（运行编号不同、计数器跳了不止一步、或收到单独的 `rev` 事件）就请求一次 `GET /v1/snapshot`：一个请求拿到全部列表、设置、告警、自身记录（`client`，含 `pushTokens`）、推送状态和角标，都在同一个 `rev`。这是 App 唯一的刷新方式，没有轮询。

推进 `rev` 的变化，以及带新 `rev` 的事件：短信被记下或状态变化（`message`）；会话列表或回收站（`conversations`）；通话记录（`calls`）；联系人（`contacts`）；留言列表（`voicemails`）；检查结果或告警（`security`）；特性列表（`features`）；设置、推送 `problem` 的变化（单独的 `rev`）。别的都不推进：`status`、`call`、`audio`、录音中的 `voicemail`、`log`、`badge`、`client`、`notify`，登记推送 token，以及在中转登记（发起登记的 App 已有响应）——除非这次登记清掉了推送 `problem`，那算这个 problem 的变化。`PATCH /v1/settings` 请求体里每有一个 `voicemail` 或 `transcription` 对象就推进一步（各发一个 `features` 事件，列表没变也发），再用单独的 `rev` 推进一步（见“设置”）。快照里的 `calls` 是最新的 100 条。背后的规则：`rev` 是所有客户端共用的一个计数，每一步都必须到达每个连接——只发给一个客户端的事件不能推进它，否则别的客户端会看到跳号，白白读一次快照。

没有 `snapshot` 的后端不带 `rev`。App 就在每次连上时重新读一遍，每个列表一个请求（`/status`、`/conversations`、`/calls`，按声明再读 `/trash`、`/contacts`、`/voicemails`、`/settings`、`/security`，最后 `/client`），之后的事件来一个用一个。这样总是对的，只是慢一些。

之后每发生一件事发一个 JSON 文本帧：

| `type` | 字段 | 何时 |
| --- | --- | --- |
| `status` | `device` | 设备状态变了（信号、注册、SIM、插拔；`device` 可能为 `null`）。 |
| `call` | `call`、`holder` | 通话或 holder 变了。每次状态迁移都发，包括变成 `null`。 |
| `audio` | `active` | 后端开始（`true`：这通电话的声音通路已就绪，可以早于接通）或停止和 holder 交换音频帧。App 收到 `true` 才打开麦克风和扬声器。 |
| `message` | `message` | 收到短信（长短信每段一次）、发出的短信被记下、或它的状态变了。 |
| `conversations` | `conversations`、`trash`? | 会话列表变了（新短信、已读、删除、恢复）。 |
| `contacts` | `contacts` | 联系人列表变了。 |
| `calls` | `calls` | 通话记录变了；带最新一页（见“通话记录”）。 |
| `voicemail` | `peer`、`reason`: `no-answer`\|`declined`、`recording`、`transcript`、`delta`? | 答录机正在录音（`recording: true`，`transcript` 是到目前为止的全文，`delta` 是新增部分）或录完了；见“答录机”。 |
| `voicemails` | `voicemails` | 录音列表变了。 |
| `security` | `state`、`alerts`、`alert`? | 检查结果变了，或产生了新告警（`alert` 是新的那条），或确认了告警。`alerts` 是未确认的。 |
| `client` | `client`、`endpoints` | 客户端记录或端点列表变了。只发给这个客户端的连接。 |
| `features` | `features` | 后端能做的事变了；与 `GET /v1` 的列表相同。 |
| `log` | `event` | 一条日志，有 `log` 特性时。 |
| `rev` | `rev` | 客户端保存的某样东西变了但没有事件承载（设置）：请求一次 snapshot。 |
| `badge` | `badge` | App 图标角标数变了：不在回收站的收到未读短信 + `seen: false` 的记录 + 未听留言 + 未确认告警。 |
| `notify` | `id`、`kind`、`callId`?、`reason`? | 可能需要通知的事；只发给一个客户端的连接，它用 `ack` 回复（见下）。 |

未知类型必须忽略，所以后端可以加自己的。哪件事发哪些事件、问哪种 notify、推哪种推送，见“从发生的事到事件和推送”那一张表。

一个客户端可以同时开着几条连接（每个端点一条），它们是同一个客户端，每个事件每条都发。

### 在线状态与 `notify`（特性 `notify`）

后端每 10 秒向每个连接发一次 WebSocket ping，20 秒内没有回应就关闭它——pong 或它发来的任何 JSON 文本帧都算回应，音频帧不算。留下的连接就是真的在线的客户端。推送之前，后端先把事情交给每个有存活连接的客户端，只给没说"已显示"的推送：

```json
{ "type": "notify", "id": "sms-42", "kind": "sms" }
```

客户端对每个 `id` 和 `kind` 只回复一次，从收到它的那条连接回复，并带上两者（同一通电话的 `call`、`call-end`、`missed` 共用一个 id，但是各自独立的询问）：

```json
{ "type": "ack", "id": "sms-42", "kind": "sms", "state": "foreground" }
```

`foreground` 表示 App 在前台、已自己显示，不再推送。`background`，或 5 秒内（来电 1.5 秒）没有回复，该客户端就会收到推送。没有存活连接的客户端不问；没有推送 token 的照样问，只是之后没东西可推。`id` 是 `call-<id>`、`sms-<id>`、`alert-<id>`（没有通话记录的留言为 `voicemail-<id>`），与推送的 collapse id 相同，客户端不管从哪条路收到都只显示一次。`kind` 是 `call`（响铃中的来电，只发给没有 VoIP token 的客户端——有的直接收 VoIP 推送——带 `callId`）、`missed`、`voicemail`、`sms`、`alert`，或 `call-end`。（"VoIP 推送"是 Apple 对 PushKit 来电唤醒推送的称呼，仅用于唤醒 App 显示来电界面。）

**停止响铃。** 来电离开 `incoming` 时：某个客户端接了，`reason` 为 `answered`；答录机接了（包括 `screen`）、对方放弃或无人接听，为 `unanswered`；没接通就结束、且在某个客户端 `hangup` 之后 15 秒内，为 `declined`。`call-end`（带 `callId` 和 `reason`）发给收到过这通电话 VoIP 推送的每个客户端，除了接听的、拒接的、或把它交给答录机的那个（用 `screen`，同样在 15 秒内）。任何 `ack`——`foreground` 或 `background`——都表示那个客户端已经收起了来电界面；1.5 秒内没有回复、或没有存活连接的，收一条 VoIP“结束”推送。系统根本没有显示这通来电的客户端（被专注模式拦下），可以不等问就提前发这个 `ack`；这样响铃结束时既不问它，也不给它推送——结束推送到了手机还得再上报一次来电，而开启"重复来电"时（默认开启），专注模式会放行同一号码的第二次来电。

`ack` 是客户端唯一会发的 JSON。

## 音频帧

通话音频在事件流上以二进制帧双向传送，仅当连接的客户端是 holder 时。格式是裸 PCM：16 位小端、8 kHz、单声道、每帧 20 ms（320 字节采样）。后端随声音到来发下行，每 20 ms 一帧，不成批发。

```
下行（后端 → 客户端）   0x01 | seq 高字节 | seq 低字节 | 320 字节 PCM
上行（客户端 → 后端）   0x02 | seq 高字节 | seq 低字节 | 320 字节 PCM
```

`seq` 是 16 位大端计数器，会回绕；两个方向各自计数。接收方用序号算术比较：`d = (seq − last) mod 65536`，`last` 是最近播放的那帧；`d == 0` 是见过的帧（同一帧可能经两个端点到达），`d > 32768` 是更旧的帧，都丢弃；`1 ≤ d ≤ 32768` 是新帧。后端只向 holder 发下行——同一帧、同一个 `seq` 发给它的每条连接——只接受 holder 的上行，其余丢弃；App 采集到就发上行，每 20 毫秒一帧。静音的上行帧不算数；后端可以用信号电平判断同一客户端的多条连接里哪一条是活的。

## 从发生的事到事件和推送

每件事会发出什么，只此一张表。“rev”表示这个事件推进 `rev`（有 `snapshot` 时）。notify 和推送两列在有 `notify`、`push` 时适用；没有 `notify` 时后端直接推。推送一列写的是“推送”一节里的类别和 collapse id；被排除的客户端既不问也不推。

| 发生的事 | 事件（发给每个连接） | `notify` kind（等待） | 推送 | 排除 |
| --- | --- | --- | --- | --- |
| 收到短信（长短信：收齐时） | `message` rev（每段也发，每段都可能使 `badge` 变化）、`conversations` rev、`badge` | `sms`（5 秒） | alert `sms`，`sms-<id>` | — |
| 发出的短信被记下 | `message` rev（`pending`） | — | — | — |
| 发出或失败 | `message` rev、`conversations` rev | — | — | — |
| 来电开始响铃（知道号码或满 2 秒） | `call` | `call`（1.5 秒），没有 VoIP token 的客户端 | 有 VoIP token 的立即 VoIP；其余不在前台的 alert `call`，`call-<id>` | — |
| 停止响铃 | `call` | `call-end`（1.5 秒），收到过 VoIP 推送的客户端 | 没确认的收 VoIP“结束” | 接听的、拒接的、交给答录机的那个客户端 |
| 接通，或 holder 变了 | `call`（声音通路就绪时还有 `audio`） | — | — | — |
| 结束 | `call`（`null`）、`calls` rev；未接时 `badge` | 仅未接：`missed`（5 秒） | 仅未接：alert `missed-call`，`call-<id>` | — |
| 答录机录音中 | `voicemail`（不推进 rev） | — | — | — |
| 留言保存 | `voicemails` rev、`badge` | `voicemail`（5 秒） | alert `voicemail`，`call-<id>`（没有记录时 `voicemail-<id>`） | 无；客户端接过通话时根本不发 |
| 答录机没有录到留言 | `calls` rev、`badge` | `missed`（5 秒） | alert `missed-call`，`call-<id>` | — |
| 产生告警 | `security` rev（带 `alert`）、`badge` | `alert`（5 秒） | alert `security`，`alert-<id>` | — |
| 检查结果变化、确认告警 | `security` rev | — | — | — |
| 设置变化（`PATCH /v1/settings`） | 每个 `voicemail`/`transcription` 对象一个 `features` rev，有 `ownNumber` 时 `status`，然后 `rev` | — | — | — |
| 推送 problem 变化 | `rev` | — | — | — |
| 读了会话、看了通话、听了留言、删除或恢复 | `conversations` / `calls` / `voicemails` rev；角标变了发 `badge` | — | 角标变了：只改角标的推送，发给没有存活连接的客户端 | 有存活连接的客户端 |
| 联系人变化 | `contacts` rev、`conversations` rev、`calls` rev | — | — | — |
| 设备状态变化 | `status` | — | — | — |
| 某个客户端的记录或端点变化 | `client`，只发给那个客户端 | — | — | — |

同一行里的事件按列出的顺序发，每个连接收到的顺序都一样；`notify` 帧在事件之后，推送在对它们的回复之后。答录机接的电话结束时分两行：先是“结束”（`call` `null`、`calls`），然后是“留言保存”或“答录机没有录到留言”。接管时先发 `call`（新的 holder）和 `calls`（`answered`），再发答录机的 `recording: false` 的 `voicemail`。

## 推送（特性 `push`）

后端不能直接唤醒 App；Apple 推送服务（APNs）才行，而只有持有 App 的 APNs 密钥的人能经它发送。CellPilot 为后端运营一个中转：`https://push.cellpilot.dev`，后端要用的两个接口定义在下面（“中转”）。中转按设计看不到号码和短信。后端遵循本规范时，它发出的每条推送都为要打开它的那一部 App 封好，推送内容中转和 Apple 都读不到；它们仍能看到投递所需的元数据——发送时间、目标设备和通知类型。没有封装载荷的推送中转一律拒绝，只有单独的角标数除外；Apple 需要以明文传递的少数字段——通用的提示文字（`CellPilot` 和不超过 40 个字符的正文）、类别和角标——仍然可读。后端必须让明文保持通用。中转还能看到投递所需的信息：APNs token、账号、后端的 id 和标签，以及每条推送的发送时间。哪件事推什么，见“从发生的事到事件和推送”。

### 登记

App 每次启动对 `pushTokens` 里没有的 token 调用 `POST /v1/client/push-tokens`，带 `{ "token", "kind": "alert"|"voip", "environment": "sandbox"|"production" }`；`token` 是 32–200 个十六进制数字，值不对回 `400` 并指出字段。后端按 token 保存，记下客户端和种类：同一个 token 再来是无变化，由另一个客户端登记就改归那个客户端，一个客户端可以有几个同种 token（都推）。中转说某个 token 失效时、客户端解除配对或被撤销时删掉。经中转推送的后端用不到 `environment`，中转知道每个 token 的环境。

`DELETE /v1/client/push-tokens/{token}` 撤回一个 token（只能是这个客户端自己的；不持有的 token 也回 `200`）：用户关掉系统来电界面时，App 会撤回自己的 VoIP token，因为 iOS 会把每个 VoIP 推送都显示成来电。后端没有某个客户端的 VoIP token 时，就用普通推送通知它有来电。

### 信封

密钥从双方已经共有的客户端 token 派生，不需要额外交换：

```
key = HKDF-SHA256(ikm = SHA-256(token), salt = "cellpilot", info = "push-v1", length = 32)
```

其中 `token` 是客户端 token 的 UTF-8 字节，`ikm` 是 32 字节的原始哈希（后端存的是十六进制哈希，用它的字节）。测试向量：token `test-token-abc123` 派生出密钥 `be1588bb645dc5912eb961418ef2143b6bf623f1c0e85e1ec038ae43a16b179e`。

载荷是一个 JSON 对象，UTF-8，用 AES-256-GCM 和新鲜的 12 字节 nonce 加密，不带附加数据，tag 16 字节，以 `nonce ‖ 密文 ‖ tag` 的 base64url（无填充）放在字段 `e` 里，旁边是 `v: 1`。测试向量：用上面的密钥、nonce `000102030405060708090a0b`、载荷 `{"title":"妈妈","body":"晚点到","category":"sms","peer":"+8613812345678","messageId":42}`，`e` 为 `AAECAwQFBgcICQoLU1I1IUCqNYHuNp5_qSu3qSwweGAE5VyXJ_TwCp-GcL5m6DybdH4HHDt64o6eXWsbDznzcsffdWh3t8DQRojwIgS7r0kXDQgFnpiIjGPrtgCePtq-5JEeETZIwNa0edO7mMBOz7BYBIq9BgQnCw`。

**alert 推送**是手机对短信、未接来电、留言、安全告警显示的通知。明文部分什么都不说：

```json
{ "aps": { "alert": { "title": "CellPilot", "body": "New message" }, "sound": "default",
           "category": "sms", "interruption-level": "active", "mutable-content": 1 },
  "e": "…", "v": 1 }
```

明文只说来了哪一类东西；App 的通知扩展用封起来的内容替换它：`{ "title", "body", "category", …data }`，用客户端的语言，`category` 与 `aps.category` 相同。只有这五个类别，App 按类别和字段名决定点开后去哪：

| 事 | `category` | 封装的 `title` / `body` | 封装的数据 | collapse id | `interruption-level` | `sound` |
| --- | --- | --- | --- | --- | --- | --- |
| 短信 | `sms` | 对方的名字或号码 / 正文，超过 240 个字符截断加 `…` | `peer`、`messageId` | `sms-<id>` | `active` | `default` |
| 来电，发给没有 VoIP token 的客户端 | `call` | “来电” / 来电者（名字、号码或“无来电显示”） | `number`（隐藏为 `null`）、`callId` | `call-<id>` | `time-sensitive` | `ringtone.caf` |
| 未接来电 | `missed-call` | 来电者 / “未接来电”（答录机接了但没有留言：“未接来电 · 未留言”） | `number`、`callId` | `call-<id>` | `active` | `default` |
| 留言 | `voicemail` | 来电者 / 如“未接来电 · 有留言 18 秒” | `voicemailId`、`number`、`callId` | `call-<id>`（没有记录时 `voicemail-<id>`） | `active` | `default` |
| 安全告警 | `security` | “安全告警：”加告警标题 / 详情第一行 | `alertId` | `alert-<id>` | `time-sensitive` | `default` |

`mutable-content: 1` 必须有：通知扩展靠它打开 `e`。中转只转发恰好由 `aps`、`e`、`v` 组成的 alert：`aps.alert.title` 为 `"CellPilot"`，`aps.alert.body` 是不超过 40 个字符的字符串（措辞随意——`cellpilotd` 用 `New message`、`Incoming call`、`Missed call`、`New voicemail`、`Security alert`，或 新消息、来电、未接来电、新留言、安全告警），`aps` 里只能有 `alert`、`sound`、`category`、`interruption-level`、`mutable-content`、`thread-id` 和 `badge`（0–99999 的整数），`e` 长 16–4000 个字符。`aps` 里的一切都是明文：通知正文和 `thread-id` 里不要放能认出人或引用短信的内容。

除来电那条之外，每条普通推送都在 `aps.badge` 带上图标角标数：不在回收站的收到未读短信 + `seen: false` 的记录 + 未听留言 + 未确认告警，与 `hello`、`badge` 事件、快照的 `badge` 是同一个数。在一个客户端上看完后，没有存活连接的客户端会收到只有 `{ "aps": { "badge": n } }` 的推送——不封装、不显示、不带 collapse id；iOS 只能从明文读角标。300 毫秒内的变化只发一次（`badge` 事件也一样），而且只在这个数和上次发出的不同时才发——整个后端只有一个数，发给任何客户端的任何推送或 `badge` 事件都会更新它，后端启动时以当时的数为起点。

**VoIP 推送**通过 CallKit 让手机为来电响铃，一知道号码就发（两秒还没有号码就当隐藏号码发）。它恰好只有 `e` 和 `v`，没有 `aps`，封着 `{ "callId", "number", "name", "place": { "en", "zh" } }`：隐藏号码时 `number` 为 `null`，`name` 是联系人显示名或 `null`，`place` 总是对象，每种语言不知道时为 `null`（没有 `places` 时两个都是）。只能为真正在响铃的来电发送——iOS 要求 App 对每条 VoIP 推送都报告一通来电——中转以过期时间 0 发送它，Apple 会立即尝试投递，送不到就丢弃而不会延迟送达；不保证一定送达。收到它的客户端这通电话不再收 `call` 普通推送，也不被 `notify` 询问。来电停止响铃时，没有确认 `call-end`（见“在线状态与 `notify`”）的客户端会再收到一条，封着 `{ "type": "end", "callId", "reason" }`；App 上报后立即结束。没有 `type`，App 会把它当成一通新来电。

### 经中转

后端把组装好的 APNs 消息体发到中转的 `POST /v1/push`，用自己的 Ed25519 密钥签名。要获得这个资格，它必须在中转上*登记*到一个账号名下——用户的 Apple 登录身份，由 App 处理。由 App 牵线：

1. 用户在 App 里用 Apple 登录，App 把手机自己的 APNs token 绑到中转上的这个账号，所以后端只能到达它登记所属账号的手机。
2. App 问后端怎么推送：`GET /v1/push` 返回 `{ "mode": "none" | "relay" | "direct", "relay": { "url", "daemonId" } | null, "problem"? }`。`none`：还没有推送途径；`relay`：已登记。（`direct` 是保留值；后端报告 `none` 或 `relay`。）`problem`（可选）说明推送为什么发不出去，好让手机告诉主人：`{ "code", "at", "quota"? }`，`code` 是 `suspended`、`not-entitled`、`quota`（带每日额度 `quota`）、`rate`、`not-enrolled`、`unbound`、`apns` 或 `unreachable`，`at` 是开始的时间——之后同一原因的拒绝不改它。`quota` 是中转的每日额度，只随 `quota` 出现。推送恢复后为 `null` 或不出现；没有定时重试，每条推送都照常尝试，所以暂停、开通或当日额度一恢复，第一条成功的推送就把它清掉。有 `snapshot` 的后端在它变化时推进 `rev`；snapshot 里的 `push` 是同一个对象。App 在设置页显示它，`unbound` 时自己去中转重新绑定 token。
3. 如果是 `none`，App 从中转拿一张一次性许可（十分钟有效）交给后端：`POST /v1/push/enrol { "relayUrl", "grant" }`。后端到中转登记（`POST /v1/daemons`，见下），返回新的推送状态。此后它经中转推送，中转只允许它到达这个账号的手机。`relayUrl` 是 `https://主机[:端口]`，不带路径，结尾的 `/` 去掉（`400`，`"relayUrl"`）；`grant` 16–200 个字符（`400`，`"grant"`）。中转拒绝、或 15 秒没回答，回 `502 upstream_failed`，message 里写中转的状态码和 `error`。用同一把密钥再登记沿用原来的 `daemonId`。后端按给出的样子保存 `relayUrl`（去掉首尾空白和结尾的 `/`），并作为 `relay.url` 报告；指向测试中转（见“测试”）的后端报告它实际使用的地址。

### 中转

两个接口，都是 JSON，在中转的地址上（`https://push.cellpilot.dev`，不带路径）。

**`POST /v1/daemons`**——登记。不签名：许可就是凭据。

```json
{ "grant": "…", "publicKey": "<32 个原始字节，base64>", "proof": "<签名，base64>", "label": "my-backend" }
```

`proof` 是用私钥对 `cellpilot-enrol\n` 加许可的 Ed25519 签名——公钥不是秘密，没有它任何人都能把别人的后端登记到自己账号下。`label` 可选（截到 60 个字符）。返回 `200 { "daemonId": "d_…" }`；同一把公钥再登记沿用原来的 id（并移到这张许可所属的账号）。拒绝：`400 {"error":"grant, publicKey and proof"}`（缺字段或公钥不是 32 字节）、`401 {"error":"proof not accepted"}`、`401 {"error":"grant not accepted"}`（许可不存在、过期或已用过）、`429 {"error":"too many requests"}`（同一地址登记太多次）。不需要别的步骤：登记后就能推给这个账号绑定的每台手机。

**`POST /v1/push`**——要签名（见下）。

```json
{ "token": "<手机的 APNs token>", "type": "alert", "body": { "aps": { … }, "e": "…", "v": 1 }, "collapseId": "sms-42" }
```

`type` 是 `alert`（包括只改角标的）或 `voip`；`body` 是“信封”一节描述的 APNs 消息体原样，中转会检查（只放行封好的消息体和单独的角标）；`collapseId` 可选，只用前 64 个字符，只改角标和 VoIP 推送不带。中转按 token 的绑定选 APNs 环境，自己设主题、推送类型、优先级（只改角标 5，其他 10）和过期时间（普通推送一小时，VoIP 为 0）：后端从不发送 `environment` 或 APNs 请求头。

**中转的回答**（`POST /v1/push`）：`200 {"ok": true}` 清掉 `problem`；否则是 `{ "error", …}`，按下表处理（响应体里有 `gone: true` 时不论状态码都表示 token 已失效——删掉它）：

| HTTP | `error` | `problem.code` |
| --- | --- | --- |
| 400 | `only sealed pushes are relayed`、`body is not JSON` | 不设：改你的推送 |
| 401 | `not authorized`（签名、key id、时钟或 nonce） | `not-enrolled` |
| 402 | `account suspended` / `not entitled` | `suspended` / `not-entitled` |
| 403 | `token not bound to this daemon` | `unbound` |
| 410 | `token gone`，带 `gone: true`、`reason` | 不设：删掉 token |
| 429 | `daily quota reached`，带 `quota` / `rate limited`（每小时上限） | `quota` / `rate` |
| 502 | `apns refused`，带 `status`、`reason` | `apns` |
| 其他 5xx、15 秒没有回答 | | `unreachable` |

文字按宽松方式匹配：`402` 的 `error` 含 `suspended` 就是 `suspended`，其他都是 `not-entitled`；`429` 的 `error` 含 `daily quota` 就是 `quota`，其他都是 `rate`。

只有中转真正发给 Apple 的推送计入账号的小时和日额度，具体数值见中转的回答；被拒的——不论原因，包括超出每日额度和每小时上限——都不计。限额、配额及其计算方式由中转设定，可能会变化；示例中的数值仅作说明。**`not-enrolled`** 表示中转不再认识后端的密钥，后端这边修不好：后端放弃登记，`GET /v1/push` 报告 `mode: "none"`、`relay: null`、`problem: { "code": "not-enrolled", … }`，下一个刷新的 App 会重新替它登记——同一把密钥，拿回同一个 `daemonId`。

**签名。** 除 `POST /v1/daemons` 外的请求都带 `x-relay-key`（`daemonId`）、`x-relay-ts`（Unix 秒，与中转时钟相差 120 秒以内）、`x-relay-nonce`（任意字符串，最长 64 个字符，5 分钟内不重复）和 `x-relay-sig`：对 `METHOD\nPATH\nTS\nNONCE\nhex(SHA-256(请求体))` 的 Ed25519 签名——路径就是请求的路径，摘要对实际发出的字节计算、小写十六进制，结尾没有换行。签名、公钥（32 个原始字节）和登记证明 `proof` 用 base64，base64url 也接受。测试向量：种子 `0102…1f20`（32 字节，十六进制 01 到 20），公钥 `ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=`；`POST /v1/push`、ts `1790770000`、nonce `3q2-7w1Kd9Qx-AbC`、只改角标的请求体 `{"token":"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90","type":"alert","body":{"aps":{"badge":3}}}`（摘要 `065d25e89916ae08f52cd6c65ba9508da35dd470de4027dab38c885283849446`）的签名是 `P91OJuJl8PoiJA7jfXOXwJHoATCvpfJEJvUAvKBQLKwgzhYkZ2jqNiV1bCKO0mYQe2+hjn6D+/y1MzUfz7XIAQ==`；许可 `Zm9vYmFyLWdyYW50LWV4YW1wbGU` 的证明是 `jbf6tkqSPJdAcRo0aVjEQ1nGJYXrNVw4dE66yUTdO7uiVmqUfh3dPp8zsVF9nng/CjwWrHfMv4mgrBIezsFpBA==`。

**测试。** `tools/test-relay.mjs` 是中转的替身；见“测试”。

## 网页入口（特性 `portal`）

`POST /v1/portal/session` 返回 `{ "url", "expiresInS", "cookies"?: [{ "name", "value" }] }`。App 在网页视图里打开 `url`，带上端点的请求头，并写入给出的 cookie。页面是什么是后端的事；`cellpilotd` 显示它的控制台，它的 `url` 带一个码，在 `expiresInS`（60）秒内只能打开一次。

## 后端必须实现什么

核心部分，按有用程度排序：

1. `GET /v1`、`GET /v1/ping`、`POST /v1/pair`，Bearer 鉴权及 `401`/`410` 语义。
2. `GET /v1/client` 及其端点，`PATCH`，`DELETE`。
3. `GET /v1/status`；事件流的 `hello`、`status`、`call`、`audio`。
4. `GET /v1/call`、`dial`、`answer`、`hangup`、`dtmf`；双向音频帧。
5. `GET /v1/calls`、`DELETE /v1/calls/{id}`、`calls` 事件。
6. 会话与短信：列表、翻页、发送、已读、删除；`message` 和 `conversations` 事件。

然后是它能如实声明的任何特性。`openapi.yaml` 是路由和形态的权威清单。

## 测试

这里的一切都可以不用 App、用本仓库里的工具检查（Node 22 或更新，没有依赖）。

**`tools/api-check.mjs`** 按核心和后端声明的特性检查一个运行中的后端，每个响应和事件帧都逐字段对照 `openapi.json` 和 `events.schema.json`。默认只读：从不拨号、接听、发短信或改设置，按设计不做任何改动，可以对插着真 SIM 卡的后端运行。其余选项只能用于模拟设备的后端，`--dial`、`--sim`、`--code` 都要和 `--write` 一起用：

| 选项 | 增加 |
| --- | --- |
| `--write --to <号码>` | 发一条短信并跟着事件流检查：`message` 先 pending 后最终状态，`conversations` 只在之后，`rev` 一步一步推进。 |
| `--dial` | 拨 `--to`：通话期间的记录、holder、挂断、结束后的记录；加 `--sim` 时还有双向音频帧。 |
| `--sim [--from <号码>]` | 驱动模拟钩子（见下）：来一条短信和两通电话，检查 `message`、`conversations`、`badge`、`notify` 和 `ack`、接听、音频帧，以及一条未接来电的记录。 |
| `--code <码>` | 用后端可重复使用的测试码配对一个一次性客户端：再配对一次旧 token 变 `401`，解除配对后变 `410`。 |

```sh
node tools/api-check.mjs --url http://192.168.1.10:9400 --token <某个已配对客户端的 token>
node tools/api-check.mjs --url http://127.0.0.1:8799 --token <token> --write --to +15555550101 --dial --sim --code 123456   # 只用于模拟设备
```

每项检查打印一行（`ok`、`FAIL` 或 `skip`），有任何失败时以非零状态退出。

**模拟钩子。** 模拟设备的后端可以提供下面这些，在 `/v1` 之外、不要 token、只对本机（回环地址）开放。它们是测试用的约定，不是 API 的一部分：App 从不调用，驱动真实设备的后端不能提供。

| 钩子 | 请求体 | 发生什么 |
| --- | --- | --- |
| `POST /_sim/sms` | `{ "from", "text" }` | 来一条短信。 |
| `POST /_sim/call` | `{ "from" }`（`null`：隐藏号码） | 来电响铃。 |
| `POST /_sim/hangup` | `{}` | 对方挂断；还在响铃的来电因此成为未接。 |
| `POST /_sim/answer` | `{}` | 对方接听拨出的电话。可选：模拟器可以自己接听。 |

每个都回 `200 {}`，不合时宜时（已经有通话）回 `409`。

**`tools/test-relay.mjs`** 是推送中转的替身。它检查中转检查的东西——登记证明、每个签名、时钟、nonce、推送是否封好——用给它的客户端 token 打开每个封好的载荷，并标出中转会放行但 App 依赖的东西（类别、collapse id、声音、中断级别、封装的字段）。把后端的中转地址指向它（测试用的覆盖设置：`POST /v1/push/enrol` 本身只接受 https），并告诉它下一次回什么：

```sh
node tools/test-relay.mjs --port 18780 --state relay-state.json
curl -X POST http://127.0.0.1:18780/_tokens -d '{"token":"<客户端 token>"}'        # 配对之后
curl -X POST http://127.0.0.1:18780/_next -d '{"answer":"quota","times":3}'         # 接下来三条推送
curl -X POST http://127.0.0.1:18780/_next -d '{"on":"enrol","answer":"grant"}'      # 下一次登记
```

推送的回答：`not-enrolled`、`suspended`、`not-entitled`、`unbound`、`quota`、`rate`、`gone`、`apns`、`unreachable`；登记的回答：`grant`、`proof`、`rate`、`unreachable`；`ok` 恢复正常。许可 `expired-grant-for-testing` 总是被拒。

**`tools/mock-backend.mjs`** 是 App 能用的最小后端：只有核心，一个文件、没有依赖，通话和短信都是模拟的，带模拟钩子。可以当作起点来读，也可以让 App 和它配对，看看只有核心的后端在手机上是什么样子：

```sh
node tools/mock-backend.mjs --port 8799 [--code 123456] [--incoming]   # 打印配对码
```

**`fixtures/number-rules.json`** 是“号码”一节的用例表：保存成什么、读成什么、怎么显示、归属地。
