# Changelog

The API is versioned by its base path (`/v1`). Within a version it only grows: entries add fields,
events, features or clarifications. An entry marked **Changed rule** tightens what a backend should
do; the app keeps working with a backend that follows the earlier text, and the entry says what to
change. Tools are versioned with the repository.

[中文说明见下方](#中文)

## 2026-10-04

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

### 2026-10-04

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

### 2026-10-03

- 新增 CellPilot App 和推送中转的隐私政策（`docs/privacy.html`）。

### 2026-10-02

CellPilot 设备 API v1 首次公开发布：规范（英文为准，附中文版）、OpenAPI 3.1 描述、事件流 JSON Schema、中英文后端指南、
合规检查工具 `api-check`、最小后端 `mock-backend`、本地推送中转 `test-relay`，以及号码规则用例表。
