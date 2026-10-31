/**
 * Live Stream UI mirror and subtitle preference handling.
 */

// ---------- Streaming transcription (realtime WebSocket) ----------
//
// 原理：麦克风 → PCM 帧（AudioWorklet，createPcmCapture）→ 重采样到目标采样率 →
// Int16 → WebSocket（百炼 run-task）→ 服务端逐句返回 partial/final → 字幕式回显。
// 目标采样率随模型走（provider.sampleRateFor：16kHz，8k 电话模型为 8kHz），且必须
// 与 run-task 里声明的 sample_rate 一致，否则服务端按错误速率解析音频。
// 服务端负责分段，本地不做 VAD（VAD 分段批量已随伪流式删除）。

async function toggleStreaming() {
  if (!isStreaming) {
    await startStreaming();
  } else {
    await stopStreaming();
  }
}

async function startStreaming() {
  // busy 覆盖消息往返窗口（background 端 start 要建文档 + 等 task-started）。
  if (isStreamingBusy || isStreaming) {
    debugEvt('start-blocked', { isStreamingBusy, isStreaming });
    return;
  }
  isStreamingBusy = true;

  const provider = getCurrentProvider();
  if (!provider) {
    debugEvt('start-fail', { reason: 'no-provider' });
    showStatus('No provider selected.', 'error');
    isStreamingBusy = false;
    return;
  }
  if (!provider.supportsStreaming) {
    debugEvt('start-fail', { reason: 'no-streaming-support', provider: provider.id });
    showStatus('Provider does not support streaming.', 'error');
    isStreamingBusy = false;
    return;
  }
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    debugEvt('start-fail', { reason: 'no-api-key' });
    showStatus('API key required for streaming.', 'error');
    isStreamingBusy = false;
    return;
  }

  // Custom 地域必须手填 endpoint：发消息前在 UI 拦下（只有本页知道 region 下拉意图）。
  // 留空会把 Custom 静默变成北京，跨地域 Key 必然握手 401。
  const endpoint = resolveEndpoint(provider);
  if (els.regionSelect?.value === 'custom' && !endpoint) {
    debugEvt('start-fail', { reason: 'no-endpoint', region: 'custom' });
    showStatus('Custom region requires an endpoint URL.', 'error');
    isStreamingBusy = false;
    return;
  }

  // 尽早禁用，把重入窗口压到最小
  els.streamBtn.disabled = true;
  debugEvt('start-begin', { provider: provider.id });

  // 字幕绑定"点击 Live Stream 时"的活动 tab：权限弹窗期间用户可能切 tab，
  // 开麦后再查会把字幕绑到错误的页面。查询失败不阻塞主流程。
  let targetTabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tab?.id ?? null;
  } catch {
    targetTabId = null;
  }

  els.resultText.value = '';
  syncResultButtons(); // 清空后同步禁用 Copy/Fill

  try {
    // 会话宿主在 offscreen：模型回落 / AudioContext / PCM / WebSocket 都在那边发生，
    // 这里只发消息并镜像状态。超时 25s：ready(10s) + getUserMedia + 采集启动 + 余量。
    await globalThis.MessageClient.send(
      globalThis.MESSAGES.STREAM_START,
      {
        providerId: provider.id,
        apiKey,
        model: resolveModel() || provider.defaultStreamModel,
        endpoint: endpoint || '',
        subtitles: subtitlesEnabled,
        targetTabId,
        audioInput: selectedAudioInput,
      },
      globalThis.TARGETS.BACKGROUND,
      25000,
    );
    isStreaming = true;
    els.streamBtn.textContent = 'Stop Stream';
    disableOtherRecordButtons(els.streamBtn);
    // 成功提示由 offscreen 的 STREAM_UPDATE(active) 补发（麦克风回退时替换为错误提示）
  } catch (error) {
    debugEvt('start-error', { message: error?.message || String(error) });
    showStatus('Cannot start streaming: ' + error.message, 'error');
  } finally {
    isStreamingBusy = false;
    if (!isStreaming) enableAllRecordButtons();
    if (!isStreaming) els.streamBtn.disabled = false;
  }
}

async function stopStreaming() {
  // 防重入：stop 消息往返期间 offscreen 的终止广播可能同时到达（服务端恰好也结束）。
  if (isStreamingBusy) {
    debugEvt('stop-blocked', {});
    return;
  }
  isStreamingBusy = true;
  isStreaming = false;
  els.streamBtn.disabled = true;
  debugEvt('stop-begin', {});
  try {
    // 收尾（finish-task、最终文本、历史、字幕 done）都在 offscreen 完成后由
    // STREAM_UPDATE 广播把最终文本回填本页。
    await globalThis.MessageClient.send(
      globalThis.MESSAGES.STREAM_STOP,
      {},
      globalThis.TARGETS.BACKGROUND,
      20000,
    );
    showStatus('Streaming stopped.', 'success');
  } catch (error) {
    // offscreen 停止失败时会话可能仍在跑：以 background 为准重新对账（同 tab 录音模式）
    debugEvt('stop-error', { message: error?.message || String(error) });
    await syncStreamingState();
  } finally {
    // busy 必须先清：enableAllRecordButtons 把 busy 视为“该路仍活跃”，
    // 先 enable 会把另外两路锁死在 disabled（#107）。
    isStreamingBusy = false;
    els.streamBtn.textContent = isStreaming ? 'Stop Stream' : 'Live Stream';
    if (!isStreaming) enableAllRecordButtons();
  }
}

// 装载/停止失败后与 background 对账流式状态（同 syncTabRecordingState 模式）：
// background 查 storage.session 标记 + offscreen 文档存在性；活跃时再向 offscreen
// 拿会话详情（当前文本）回填结果区。
async function syncStreamingState() {
  try {
    const data = await globalThis.MessageClient.send(globalThis.MESSAGES.STREAM_STATE, {});
    applyStreamingState(!!data?.streaming);
    if (data?.streaming) {
      // background 只知道"活着"；会话详情（当前文本）要直接问 offscreen
      const detail = await globalThis.MessageClient.send(
        globalThis.MESSAGES.STREAM_STATE,
        {},
        globalThis.TARGETS.OFFSCREEN,
        8000,
      );
      if (detail?.streaming && typeof detail.text === 'string') {
        els.resultText.value = detail.text;
        syncResultButtons();
      }
    }
    return true;
  } catch {
    return false; // 查询失败（SW 刚回收等）：保持本地镜像，返回未对齐
  }
}

// 按 background 真相刷新三路互斥按钮（streamBtn 文案 + 其它两路禁用）
function applyStreamingState(streaming) {
  isStreaming = streaming;
  if (streaming) {
    els.streamBtn.textContent = 'Stop Stream';
    disableOtherRecordButtons(els.streamBtn);
  } else {
    els.streamBtn.textContent = 'Live Stream';
    enableAllRecordButtons();
  }
}

// offscreen → 本页的单向广播（target:'ui'）：文本更新 / 状态提示 / 终止。
// popup 关闭期间发出的广播自然丢失（无人监听），会话不受影响 —— 重开时按
// STREAM_STATE 对账补齐。background/offscreen/content 的 target 过滤都会忽略它。
globalThis.chrome?.runtime?.onMessage?.addListener((request) => {
  if (request?.target !== globalThis.TARGETS.UI || request?.type !== globalThis.MESSAGES.STREAM_UPDATE) return false;
  // 字段约定（与 offscreen-streaming.js 的 broadcastUpdate 对齐）：
  //   status → { text, type }；error-status → { message }；ended → {}
  // 此前这里读 message（offscreen 从不发送该字段），成功提示与麦克风回退
  // 警告全部被静默丢弃（#60）。
  const { kind, text, type, message } = request.payload || {};
  const statusText = typeof text === 'string' ? text : '';
  if ((kind === 'text' || kind === 'final-text') && typeof text === 'string') {
    els.resultText.value = text;
    syncResultButtons();
  } else if (kind === 'status' && statusText) {
    showStatus(statusText, type === 'error' ? 'error' : 'success');
  } else if (kind === 'active') {
    // 启动成功（offscreen 在 task-started + 采集就绪后广播）。STREAM_START 的响应
    // 也能置位 isStreaming，但那时 offscreen 的状态广播可能已先到达（popup 关闭
    // 期间重开对账等场景）——这里只做幂等复位与按钮文案兜底。
    if (!isStreaming) applyStreamingState(true);
  } else if (kind === 'error-status' && message) {
    showStatus(message, 'error');
    if (isStreaming) applyStreamingState(false); // 远端终止：会话已收尾，UI 复位
  } else if (kind === 'ended') {
    debugEvt('stream-ended-broadcast', {});
    applyStreamingState(false);
  }
  return false;
});

// 字幕镜像现由 offscreen 会话驱动（partial/final/done 全在会话侧）；本页开关
// 负责持久化偏好 + 会话中途热切换（STREAM_SET_SUBTITLES）。会话不活跃时
// 给出明确提示，避免用户把“暂时没有浮层”误认为开关失效。
async function toggleSubtitles() {
  subtitlesEnabled = !subtitlesEnabled;
  els.subtitleBtn.textContent = subtitlesEnabled ? 'Subtitles on' : 'Subtitles';
  els.subtitleBtn.classList.toggle('active', subtitlesEnabled);
  const saved = await persistConfig(); // 配置写失败会自行显示状态，浮层仍按用户点击立即切换
  if (isStreaming) {
    try {
      await globalThis.MessageClient.send(
        globalThis.MESSAGES.STREAM_SET_SUBTITLES,
        { subtitles: subtitlesEnabled },
        globalThis.TARGETS.OFFSCREEN,
        5000,
      );
    } catch {
      /* 会话侧很快也会通过对账拿到正确值；失败不阻塞开关 */
    }
  } else if (saved) {
    showStatus(
      subtitlesEnabled
        ? 'Subtitles will appear when Live Stream is running.'
        : 'Subtitles are off for future Live Streams.',
      'info',
    );
  }
}
