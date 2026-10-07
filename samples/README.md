# samples/ — 测试与示例素材目录

> 此目录用于存放需要纳入版本控制的测试样例、演示素材等。
> 与 `temp/` 不同，这里的内容**会被 git 跟踪**，请只放体积较小、确有保留价值的样例。

## 目录结构

```
samples/
├── audio/        # 测试音频样例（短片段，用于验证转录功能）
│   ├── README.md
│   └── *.wav / *.mp3 / ...
├── media/        # 测试用媒体文件（如流式诊断页引用的 sample.mp4）
└── README.md     # 本说明文件
```

## 可提交的文件类型

`.gitignore` 对 `samples/` 采用**扩展名白名单**（`!samples/**/*.<ext>`）——只有下列类型会被放行，
其余规则（含 `.env`、`api_keys.json`、`*.pem` 等密钥规则）在本目录**依然生效**。
新增样例类型时，需同时在 `.gitignore` 中补一条白名单规则。

- **音频样例**：`*.wav`、`*.mp3`、`*.mp4`、`*.ogg`、`*.webm`、`*.m4a`、`*.flac`、`*.pcm`
- **模型样例**：`*.onnx`、`*.bin`、`*.gguf`、`*.safetensors`、`*.pb`、`*.tflite` 等小体积模型（用于测试本地推理）

## 使用约定

- 音频样例建议**控制在 1MB 以内**（短片段即可验证功能，避免仓库膨胀）
- 模型样例**必须**是 tiny/mini 版本（如 whisper-tiny ≈ 40MB 起仍偏大，建议只放极小的 demo 模型）
- 命名清晰，如 `zh-sample-10s.wav`、`en-sample-meeting.wav`、`whisper-tiny-test.onnx`
- 如需大体积测试文件，请放在 `temp/`（不入 git）
- 此目录下可按语言/场景进一步分类，如 `samples/audio/zh/`、`samples/models/`

