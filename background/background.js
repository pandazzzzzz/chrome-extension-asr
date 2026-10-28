// Background service worker — 消息路由 + offscreen 协调。
//
// 职责：
//   - 接收 popup/content 发来的 asr:* 消息（按 target 过滤，只处理发给 background 的）
//   - asr:tab-record-*：创建/复用 offscreen document，经 tabCapture 取 streamId
//   - asr:fill-text：转发给当前活动 tab 的 content script

// MV3 service worker 为经典脚本，用 importScripts 同步加载依赖。
// 顺序：共享错误 → 消息契约 → 历史存储（IndexedDB 在 SW 可用；配置/加密仍由
// 扩展页面读取）。Live Stream 的 START 消息会携带明文 API Key 经过 background
// 内存转发；background 不持久化密钥，WebSocket 与音频采集都在 offscreen 中。
importScripts(
  '../shared/errors.js',
  '../shared/timeout.js',
  '../messaging/messages.js',
  '../store/history.js',
);

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// 诊断页订阅者集合：诊断页 content 桥（debug/bridge.js）在装载时发 DEBUG_SUBSCRIBE
// 登记本 tab id，这里只向订阅 tab 转发遥测 —— 替代原来"每次事件查全部 tab 广播"的
// O(全部 tab) 开销。集合存内存，service worker 挂起重启会清空；桥在 focus/pageshow
// 时重发订阅自愈。
const debugSubscribers = new Set();

// background 侧生命周期遥测。诊断事件此前只来自 popup/offscreen，而三路互斥、
// offscreen 文档回收、代际守卫的仲裁都发生在本上下文 —— #68/#71/#72 的竞态
// 在诊断页上不可见。schema 与 offscreen-streaming.js 的 debugEvt 对齐（{ ev, at, src }）。
function debugEvt(ev, detail) {
  // runtime.sendMessage 不会回到发送者自己的 onMessage，因此 background 不能
  // 依赖“发给 debug target 再由 onMessage 转发”的路径。直接写入已订阅 tab。
  forwardDebugToTabs({ ev, at: Date.now(), src: 'background', ...detail });
}

function forwardDebugToTabs(payload) {
  for (const tabId of debugSubscribers) {
    chrome.tabs.sendMessage(
      tabId,
      { type: globalThis.MESSAGES.DEBUG_EVT, payload, target: globalThis.TARGETS.DEBUG },
      () => {
        // 桥仍会回 sendResponse({ok:true})；若桥已不在（导航走/关闭），无人响应 →
        // lastError 置位，从集合移除自愈。
        if (chrome.runtime.lastError) debugSubscribers.delete(tabId);
      },
    );
  }
}

// tab 关闭立即清理，不必等下一次转发时的 lastError 兜底。
chrome.tabs.onRemoved.addListener((tabId) => {
  debugSubscribers.delete(tabId);
});

// 插件安装/更新时的初始化
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed:', details.reason);
  if (details.reason === 'install') {
    // 首次安装：清理早期模板遗留的 storage.sync 演示数据
    chrome.storage.sync.get(['data'], (result) => {
      if (result.data !== undefined) chrome.storage.sync.remove(['data']);
    });
  }
});

// ---------- Keyboard shortcuts（manifest.commands） ----------
// 只有需要自己处理的两个命令在这里；`_execute_action` 是保留命令，由 Chrome 直接
// 打开 popup，**不会**触发 onCommand，故不在此列。
//
// ⚠️ `sidePanel.open()` 的调用**前面不能有任何 await**（与 `chrome.permissions.request()`
// 同一类约束）：用户手势只在 listener 的**第一个同步轮次**内有效，中间隔一个
// `await chrome.tabs.query(...)` 手势就没了，报 "may only be called in response to
// a user gesture"。所以这里传 `WINDOW_ID_CURRENT`，让 Chrome 在内部同步解析窗口
// （side_panel_api.cc 的注释：「This handles e.g. the WINDOW_ID_CURRENT constant by
// converting it to the concrete window ID」），而不是自己去查 tab。
//
// onCommand 的 sender 不携带 tab 信息（事件本身没有 tab 字段），需要 tab 只能自己
// 查 —— 这也是快捷键**不**用于启动标签页录音的原因：`tabCapture` 要的 tab 级授权
// 虽然同样由「键盘快捷键」这类手势授予（Chrome 文档《The activeTab permission》
// 明确列出 "Executing a keyboard shortcut"），但麦克风录音的 MediaRecorder 仍
// 属于当前 UI 页面；从 SW 发起需要先打开 UI/取得录音租约，属于独立交互改动，
// 不在快捷键处理范围内。
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-side-panel') {
    // 同步调用，不 await 任何东西在前（见上）。
    chrome.sidePanel
      .open({ windowId: chrome.windows.WINDOW_ID_CURRENT })
      .catch((error) => console.warn('open-side-panel failed:', error?.message || error));
    return;
  }
  if (command === 'open-options') {
    chrome.runtime.openOptionsPage().catch((error) => {
      console.warn('open-options failed:', error?.message || error);
    });
  }
});

// 查询当前活动 tab 并把消息转发给它的 content script。
// content 的响应必须原样透传（如 fill-text 无聚焦字段时回 { ok:false, NO_FIELD }，
// 丢掉它会让 popup 永远显示成功）；message 未定义时（异常路径）按失败处理。
async function forwardToTab(type, payload, tabId) {
  let resolvedTabId = tabId;
  if (resolvedTabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    resolvedTabId = tab?.id;
  }
  if (resolvedTabId == null) {
    return { ok: false, error: globalThis.Errors.NO_TAB };
  }

  try {
    const response = await chrome.tabs.sendMessage(resolvedTabId, {
      type,
      payload,
      target: globalThis.TARGETS.CONTENT,
    });
    if (response && response.ok) return { ok: true, data: response.data };
    return {
      ok: false,
      error: response?.error
        ? globalThis.normalizeError(response.error)
        : globalThis.Errors.NO_CONTENT,
    };
  } catch (error) {
    // content script 未注入（如 chrome:// 页面）时 sendMessage 会失败
    return { ok: false, error: globalThis.Errors.NO_CONTENT };
  }
}

// 转发 asr:fill-text 到当前活动 tab 的 content script
async function handleFillText(payload) {
  const { text } = payload || {};
  if (!text) return { ok: false, error: globalThis.Errors.NO_TEXT };
  return forwardToTab(globalThis.MESSAGES.FILL_TEXT, { text });
}

// 转发字幕浮层消息（asr:subtitle-show / asr:subtitle-hide，见 content/subtitle.js）
async function handleSubtitleShow(payload) {
  const text = payload?.text || '';
  if (!text) return { ok: false, error: globalThis.Errors.NO_TEXT };
  return forwardToTab(globalThis.MESSAGES.SUBTITLE_SHOW, {
    text,
    done: !!payload?.done,
  }, payload?.tabId);
}

async function handleSubtitleHide(payload) {
  return forwardToTab(globalThis.MESSAGES.SUBTITLE_HIDE, {}, payload?.tabId);
}

async function handleHistoryAdd(payload) {
  const text = payload?.text || '';
  if (!text) return { ok: false, error: globalThis.Errors.NO_TEXT };
  try {
    await globalThis.HistoryStore.add({
      text,
      provider: payload?.provider || '',
      model: payload?.model || '',
    });
    return { ok: true, data: { saved: true } };
  } catch (error) {
    return {
      ok: false,
      error: globalThis.normalizeError(error, globalThis.Errors.STORAGE_ERROR),
    };
  }
}

// ---------- Offscreen 协调（标签页录音） ----------
// offscreen 单例创建，避免并发重复 createDocument
let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  if (existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  debugEvt('offscreen-create', {});
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Recording tab audio for transcription',
  }).finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
  debugEvt('offscreen-created', {});
}

// 录音结束后显式关闭 offscreen 文档：它的 JS 上下文（含已加载脚本）会常驻内存,
// MV3 不会自动回收。closeDocument 在文档不存在时会 reject（如 stop 消息本来就没
// 送达）,吞掉即可——下次 ensureOffscreenDocument 会用 getContexts 自愈。
async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
    debugEvt('offscreen-closed', {});
  } catch {
    /* 已不存在 / 关闭失败 */
  }
}

// 文档"代际"计数：popup 客户端超时（10/20s）不取消 background 里仍在跑的 handler,
// 用户重试会开新一轮。若回收动作不区分代际,上一轮迟到的 stop 收尾会关掉属于新一轮
// 的文档、毁掉正在进行的录音。约定：start 成功即 enter 当代；任何一次回收之后、
// 下一次 start 之前的迟到收尾，token 不等 → 拒绝执行。
let offscreenGeneration = 0;
let activeOffscreenToken = null; // { kind: 'stream'|'tab', generation: number }

// ---------- Live Stream 状态（跨 popup 生命周期） ----------
// 会话宿主在 offscreen（offscreen-streaming.js）：popup/sidepanel 只是 UI 壳，
// 关闭即销毁，状态真相在 background + offscreen。apiKey 仅经 background 内存
// 转发并在 offscreen 会话期间驻留，不写入 storage。流式与标签页录音共享同一份
// offscreen 文档 —— 三路互斥的
// "文档归属"判断必须覆盖两路，谁都不能在对方活跃时回收文档。
const STREAMING_KEY = 'streaming';
const STREAM_GENERATION_KEY = 'streamGeneration';

async function nextStreamGeneration() {
  let current = 0;
  try {
    const r = await chrome.storage.session.get(STREAM_GENERATION_KEY);
    current = Number(r?.[STREAM_GENERATION_KEY]) || 0;
  } catch {
    /* storage.session 不可用时仍用内存计数兜底 */
  }
  current += 1;
  try {
    await chrome.storage.session.set({ [STREAM_GENERATION_KEY]: current });
  } catch {
    /* 同上：竞态防护降级，不影响会话本身 */
  }
  return current;
}

async function setStreaming(active) {
  try {
    await chrome.storage.session.set({ [STREAMING_KEY]: active === true });
  } catch {
    /* storage.session 不可用时降级为无状态：不影响会话本身 */
  }
}

// 与 isTabRecording 同构：storage.session 标记与 offscreen 文档存在性对账。
async function isStreaming() {
  let flagged = false;
  try {
    const r = await chrome.storage.session.get(STREAMING_KEY);
    flagged = r?.[STREAMING_KEY] === true;
  } catch {
    return false;
  }
  if (!flagged) return false;
  const ctxs = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (ctxs.length === 0) {
    await setStreaming(false);
    releaseAudio('stream');
    if (activeOffscreenToken?.kind === 'stream') activeOffscreenToken = null;
    return false;
  }
  return true;
}

// ---------- 三路录音仲裁 ----------
// 麦克风录音仍在 UI 进程执行，但“开始录音”的许可由 background 统一发放：
// popup/sidepanel 在 getUserMedia 前建立长连接租约，页面关闭时连接断开，
// 租约自动释放。audioReservation 在异步查询持久状态期间占位，避免 Mic 与
// Stream/Tab 同时通过“当前没人录音”的检查。
let audioOwner = null;      // { kind: 'mic'|'tab'|'stream', port?: Port }
let audioReservation = null; // 正在核验中的 kind

async function reserveAudio(kind, port = null) {
  if (audioReservation) return false;
  audioReservation = kind;
  try {
    if (audioOwner?.kind === 'stream') await isStreaming();
    else if (audioOwner?.kind === 'tab') await isTabRecording();
    if (audioOwner) return false;
    if (await isTabRecording()) return false;
    if (await isStreaming()) return false;
    audioOwner = { kind, port };
    debugEvt('audio-owner-claimed', { kind });
    return true;
  } finally {
    audioReservation = null;
  }
}

function releaseAudio(kind, port = null, expectedOwner = null) {
  if (audioOwner?.kind !== kind) return false;
  if (port && audioOwner.port !== port) return false;
  if (expectedOwner && audioOwner !== expectedOwner) return false;
  debugEvt('audio-owner-released', { kind });
  audioOwner = null;
  return true;
}

function hasNewerStreamToken(tokenAtStart) {
  return activeOffscreenToken !== null && activeOffscreenToken !== tokenAtStart;
}

async function clearStreamingFlagUnlessReplaced(tokenAtStart) {
  if (hasNewerStreamToken(tokenAtStart)) return false;
  await setStreaming(false);
  if (hasNewerStreamToken(tokenAtStart)) {
    // The old teardown lost the race after writing false. Restore the flag for
    // the session that now owns the offscreen document.
    await setStreaming(true);
    return false;
  }
  return true;
}

async function handleStreamStart(payload) {
  if (!(await reserveAudio('stream'))) {
    debugEvt('mutex-rejected', { want: 'stream', held: audioOwner?.kind || audioReservation || 'unknown' });
    return { ok: false, error: globalThis.Errors.ALREADY_RECORDING };
  }
  try {
    debugEvt('stream-start-relay', {});
    await ensureOffscreenDocument();
    const streamGeneration = await nextStreamGeneration();
    let result;
    try {
      result = await sendToOffscreen(
        globalThis.MESSAGES.STREAM_START,
        { ...payload, streamGeneration },
        19000,
      );
    } catch (e) {
      // START 超时：offscreen 失联且未开始会话（后台已代为清理，见 offscreen 侧）。
      // 但若它实际已开始（结果丢失），标记与文档对账会自愈，这里只回收文档。
      await closeOffscreenDocument();
      activeOffscreenToken = null;
      throw e;
    }
    if (result.ok) {
      activeOffscreenToken = { kind: 'stream', generation: streamGeneration };
      debugEvt('stream-token-claimed', { generation: streamGeneration, streamGeneration });
      await setStreaming(true);
    } else {
      if (result.error?.code !== globalThis.Errors.ALREADY_RECORDING.code) {
        await closeOffscreenDocument();
        activeOffscreenToken = null;
      }
      releaseAudio('stream');
    }
    return result;
  } catch (e) {
    releaseAudio('stream');
    throw e;
  }
}

async function handleStreamStop() {
  const tokenAtStart = activeOffscreenToken;
  const ownerAtStart = audioOwner?.kind === 'stream' ? audioOwner : null;
  debugEvt('stream-stop-relay', { token: tokenAtStart });
  const result = await sendToOffscreen(globalThis.MESSAGES.STREAM_STOP, {}, 15000);
  // 代际守卫与 handleTabRecordStop 同构（流式与 tab 录音共享文档）
  let reclaimed = false;
  const ownsStream = tokenAtStart?.kind === 'stream'
    && tokenAtStart === activeOffscreenToken;
  const recoveredStream = tokenAtStart === null && result.ok && !(await isTabRecording());
  if (hasNewerStreamToken(tokenAtStart)) {
    debugEvt('stream-stop-stale', { token: tokenAtStart });
    return result;
  }
  if ((ownsStream || recoveredStream) && (tokenAtStart !== null || result.ok)) {
    await closeOffscreenDocument();
    if (!hasNewerStreamToken(tokenAtStart)) activeOffscreenToken = null;
    reclaimed = true;
  }
  if (result.ok) {
    const cleared = await clearStreamingFlagUnlessReplaced(tokenAtStart);
    if (cleared) releaseAudio('stream', null, ownerAtStart);
  } else if (reclaimed) {
    releaseAudio('stream', null, ownerAtStart);
  }
  return result;
}

// offscreen 的远端终止通知：会话已自行收尾（finalize + teardown），这里只做
// background 侧的清理。文档回收按代际 —— 若用户已重开新一轮，绝不关新会话的文档。
async function handleStreamEnded(payload) {
  const tokenAtStart = activeOffscreenToken;
  const ownerAtStart = audioOwner?.kind === 'stream' ? audioOwner : null;
  const streamGeneration = payload?.streamGeneration;
  debugEvt('stream-ended-received', { token: tokenAtStart, streamGeneration: streamGeneration ?? null });
  // streamGeneration 是 storage.session 持久的流式专属计数，与 offscreen 文档
  // 生命周期解耦；streamSeq 只在文档内部防延迟回调串扰，不能跨文档比较。
  // SW 重启后 token 为 null，此时 STREAM_ENDED 本身已证明会话收尾完成，
  // 不能把 generation 与 null 比较而误判 stale（#68）。
  const staleKind = tokenAtStart !== null && tokenAtStart.kind !== 'stream';
  const staleGeneration = tokenAtStart?.kind === 'stream'
    && typeof streamGeneration === 'number'
    && streamGeneration !== tokenAtStart.generation;
  const recoveredButTabActive = tokenAtStart === null && await isTabRecording();
  const staleStream = staleKind || staleGeneration || recoveredButTabActive;
  if (staleStream) {
    debugEvt('stream-ended-stale', { streamGeneration, token: tokenAtStart });
    return { ok: true, data: { stale: true } };
  }
  const cleared = await clearStreamingFlagUnlessReplaced(tokenAtStart);
  if (!cleared) {
    debugEvt('stream-ended-replaced', { streamGeneration, token: tokenAtStart });
    return { ok: true, data: { stale: true } };
  }
  // both-null（SW 重启丢 token）也回收：STREAM_ENDED 只会在 offscreen 完整
  // 收尾后发出，比 STOP 的 result.ok 更强；与 handleTabRecordStop 的
  // both-null 分支同构（#68）。
  if (tokenAtStart === activeOffscreenToken) {
    debugEvt('stream-ended-close', { token: tokenAtStart });
    await closeOffscreenDocument();
    activeOffscreenToken = null;
  }
  // 文档关闭期间必须继续持有音频租约；否则新的 STREAM_START 会复用即将关闭的
  // 文档，随后这里把新会话的 token 清掉，留下无文档但 streaming=true 的僵尸态。
  if (!hasNewerStreamToken(tokenAtStart)) {
    releaseAudio('stream', null, ownerAtStart);
  }
  return { ok: true, data: { stale: false } };
}

// ---------- 标签页录音状态（跨 popup 生命周期） ----------
// popup 是随时会被关掉的 UI 壳，而录音活在 offscreen 里 —— 状态不能只存 popup
// 的内存变量：关掉再打开 popup 会丢掉「正在录音」，按钮复位成可点，此时再点
// Record Tab 只会拿到 ALREADY_RECORDING，而**没有任何 UI 路径能停止录音**
//（offscreen 文档与标签页采集一直留到浏览器关闭）。故把状态放在 background
// 这一侧，用 storage.session 持久化（SW 挂起重启后仍在，浏览器关闭即清空）。
const TAB_RECORDING_KEY = 'tabRecording';

async function setTabRecording(recording) {
  try {
    await chrome.storage.session.set({ [TAB_RECORDING_KEY]: recording });
  } catch {
    /* storage.session 不可用（极旧版本）时降级为无状态：不影响录音本身 */
  }
}

// 读取真实状态：storage.session 的标记要与 offscreen 文档的存在性对账。
// 文档不在 → 录音必然不在（它就在文档里），顺手清掉可能残留的标记自愈。
async function isTabRecording() {
  let flagged = false;
  try {
    const r = await chrome.storage.session.get(TAB_RECORDING_KEY);
    flagged = r?.[TAB_RECORDING_KEY] === true;
  } catch {
    return false;
  }
  if (!flagged) return false;
  const ctxs = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (ctxs.length === 0) {
    await setTabRecording(false);
    releaseAudio('tab');
    if (activeOffscreenToken?.kind === 'tab') activeOffscreenToken = null;
    return false;
  }
  return true;
}

// 给 offscreen 发消息并按 { ok, data, error } 归一化。
// 超时兜底：文档被关/崩溃时回调可能迟迟不来,background 的 onMessage handler 会
// 永久悬挂占用 SW。预算须 **小于** popup 端对应超时（START 10s / STOP 20s）,
// 让 background 先得出确定结论；真发生超时,该轮 token 已作废,后续回收被代际
// 守卫拒绝,迟到送达的 handler 也只回 ok:false,无害。
async function sendToOffscreen(type, payload, timeoutMs) {
  const p = new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type, payload, target: globalThis.TARGETS.OFFSCREEN, requestId: Date.now().toString(36) },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: globalThis.createError(
              globalThis.Errors.NO_OFFSCREEN,
              chrome.runtime.lastError.message,
            ),
          });
          return;
        }
        if (!response) {
          resolve({ ok: false, error: globalThis.Errors.NO_RESPONSE });
          return;
        }
        resolve(response);
      },
    );
  });
  return globalThis.withTimeout(p, timeoutMs, `sendToOffscreen ${type}`);
}

// 开始录标签页：取 streamId → 通知 offscreen 开始
async function handleTabRecordStart(payload) {
  if (!(await reserveAudio('tab'))) {
    debugEvt('mutex-rejected', { want: 'tab-record', held: audioOwner?.kind || audioReservation || 'unknown' });
    return { ok: false, error: globalThis.Errors.ALREADY_RECORDING };
  }
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    releaseAudio('tab');
    throw e;
  }
  if (!tab || !tab.id) {
    releaseAudio('tab');
    return { ok: false, error: globalThis.Errors.NO_TAB };
  }

  // getMediaStreamId 需要「用户调用扩展」标记（点击工具栏图标授予；本扩展未声明
  // activeTab —— 该标记由 tabCapture 权限的 tab-specific 授予产生，与 activeTab 无关）
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    releaseAudio('tab');
    return {
      ok: false,
      error: globalThis.createError(globalThis.Errors.TAB_CAPTURE, error.message || ''),
    };
  }

  try {
    await ensureOffscreenDocument();
  } catch (e) {
    releaseAudio('tab');
    throw e;
  }
  let result;
  try {
    result = await sendToOffscreen(globalThis.MESSAGES.TAB_RECORD_START, { streamId }, 9000);
  } catch (e) {
    // START 超时：offscreen 失联。此刻可证明它没有活跃录音（ALREADY_RECORDING 是
    // 同步早退,不会挂起）,销毁重建是唯一安全路径。rethrow 交给统一 catch → TIMEOUT。
    await closeOffscreenDocument();
    activeOffscreenToken = null;
    releaseAudio('tab');
    throw e;
  }
  // start 失败时回收文档，但 **ALREADY_RECORDING 除外**：那是另一路（如 sidepanel）
  // 正在录音的良性信号，此刻关文档 = 杀掉人家活跃的录音。其余失败（getUserMedia
  // 被拒等）意味着文档内状态不可信，销毁重建更安全。
  if (!result.ok && result.error?.code !== globalThis.Errors.ALREADY_RECORDING.code) {
    await closeOffscreenDocument();
    activeOffscreenToken = null;
  }
  // 成功即认领当代（token 须在此同步刷新,handleTabRecordStop 靠它判断归属），
  // 并把「正在录音」落到 storage.session —— popup 关掉重开要靠它对齐 UI。
  if (result.ok) {
    offscreenGeneration += 1;
    activeOffscreenToken = { kind: 'tab', generation: offscreenGeneration };
    debugEvt('tab-record-token-claimed', { generation: offscreenGeneration });
    await setTabRecording(true);
  } else {
    releaseAudio('tab');
  }
  return result;
}

// 停止录标签页：offscreen 返回录制 Blob，随后回收文档
async function handleTabRecordStop() {
  const tokenAtStart = activeOffscreenToken;
  const result = await sendToOffscreen(globalThis.MESSAGES.TAB_RECORD_STOP, {}, 19000);
  // 代际守卫——只在"本 stop 仍归属当前有效代"时回收文档：
  //   token 匹配且非 null：本代正常收尾（成败都关：stop 失败意味着文档内状态不可信）。
  //   两边皆 null：SW 挂起重启丢了 token 但文档还在——仅当 STOP 确实送达（result.ok，
  //     录音被证实停止）才回收；失败分支分不清是否还有活跃录音，宁可留文档不误杀。
  //   token 不匹配：重试已换代，这是陈旧 stop 的迟到收尾，绝不关新录音的文档。
  let reclaimed = false;
  const ownsTab = tokenAtStart?.kind === 'tab'
    && tokenAtStart === activeOffscreenToken;
  const recoveredTab = tokenAtStart === null && result.ok && !(await isStreaming());
  if ((ownsTab || recoveredTab) && (tokenAtStart !== null || result.ok)) {
    await closeOffscreenDocument();
    activeOffscreenToken = null;
    reclaimed = true;
  }
  // STOP 送达（result.ok）即录音确已停止 → 清状态。失败分支分不清文档里是否还有
  // 活跃录音（如代际不匹配时我们故意留着文档），保留标记让 popup 仍显示「录音中」，
  // 由 isTabRecording() 的文档存在性对账兜底。
  if (result.ok) {
    await setTabRecording(false);
    releaseAudio('tab');
  } else if (reclaimed) {
    releaseAudio('tab');
  }
  return result;
}

// 麦克风录音租约：MediaRecorder 留在 UI，但所有权由常驻的 background 裁决。
// 长连接断开（popup/sidepanel 关闭）即释放，避免残留锁让其它路径永远 ALREADY。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== globalThis.MESSAGES.MIC_RECORD_PORT) return;
  let owned = false;
  let disconnected = false;

  port.onMessage.addListener((message) => {
    if (message?.type === globalThis.MESSAGES.MIC_RECORD_ACQUIRE) {
      void (async () => {
        const acquired = await reserveAudio('mic', port);
        if (!acquired || disconnected) {
          if (acquired) releaseAudio('mic', port);
          try {
            port.postMessage({ ok: false, error: globalThis.Errors.ALREADY_RECORDING });
          } catch { /* page already gone */ }
          try {
            port.disconnect();
          } catch { /* already disconnected */ }
          return;
        }
        owned = true;
        try {
          port.postMessage({ ok: true, data: { recording: true } });
        } catch {
          owned = false;
          releaseAudio('mic', port);
        }
      })();
    } else if (message?.type === globalThis.MESSAGES.MIC_RECORD_RELEASE && owned) {
      owned = false;
      releaseAudio('mic', port);
    }
  });

  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (owned) releaseAudio('mic', port);
    owned = false;
  });
});

// 统一消息入口
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type, payload, target } = request || {};

  // 诊断页订阅/退订：content 桥（debug/bridge.js）在诊断页装载时登记本 tab id，
  // 离开/关闭时退订。订阅集合存内存，worker 重启会清空 —— 桥靠 focus/pageshow +
  // 15s 低频重发自愈（见 debug/bridge.js）。subscribe 回响应：桥据此把「订阅链路
  // 是否活着」转给页面，面板显示真实状态而非陈旧计数（SW 冷启时第一条订阅会唤醒
  // worker 并得到响应，即天然的心跳）。
  // 订阅只接受批准 URL 的 top frame：iframe 的 sender.url 也可能指向诊断页，
  // 但不应因此获得整个 tab 的遥测转发权。
  if (type === globalThis.MESSAGES.DEBUG_SUBSCRIBE && sender?.tab?.id != null) {
    if (sender.frameId !== 0 || !globalThis.isApprovedDebugPageUrl(sender.url)) {
      sendResponse({
        ok: false,
        error: globalThis.createError(globalThis.Errors.UNKNOWN, 'Debug subscription denied'),
      });
      return true;
    }
    debugSubscribers.add(sender.tab.id);
    sendResponse({ ok: true });
    return true; // 保留通道，页面才能观察到送达（fire-and-forget 会吞掉 lastError）
  }
  if (type === globalThis.MESSAGES.DEBUG_UNSUBSCRIBE && sender?.tab?.id != null) {
    debugSubscribers.delete(sender.tab.id);
    return false;
  }

  // 诊断遥测转发（target:'debug'）：
  // chrome.runtime.sendMessage 只广播给扩展上下文（background / 扩展页），
  // **到不了 content script** —— content 只能由 chrome.tabs.sendMessage 送达。
  // 所以这里由 background 中转一跳给各 tab 的 content 桥（debug/bridge.js）。
  if (type === globalThis.MESSAGES.DEBUG_EVT && target === globalThis.TARGETS.DEBUG) {
    forwardDebugToTabs(payload);
    return false; // fire-and-forget，不占响应通道
  }

  // target 过滤：runtime.sendMessage 是广播，offscreen/content 收到的
  // background 消息也在这里触发，非 background 的直接忽略
  if (target !== undefined && target !== globalThis.TARGETS.BACKGROUND) return false;

  (async () => {
    try {
      switch (type) {
        case globalThis.MESSAGES.SUBTITLE_SHOW:
          return await handleSubtitleShow(payload);
        case globalThis.MESSAGES.SUBTITLE_HIDE:
          return await handleSubtitleHide(payload);
        case globalThis.MESSAGES.FILL_TEXT:
          return await handleFillText(payload);
        case globalThis.MESSAGES.TAB_RECORD_START:
          return await handleTabRecordStart(payload);
        case globalThis.MESSAGES.TAB_RECORD_STOP:
          return await handleTabRecordStop();
        case globalThis.MESSAGES.TAB_RECORD_STATE:
          return { ok: true, data: { recording: await isTabRecording() } };
        case globalThis.MESSAGES.STREAM_START:
          return await handleStreamStart(payload);
        case globalThis.MESSAGES.STREAM_STOP:
          return await handleStreamStop();
        case globalThis.MESSAGES.STREAM_STATE:
          return { ok: true, data: { streaming: await isStreaming() } };
        case globalThis.MESSAGES.STREAM_ENDED:
          return await handleStreamEnded(payload);
        case globalThis.MESSAGES.HISTORY_ADD:
          return await handleHistoryAdd(payload);
        default:
          return { ok: false, error: globalThis.Errors.UNKNOWN_ACTION };
      }
    } catch (error) {
      console.error('Background handler error:', error);
      return { ok: false, error: globalThis.normalizeError(error) };
    }
  })().then(sendResponse);

  return true; // 保持消息通道开启以异步响应
});
