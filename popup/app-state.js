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
// Tab 录音的 OPFS 引用必须落盘：UI 关闭后文件就成了没人能读、也没人能删的孤儿
// （#109）。popup 与 sidepanel 各用独立槽位，互不覆盖；旧版单键作为一次性回退。
const PENDING_TAB_RECORDING_PREFIX = 'pendingTabRecording';
function pendingRecordingKey(pathname) {
  return `${PENDING_TAB_RECORDING_PREFIX}:${String(pathname || '').includes('/sidepanel/') ? 'sidepanel' : 'popup'}`;
}
const PENDING_TAB_RECORDING_KEY = pendingRecordingKey(
  typeof location !== 'undefined' ? location.pathname : '',
);
let pendingStorageQueue = Promise.resolve();

// pending 槽的持久化/清除必须串行：clear 的 read-then-remove 若和新录音的 set
// 交错，会把刚写入的新引用删掉。Web Locks 覆盖同源多页面，队列兜底旧环境。
function enqueuePendingStorage(task) {
  const run = pendingStorageQueue.then(() => {
    const locks = globalThis.navigator?.locks;
    if (!locks?.request) return task();
    return locks.request(`asr-pending-recording:${PENDING_TAB_RECORDING_KEY}`, task);
  });
  pendingStorageQueue = run.catch(() => {});
  return run;
}

function pendingRecordingRefs(stored) {
  return Object.entries(stored || {})
    .filter(([key, value]) => key.startsWith(PENDING_TAB_RECORDING_PREFIX) && globalThis.RecordingStore.isRef(value))
    .map(([, value]) => value);
}

async function persistPendingTabRecording(ref) {
  if (!globalThis.RecordingStore.isRef(ref)) return false;
  return enqueuePendingStorage(async () => {
    try {
      await chrome.storage.local.set({ [PENDING_TAB_RECORDING_KEY]: ref });
      return true;
    } catch (error) {
      debugEvt('pending-recording-persist-error', { message: error?.message || String(error) });
      return false;
    }
  });
}

// 只能清除本上下文槽里、且仍是同一文件的引用。ref 为 null 表示数据已损坏。
async function clearPendingTabRecordingIfHeld(ref) {
  return enqueuePendingStorage(async () => {
    try {
      if (ref) {
        const stored = await chrome.storage.local.get(PENDING_TAB_RECORDING_KEY);
        if (stored?.[PENDING_TAB_RECORDING_KEY]?.file !== ref.file) return;
      }
      await chrome.storage.local.remove?.(PENDING_TAB_RECORDING_KEY);
    } catch {
      /* storage unavailable */
    }
  });
}

function clearPendingTabRecording(ref) {
  void clearPendingTabRecordingIfHeld(ref);
}

// 装载时恢复本上下文的未保存录音，并清理所有上下文都没有引用的孤儿文件。
async function restorePendingTabRecording() {
  let stored = {};
  let readFailed = false;
  try {
    stored = (await chrome.storage.local.get(null)) || {};
  } catch (error) {
    readFailed = true; // 读不到引用状态就不能判断哪些文件该清
    debugEvt('pending-recording-read-error', { message: error?.message || String(error) });
  }
  const ownPending = stored[PENDING_TAB_RECORDING_KEY];
  const legacyPending = stored[PENDING_TAB_RECORDING_PREFIX];
  const pending = globalThis.RecordingStore.isRef(ownPending)
    ? ownPending
    : globalThis.RecordingStore.isRef(legacyPending) ? legacyPending : null;
  const pendingKey = pending === ownPending
    ? PENDING_TAB_RECORDING_KEY
    : PENDING_TAB_RECORDING_PREFIX;
  if (globalThis.RecordingStore.isRef(pending)) {
    let missing = false;
    // isRef 只校验结构；文件可能已被站点数据清理。OPFS 不可用时保持引用，让 Save 报真实错误。
    try {
      if (typeof globalThis.RecordingStore.list === 'function') {
        missing = !(await globalThis.RecordingStore.list()).includes(pending.file);
      }
    } catch { /* OPFS unavailable */ }
    if (missing) {
      debugEvt('pending-recording-missing', { file: pending.file });
      if (pendingKey === PENDING_TAB_RECORDING_KEY) {
        await clearPendingTabRecordingIfHeld(pending);
      } else {
        // 旧版单键不属于任一 UI 上下文，直接清掉；下一次打开不会再次命中。
        try {
          await chrome.storage.local.remove?.(PENDING_TAB_RECORDING_PREFIX);
        } catch { /* storage unavailable */ }
      }
    } else {
      audioBlob = null;
      audioRecording = pending;
      showStatus('Previous tab recording is ready — use Save audio.', 'success');
      debugEvt('pending-recording-restored', { size: pending.size });
      if (pendingKey === PENDING_TAB_RECORDING_PREFIX) {
        // 旧版单键迁移到本上下文槽位：先写新槽再删旧键，避免过程中两边都没有引用。
        try {
          await chrome.storage.local.set({ [PENDING_TAB_RECORDING_KEY]: pending });
          await chrome.storage.local.remove?.(PENDING_TAB_RECORDING_PREFIX);
        } catch { /* storage unavailable: keep the legacy key */ }
      }
    }
  }
  if (readFailed) return; // 未知引用状态时不要 sweep，否则可能删掉有效的未保存录音
  try {
    const keep = new Map();
    for (const ref of pendingRecordingRefs(stored)) keep.set(ref.file, ref);
    if (audioRecording) keep.set(audioRecording.file, audioRecording);
    const removed = await globalThis.RecordingStore.sweep([...keep.values()]);
    if (removed) debugEvt('recording-sweep', { removed });
  } catch (error) {
    debugEvt('recording-sweep-error', { message: error?.message || String(error) });
  }
}
