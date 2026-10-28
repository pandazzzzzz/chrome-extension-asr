# 完整手测验收文档（Manual Acceptance Test Plan）

> 本文档是**全功能面**的人工验收规程：每个用例给出步骤、预期、判定与取证方法，
> 照做即可完成一轮完整验收并留档。`docs/manual-verification.md` 是聚焦 Live Stream
> 的简版清单，本文是它的超集（编号映射见 §2 各表最后一列）。
>
> - 适用版本：`main` ≥ `094255b`（PR #20 之后；含 PR #18 的端点守卫与 8k 采样率修复）
> - 编写日期：2026-10-17
> - 本文档中标 🖐 的用例**只能人工执行**；标 🤖 的已有自动化覆盖，人工验收时可跳过
>   （除非要求全量重跑），标 🖐/🤖 混合的表示结构可自动、体验必须人判。

---

## 1. 测试环境要求

| 项 | 要求 | 备注 |
|---|---|---|
| 浏览器 | Chrome 稳定版最新（验收记录里写实际版本号） | 自动化 harness 用 Chrome for Testing 154，手测请用正式 Chrome |
| 扩展安装 | `chrome://extensions` → 开发者模式 → **Load unpacked** → 选仓库根目录 | 每次改代码后须点扩展卡片的**刷新**（MV3 无热重载） |
| 操作系统 | Windows / macOS 任一；快捷键用例按平台跑 | macOS 用 `Cmd+Shift+*` 变体 |
| 麦克风 | 至少 1 个可用输入设备；**设备类用例（TC-D）建议准备 2 个**（如内置 + USB） | 热插拔用例需要真拔插 |
| 扬声器 | 可听到标签页外放声音 | TC-H3 的听感判定依赖它 |
| API Key | 百炼有效 Key，**与地域匹配**（北京 Key ↔ Beijing 地域；新加坡 Key ↔ Singapore） | Key 与地域错配的表现是握手 401，不是代码 bug |
| 模型额度 | 验收前在百炼控制台确认所选模型**有免费额度**。本账号已知：`fun-asr-realtime` 2026-10-10 已耗尽；`paraformer-realtime-8k-v2` 36K 秒/月（每月 1 日重置） | 计费单位是**秒**（7.28s 音频 ≈ 扣 7）。控制单次通话时长，静音别超 30s |
| 诊断页（强烈建议开着） | `node tests/serve-debug.js` → 打开 `http://localhost:18923/tests/stream-debug.html` | 实时显示扩展遥测事件；页面自带 `#in1/#ta1/#ce1/#sampleVideo` |
| 深色模式用例 | 系统主题或 `chrome://settings` → Appearance → Dark | TC-L8 |
| 隐私 | **全程不要把 API Key、含 `?api_key=` 的 URL 写进任何截图 / issue / 导出的日志文件** | 本扩展把 Key 拼进 WebSocket 查询串（浏览器限制），诊断日志导出前检查 |

## 2. 测试用例

结果列填 **PASS / FAIL / N/A**；FAIL 时按 §4 分诊表取证并把 debug 事件名写进备注。

### TC-A 安装与首启

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| A1 | 全新加载扩展，打开 popup | 无报错；工具栏图标正常；popup 尺寸/文案完整 | 🖐 |
| A2 | popup 基线文案 | 按钮为 `Start Recording` / `Record Tab` / `Save audio` / `Live Stream` / `Copy text` / `Fill into page` / `Subtitles` / `Options` / `Side panel`；**Copy/Fill 禁用**（无结果）；**Subtitles 为关闭态**（不高亮）；Result 占位文案说明录音只产出音频；Model 预填默认流式模型 | 🖐/🤖（§manual-verification 0 节；按钮禁用逻辑与占位文案有 Node 断言） |
| A3 | 老配置升级：装有旧版本（配置在 `storage.sync`）时更新到本版 | 配置迁移到 `storage.local`、明文 Key 变密文、`storage.sync` 里 `asrConfig` 消失 | 🤖（`tests/config.test.js` 迁移用例 + batch 探针） |
| A4 | 重载扩展后再开 popup | 配置保留、无 console 错误 | 🖐 |

### TC-B 麦克风录音

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| B1 | 点 **Start Recording** | 变 `Stop Recording`，状态 `Recording... speak now.`，**另两个录音按钮禁用** | 🤖（`probe-saveaudio.js`） |
| B2 | 说 3 秒 → **Stop Recording** | 状态 `Recording complete — audio only. Use Save audio, or Live Stream for transcription.`，三按钮复原 | 🤖（同上） |
| B3 | 点 **Save audio**（默认 webm） | 下载 `recording-<ISO时间戳>.webm`，状态 `Saved recording (NN KB).` | 🤖（同上） |
| B4 | 格式选 `mp4` 再存 | 落盘扩展名是 **`.m4a`**（已知文案差异，非 bug）；文件能播 | 🖐（听感） |
| B5 | 格式选 `wav` 再存 | 落盘 `.wav`；能播且是录音内容 | 🖐（听感） |
| B6 | **双击 Start Recording** | 只开一条流；停止后**麦克风占用指示（标签页红点/系统指示灯）消失** | 🖐（红点只能人看；防重入逻辑在 `isRecordingBusy` 护栏） |
| B7 | 录音中途拔麦克风 | 有错误提示且按钮回落到可点状态，**不卡录音态、红点不常驻** | 🖐 |

### TC-C Live Stream 核心（真语音）

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| C1 | 填 Key → 点 **Live Stream** | 按钮 `Stop Stream`，状态 `Streaming: speak, results will appear as you go.`，弹麦克风授权（首次） | 🖐/🤖（协议层 Node 24 例覆盖；UI 反馈人工） |
| C2 | 说一句完整中文，停顿 | 结果区**边说边刷新**（partial 覆盖当前句），停顿后**定稿追加**、partial 清空。注：partial/final 无视觉区分，靠「是否还在变」判断 | 🖐（**必须真语音**，假麦是音调，识别文本无意义） |
| C3 | 连续说 2–3 句 | final 逐句累加、顺序正确、**不丢首句**、不重复 | 🖐 |
| C4 | 持续静音 ≥10 秒 | 连接不断（心跳保活），之后说话仍能出字 | 🖐 |
| C5 | 说一句英文 | 出英文文本，**不被识别成中文** | 🖐 |
| C6 | 正在说半句时点 **Stop Stream** | 状态 `Streaming stopped.`、按钮回 `Live Stream`，**未定稿的半句被并入结果**（flushPartial 兜底） | 🖐 |
| C7 | **快速双击 Live Stream** | 只开一条流（诊断页无第二条 `start-begin`；无两个 WS） | 🤖（`probe-ui-guards.js` G1） |
| C8 | 停止后打开 options 页 | 历史**新增一条**，文本与结果一致、provider/model 正确 | 🖐 |
| C9 | 什么都不填直接点 Live Stream（Key 为空） | 状态 `API key required for streaming.`，不开麦不连接 | 🤖 |

### TC-D 音频输入选择

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| D1 | 首次安装、从未授权时打开 popup | **Microphone** 下拉框可见；只有 `System default` 或 `Microphone N` 占位名 | 🖐（无权限时枚举不到 label 是平台行为） |
| D2 | 授权录音后再看 | 出现**真实设备名**（如 `麦克风阵列 (Realtek)`） | 🖐/🤖（枚举逻辑有单测；真 label 人工） |
| D3 | 选非默认设备（如 USB 麦）→ 对它说话 → 录音保存 | 回放听到的**是那台设备**的声音（多设备时用不同音源对比最直观） | 🖐 |
| D4 | 选设备 → 关闭再重开 popup | 下拉框**回填**上次选择；`storage.local → asrConfig.audioInput` 为其 deviceId | 🤖（`audio-input-e2e.js`） |
| D5 | 选设备后跑一次 **Live Stream** | 出字正常，用的是所选设备（对着它说话才出字，另一台静音） | 🖐 |
| D6 | 选中设备后**拔掉它** → 再点录音 | 状态 `Selected microphone is unavailable — using system default.`，录音**照常开始**（默认设备），下拉框回到 `System default` | 🤖（失效回退用假 id 已验）+ 🖐（真拔插） |
| D7 | 空闲时热插拔 USB 麦克风 | 下拉框自动重建且**保留当前选择**（若设备仍在） | 🖐（`devicechange` 真事件） |
| D8 | sidepanel 打开 | 同样有 Microphone 下拉框，**与 popup 共享**同一存储值 | 🖐/🤖（共享靠同一 `asrConfig`，代码同源） |

### TC-E 地域 / 端点 / 模型守卫（PR #18 验收点）

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| E1 | Region=Beijing 跑流式 | WS 连 `dashscope.aliyuncs.com`（诊断页 `ws-connecting` 可见目标；**导出日志前删掉 URL 里的 Key**） | 🤖 |
| E2 | Region=Singapore + 新加坡 Key | 连 `dashscope-intl…`；**用北京 Key 时握手失败** —— 报 `Stream error`/`Cannot start streaming` 类网络错误属预期（Key 地域不符） | 🖐（有国际 Key 才跑，否则 N/A） |
| E3 | Region=Custom + 合法 `wss://` URL | 实际拨所填 URL | 🤖（`probe-8k-custom.js` C2） |
| E4 | **Region=Custom + Endpoint 留空 → 点 Live Stream** | 状态 `Custom region requires an endpoint URL.`；**麦克风不亮**、无 `ws-connecting` 事件、按钮仍是 `Live Stream` 可点；**绝不连北京** | 🤖（C1/C1b/C8） |
| E5 | **options 页** Region=Custom + 清空 Endpoint → 点 **Save** | 提示 `Custom region requires an endpoint URL.`；storage 里 `endpoint` **保持上一次的值**（被拒的 save 不落盘）。再填 `wss://…` → `Settings saved.` | 🤖（C9a–d） |
| E6 | Model 填会话制模型名（如 `qwen3-asr-flash-realtime`）→ 点 Live Stream | 状态提示回落：`Using fun-asr-realtime — "…" is not a run-task model.`，然后**照常出字**（白名单兜底是正确行为） | 🤖（Node 白名单例） |
| E7 | 8k 模型：Model=`paraformer-realtime-8k-v2` → 说一句 | 正常出 partial/final；诊断页 `run-task-sent` 的 `sampleRate` = **8000**、`ws-connecting` 的 `targetSampleRate` = **8000** | 🖐（服务端接受已于 2026-10-16 真 Key 验过；**真语音文字质量**需人耳） |
| E8 | 8k 模型快照名：`fun-asr-flash-8k-realtime-2026-01-28` | 同上（前缀匹配 8000） | 🤖（C5） |
| E9 | 16k 模型回归：`fun-asr-realtime` 或 `paraformer-realtime-v2` | `sampleRate=16000`、出字正常（注意前者本账号额度状态，选有额度的跑） | 🖐/🤖 |

### TC-F 标签页录音（Record Tab）

> ⚠️ 必须**从工具栏图标**（或 `Ctrl+Shift+Y`）打开 popup 再点 Record Tab —— `tabCapture`
> 要求「用户调用扩展」标记。

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| F1 | 诊断页让 `#sampleVideo` 出声 → 工具栏开 popup → 点 **Record Tab** | 变 `Stop Tab Rec`，状态 `Recording tab audio... play something in the tab.` | 🤖（`probe-fix-regression.js`，`triggerExtensionAction` 等价工具栏点击） |
| F2 | **★ 播放期间听扬声器** | **标签页声音仍然可听**——捕获不得静音页面（历史 bug，决策 #3） | 🖐 **只能人耳** |
| F3 | 点 **Stop Tab Rec** → **Save audio** | 状态 `Tab recording complete — audio only. Use Save audio, or Live Stream for transcription.`；下载文件**能播放且含标签页音频** | 🖐（听回放） |
| F4 | 录音中**关掉 popup 再重开** | 按钮仍 `Stop Tab Rec`、三按钮互斥仍在、**能正常停止**（状态由 background 持有） | 🤖 |
| F5 | 在不可捕获页面（`chrome://` 等）点 Record Tab | 报 `TAB_CAPTURE` 类错误，按钮**复原**、不卡录音态 | 🤖（结构）+ 🖐（文案观感） |
| F6 | sidepanel 里点 Record Tab 开始/停止，再切回 popup | 两边按钮态**对齐真实录音状态**、互不报错 | 🤖（`probe-already-recording.js`）+ 🖐 真实面板 |

### TC-G 结果操作（Copy / Fill）

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| G1 | 结果为空 | **Copy text / Fill into page 均禁用** | 🤖（`probe-ui-guards.js` G2a） |
| G2 | 有结果点 **Copy text** → 到别处粘贴 | 状态 `Copied to clipboard.`；粘贴内容与结果**逐字一致** | 🤖（状态文案）+ 🖐（真粘贴比对） |
| G3 | 诊断页 `#in1`（单行）聚焦 → **Fill into page** | 状态 `Filled into page input.`，文本进输入框 | 🤖（`batch1.js` fill 三路） |
| G4 | `#ta1`（多行）、`#ce1`（contenteditable）重复 | 同上（ce 走 `execCommand('insertText')` 分支） | 🤖 |
| G5 | 无任何聚焦输入框的页面点 Fill | 状态 `Fill failed: No focused input field`（`NO_FIELD`），**不静默失败**（历史 bug #3） | 🤖 |
| G6 | 在真实 React/Vue 受控输入框 Fill | 页面组件状态同步（表单按钮变可用等） | 🖐 |
| G7 | 页面卡死/极慢时点 Fill | 10s 后提示 `Fill timed out — check the page before retrying (it may already be filled).` —— **刻意**不谎报失败（填充可能已落地） | 🖐 |

### TC-H 浮动字幕

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| H1 | 普通 http(s) 页面 → 点 **Subtitles** | 按钮 `Subtitles on`（高亮）；状态提示 `Subtitles will appear when Live Stream is running.`；空闲时不创建空浮层 | 🤖（Node 空闲态文案断言） |
| H2 | 开着 Subtitles 跑 **Live Stream**（真语音） | 浮层文本**随 partial 实时刷新**，定稿后仍在 | 🖐（真语音链路） |
| H3 | 点 **Stop Stream** | 浮层保留约 2s 后**自动淡出** | 🤖（done=true 淡出已验） |
| H4 | 拖动浮层 | 跟随指针、松手停在原处、**位置钳制在视口内** | 🖐（手感） |
| H5 | 流式过程中切到另一个标签页 | 浮层留在**原标签页**（不跟随切换，属设计） | 🖐 |
| H6 | 关闭 Subtitles → 重开 popup | 状态提示 `Subtitles are off for future Live Streams.`；开关状态**持久化** | 🤖 |
| H7 | 在 `chrome://` 页面开着 Subtitles 跑流式 | 结果区照常；**无浮层且不报错**（旁路失败被吞是刻意） | 🤖（结构）+ 🖐 |

### TC-I 键盘快捷键（须真实键盘；CDP 按键到不了浏览器 accelerator）

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| I1 | 按 `Ctrl+Shift+Y`（mac `Cmd+Shift+Y`） | popup 打开（等价工具栏图标） | 🤖 2026-10-16 OS 级 SendKeys 验过（`probe-cmd-keys.js`），手测复确认 |
| I2 | 按 `Ctrl+Shift+U` | **side panel 打开**。若代码回归，报错会是 ``sidePanel.open() may only be called in response to a user gesture``（handler 里 `open()` 前多了 await —— 决策：必须同步调用） | 🤖 同上 |
| I3 | 快捷键开 popup 后**立刻点 Record Tab** | 正常开始录音（键盘 accelerator 也算「用户调用扩展」，tab 级授权成立） | 🖐 |
| I4 | `chrome://extensions/shortcuts` 给 **Open the ASR options page** 设一个键 | 按下即打开 options 页 | 🖐（handler 机制已用临时 suggested_key 自动验过；**用户自设路径**要人工） |
| I5 | shortcuts 页看三条命令 | popup/side panel 有默认键；**options 无默认键属预期**（`Ctrl+Shift+O` 与浏览器书签管理器冲突会被 Chrome 静默丢弃，故留空由用户自设） | 🖐 |

### TC-J options 页与历史

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| J1 | popup → **Options** | 设置页打开，字段回填当前配置 | 🤖 |
| J2 | 存储状态区 | API Key 显示 `configured (encrypted at rest)`；crypto key `present (non-extractable)` | 🤖 |
| J3 | 改 provider/Key/Region/Model → Save | `Settings saved.`；重开 popup 反映新值 | 🤖 |
| J4 | **★ issue #19 回归**：popup 选非默认麦克风 + 格式设 `wav` + 开 Subtitles → 去 options 只改 Model → Save → 重开 popup | **三项偏好全部存活**，且 popup 的 **Audio format 控件显示 `wav`**（回填 bug 已修）；options 页自己的格式控件改动**也会被保存** | 🤖（`tests/config.test.js` 6 例 + `probe-issue19.js` 5/5）——手测复跑一次即可 |
| J5 | 跑几条流式后看历史列表 | 最新在前；**列表渲染最多 20 条**（上限 50 条裁剪） | 🤖（种子历史）+ 🖐（真实条目可读性） |
| J6 | 点 **Clear history** | 列表清空、计数 0 | 🖐 |
| J7 | **Export JSON**（有历史） | 下载 `asr-history-<时间戳>.json`；内容 `{exportedAt,count,entries[]}`、降序、中文/长文本无损 | 🤖（`probe-export.js`）|
| J8 | 历史为空时 Export | 提示 `Nothing to export.` 且**不产生文件** | 🤖 |
| J9 | 系统切深色后逐页看 popup/侧栏/options | **全部**变深色（底/输入框/按钮/状态条/`<select>` 弹层）；**无任何区域残留白底** | 🤖（计算样式+对比度）+ 🖐（视觉扫一遍） |
| J10 | 深色下读文字 | 正文/按钮清晰（自动化实测对比度：正文 ≈15.4:1、主按钮白字 ≈5.2:1，均 ≥4.5） | 🤖 |

### TC-K Side panel

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| K1 | popup 点 **Side panel** | 侧栏打开、popup 收起 | 🤖（target 出现）+ 🖐 真实窗口 |
| K2 | 侧栏里跑完整 Live Stream（真语音） | 与 popup 行为完全一致（同一 `app.js`）；**面板存活期间状态保持**（关 popup 不丢） | 🖐 |
| K3 | 侧栏开着再开 popup，两边交替操作 | 互不串状态；配置共享（一边改另一边重开可见） | 🖐 |
| K4 | 关闭侧栏后重开 | 结果区清空与否符合设计（无持久化承诺）；无报错 | 🖐 |

### TC-L 性能基线（无需 Key，可自动复跑）

| # | 检查 | 预期 | 覆盖 |
|---|---|---|---|
| L1 | `node temp/perf/run.js A` | `frameSize=256`；点击→首帧 ≈80ms；帧间隔 p50 ≈19–20ms、max ≤25ms（8k 模型下 256 样本 = 32ms/帧属预期） | 🤖 |
| L2 | `run.js B`（30s 合成流） | **页面元素数** 3/15/30s 不涨（勿用 CDP nodes 判断，见清单注）；停止后堆回落 | 🤖 |
| L3 | `run.js C` | offscreen 冷启 ≈30–65ms；8 轮 create/close 无逐轮变慢（2026-10-16 实测 18–23ms 轻微波动）；残留文档数 0 | 🤖 |
| L4 | 真人长会话手感 | 边说边打字延迟无明显卡顿；停止响应 <1s | 🖐 |
| L5 | 长跑 >10 分钟 | 连接不断、内存不疯涨、无越拖越卡 | 🖐（清单标注项） |

### TC-M 隐私与安全审计

| # | 步骤 | 预期 | 覆盖 |
|---|---|---|---|
| M1 | popup DevTools → Application → `chrome.storage.local` → `asrConfig.apiKey` | **密文**（base64 样），肉眼不可读 | 🤖（Node 例 + smoke） |
| M2 | IndexedDB `asr-crypto` 里的 AES Key | `extractable === false` | 🤖（smoke 用例） |
| M3 | 抓包 / 看 network | 音频只流向所选地域的 dashscope 域名；**除诊断页本地导出外无任何数据上行**（telemetry 只存本地内存） | 🖐 |
| M4 | 导出日志 / 截图 / issue 附件 | **不含** `api_key=` 明文（本扩展 Key 在 WS URL query 里 —— 一切外部产物先自查） | 🖐 |
| M5 | 历史导出 JSON | 只落在本地下载目录，无网络请求伴随 | 🖐 |

## 3. 通过标准

一轮验收视为**通过**，须同时满足：

- [ ] TC-C（Live Stream 真语音）**全部 PASS** —— 唯一无法用自动化代替的核心链路
- [ ] TC-D / TC-F / TC-G / TC-H / TC-K 无 FAIL（N/A 须注明原因，如缺第二台麦 / 无国际 Key）
- [ ] **F2（标签页不静音）PASS** —— 历史 bug 回归位
- [ ] J4（issue #19 回归）PASS
- [ ] E4 / E5（Custom 空端点双守卫）PASS —— PR #18 回归位
- [ ] I1–I5 快捷键 PASS（须真实键盘）
- [ ] M 组无「明文 Key 外泄」发现
- [ ] 无「标签页被静音 / 麦克风红点常驻 / fill 静默失败」三类历史 bug 复现（§manual-verification 7 对齐）

## 4. FAIL 分诊表（按诊断页 debug 事件定位）

| 现象 | 关键事件 / 状态文案 | 大概率根因 |
|---|---|---|
| 点 Live Stream 无反应 | `start-blocked` | busy 护栏拦截（正常，再点一次） |
| 同上 | `start-fail: no-provider / no-api-key / no-endpoint` | 对应配置项为空；`no-endpoint` = E4 守卫生效 |
| 连不上 | `ws-connecting` → `ws-error` | Key 与地域不匹配（401）/ URL 拼错 / 网络 |
| 卡在等待 10s 超时 | `ready-timeout`，`Timed out waiting for task-started (check model / API key)` | Key 无效或模型不在白名单 |
| 模型被换 | `model-fallback` + 状态 `Using fun-asr-realtime — …` | 填了非白名单名（**正常兜底**，见 E6） |
| 8k 模型 task-failed | `run-task-sent.sampleRate` ≠ 8000 | 采样率元数据回退（应不可能，若现 = 回归，提 issue）|
| 丢首句 | — | `await ready` 前采音被丢（历史决策 #4，回归位） |
| 只有 partial 不定稿 | — | 服务端未发 `sentence_end`（网络/服务端侧） |
| 最后一句丢失 | — | `flushPartial()` 未跑（回归位） |
| 字幕没出现 | `subtitle-error: NO_CONTENT` | 目标页不可按需注入或无 `activeTab` 授权（`chrome://` 属预期） |
| 快捷键侧栏报 gesture 错 | SW console | `sidePanel.open()` 前被插了 await（决策 #2，回归位） |
| 录音失败后红点常驻 | — | 音轨泄漏（历史 bug #4，回归位） |

## 5. 验收记录模板

```
版本: main = <git rev-parse --short HEAD>（应 ≥ 094255b）
Chrome: <chrome://version 首行>
OS: <Windows 10 19045 / macOS xx>
测试人:
日期: 开始 ____-__-__ 结束 ____-__-__
Key 地域: Beijing / Singapore / Custom
所用模型: <默认名 / 8k 名>   额度起点: <控制台截图>

结果矩阵: TC-A __ B __ C __ D __ E __ F __ G __ H __ I __ J __ K __ L __ M __
FAIL 明细:
  - [编号] 现象 | 复现步骤 | debug 事件 | 初步定位
N/A 明细与原因:
  - [编号] 原因（无设备 / 无额度 / …）
结论: 通过 / 不通过（回归 issue: #__）
```

## 6. 与自动化清单的映射（哪些人工项可被机器复核）

| 人工用例 | 对应本地脚本（gitignored，`temp/`，需 CfT harness） | 最近一次全绿 |
|---|---|---|
| C7 / G1 / G2 / K1 | `temp/verify/probe-ui-guards.js` | 2026-10-16 |
| E3–E8 / J3 | `temp/verify/probe-8k-custom.js` | 2026-10-16 |
| B1–B3 | `temp/verify/probe-saveaudio.js` | 2026-10-16 |
| D4–D6（假设备） | `temp/audio-input-e2e.js` | 2026-10-16 |
| F1 / F4 | `temp/verify/probe-fix-regression.js`、`probe-no-activetab.js` | 2026-10-16 |
| H1–H3 / H6 | `temp/subtitle-e2e.js` | 2026-10-16 |
| J4（merge 语义） | `tests/config.test.js`（**入库进 CI**）+ `temp/verify/probe-issue19.js` | 2026-10-17 |
| I1–I2 | `temp/verify/probe-cmd-keys.js`（OS SendKeys；焦点核验失败会拒发不污染其它窗口） | 2026-10-16 |
| L1–L3 | `temp/perf/run.js all` | 2026-10-16 |
| 协议层（TC-C 骨架） | `npm test`（CI 每次跑） | 2026-10-17 |

> `temp/` 脚本不入 CI、不随 clone 分发；本轮手测**以人工判定为准**，上表仅供失败时交叉验证。
> 8k 服务端真连验收（协议级）已于 2026-10-16 用真 Key 通过，见 `docs/HANDOFF.md` §3.0；
> 本文档 E7 要验的是**真语音识别质量**，仍需人耳。

## 7. 执行顺序建议（约 60–75 分钟）

1. §1 环境准备 + 开诊断页（10 min）
2. TC-A → TC-B（10 min）
3. **TC-C（真语音核心，20 min）** —— 过不了后面都别跑，先分诊
4. TC-E（守卫 + 8k，10 min）
5. TC-F → TC-G → TC-H（15 min）
6. TC-I 快捷键 + TC-J options（10 min）
7. TC-D 设备用例（有第二台麦再做，10 min）
8. TC-K / TC-M（5 min）
9. TC-L4/L5 长会话（可选，另开时段）
10. 填 §5 记录，FAIL 按 §4 分诊后提 issue
