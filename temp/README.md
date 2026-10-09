# temp/ — 临时与本地文件目录

> ⚠️ 此目录下的**内容**不会被 git 跟踪（`.gitignore` 的 `temp/**` 规则）。
> 仅保留目录结构与说明文件：`README.md` 与各子目录的 `.gitkeep` 是例外，会被跟踪。
> 这里存放开发过程中产生的临时文件、本地模型缓存、测试脚本等，不进入版本控制。

## 目录结构

```
temp/
├── models/       # 本地 AI 模型文件（如 Whisper ONNX / WASM 模型）
├── cache/        # 各类运行时缓存（如 transformers.js 缓存、音频缓存）
├── audio/        # 临时录制的音频文件、测试音频样本
├── scripts/      # 本地调试用的一次性脚本、测试代码片段
├── notes/        # 开发笔记、调研记录、临时 markdown 文档
│   # 说明：本地 e2e/探针脚本散落在 temp/ 根（如 subtitle-e2e.js / audio-input-e2e.js / run-smoke.js），
│   # 它们依赖 temp/verify/chrome-win64 的 Chrome for Testing，不入库、CI 不跑。
└── README.md     # 本说明文件
```

各子目录以 `.gitkeep` 占位（目录结构入库，内容不入库）。此外目录下可随时出现
未跟踪的临时产物（如 `temp/verify/` 的 Chrome-for-Testing 与自动化 profile），
它们同样被 `temp/**` 覆盖，无需登记。

## 使用约定

- **不要**在这里存放需要共享的正式代码或配置
- **不要**在这里提交任何 API Key、密钥或敏感信息
- 调试脚本用完即弃，如确有保留价值应迁移到正式的 `scripts/`（或 `tests/`）目录
- 模型文件较大（通常几十MB~几GB），始终放在这里或使用 huggingface 缓存，不要放入项目源码目录
