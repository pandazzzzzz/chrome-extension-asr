# 真机端到端验证清单 — Live Stream 与录音壳

> 目标：补上项目**唯一未被任何自动化覆盖**的链路 —— Live Stream 的真实 WebSocket 流式
> （真 API Key + 真浏览器，自动化无法模拟工具栏手势与音频）。同时回归录音壳三路。
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
| Model | 下拉框，预置五个有免费额度的 run-task 模型（选项来自 provider 的 `modelOptions`）：`qwen-audio-3.1-asr-flash-streaming`（**默认**）、`qwen-audio-3.1-asr-flash-message`、`qwen-audio-3.0-asr-flash-streaming`、`paraformer-realtime-v2`、`paraformer-realtime-8k-v2`，末项 `Custom…` 会展开一个手填框（老配置里的非预置模型自动归到 Custom 并保留原文）。**下拉不是白名单本身**：白名单仍以 `streamModels` 为准（含 `fun-asr-realtime`、`fun-asr-flash-8k-realtime` 等未预置项，可带日期后缀，选 Custom 手填即可）。其余模型名——包括 `qwen3-asr-flash-realtime` 这类走 `/api-ws/v1/realtime` 会话制协议的——会被回落为默认模型。**采样率随模型走**：8k 电话模型（`fun-asr-flash-8k-realtime`、`paraformer-realtime-8k-v2`）以 8000 Hz 采集并在 run-task 声明 `sample_rate:8000`，其余为 16000 Hz |
| Region | 默认 `Beijing (华北2)` → 自动用 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`。切到 `Singapore (新加坡)` → 自动用 `wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference`。选 `Custom` 才出现 Endpoint 文本框（业务空间专属域名 `wss://{WorkspaceId}.{region}.maas.aliyuncs.com/api-ws/v1/inference` 等）。**Custom 留空是硬错误**（点 Live Stream 直接报 `Custom region requires an endpoint URL.`，不开麦、不连接），**不再**静默回落北京。**Region 必须与 API Key 的地域一致**，否则握手 401 |
| 诊断页（可选） | `node tests/serve-debug.js` → 开 `http://localhost:18923/tests/stream-debug.html`，可看实时遥测事件。服务器**只托管诊断页、脱敏脚本与样例视频**（`.env.local`、`.git/`、`docs/`、`temp/`，以及 `tests/` 下的手测计划/导出日志在 HTTP 上不可读），并**拒绝非回环 `Host` 头**——所以你放在仓库里的测试 Key 不会被这个页面或任何本机网页取走 |

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
| 1.8 | 停止后看 options 页 | 历史**新增一条**，内容与结果一致，provider/model 正确 | 无记录 = offscreen `finalizeSession` 的 `asr:history-add` 未送达 background |
| 1.9 | 下拉选 `paraformer-realtime-8k-v2`（或 Custom 手填 `fun-asr-flash-8k-realtime`）→ 点 **Live Stream** → 说一句 → 停止 | 正常出 `task-started`，partial/final 照常刷新；诊断页 `run-task-sent` 的 `sampleRate` = **8000**，`ws-connecting` 的 `targetSampleRate` = **8000** | 服务端回 `task-failed` = 声明速率与采集速率不一致（元数据回退），或该 Key 地域无此模型 |
| 1.10 | 选 `Custom` → **清空** Endpoint → 点 **Live Stream** | 状态 `Custom region requires an endpoint URL.`，**麦克风不亮**、无 `ws-connecting` 事件、按钮仍是 `Live Stream` 可点 | 拨到 `dashscope.aliyuncs.com` = 守卫失效（静默回落北京，本 PR 修的就是它） |

**已知失败模式（对照排查）**：

- 状态显示 `API key required for streaming.` → Key 未填或未保存
- 状态显示 `No provider selected.` → provider 下拉框为空
- 状态显示 `Custom region requires an endpoint URL.` → 选了 `Custom` 但端点框为空。守卫在**开麦之前**，因此麦克风红点不会出现、也不会建立 WebSocket；补一个 `wss://…` URL 再点即可
- 10 秒后报 `Timed out waiting for task-started (check model / API key)` → Key 无效，或模型不在 run-task 白名单
- 诊断页出现 `model-fallback`（`requested` = 你填的模型名，`using` = 默认流式模型）→ 你填了批量模型或会话制模型（如 `qwen3-asr-flash-realtime`），offscreen 已自动兜底为默认流式模型（**这是正确行为**，非 bug）
- 选 8k 电话模型（`fun-asr-flash-8k-realtime` / `paraformer-realtime-8k-v2`）后服务端立刻回 `task-failed` → 检查 run-task 报文 `payload.parameters.sample_rate` 是否为 **8000**（诊断页 `run-task-sent` 事件的 `sampleRate` 字段直接给出该值；若为 16000 说明采样率元数据回退了）

---

## 2. 麦克风录音回归

| # | 操作 | 预期 |
|---|---|---|
| 2.1 | 点 **Start Recording** | 变 `Stop Recording`，状态 `Recording... speak now.`，**另两个录音按钮禁用** |
| 2.2 | 说 3 秒 → 点 **Stop Recording** | 状态 `Recording complete.`，按钮复原，三路重新可用 |
| 2.3 | 点 **Save audio** | 下载文件成功。**注意**：下拉框写 `mp4`，但落盘扩展名是 **`.m4a`**（`extensionForMime()` 把 `audio/mp4` 映射为 `m4a`）。`wav` 并非所有 Chrome 都支持：不支持时状态栏会提示实际回退格式，文件扩展名也跟随实际格式，而不是继续写 `.wav` |
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
| 3.7 | **关键**：录音中**关掉 popup 再打开**（点页面/切窗口都算） | 按钮仍为 `Stop Tab Rec`、三路互斥仍在，**能正常停止** —— 录音状态由 background 持有（§5.3），popup 重开会对账恢复 |
| 3.8 | 录音中，从 sidepanel 点 **Record Tab** | 按钮切为 `Stop Tab Rec`（对齐到真实录音中），**不报错**且能停止 |

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
| 4b.5 | 流式过程中切到另一个标签页 | 浮层留在**原标签页**（字幕绑定点击 Live Stream 时的 tab，不跟随切 tab，也不会在新页面再开一份） | 新页面出现浮层 = 字幕未绑定起始 tab |
| 4b.6 | 关闭 **Subtitles** 开关 | 浮层立即隐藏；开关状态**持久化**（重开 popup 仍为关闭） | 状态不保留 = `asrConfig.subtitles` 未读写 |
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
| 5.6a | 历史库异常时打开 options / 点 Clear history | 显示 `Cannot read history: …` / `Clear history failed: …`，**不**把读取失败说成 `No history yet.`，也不谎报清空成功 |
| 5.6b | options 页点 **Export JSON**（历史非空时） | 下载 `asr-history-<时间戳>.json`；内容为 `{exportedAt, count, entries[]}`，`entries` 按时间降序、`text` 完整（含中文与长文本） |
| 5.6c | 历史为空时点 **Export JSON** | 提示 `Nothing to export.`，**不产生文件** |
| 5.7 | 在 `chrome.storage.local` 检查密钥 | **不应出现明文 Key**（DevTools → Application → Storage）；且 `asr-crypto` IndexedDB 中密钥 `extractable === false` |
| 5.8 | 把系统/浏览器切到深色（`chrome://settings` → Appearance → Dark）后打开 popup / 侧栏 / options | 三处**全部**变深色：页面底、输入框、按钮、状态条；`<select>` 下拉菜单也是深色（靠 `color-scheme: dark`）。**无任何区域仍是白底** |
| 5.9 | 深色下检查对比度 | 正文与按钮文字清晰可读（自动化实测：正文 15.4:1、主按钮白字 5.2:1） |
| 5.10 | 设置页 Region 选 `Custom`、清空 Endpoint → 点 **Save** | 提示 `Custom region requires an endpoint URL.`，且 `chrome.storage.local` 里 `asrConfig.endpoint` **保持上一次的值**（被拒绝的 save 不落盘、不覆盖）。填一个 `wss://…` 后再 Save → `Settings saved.` |
| 5.11 | 流式过程中直接关闭 popup（不点 Stop） | 流**不断**（会话宿主在 offscreen）；重开 options：历史在停止后出现；开着 Subtitles 时原页面浮层持续更新 | 断流 = 会话宿主仍留在 popup（回归 #51）；历史缺失 = `asr:history-add` 未生效 |

---

## 6. 失败时怎么取证

诊断页（`node tests/serve-debug.js`）会实时显示扩展遥测事件，面板顶部可按事件名过滤
（输入 `ws-` / `record-` / `tab-` 只看一条路径）。事件名来自 `popup/app.js` 与
`offscreen/offscreen-streaming.js` 的 `debugEvt()`、以及 provider 的 `track()`；
下表按**功能路径**分组列出排查时真正用得上的。

**① Live Stream / WebSocket（流式主路径）**

| 现象 | 关键事件 | 含义 |
|---|---|---|
| 点 Live Stream 无反应 | `start-blocked` | busy/已流式，被重入护栏拦下 |
| 同上 | `start-fail` + `reason` | `no-provider` / `no-streaming-support` / `no-api-key` / `no-endpoint`（Custom 留空，开麦前即返回） |
| 连不上 | `ws-open` → `ws-error`（provider） / `ws-ready-fail` | WebSocket 握手失败（查 Key / endpoint / 网络）。`run-task-sent` 带 `sampleRate`，可核对是否等于模型要求的速率 |
| 卡在等待 | `ws-ready-fail` / `ready-timeout` | 10s 内未收到 `task-started` |
| 模型被换 | `model-fallback` | 填了批量模型，已自动兜底 |
| 采样率不符 | `run-task-sent` + `sampleRate` | 该值 = run-task 实际声明的 `sample_rate`（8k 电话模型应为 `8000`，其余 `16000`） |
| 服务端拒绝任务 | `task-failed` | 报文里带 `error_message`，多为模型名/地域与 Key 不匹配 |
| 停止异常 | `stop-sent` → `stop-done`（provider）/ `ws-error` | `stop-done` 带 `winner`：`timeout` = 服务端 5s 未确认（teardown 仍会完成） |
| 结果丢失 | `ws-end-stale` | 旧会话残留的 `onEnd` 被正确忽略（**正常**，对照 payload 的 `streamSeq` 分拣新旧会话） |
| 提前结束 | `session-end`（provider） | 启动期服务端就断开；`message:null` + `closeRequested:true` = 主动关闭（正常） |
| 静音时断连 | `heartbeat`（有）/ 无该事件（无） | 持续静音应周期性出 `heartbeat`；完全没有 = 心跳包未生效 |
| 会话已在跑 | `streaming-active-offscreen` | task-started + 采集就绪后由 offscreen 打点；出现即整条链路健康 |

**② 麦克风录音 / 输入设备（清单 §2、§2b）**

| 现象 | 关键事件 | 含义 |
|---|---|---|
| 开始录音失败 | `record-error` + `where: 'start'` | `getUserMedia` 被拒 / 设备不可用（看 `message`） |
| 录音没声音/时长异常 | `record-stopped` + `size`/`mime` | `size` 为 0 = 采到空数据 |
| 选的设备没生效 | `mic-open` + `deviceId` | `default` = 未指定设备；填了设备却显示 `default` = 该设备已拔出，走了回退 |
| 设备消失 | `audio-input-fallback` + `reason` | `selected-device-gone`（枚举不到）/ `device-unavailable`（打开失败）——均为**预期回退**，非 bug |
| 保存音频 | `audio-saved` + `size`/`mime` | 有该事件但用户没看到下载 = 浏览器下载被拦 |

**③ 标签页录音（清单 §3）**

| 现象 | 关键事件 | 含义 |
|---|---|---|
| 启动失败 | `tab-record-error` + `where: 'start'` | `tabCapture` 无授权 / offscreen 不可达 |
| 重开 popup 后按钮态错 | `tab-record-restored` | popup 从 background 对齐到「正在录音」——有它说明状态同步生效 |
| 停止后没拿到音频 | `tab-record-stopped` + `size`/`mime` | `size: 0` = offscreen 返回空 Blob |

**③b. 三路互斥与 offscreen 生命周期（background 仲裁层）**

| 现象 | 关键事件 | 含义 |
|---|---|---|
| 某一路点不动 | `mutex-rejected` + `want`/`held` | background 拒绝并发：`want`=想开的那路，`held`=正在跑的那路。**被拒是正常仲裁**，不是故障 |
| offscreen 文档反复重建 | `offscreen-create` → `offscreen-created` | 每次 start 都出现 = 文档未被复用（查为何上一轮没回收）；复用路径只有 `offscreen-created` 前无 `offscreen-create` |
| 文档残留/不回收 | `offscreen-closed` | 收尾时应出现；缺失 = `closeDocument` 未被调用（对照 #68 的场景） |
| 会话代际混乱 | `stream-token-claimed` / `tab-record-token-claimed` + `generation` | 每次成功 start 自增一代；对照 `stream-stop-relay`/`stream-ended-received` 的 `token` 可判断迟到的收尾是否属于当前代（#72 的观测点） |
| Stop 无响应 | `stream-stop-relay` → `stream-ended-received` 顺序 | stop 在 ended 之后被处理 = #72 描述的响应被吞；两者交错出现即复现 |

**④ 配置与存储（清单 §5）**

| 现象 | 关键事件 | 含义 |
|---|---|---|
| 打开 popup 就异常 | `popup-ready` + `provider`/`model`/`hasKey`/`hasEndpoint` | 配置载入后的初始快照；`hasKey:false` = Key 没读回来 |
| 保存了什么 | `config-saved` + `provider`/`model`/`endpoint`/`audioType`/`subtitles`/`audioInput`/`hasKey` | 只记 `hasKey` 布尔，**不记 Key 本身**；`endpoint` 记原值（看得出是不是 `https://` 批量残留） |
| Provider 被换 | `stale-provider-fallback` + `saved`/`fallback` | 存的 provider 在当前注册表里没有（已删除/未加载），回落到默认 |
| 老配置地域判定 | `legacy-endpoint-kept` + `endpoint` | 老配置没有 `region` 但存了显式 endpoint → 归为 `custom` 保留原值（不猜地域） |
| 历史没记上 | `history-error`（offscreen） | offscreen → background 的 `asr:history-add` 失败 = background 写 IndexedDB 出错；连 `stream-finalized` 都没有 = 会话收尾路径未执行 |
| 会话是否正常收尾 | `stream-finalized`（用户停止）/ `stream-pagehide-like-end`（远端终止）/ `stream-stopped-offscreen` + `reason` | 停止后应出现其一；两者皆无 = `endSession` 未执行 |

**⑤ 结果动作与字幕（清单 §4、§4b）**

| 现象 | 关键事件 | 含义 |
|---|---|---|
| 字幕没出现 | （无专有打点；转发失败被 offscreen 静默吞掉） | 先确认页面有 content script（`chrome://` 等页面本就无浮层）；再查 `SUBTITLE_SHOW` 是否发出 |
| 注入没生效 | `fill-ok` / `fill-error` + `code` | `fill-error` 带 `NO_FIELD` = 活动元素不是可编辑字段（看诊断面板「活动元素」） |
| 复制失败 | `copy-ok` / `copy-error` | `copy-error` 多为页面未获焦（clipboard 需焦点） |

> 事件名/字段若与代码不符（新增打点或改名），以 `popup/app.js`、`offscreen/offscreen-streaming.js`、
> `background/background.js` 的 `debugEvt(...)` 调用点与 `transcription/providers/qwen.js` 的 `track(...)` 为准。
> 事件统一带 `{src}` 来源标记（`ui` / `offscreen` / `background` / provider 事件经 offscreen 转发）；
> offscreen 会话事件带 `streamSeq`，可分拣新旧会话交错的日志。

诊断页底部有**导出日志 (.txt)** 按钮，导出含「扩展遥测」与「fill-text 注入」两段，便于附到 issue。
长跑时事件列表有 **2000 条上限**（超出丢最早的，导出同样截断并在段头标注）——取证请尽早导出。

---

## 6b. 键盘快捷键

> ⚠️ **必须用真实键盘**：自动化（puppeteer keyboard / CDP `Input.dispatchKeyEvent`）
> **到不了浏览器级 accelerator** —— 已用对照实验确认（`Ctrl+T` 新建标签同样无效）。
> 本仓库用 headed Chrome + PowerShell `SendKeys` 才能测（`temp/verify/probe-cmd-keys.js`）。

| # | 操作 | 预期 |
|---|---|---|
| 6b.1 | 按 `Ctrl+Shift+Y`（mac `Cmd+Shift+Y`） | popup 打开（与点工具栏图标等价） |
| 6b.2 | 按 `Ctrl+Shift+U`（mac `Cmd+Shift+U`） | **side panel 打开**。若报 `` `sidePanel.open()` may only be called in response to a user gesture `` → handler 里在 `open()` 前多了一个 `await`（`background.js` 的 onCommand 注释有此约束） |
| 6b.3 | `chrome://extensions/shortcuts` 里给 **Open the ASR options page** 设一个键，再按 | options 页打开 |
| 6b.4 | 6b.1 之后立刻点 **Record Tab** | 正常开始录音（快捷键算一次「扩展调用」，tab 级授权成立） |
| 6b.5 | 在 `chrome://extensions/shortcuts` 查看三条命令 | 前两条有默认键，第三条（options）为空 —— 属预期，用户自设 |

---

## 6c. 性能基线（可复现，无需 API Key）

不需要真机 Key：用 stub WebSocket 隔离插件自身开销（`temp/perf/`，gitignored）。

```sh
cd temp/perf && node run.js all      # A 首字延迟 / B 30s 内存 / C offscreen 生命周期
```

| # | 检查 | 预期（2026-10-11 基线） |
|---|---|---|
| 6c.1 | A：`frameSize` 是否为 **256** | 帧间隔 p50 ≈ 19–20ms、max ≤ 25ms；「点击 → 首帧送达」≈ 80ms |
| 6c.2 | A：帧长若被改回 1024 | 首帧累积变 64ms（总延迟 +41ms）、帧间隔 max 涨到 ~71ms —— 属**回退** |
| 6c.3 | B：30s 流式后**页面元素数**（不是 CDP nodes） | 与 3s 时**相同**（不涨 = 无 DOM 泄漏）；堆停止后回落 |
| 6c.4 | C：8 轮 offscreen create/close | 每轮 15–20ms，**无逐轮变慢**；结束后残留文档数 = 0 |
| 6c.5 | C：`createDocument` 冷启动 | ≈ 30–65ms（只首次录音付一次） |

> ⚠️ **判断 DOM 泄漏别用 CDP 的 `Memory.getDOMCounters().nodes`** —— 它会随 `textarea.value`
> 赋值次数持续增长（30s 涨 ~1000），与流式无关；对照实验见 `temp/perf/dom-control.js`。
> 看页面侧 `document.getElementsByTagName('*').length`。

---

## 7. 通过标准

本次验证视为通过需同时满足：

- [ ] **1.x 全部通过**（Live Stream 真机出 partial/final，且停止后历史有记录）
- [ ] 2.x / **2b.x** / 3.x / 4.x / **4b.x** 无回归
- [ ] 5.x / **5.6b / 5.6c / 5.8 / 5.9** 无回归（导出、深色）
- [ ] **6b.x 通过**（快捷键；须真实键盘，见上）
- [ ] **6c.x 通过**（性能基线；可自动化复跑，帧长未被改回 1024）
- [ ] 无「标签页被静音」「麦克风红点常驻」「fill 静默失败」三类历史 bug 复现

## 8. 完成后

1. 在本文档顶部记录本轮验证结论：附**日期 + Chrome 版本 + 模型名**
2. 更新 GitHub Issue #1：`Performance optimization` 之外，若 Live Stream 通过则说明核心链路已闭环
3. 若发现新 bug：按（现象 / 根因 / 修复）格式记录到新 issue，并考虑补一条自动化测试

---

## 附：本清单未覆盖的（属正常范围）

- **WebSocket 协议细节**（run-task 握手、`task-started`/`task-finished` 时序）—— 已由
  `tests/streaming.test.js` 覆盖契约层，网络层只能真机验
- **Record Tab 的自动化** —— ✅ **已可自动化**（2026-10-11）：`page.triggerExtensionAction()`
  等价于真实工具栏点击（`--allowlisted-extension-id` 只是对照手段，非必需）。
  仅「标签页声音不被静音」这一**听感**断言仍需人工听一次
- **长时间流式稳定性**（>10 分钟）—— 建议单独做一次长跑，观察内存与连接保持
