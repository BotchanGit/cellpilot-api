# Changelog

The API is versioned by its base path (`/v1`). Within a version it is intended only to grow: entries add fields,
events, features or clarifications. An entry marked **Changed rule** tightens what a backend should
do; the app keeps working with a backend that follows the earlier text, and the entry says what to
change. Tools are versioned with the repository.

[中文说明见下方](#中文)

## 2026-10-10

### Changed rule — outbound limits

The limits are stricter, and the app now judges only by what it has seen itself, so a backend's
claims cannot widen them. *What to change:* a backend applying the limits should follow the
updated table in the specification (*Outbound limits*); new `details.rule` values may come back
with `429 outbound_limited`.

- **Familiar** now takes three days: since the contact was made or the number first called or
  texted. The app counts from when it first saw the number and lets at most 5 numbers become
  familiar a day.
- **Totals**: 10 calls (was 20) and 20 texts (was 30) a day.
- **New rules**: `call-burst` and `text-burst` (at most 3 different numbers within 15 minutes for
  calls, 10 for texts), `short-calls` (3 calls in a row to different numbers, each over within 15
  seconds, pause calling for 30 minutes), `code-relay` (a verification code received in the last
  10 minutes cannot be sent on), `code-flood` (codes from 10 or more senders in a day pause
  everything), `sim-changed` (no unfamiliar numbers for a day after the SIM changes) and
  `forbidden-code` (no dial strings that set up call forwarding or hide the caller id).
- **Locks** last 7 days when the previous one began less than a week before.
- In the app only: a text that reads like a scam is sent only after the user confirms, and
  counts as a strike when the wording is strong; international, premium-rate and one-ring call-backs are asked about first;
  links in received texts open only after the user confirms.

### Added — scam-wording list

- [`spec/scam-keywords.json`](spec/scam-keywords.json): the wording the app asks about before
  sending, and which a backend may use to flag incoming texts. Entries are combinations of terms,
  graded strong or medium; warning markers keep anti-fraud warnings, which quote scam wording,
  from matching medium entries. It is tuned for precision: on texts it was not tuned on, it
  catches about a quarter of scams and flags about 2% of deliberately scam-like genuine texts,
  none of them with a strong entry. It will be updated.

### Added — spam and blocking (feature `spam`)

A backend can now screen what arrives and keep spam out of the inbox; see *Spam and blocking* in
the specification. Nothing changes for a backend that does not declare `spam`.

- Messages carry `spam`: `null`, or a verdict (`spam` out of the inbox, `suspect` marked in it) with
  its reason (`blocked`, `keyword`, `classifier`, `report`). Strong entries of the wording list file a
  text as spam, medium ones mark it; a link alone is no reason. Someone the user knows (a contact,
  someone they have texted, a sender they took out of spam) is never filed except by the blocklist,
  only marked.
- A recommended method for the backend's own judgement: a naive Bayes model learnt from the
  backend's own examples (judging only with enough genuine examples, mostly ordinary texts kept a
  week; spam only when nearly sure and from a personal number, never for a text with a
  verification code) and six signals, counted in points (strong wording 2, medium wording 1, each
  signal 1, the model 1 or 2): two file a text, one marks it.
  `detail` lists what counted (`keyword:`, `signal:`, `words:`), which the app words in the user's language. Warning
  markers from an official sender now cancel strong entries too (list version 2, with Traditional
  Chinese markers).
- The wording list as a backend applies it (`GET /v1/spam/keywords`): what each entry caught, how
  often its catches were taken out of spam or reported, demoted after too many mistakes; any entry
  can be switched off (`PATCH /v1/spam/keywords/{id}`).
- The spam folder (`GET /v1/spam`, `GET /v1/spam/{peer}/messages`, `POST /v1/spam/restore`,
  `POST /v1/spam/purge`), reporting spam that got through (`POST /v1/spam/report`, which also
  blocks the sender), and the blocklist
  (`GET`/`POST /v1/blocklist`, `DELETE /v1/blocklist/{number}`, the `blocklist` event). The
  `conversations` event and the snapshot carry `spam`; the snapshot carries `blocklist`.
- A blocked number's call is refused before anyone is rung and recorded with the new outcome
  `blocked`. Spam and blocked calls are told with one quiet push each, category `spam`, never
  quoting the text.
- What the judgement learns from — reports, messages taken out of spam — stays on the backend; the
  specification gives the format.

### Testing

- A new optional simulation hook, `GET /_sim/state`: what the far end has received (texts sent,
  keys pressed, the call), so a test can check that a text really left or was held back.

## 2026-10-04

### Added — outbound limits; what CellPilot is for

- **What CellPilot is for**, now stated the same way everywhere: so that people whose iPhone takes
  only eSIM do not miss the texts and calls of a physical SIM card of their own. It is made mainly
  for receiving; calling and texting are for the occasional need, and a number used every day
  belongs in a phone or on an eSIM.
- **Outbound limits** (new section in the specification). The app now limits calls and texts:
  within 24 hours, calls to 3 and texts to 3 distinct numbers that are not contacts and have not
  contacted the line, calls to 10 hotlines, 20 calls and 30 texts in all, 30 seconds between
  calls, no links except to familiar numbers, one text to at most 2 numbers; two refusals pause
  outbound to unfamiliar numbers for 24 hours. Emergency numbers are never limited.
  *What to change:* a backend should apply the same limits to `POST /v1/call/dial` and
  `POST /v1/messages` and refuse with the new error code `429 outbound_limited`, whose `details`
  carry `rule`, `limit` and `retryAt`. A backend without them still works; the app's own limits
  apply either way.
- **Paired phones.** A backend may limit how many phones are paired at once and refuse a new one
  with `409 conflict` and `details.limit`, without spending the code. The reference backend allows
  three.
- The acceptable use policy, the READMEs, OpenAPI (`Error.code`, `Error.details`, the `429` of
  `dial` and `sendMessage`, the `409` of `pair`) and the guide follow.

### Changed rule — answering machine (backends with the `voicemail` feature)

- **A voicemail is a message kept.** A recording becomes a voicemail only when it holds a message:
  sound above the line's own noise, or — where it was transcribed — words. A recording under a
  second, or silence however long, is no message: keep nothing, and end the call as **missed**
  (`outcome: "missed"`, `answeredAt` and `durationS` `null`, `seen: false`) with the `missed-call`
  push "Missed call · no message left". Before, any recording of a second or more was a voicemail,
  silent or not. A take-over keeps the recording only if it holds a message.
  *What to change:* test the recording before saving it; turn the record into a missed call when it
  holds nothing.
- **Pick up only with call audio.** The machine answers only when call audio is flowing; if the audio
  path failed to start, hang up instead, so the caller is not left in silence. If audio fails while
  it records, keep what was recorded so far, judge it by the rule above, and hang up.
- **Restarts.** A record left open as `voicemail` by a restart stays `voicemail` only if a message was
  kept; otherwise it becomes `missed`.
- The `voicemail` and `missed` outcomes, `seen`, the happenings table ("The machine got no
  message") and OpenAPI's `CallRecord.outcome` say the same.

### Added — `call-end` acknowledged ahead (backends with `push` and `notify`)

- A client whose system never showed a ringing call (iOS Focus held it back) may now send the
  `call-end` `ack` before it is asked. A backend should remember it and, when the ringing stops,
  neither ask that client nor send it the VoIP end push. Without this, iOS has to report the end push
  as a call again, and Focus lets a second call from the same number through: the phone flashes a
  call screen. A backend that ignores the early ack still works; its users see that flash.

### Docs

- The backend guide (English and Chinese) and the Chinese specification follow both changes.

### Legal and acceptable use

No API behaviour changes.

- Added [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md) (what CellPilot may and may not be used for,
  emergency calls, recording, reporting) and [`NOTICE.md`](NOTICE.md) (trademarks, third-party
  data, encryption).
- The READMEs have a **Legal** section: lawful use only, not for emergencies, recording consent,
  no warranty, trademarks, where to report problems.
- The specification has a section *Intended use and limits*: one person, their own SIM, their own
  devices, and what a backend must not add. The answering machine has a note on recording and
  consent; the guide follows.
- The privacy policy now lists in full what the relay sees to deliver a notification, and adds
  copies kept by iOS, where data is processed, your rights, requests from authorities and that
  the relay is currently invitation-only.
- Corrected statements about what passes through the relay: calls and messages do not; with push
  on, notifications do, sealed, and the relay and Apple still see delivery metadata. VoIP pushes
  are sent with expiry 0, so they are dropped rather than delivered late; delivery is not
  guaranteed. The compatibility promise is stated as an intention, and relay limits may change.
- Wording: "country or region"; in Chinese, "一致性检查" for conformance checks and "国家或地区".
- The owner's statement: CellPilot is made only for lawful purposes; we abide by the law and do
  not endorse, support or assist any unlawful activity. Tell us right away at
  abuse@cellpilot.dev if you find misuse, or anything that conflicts with laws or regulations; we
  will cooperate with the authorities and rectify it, and if necessary change, restrict or shut
  down the feature or service concerned.

## 2026-10-03

- Added the privacy policy for the CellPilot app and push relay (`docs/privacy.html`).

## 2026-10-02

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

---

## 中文

### 2026-10-10

**规则变更：外发限制**

限制更严格了，而且 App 现在只依据它自己看到的情况判断，后端怎么说都放宽不了。*需要改的：* 执行外发限制的后端，按规范里更新后的表格（“外发限制”）调整；`429 outbound_limited` 可能带回新的 `details.rule` 值。

- **熟悉的号码**现在要满三天：从建立联系人或第一次来电、来短信算起。App 从它自己第一次看到这个号码算起，每天最多让 5 个号码变成熟悉的号码。
- **总量**：每天 10 通电话（原来 20）、20 条短信（原来 30）。
- **新增规则**：`call-burst` 和 `text-burst`（15 分钟内最多拨打、10 分钟内最多发短信给 3 个不同号码）、`short-calls`（连续 3 通打给不同号码且每通都不到 15 秒，暂停拨号 30 分钟）、`code-relay`（最近 10 分钟收到的验证码不能转发）、`code-flood`（一天内收到 10 个以上不同发送方的验证码，暂停一切外发）、`sim-changed`（换卡后 24 小时内不能联系不熟悉的号码）和 `forbidden-code`（不能拨打设置呼叫转移或隐藏主叫号码的代码）。
- **锁定**：距上一次锁定不到一周又被锁定的，锁 7 天。
- 只在 App 里：像诈骗话术的短信要用户确认后才发送，命中强关键词时计一次违规；拨打国际长途、高额收费号码或回拨"响一声"的号码前先确认；收到的短信里的链接要确认后才打开。

**新增：诈骗话术关键词表**

- [`spec/scam-keywords.json`](spec/scam-keywords.json)：App 发送前会询问的话术，后端也可以用来标记收到的短信。每条是若干词的组合，分强、中两级；提醒用语可以让引用诈骗说法的反诈提醒不命中中等关键词。它以准确为先：在没参与调整的样本上，大约能识别四分之一的诈骗短信，对刻意挑选的、最像诈骗的正常短信误伤约 2%，而且都不是强关键词。之后会持续更新。

**新增：垃圾短信与黑名单（特性 `spam`）**

后端现在可以筛查收到的东西，把垃圾短信挡在收件箱外；见规范里的“垃圾短信与黑名单”。没有声明 `spam` 的后端什么都不用改。

- 短信带 `spam`：`null`，或一个结论（`spam` 不进收件箱，`suspect` 在收件箱里带标记）和理由（`blocked`、`keyword`、`classifier`、`report`）。话术表的强条目把短信归入垃圾短信，中等条目只标记；只有链接不算理由。用户认识的人（联系人、给对方发过短信的号码、从垃圾短信里移出过的发送方）除了黑名单不会被归入，只会被标记。
- 推荐的后端判断方法：从后端自己的样本学出来的朴素贝叶斯模型（正常样本足够才参与，主要是保留了一周的日常短信；只有很有把握、且来自个人号码才归入垃圾短信，含验证码的短信不会因它被归入），以及六个信号，按分计算（强话术 2 分、中等话术 1 分、每个信号 1 分、模型 1 或 2 分）：满 2 分归入垃圾短信，1 分打标记。`detail` 列出计分项（`keyword:`、`signal:`、`words:`），App 按用户的语言显示。官方号码发来的提醒用语现在也会让强条目不算命中（话术表第 2 版，补充了繁体提醒用语）。
- 后端实际应用的话术表（`GET /v1/spam/keywords`）：每个条目拦了多少、被移出和被举报多少，误判太多时自动降级；任何条目都可以关掉（`PATCH /v1/spam/keywords/{id}`）。
- 垃圾短信文件夹（`GET /v1/spam`、`GET /v1/spam/{peer}/messages`、`POST /v1/spam/restore`、`POST /v1/spam/purge`），举报漏网的垃圾短信（`POST /v1/spam/report`，同时拉黑发送方），以及黑名单（`GET`/`POST /v1/blocklist`、`DELETE /v1/blocklist/{number}`、`blocklist` 事件）。`conversations` 事件和快照带 `spam`；快照带 `blocklist`。
- 黑名单号码的来电在任何人被呼叫之前就被拒接，记为新的结局 `blocked`。垃圾短信和被拦截的来电各发一条静默推送，类别 `spam`，绝不包含短信内容。
- 判断所学习的东西——举报、从垃圾短信里移出的短信——留在后端；规范给出了格式。

**测试**

- 新增可选的模拟钩子 `GET /_sim/state`：对方收到了什么（发出的短信、按的键、当前通话），测试可以借此确认一条短信确实发了出去，或确实被拦下。

### 2026-10-04

**新增：外发限制；CellPilot 的用途**

- **CellPilot 的用途**，各处统一表述为：让只能使用 eSIM 的 iPhone 用户，不错过自己另一张实体 SIM 卡上的短信和来电。
  它以接收为主；拨号和发短信只为偶尔的需要提供，日常使用的号码应当放进手机或转为 eSIM。
- **外发限制**（规范新增一节）。App 现在会限制拨号和短信：24 小时内，最多拨打 3 个、发短信给 3 个不在通讯录也没有联系过这条线路的号码，
  拨打 10 个热线，全部通话 20 通、短信 30 条，两次拨号间隔 30 秒，带链接的短信只能发给熟悉的号码，同一条短信最多发给 2 个号码；
  被拒绝两次会暂停对陌生号码的外发 24 小时。紧急号码不受限制。
  *需要改的：* 后端应当对 `POST /v1/call/dial` 和 `POST /v1/messages` 执行同样的限制，并用新的错误码 `429 outbound_limited` 拒绝，
  `details` 带 `rule`、`limit` 和 `retryAt`。不执行的后端照样能用；App 自己的限制始终有效。
- **配对手机数。** 后端可以限制同时配对的手机数，用 `409 conflict` 加 `details.limit` 拒绝新手机，不消耗配对码。参考后端允许三台。
- 合法使用条款、两份 README、OpenAPI（`Error.code`、`Error.details`、`dial` 和 `sendMessage` 的 `429`、`pair` 的 `409`）和指南已同步。

**规则变更：答录机（声明了 `voicemail` 特性的后端）**

- **留言必须有内容。** 录音只有含有留言内容时才算留言：有高于线路本底噪声的声音，或者（有转写时）转写出了文字。
  不满 1 秒、或者不论多长都是静音的录音，不算留言：什么都不保存，这通电话按**未接**结束（`outcome: "missed"`，
  `answeredAt` 和 `durationS` 为 `null`，`seen: false`），并推送 `missed-call`"未接来电 · 未留言"。
  以前只要录音满 1 秒，不管有没有声音都算留言。被接管时，录音也要含有留言内容才保存。
  *需要改的：* 保存录音前先判断有没有内容；没有内容就把记录改成未接。
- **有通话音频才接。** 只有通话音频在流动时答录机才接听；音频通路没能启动时直接挂断，不要让对方对着静音等。
  录音过程中音频故障：保留之前录到的部分，按上面的规则判断，然后挂断。
- **重启。** 重启时还开着的 `voicemail` 记录，留下了留言才保持 `voicemail`，否则改为 `missed`。
- `voicemail` 和 `missed` 两个结果、`seen`、"从发生的事到事件和推送"表（"答录机没有录到留言"）以及 OpenAPI
  的 `CallRecord.outcome` 描述都已同步。

**新增：可以提前确认 `call-end`（声明了 `push` 和 `notify` 的后端）**

- 系统根本没有显示来电的客户端（被 iOS 专注模式拦下）现在可以不等询问，就先发 `call-end` 的 `ack`。
  后端应当记下它，响铃结束时既不询问这个客户端，也不给它发 VoIP 结束推送。否则 iOS 收到结束推送时必须再上报一次来电，
  而专注模式会放行同一号码的第二次来电，手机会闪一下来电界面。不支持这条的后端照样能用，只是用户会看到这一闪。

**文档**

- 后端指南（中英文）和中文规范都已同步以上两项。

**法律声明与合法使用**

API 行为没有变化。

- 新增 [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md)（CellPilot 可以和不可以用来做什么、紧急呼叫、录音、举报）和
  [`NOTICE.md`](NOTICE.md)（商标、第三方数据、加密）。
- 两份 README 增加了**法律声明**一节：仅限合法用途、不能用于紧急呼叫、录音须知、不提供担保、商标、问题报告渠道。
- 规范新增"预期用途与限制"一节：一个人、自己的 SIM 卡、自己的设备，以及后端不得加入的功能。答录机一节增加了录音与同意的说明；指南同步。
- 隐私政策完整列出了中转为投递通知能看到的信息，并新增 iOS 保存的副本、数据在哪里处理、你的权利、有关部门的要求，以及中转目前仅限受邀使用。
- 更正了关于什么经过中转的表述：通话和短信不经过；开启推送时，通知经过中转，内容是封装的，中转和 Apple 仍能看到投递元数据。
  VoIP 推送以过期时间 0 发送，送不到就丢弃而不会延迟送达；不保证一定送达。兼容性承诺改为意向表述，中转限额可能变化。
- 用词：一致性检查、符合本规范的后端；号码和 SIM 卡归属写作"国家或地区"。
- 所有者声明：CellPilot 仅为合法用途而制作；我们遵守法律法规，不认可、不支持、也不协助任何违法活动。发现滥用或任何与法律法规相抵触的内容，
  请立即通过 abuse@cellpilot.dev 告诉我们；我们会配合有关部门并予以整改，必要时变更、限制或关闭相关功能或服务。

### 2026-10-03

- 新增 CellPilot App 和推送中转的隐私政策（`docs/privacy.html`）。

### 2026-10-02

CellPilot 设备 API v1 首次公开发布：规范（英文为准，附中文版）、OpenAPI 3.1 描述、事件流 JSON Schema、中英文后端指南、
一致性检查工具 `api-check`、最小后端 `mock-backend`、本地推送中转 `test-relay`，以及号码规则用例表。
