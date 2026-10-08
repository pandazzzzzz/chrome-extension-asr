# 架构设计 — Speech Recording Chrome 扩展

> 本文档是项目的**目标架构蓝本**，基于对仓库现状的通读与对 GitHub 优质同类项目的调研（2026-09）整理而成。
> 定位：**Manifest V3 · 无构建 · 纯 JS/HTML/CSS**，遵循该约束做**渐进式演进**。
> 本文档描述"应该长成什么样"及"为什么"；具体重构另行按优先级分步计划。
>
> **现状快照**：当前为**录音壳 + 真流式**。麦克风/Tab 录音、offscreen、配置（含加密 API Key）、
> 结果区/填充通路保留；百炼真 WebSocket 流式（run-task 协议）已整合进 main（`5637a77`）。
> 旧的伪流式（VAD 分段增量式）、批量 provider（Qwen/OpenAI/Deepgram）、单次 Transcribe 调度
> 均已主动删除；当前本地不做 VAD，由服务端分句。批量转录属设计取舍，将来要做时重建。

---

## 1. 现状与目标

### 1.1 现状盘点

| 模块 | 现状 | 问题 |
|---|---|---|
| `popup/app.js` + `sidepanel` + `options` | mic/Tab 录音 + **Live Stream 真流式** + 配置表单（Provider 为下拉框，API Key 加密） | — |
| `background/background.js` | 消息路由 + offscreen 协调 + fill-text 转发 | 无 API 代理/转录（已删，设计取舍） |
| `content/content.js` + `.css` | 页面听写注入（`asr:fill-text`），兼容受控组件 | — |
| `content/subtitle.js` | 浮动字幕浮层（`asr:subtitle-show` / `-hide`）：closed Shadow DOM 渲染，可拖动、会话结束自动淡出 | — |
| `audio/` | `recorder.js`（MediaRecorder）+ `convert.js`（Int16/重采样）+ `pcm-capture.js`/`pcm-worklet.js`（PCM 帧采集喂流式） | `vad.js` 已删（服务旧伪流式） |
| `transcription/` | `providers/{base,qwen,index}.js`：百炼真 WebSocket 流式（run-task 协议） | 无批量 transcribe / transcriber 调度（设计取舍） |
| 配置存储 | `chrome.storage.local` 存 `asrConfig`（API Key 经 AES-GCM 加密） | — |
| 构建 / 质量 | 无构建/无 TS；lint 占位；冒烟测试 `tests/p1-smoke-test.js`（已跟踪）；流式单测仅在本地 `temp/test-streaming-integration.js`（gitignored，未持久化） | 依赖脚本加载顺序；无类型契约；流式单测待移入 `tests/` 并挂 `npm test` |
| `manifest.json` | `storage`/`activeTab`/`tabCapture`/`sidePanel`/`offscreen` + **2 个 host_permissions**（dashscope 国内 + 国际） | — |

### 1.2 目标能力

1. **快速转录**（规划）：popup 录音 → 云端 provider API → 文本（批量转录已删，待重建）
2. **本地隐私转录**：transformers.js Whisper 本地推理，音频不出设备（规划）
3. **标签页听写 / 实时转录**：任意输入框语音自动填入；**真 WebSocket 流式已落地**（Qwen run-task）
4. **多提供商统一**：云 + 本地 provider 同接口，能力元数据化（流式?/本地?/默认模型?）（部分落地）

---

## 2. 参考项目（GitHub 调研）

★ 为调研时 star 数（2026-09）。已去重，仅保留有独特借鉴价值的项目：

| 项目 | ★ | 借鉴点 |
|---|---|---|
| `ainoya/chrome-extension-web-transcriptor-ai` | 50 | ⭐ **最接近本项目目标**：TabCapture + offscreen 采集标签页音频 + `whisper-worker.js` 本地推理 + Side Panel，骨架几乎可直接映射 |
| `xenova/whisper-web` | 3.3k | 浏览器内 Whisper 范式：worker 流水线、ONNX 量化、WebGPU、模型缓存（基于 transformers.js） |
| `Ordinath/Whisper_to_ChatGPT` | 77 | popup 录音 → Whisper API → **content script 把转录注入页面输入框** |
| `saharmor/whisper-playground` | 838 | **Silero VAD** 语音活动检测 + 流式分片 |
| `charliegerard/speak-extension` | 86 | **Web Speech API** 免后端的最简范式 |
| `botbahlul/crx-live-translate` | 123 | 网页**流媒体音频实时识别** |
| `tantara/transformers.js-chrome` | 105 | Plasmo + WebGPU 端侧推理的 MV3 扩展、离线可用 |
| `GoogleChrome/chrome-extensions-samples` | 17.8k | 官方 offscreen / tabCapture / recorder 规范范本 |

（WXT、Plasmo 等构建框架仅作为远期备选，见 §5。）

---

## 3. 目标架构图

> ⚠️ **本节是目标蓝图，不全是现状。** 现状见 §1.1 与文档头「现状快照」。
> 图中 **`transcription/providers`（流式）与 `audio` 的 `pcm-capture` / `convert` 已落地**
> （Qwen run-task 真流式，`5637a77`）；但 `transcription/transcriber`（批量调度）、
> `local/`、`model-cache`、`shared/utils` 与 `background` 的「密钥/配置管理」「API 代理」
> 职责**均未落地**（密钥/配置现由 popup/options 页面直接读写，background 只做消息路由）。
> `audio/vad` 已随旧伪流式删除（当前由服务端分句，本地不做 VAD），**不要按图索骥
> `importScripts` 这些尚不存在的文件**。

```
┌──────────────────────────────────────────────────────────────────────┐
│                       MV3 入口点 (Extension Contexts)                  │
│                                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌─────────────┐      │
│  │  popup/   │  │  sidepanel/  │  │  options/ │  │  content/   │      │
│  │ 快速录音   │  │ 实时转录面板   │  │ 全局设置   │  │ 页面听写/浮动  │      │
│  └────┬─────┘  └──────┬───────┘  └─────┬─────┘  └──────┬──────┘      │
│       │               │                │               │             │
│       └────────────── message API ─────┴───────────────┘             │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ chrome.runtime.sendMessage
┌──────────────────────────────▼───────────────────────────────────────┐
│                     background / service worker                       │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │ • 消息路由 (messaging)        • 密钥/配置管理 (storage)          │     │
│  │ • API 代理 (避 CORS/复用 token) • 生命周期 & 权限管理            │     │
│  └───────────────┬──────────────────────────┬─────────────────┘     │
└──────────────────┼──────────────────────────┼───────────────────────┘
                   │                          │
      ┌────────────▼───────────┐   ┌──────────▼──────────────────────┐
      │       audio 音频层       │   │      transcription 转录层        │
      │  recorder    麦克风     │   │  ┌───────────────────────────┐  │
      │  pcm-capture PCM帧采集  │   │  │ providers/ 云提供商         │  │
      │  vad         语音切分   │   │  │  base / qwen / openai /    │  │
      │  convert     PCM→WAV   │   │  │  deepgram / groq / google  │  │
      └────────────┬───────────┘   │  └─────────────┬─────────────┘  │
                   │               │  ┌─────────────▼─────────────┐  │
                   │               │  │ local/ 本地推理            │  │
                   │               │  │ whisper-worker.js         │  │
                   │               │  │ (transformers.js + ONNX)  │  │
                   │               │  └─────────────┬─────────────┘  │
                   │               │  ┌─────────────▼─────────────┐  │
                   │               │  │ transcriber 调度           │  │
                   │               │  │ 批量/流式/重试/错误标准化    │  │
                   │               │  └───────────────────────────┘  │
                   ▼               └──────────────────────────────────┘
          offscreen/ document         （本地推理在独立 Worker 线程）
        tabCapture + MediaRecorder
          转码为 WAV/WebM 分片
                   │
                   ▼
       ┌──────────────────── storage 存储层 ─────────────────────┐
       │ config  (全部存 storage.local, apiKey 经 AES-GCM 加密)  │
       │ history (IDB, 转录历史, 上限 50)  model-cache (P2b)     │
       └─────────────────────────────────────────────────────────┘
```

---

## 4. 按功能划分的模块清单

> 标记：**〔已有〕** 已落地实现；**〔新增〕** 规划中尚未实现；**〔保留〕** 沿用现状；**〔修改〕** 现状需重构。目录均在仓库顶层落地。

```
├── manifest.json            #  〔已有〕permissions + side_panel + options_ui + 2 host_permissions（dashscope cn + intl）
│
# ── 入口层 ──────────────────────────────────────────────
├── popup/                   # 〔保留〕快速录音 + 真流式窗口
│   ├── popup.html / popup.css
│   └── app.js              # 〔已有〕录音 + Live Stream + 配置表单（Provider 为下拉框）
├── sidepanel/               #  〔已有〕长会话面板（复用 popup/app.js + popup.css）
├── options/                 #  〔已有〕全局设置 + 转录历史 + 存储状态
├── content/                 # 〔已有〕页面听写注入（asr:fill-text）+ 浮动字幕（asr:subtitle-*）
│   ├── content.js / content.css
│   └── subtitle.js         # 浮动字幕浮层（closed Shadow DOM，可拖动）
├── offscreen/               #  〔已有〕标签页采集宿主（tabCapture streamId + MediaRecorder）
│   └── offscreen.html / offscreen.js
├── background/
│   └── background.js        # 〔已有〕消息路由 + offscreen 协调 + fill-text 转发
│
# ── 音频层 ──────────────────────────────────────────────
├── audio/
│   ├── recorder.js         #  〔已有〕MediaRecorder 封装（popup 麦克风 + offscreen 标签页共用）
│   ├── convert.js          #  〔已有〕PCM 助手：floatToInt16 / resampleFloat32
│   ├── pcm-capture.js      #  〔已有〕PCM 帧采集（AudioWorklet，回退 ScriptProcessorNode）
│   └── pcm-worklet.js      #  〔已有〕AudioWorklet 处理器
│
# ── 转录层（流式已落地；批量/调度待重建） ───────────────
├── transcription/
│   └── providers/          #  〔已有〕真 WebSocket 流式 provider
│       ├── base.js         #  〔已有〕流式接口 + 能力元数据 + post 助手
│       ├── qwen.js         #  〔已有〕Qwen (DashScope) run-task 流式
│       └── index.js        #  〔已有〕provider 注册表
│   # transcriber.js        #  〔规划〕批量调度（批量/重试/错误标准化，当前不存在）
│
# ── 存储层 ──────────────────────────────────────────────
├── store/
│   ├── config.js           #  〔已有〕配置读写（全部存 storage.local，apiKey 经 WebCrypto 加密）
│   ├── crypto.js           #  〔已有〕WebCrypto AES-GCM 加解密（密钥存 IndexedDB）
│   ├── history.js          #  〔已有〕转录历史（IndexedDB，上限 50 条自动裁剪）
│   └── model-cache.js      #  〔新增〕本地模型缓存（Cache API / IDB）
│
# ── 契约与共享层 ─────────────────────────────────────────
├── messaging/               # 〔已有〕跨上下文消息契约
│   ├── messages.js         #  〔已有〕类型化 action + target 路由（fill-text / subtitle-* / tab-record-*）
│   └── client.js           #  〔已有〕sendMessage 封装（promise + 错误）
├── shared/
│   ├── errors.js           #  〔已有〕统一错误码 + createError / normalizeError
│   └── timeout.js          #  〔已有〕withTimeout 兜底（消息/录音等永不 settle 的 Promise）
│
# ── 诊断与构建辅助 ───────────────────────────────────────
├── debug/
│   └── bridge.js           #  〔已有〕诊断遥测桥（content script 注入，仅本地诊断页生效）
├── scripts/
│   └── pack.js             #  〔已有〕打包 extension.zip（PowerShell ZipFile，node:zlib 回退）
│
├── docs/                    #  〔已有〕架构设计文档（进度/交接笔记见本地 docs/HANDOFF.md，不入库）
│   └── ARCHITECTURE.md     #  架构图 / 模块划分 / 演进路线
├── tests/                   #  〔已有〕浏览器可直接打开的冒烟测试（三种上下文均可运行）
│   ├── p1-smoke-test.html
│   ├── p1-smoke-test.js    #  用例主体（外置：内联 <script> 会被扩展 CSP 拦截）
│   ├── stream-debug.html   #  流式诊断页（配合 tests/serve-debug.js）
│   └── serve-debug.js      #  诊断页本地静态服务器（127.0.0.1 与 [::1] 各一实例）
└── samples/ , temp/        # 〔保留〕样例素材与本地临时文件
```

---

## 5. 演进路线（渐进式，无构建）

按优先级排序，每项可独立作为一个重构计划。

| 优先级 | 事项 | 涉及 | 状态 |
|---|---|---|---|
| P0 | **密钥安全**：全部配置存 `storage.local`，apiKey 经 WebCrypto 加密 | `store/config.js`、`store/crypto.js`、`popup/app.js` | ✅ 已落地 |
| P1 | **background 职责落地**：消息路由 | `background/background.js`、`messaging/` | ✅ 已落地 |
| P1 | **content 职责落地**：页面听写注入 | `content/` | ✅ 已落地 |
| P2 | **转录层清理**：删除伪流式（VAD 分段）、批量 provider、Transcribe 调度 | `transcription/`、`audio/vad`、`popup/` | ✅ 已落地 |
| P2 | **真 WebSocket 流式**：重建 `transcription/` 流式 provider + 音频 PCM 层（Qwen run-task；服务端分句，无本地 VAD） | `transcription/providers/`、`audio/{convert,pcm-capture,pcm-worklet}` | ✅ 已落地（`5637a77`） |
| P2 | **本地推理**：transformers.js Whisper worker | `transcription/local/`、`store/model-cache` | ⏳ 待做（需引入构建/依赖，另确认） |
| P3 | **标签页采集**：tabCapture + offscreen | `offscreen/`、`audio/recorder.js`、`manifest.json` | ✅ 已落地 |
| P4 | **浮动字幕**：活动页浮动字幕浮层（`asr:subtitle-*`，closed Shadow DOM，可拖动） | `content/subtitle.js`、`background/`、`messaging/`、`popup/` | ✅ 已落地 |
| P4 | **UI 扩展**：侧边栏 + 设置页 | `sidepanel/`、`options/` | ✅ 已落地 |
| 远期 | **引入构建工具**：WXT / Plasmo（TS + HMR） | 全局，需一次迁移，另立计划 | ⏳ 待做 |

---

## 6. 设计原则

1. **Worker 分离**：Whisper 推理在 Web Worker，不阻塞 UI（源自 whisper-web、ainoya）
2. **Offscreen 采集**：`tabCapture`/MediaRecorder 无法在 service worker 运行，须放 offscreen document（MV3 限制）
3. **消息契约**：popup/background/content/offscreen 间用类型化消息通信
4. **可插拔 provider**：延续 `BaseProvider` 抽象，流式 provider 补能力元数据与错误契约；本地推理与云端 API 同接口
5. **隐私默认**：本地转录免 API Key、免上传；云端密钥仅存 `storage.local`
6. **渐进演进**：不引入构建工具，保持"Load unpacked 即跑"
