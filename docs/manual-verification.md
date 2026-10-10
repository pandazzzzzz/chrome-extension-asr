# 真机端到端验证清单 — Live Stream 与录音壳

> 目标：补上项目**唯一未被任何自动化覆盖**的链路 —— Live Stream 的真实 WebSocket 流式
> （`docs/HANDOFF.md` §3 记为「从未在浏览器跑通过」）。同时回归录音壳三路。
>
> 全部步骤为**人工操作**：需要真 API Key、麦克风权限、以及一次工具栏图标点击
> （`tabCapture` 要求「用户调用扩展」标记，自动化无法模拟）。

## 0. 准备

| 项 | 要求 |
|---|---|
| 扩展 | `chrome://extensions` → 开发者模式 → **Load unpacked** → 选本仓库根目录 |
| 改动后 | 每次改代码须点扩展卡片的**刷新**按钮（MV3 不热重载） |
| API Key | 百炼有效 Key。**Key 与地域必须匹配**（华北2 用北京 Key，新加坡用新加坡 Key，跨地域混用会握手 401） |
| Provider | `Qwen (DashScope)` |
| Model | `fun-asr-realtime`（默认）。**只接受 run-task 白名单模型**：`fun-asr-realtime`、`fun-asr-flash-8k-realtime`、`qwen-audio-3.{0,1}-asr-flash-streaming`、`qwen-audio-3.1-asr-flash-message`、`paraformer-realtime-{v2,8k-v2}`（可带日期后缀）。其余模型名——包括 `qwen3-asr-flash-realtime` 这类走 `/api-ws/v1/realtime` 会话制协议的——会被回落为默认模型 |
| Region | 默认 `Beijing (华北2)` → 自动用 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`。切到 `Singapore (新加坡)` → 自动用 `wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference`。选 `Custom` 才出现 Endpoint 文本框（业务空间专属域名 `wss://{WorkspaceId}.{region}.maas.aliyuncs.com/api-ws/v1/inference` 等）。**Region 必须与 API Key 的地域一致**，否则握手 401 |
| 诊断页（可选） | `node tests/serve-debug.js` → 开 `http://localhost:18923/tests/stream-debug.html`，可看实时遥测事件 |

**开始前记录基线**：popup 初始文案应为 `Start Recording` / `Record Tab` / `Save audio` /
`Live Stream` / `Copy text` / `Fill into page` / `Subtitles` / `Options` / `Side panel`，
且 **Copy/Fill 为禁用**（`syncResultButtons()` 在结果为空时禁用）、**Subtitles 为关闭态**
（`subtitlesEnabled=false`，非高亮）。

---

## 1. Live Stream 真机端到端 ★ 最高优先级

这是本次验证的**核心目标**。WebSocket 链路此前零覆盖。

| # | 操作 | 预期 | 失败含义 |
|---|---|---|---|
| 1.1 | 填 API Key → 点 **Live Stream** | 按钮变 `Stop Stream`，状态显示 `Streaming: speak, results will appear as you go.`，浏览器弹出麦克风授权 | 无反应 = `startStreaming` 早退（见 1.7） |
| 1.2 | 对着麦克风说一句完整中文，停顿 | 结果区**边改边刷新**（partial 覆盖当前句），停顿后**定稿**（final 追加、partial 清空）。注：结果区是单一 `<textarea>`，partial 与 final **无视觉区分**，只能靠"是否还在变"判断 | 只有 partial 不定稿 = 服务端未发 `sentence_end` |
| 1.3 | 再说 2–3 句 | final 逐句累加，顺序正确，无重复无丢句 | 丢开头首句 = `await wsSession.ready` 之前就开始采音（§7 决策 #4） |
| 1.4 | 持续静音 10 秒以上 | 连接**不断**（`heartbeat: true` 保活） | 断连 = 心跳包未生效或被误当作结果 |
| 1.5 | 说英文 | 出英文文本（**不应**被当中文） | 出中文 = `language_hints` 被硬编码成 `['zh']`（§7 决策 #6） |
| 1.6 | 点 **Stop Stream** | 按钮回 `Live Stream`，状态 `Streaming stopped.`，**未定稿的 partial 被并入结果**（`flushPartial()` 兜底） | 最后半句丢失 = flushPartial 未执行 |
| 1.7 | **重入测试**：快速双击 **Live Stream** | 只开一条流；日志无两条 `start-begin` | 两条流 = busy 护栏失效（§7 决策 #8） |
| 1.8 | 停止后看 options 页 | 历史**新增一条**，内容与结果一致，provider/model 正确 | 无记录 = `saveToHistory` 未触发 |

**已知失败模式（对照排查）**：

- 状态显示 `API key required for streaming.` → Key 未填或未保存
- 状态显示 `No provider selected.` → provider 下拉框为空
- 10 秒后报 `Timed out waiting for task-started (check model / API key)` → Key 无效，或模型是批量模型
- 状态显示 `Using realtime model fun-asr-realtime (batch model not valid for streaming).` → 你填了批量模型，代码已自动兜底（**这是正确行为**，非 bug）

---

## 2. 麦克风录音回归

| # | 操作 | 预期 |
|---|---|---|
| 2.1 | 点 **Start Recording** | 变 `Stop Recording`，状态 `Recording... speak now.`，**另两个录音按钮禁用** |
| 2.2 | 说 3 秒 → 点 **Stop Recording** | 状态 `Recording complete.`，按钮复原，三路重新可用 |
| 2.3 | 点 **Save audio** | 下载文件成功。**注意**：下拉框写 `mp4`，但落盘扩展名是 **`.m4a`**（`extensionForMime()` 把 `audio/mp4` 映射为 `m4a`）。选 `webm`/`wav` 则与下拉一致 |
| 2.4 | **重入**：双击 **Start Recording** | 只开一条流；**关键**：结束后麦克风占用指示（标签页红点）必须消失 |
| 2.5 | 验证音轨不泄漏 | 停止录音后，`chrome://settings/content/microphone` 或标签页图标应显示无占用 |

> 2.3 的 `mp4`→`.m4a` 是**已知的标签/实现不一致**（下拉文案 vs 实际扩展名），非本次验证目标，但记录在此以免被误判为 bug。

> 2.4/2.5 对应历史真机 bug #4（录音失败时裸 stream 无人停轨 → 麦克风红点常驻）。

---

## 2b. 音频输入选择

| # | 操作 | 预期 | 失败含义 |
|---|---|---|---|
| 2b.1 | 首次安装后打开 popup（从未授权麦克风） | **Microphone** 下拉框可见，只有 `System default` 一项或设备名为 `Microphone N` 占位 | 下拉框整行不可见 = `enumerateDevices` 返回 0 条 audioinput（无麦克风/`mediaDevices` 不可用），属预期隐藏 |
| 2b.2 | 点 **Start Recording** 授权后再看下拉框 | 出现**真实设备名**（如 `麦克风阵列 (Realtek)`） | 仍是 `Microphone N` = 授权后未刷新（`refreshAudioInputs` 未触发） |
| 2b.3 | 选一个非默认设备 → 录音 | 状态 `Recording... speak now.`；录完能从 `Save audio` 的文件听到**该设备**的声音（多设备时用不同音源对比） | 声音来自默认设备 = 约束未带 `deviceId.exact` |
| 2b.4 | 选设备 → 重开 popup | 下拉框**回填**上次选择 | 回填丢失 = `asrConfig.audioInput` 未持久化/未回读 |
| 2b.5 | 选设备 → 跑一次 **Live Stream** | 同样用所选设备（partial/final 正常出字） | 流式仍走默认 = `startStreaming` 未接入 `acquireMicrophone()` |
| 2b.6 | **失效回退**：选一个设备后把它拔掉/禁用 → 再录音 | 状态提示 `Selected microphone is unavailable — using system default.`，录音**照常开始**（用默认设备），下拉框回到 `System default` | 报 `Cannot start recording: ...` = 回退逻辑失效 |
| 2b.7 | 热插拔：录音空闲时插入/拔出 USB 麦克风 | 下拉框自动重建且**保留当前选择**（若该设备仍在） | 列表不更新 = `devicechange` 监听未生效 |
| 2b.8 | sidepanel 打开 | 同样有 **Microphone** 下拉框，选择与 popup 共享 | 侧栏无此控件 = 复用 `popup/app.js` 的 `#audioInput` 缺失 |

---

## 3. 标签页录音回归

> ⚠️ **必须**从**扩展工具栏图标**打开 popup。`tabCapture.getMediaStreamId` 要求
> 「用户调用扩展」标记，用 `chrome-extension://…/popup.html` 直接开页**会失败**（`TAB_CAPTURE` 错误）。

| # | 操作 | 预期 |
|---|---|---|
| 3.1 | 开一个**有声音**的标签页（用诊断页的 `sampleVideo` 最省事），点工具栏图标开 popup | popup 正常 |
| 3.2 | 点 **Record Tab** | 变 `Stop Tab Rec`，状态 `Recording tab audio... play something in the tab.` |
| 3.3 | **关键**：播放标签页音频 | **标签页声音仍然可听**（捕获必须回放，否则被静音 —— §7 决策 #3） |
| 3.4 | 点 **Stop Tab Rec** | 状态 `Tab recording complete.`，返回录音（超时放宽到 20s） |
| 3.5 | 点 **Save audio** | 下载的文件**能播放且含标签页音频** |
| 3.6 | 非扩展页面上点 **Record Tab** | 报 `TAB_CAPTURE` 类错误，按钮复原（不卡在录音态） |

---

## 4. 结果操作（Copy / Fill）

| # | 操作 | 预期 |
|---|---|---|
| 4.1 | 结果为空时看 **Copy text** / **Fill into page** | **均为禁用** |
| 4.2 | 有结果时点 **Copy text** | 状态 `Copied to clipboard.`，粘贴内容与结果一致 |
| 4.3 | 在诊断页的 `#in1`（单行输入）聚焦 → 点 **Fill into page** | 状态 `Filled into page input.`，文本出现在输入框 |
| 4.4 | 在 `#ta1`（多行）重复 | 同上 |
| 4.5 | 在 `#ce1`（contenteditable）重复 | 同上（走 `execCommand('insertText')` 分支） |
| 4.6 | 在**无聚焦输入框**的页面点 **Fill into page** | 报错 `Fill failed: No focused input field`（`NO_FIELD`），**不**静默失败 |
| 4.7 | 验证受控组件兼容 | 在 React/Vue 受控输入框填充后，组件状态应同步（原生 setter + `input`/`change` 事件） |

> 4.6 对应历史真机 bug #3（fill-text 错误被吞）。另注：若页面响应慢，`MessageClient` 10s 超时后提示的是
> `Fill timed out — check the page before retrying (it may already be filled).` —— 这是**刻意**区别于失败，
> 因为填充不可取消，慢页面上可能已落地（重试会插入两遍）。

---

## 4b. 浮动字幕（Floating subtitles）

| # | 操作 | 预期 | 失败含义 |
|---|---|---|---|
| 4b.1 | 开一个普通 http(s) 页面（如诊断页）→ 点 **Subtitles** | 按钮变 **Subtitles on**（高亮）；诊断页左下角出现半透明字幕浮层 | 无浮层 = content script 未注入（`chrome://` 页不支持）或 background 转发失败 |
| 4b.2 | 开着 Subtitles 跑一次 **Live Stream** | 说话时浮层文本**随 partial 实时刷新**，停顿定稿后仍在 | 只更新结果区不见浮层 = `renderStreamText` 未镜像 |
| 4b.3 | 点击 **Stop Stream** | 浮层保留约 2s 后**自动淡出**（`done=true` 超时） | 不消失 = 自动超时未生效 |
| 4b.4 | 拖动浮层 | 浮层跟随指针移动，松手后停在原处；位置限制在视口内 | 拖不动 = pointer 事件/host 定位问题 |
| 4b.5 | 流式过程中切到另一个标签页 | 浮层留在**原标签页**（消息只在发送瞬间转发，不跟随切 tab） | — |
| 4b.6 | 关闭 **Subtitles** 开关 | 当前活动页浮层立即隐藏；开关状态**持久化**（重开 popup 仍为关闭） | 状态不保留 = `asrConfig.subtitles` 未读写 |
| 4b.7 | 在 `chrome://` 页面开 Subtitles 跑流式 | 结果区照常工作，浮层不出现且**不报错**（旁路输出失败被静默） | 主流程被字幕失败打断 = pushSubtitle 未吞错 |
---

## 5. Side panel 与 Options

| # | 操作 | 预期 |
|---|---|---|
| 5.1 | popup 点 **Side panel** | 侧栏打开，popup 收起 |
| 5.2 | 在侧栏跑一次 Live Stream | 功能与 popup 一致（复用 `popup/app.js`）；状态在面板存活期间保持 |
| 5.3 | popup 点 **Options** | 打开设置页 |
| 5.4 | options 页看存储状态 | API Key 显示 `configured (encrypted at rest)` |
| 5.5 | options 页看历史列表 | 列出最近 **20** 条流式结果，条目可读 |
| 5.6 | options 页点清空历史 | 列表清空 |
| 5.7 | 在 `chrome.storage.local` 检查密钥 | **不应出现明文 Key**（DevTools → Application → Storage）；且 `asr-crypto` IndexedDB 中密钥 `extractable === false` |

---

## 6. 失败时怎么取证

诊断页（`node tests/serve-debug.js`）会实时显示扩展遥测事件。出问题时按事件名定位：

| 现象 | 关键事件 | 含义 |
|---|---|---|
| 点 Live Stream 无反应 | `start-blocked` | busy/已流式，被重入护栏拦下 |
| 同上 | `start-fail` + `reason` | `no-provider` / `no-streaming-support` / `no-api-key` |
| 连不上 | `ws-connecting` → `ws-error` | WebSocket 握手失败（查 Key / endpoint / 网络） |
| 卡在等待 | `ws-ready-fail` / `ready-timeout` | 10s 内未收到 `task-started` |
| 模型被换 | `model-fallback` | 填了批量模型，已自动兜底 |
| 停止异常 | `stop-ws-error` | 关闭时 WebSocket 报错（teardown 仍应完成） |
| 结果丢失 | `ws-end-stale` | 旧会话残留的 `onEnd` 被正确忽略（**正常**） |
| 提前结束 | `ws-ended-before-active` / `ws-ended-before-capture` | 启动期服务端就断开 |
| 字幕没出现 | `subtitle-error` + `code` | 浮层消息转发失败（`NO_CONTENT`=页面无 content script，如 `chrome://`） |

诊断页底部有**导出日志 (.txt)** 按钮，便于附到 issue。

---

## 7. 通过标准

本次验证视为通过需同时满足：

- [ ] **1.x 全部通过**（Live Stream 真机出 partial/final，且停止后历史有记录）
- [ ] 2.x / **2b.x** / 3.x / 4.x / **4b.x** 无回归
- [ ] 5.x 无回归
- [ ] 无「标签页被静音」「麦克风红点常驻」「fill 静默失败」三类历史 bug 复现

## 8. 完成后

1. 更新 `docs/HANDOFF.md` §3：把「Live Stream 真机端到端」从未验证移到已验证，附**日期 + Chrome 版本 + 模型名**
2. 更新 GitHub Issue #1：`Performance optimization` 之外，若 Live Stream 通过则说明核心链路已闭环
3. 若发现新 bug：按 `docs/HANDOFF.md` §6 的格式记录（现象 / 根因 / 修复），并考虑补一条自动化测试

---

## 附：本清单未覆盖的（属正常范围）

- **WebSocket 协议细节**（run-task 握手、`task-started`/`task-finished` 时序）—— 已由
  `tests/streaming.test.js` 覆盖契约层，网络层只能真机验
- **Record Tab 的自动化** —— `tabCapture` 的「用户调用扩展」标记是浏览器硬约束，
  自动化无法模拟，只能人工
- **长时间流式稳定性**（>10 分钟）—— 建议单独做一次长跑，观察内存与连接保持
