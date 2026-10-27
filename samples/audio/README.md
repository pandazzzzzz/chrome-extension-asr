# 测试音频样例

存放用于验证 ASR 功能的音频片段。此目录会被 git 跟踪，请只放短小、有保留价值的样例。

**当前为空**（只有本说明文件）。现有测试都不需要音频 fixture：

- Live Stream 的真机验证用真人说话，或假麦（`--use-fake-device-for-media-stream` 出的是音调，
  只够验协议通路，识别文本无意义）；
- `tests/stream-debug.html` 的 Record Tab 素材由用户在本页选择本地音视频文件，
  不再随仓库提交固定样例；
- 临时/大体积音频请放 `temp/audio/`（已 gitignore）。

约定（真要加样例时）：
- 单个文件建议 < 1MB
- 大文件请放 `temp/audio/`
- 命名格式：`<语言>-<场景>-<时长>.<ext>`，如 `zh-meeting-10s.wav`
- 扩展名必须在 `.gitignore` 的白名单里（`*.wav`/`*.mp3`/…/`*.pcm` 等，见该文件
  "samples/ 白名单"一段）；新增类型需同步补一条 `!samples/**/*.<ext>`，否则不会被跟踪
