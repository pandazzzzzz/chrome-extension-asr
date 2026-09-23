# 架构设计 — Multi-Provider ASR Chrome 扩展

> 本文档是项目的**目标架构蓝本**，基于对仓库现状的通读与对 GitHub 优质同类项目的调研（2026-09）整理而成。
> 定位：**Manifest V3 · 无构建 · 纯 JS/HTML/CSS**，遵循该约束做**渐进式演进**。
> 本文档描述"应该长成什么样"及"为什么"；具体重构另行按优先级分步计划。

---

## 1. 现状与目标

### 1.1 现状盘点

| 模块 | 现状 | 问题 |
|---|---|---|
| `popup/app.js` + `popup/providers/` | 唯一完整可用的功能；`BaseProvider` 静态类 + qwen/openai/deepgram | 依赖全局 `window.PROVIDERS`；错误处理各自为政；仅"录完再转"，无流式/VAD |
| `background/background.js` | 模板 demo（`getData`/`setData`） | 未承担 API 代理、密钥管理、消息路由 |
| `content/content.js` + `.css` | 模板 demo（改背景色）+ 未使用的 overlay 样式 | 无"页面内听写"能力 |
| 配置存储 | `chrome.storage.sync` 保存 `asrConfig`（含 API Key） | API Key 云同步，有泄露面 |
| 构建 / 质量 | 无构建/无 TS/无测试；lint 占位 | 依赖脚本加载顺序；无类型契约 |
| `manifest.json` | 仅 `storage`/`activeTab` + 三家 host | 缺 `tabCapture`、`offscreen`、`sidePanel` |

### 1.2 目标能力

1. **快速转录**（现有）：popup 录音 → 云端 provider API → 文本
2. **本地隐私转录**：transformers.js Whisper 本地推理，音频不出设备
3. **标签页听写 / 实时转录**：任意输入框语音自动填入；VAD 分片边录边转
4. **多提供商统一**：云 + 本地 provider 同接口，能力元数据化（流式?/本地?/默认模型?）

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
      │  tab-capture 标签页     │   │  │ providers/ 云提供商         │  │
      │  vad         静音检测   │   │  │  base / qwen / openai /    │  │
      │  convert     转码/重采样 │   │  │  deepgram / groq / google  │  │
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
       │ config  (storage.local 密钥 + 偏好分离)  history (IDB)  │
       │ model-cache (Cache API / IDB 本地模型缓存)               │
       └─────────────────────────────────────────────────────────┘
```

---

## 4. 按功能划分的模块清单

> 标记：**〔保留〕**沿用现状；**〔修改〕**现状需重构/补全；**〔新增〕**本次新增。目录均在仓库顶层落地。

```
├── manifest.json            # 〔修改〕补 sidePanel / tabCapture / offscreen 声明
│
# ── 入口层 ──────────────────────────────────────────────
├── popup/                   # 〔保留〕快速录音窗口
│   ├── popup.html / popup.css
│   └── app.js              # 〔修改〕接入 messaging，下沉录音/转录逻辑
├── sidepanel/               # 〔新增·可选〕实时转录/长会话面板
├── options/                 # 〔新增·可选〕全局设置页
├── content/                 # 〔已有〕页面听写注入（监听 asr:fill-text 注入聚焦输入框）
│   └── content.js / content.css
├── offscreen/               #  〔已有〕标签页采集宿主（tabCapture streamId + MediaRecorder）
│   └── offscreen.html / offscreen.js
├── background/
│   └── background.js        # 〔已有〕消息路由 + API 代理 + offscreen 协调
│
# ── 音频层 ──────────────────────────────────────────────
├── audio/
│   ├── recorder.js         #  〔已有〕MediaRecorder 封装（popup 麦克风 + offscreen 标签页共用）
│   ├── tab-capture.js      #  〔并入 background/offscreen〕streamId 获取与消费
│   ├── vad.js              #  〔已有〕能量阈值 VAD（滞回 + 最短语音/静音时长，纯逻辑可测）
│   ├── convert.js          #  〔已有〕Float32 PCM → WAV、分片拼接
│   ├── pcm-capture.js      #  〔已有〕PCM 帧采集（AudioWorklet，回退 ScriptProcessor）
│   └── pcm-worklet.js      #  〔已有〕AudioWorklet 处理器（web_accessible_resources 暴露）
│
# ── 转录层 ──────────────────────────────────────────────
├── transcription/
│   ├── providers/          #  〔已有〕由 popup/providers/ 迁入并扩展
│   │   ├── base.js         #  〔已有〕BaseProvider：补能力元数据（isLocal/supportsStreaming）
│   │   ├── qwen.js / openai.js / deepgram.js   # 现有实现迁移
│   │   ├── groq.js / google.js                 # 按 .env 预留补齐（可选）
│   │   └── index.js        #  〔已有〕注册表 + getProviderById 查询
│   ├── local/
│   │   ├── whisper-worker.js   # Web Worker：transformers.js 本地推理
│   │   └── whisper.js         # worker 调用端封装（进度/错误/生命周期）
│   └── transcriber.js      #  〔已有〕统一调度：校验 + 调用 + 结果归一（能力感知）
│
# ── 存储层 ──────────────────────────────────────────────
├── store/
│   ├── config.js           #  〔已有〕配置读写（全部存 storage.local，apiKey 经 WebCrypto 加密）
│   ├── crypto.js           #  〔已有〕WebCrypto AES-GCM 加解密（密钥存 IndexedDB）
│   ├── history.js          #  〔新增〕转录历史（IndexedDB）
│   └── model-cache.js      #  〔新增〕本地模型缓存（Cache API / IDB）
│
# ── 契约与共享层 ─────────────────────────────────────────
├── messaging/               # 〔已有〕跨上下文消息契约
│   ├── messages.js         #  〔已有〕类型化 action + target 路由（transcribe / fill-text / tab-record-*）
│   └── client.js           #  〔已有〕sendMessage 封装（promise + 错误）
├── shared/
│   ├── errors.js           #  〔已有〕统一错误码 + createError / normalizeError
│   └── utils.js            #  〔新增〕blob↔base64、格式化、时间戳
│
└── samples/ , temp/        # 〔保留〕样例素材与本地临时文件
```

---

## 5. 演进路线（渐进式，无构建）

按优先级排序，每项可独立作为一个重构计划。

| 优先级 | 事项 | 涉及 | 状态 |
|---|---|---|---|
| P0 | **密钥安全**：全部配置存 `storage.local`，apiKey 经 WebCrypto 加密 | `store/config.js`、`store/crypto.js`、`popup/app.js` | ✅ 已落地 |
| P1 | **background 职责落地**：消息路由 + API 代理 | `background/background.js`、`messaging/` | ✅ 已落地 |
| P1 | **content 职责落地**：页面听写注入 | `content/` | ✅ 已落地 |
| P2 | **转录层下沉与统一**：provider 迁移 + 调度层 + 错误标准化 | `transcription/` | ✅ 已落地 |
| P2 | **本地推理**：transformers.js Whisper worker | `transcription/local/`、`store/model-cache` | ⏳ 待做（需引入构建/依赖，另确认） |
| P3 | **标签页采集**：tabCapture + offscreen | `offscreen/`、`audio/`、`manifest.json` | ✅ 已落地 |
| P3 | **实时流式 + VAD**：边录边转（VAD 分段增量式；真 WebSocket 流式见 supportsStreaming 预留） | `audio/vad`、`audio/pcm-capture`、`popup/` | ✅ 已落地 |
| P4 | **UI 扩展**：侧边栏 + 设置页 | `sidepanel/`、`options/` | ⏳ 待做 |
| 远期 | **引入构建工具**：WXT / Plasmo（TS + HMR） | 全局，需一次迁移，另立计划 | ⏳ 待做 |

---

## 6. 设计原则

1. **Worker 分离**：Whisper 推理在 Web Worker，不阻塞 UI（源自 whisper-web、ainoya）
2. **Offscreen 采集**：`tabCapture`/MediaRecorder 无法在 service worker 运行，须放 offscreen document（MV3 限制）
3. **消息契约**：popup/background/content/offscreen 间用类型化消息通信
4. **可插拔 provider**：延续 `BaseProvider` 抽象，补能力元数据与错误契约；本地推理与云端 API 同接口
5. **隐私默认**：本地转录免 API Key、免上传；云端密钥仅存 `storage.local`
6. **渐进演进**：不引入构建工具，保持"Load unpacked 即跑"
