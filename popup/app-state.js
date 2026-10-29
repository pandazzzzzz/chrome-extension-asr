/**
 * Shared popup/side-panel state, DOM references, diagnostics, and status output.
 */

// State
let recorder = null;          // AudioRecorder 实例（麦克风）
let audioBlob = null;         // 录音结果（由 Save audio 落盘）
let audioRecording = null;    // 标签页录音的 OPFS 引用 { file, mime, size }
let isRecording = false;      // 麦克风录音中
let isTabRecording = false;   // 标签页录音中（经 background → offscreen）
let isRecordingBusy = false;  // 麦克风 start/stop 进行中（含 await），防重入
let isTabRecordingBusy = false; // 标签页 start/stop 进行中（含 await），防重入
let isStreaming = false;      // 真流式转录中（UI 镜像；真相在 background + offscreen）
let isStreamingBusy = false;  // start/stop 消息往返进行中，防重入
let micLeasePort = null;      // background 发放的麦克风录音所有权（长连接）
let lastSavedConfigSnapshot = null; // 本页 persistConfig 成功后的字段快照（识别 storage 回声；null = 尚未初始化）

// 流式会话的宿主已迁至 offscreen（offscreen-streaming.js），本页只是 UI 镜像：
// 发 start/stop、收 STREAM_UPDATE 广播刷新结果区、装载时按 STREAM_STATE 对账。
// 会话可以跨 popup/sidepanel 生命周期 —— 关闭 UI 不再断流，这正是 #43 的目标。

// ---------- 字幕镜像（浮动字幕，可选按钮 #subtitleBtn） ----------
// Live Stream 的 partial/final 实时镜像到**开始流式时**所在标签页的浮动字幕浮层
// （content/subtitle.js）。转发失败只打点不打断 —— 字幕是旁路输出，主流程
// （结果区回显 / 历史落盘）不能因为它挂掉。popup 关闭后无人发送，浮层随
// 页面刷新自然消失；无 #subtitleBtn 的入口页（options）该按钮功能静默缺失。
let subtitlesEnabled = false;

// ---------- 音频输入设备（可选下拉框 #audioInput） ----------
// deviceId '' = 跟随系统默认。设备名只在首次 getUserMedia 授权成功后才可见，
// 故枚举发生在授权之后（见 refreshAudioInputs / syncAudioInputOptions）。
let selectedAudioInput = '';

// ---------- 调试打点（诊断页 tests/stream-debug.html 经 debug/bridge.js 接收） ----------
// bridge.js 正常先于 popup runtime 加载（两个入口页的 <script> 顺序都已保证），这里的
// fallback 只兜底“未来某个入口页漏配 script 标签”。绝不携带 apiKey（endpoint 也
// 只传"是否设置"的布尔）。
// schema 与 background/offscreen 对齐：{ ev, at, src, detail }。诊断页兼容旧
// 导出日志里的 phase 字段。
globalThis.emitDebug = typeof globalThis.emitDebug === 'function'
  ? globalThis.emitDebug
  : function (entry) {
    try {
      chrome.runtime.sendMessage({
        type: (globalThis.MESSAGES && globalThis.MESSAGES.DEBUG_EVT) || 'asr:debug',
        payload: entry,
        target: (globalThis.TARGETS && globalThis.TARGETS.DEBUG) || 'debug',
      });
    } catch {
      /* 上下文已销毁 —— 调试日志丢失无妨 */
    }
  };

function debugEvt(phase, detail) {
  if (typeof globalThis.emitDebug !== 'function') return;
  globalThis.emitDebug({ ev: phase, at: Date.now(), src: 'ui', detail: detail || {} });
}

// PCM 帧统计与 partial/final 打点随会话宿主一起迁到了 offscreen（offscreen-streaming.js）。

// DOM references
const els = {};

// ---------- Helpers ----------

function showStatus(message, type) {
  els.statusDiv.textContent = message;
  els.statusDiv.className = type;
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => {
    els.statusDiv.className = '';
  }, 3500);
}
