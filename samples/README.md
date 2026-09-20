# samples/ — 测试与示例素材目录

> 此目录用于存放需要纳入版本控制的测试样例、演示素材等。
> 与 `temp/` 不同，这里的内容**会被 git 跟踪**，请只放体积较小、确有保留价值的样例。

## 目录结构

```
samples/
├── audio/        # 测试音频样例（短片段，用于验证转录功能）
│   ├── *.wav
│   ├── *.mp3
│   └── ...
└── README.md     # 本说明文件
```

## 可提交的文件类型

`samples/` 下的文件不受 `.gitignore` 中 `*.wav`、`*.onnx`、`*.bin`、`*.pb` 等全局规则约束，可提交以下样例：

- **音频样例**：`*.wav`、`*.mp3`、`*.ogg`、`*.webm`、`*.m4a`、`*.flac`、`*.pcm`
- **模型样例**：`*.onnx`、`*.bin`、`*.gguf`、`*.safetensors`、`*.pb` 等小体积模型（用于测试本地推理）

## 使用约定

- 音频样例建议**控制在 1MB 以内**（短片段即可验证功能，避免仓库膨胀）
- 模型样例**必须**是 tiny/mini 版本（如 whisper-tiny ≈ 40MB 起仍偏大，建议只放极小的 demo 模型）
- 命名清晰，如 `zh-sample-10s.wav`、`en-sample-meeting.wav`、`whisper-tiny-test.onnx`
- 如需大体积测试文件，请放在 `temp/`（不入 git）
- 此目录下可按语言/场景进一步分类，如 `samples/audio/zh/`、`samples/models/`

