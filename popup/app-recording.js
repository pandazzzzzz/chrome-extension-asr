/**
 * Microphone and tab recording, including Save audio.
 */

// ---------- Recording (microphone) ----------

// 麦克风录音跨 UI 互斥：真正的 MediaRecorder 仍在当前页面，但开始前必须先向
// background 领取租约。长连接在 popup/sidepanel 关闭时自动断开，不会留下死锁。
function acquireMicRecordingLease() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let port;
    try {
      port = globalThis.chrome.runtime.connect({
        name: globalThis.MESSAGES.MIC_RECORD_PORT,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        try { port.disconnect(); } catch { /* already closed */ }
        reject(error);
      } else {
        micLeasePort = port;
        resolve();
      }
    };

    port.onMessage.addListener((message) => {
      if (settled) return;
      if (message?.ok) {
        finish();
        return;
      }
      const error = new Error(message?.error?.message || 'Another audio recording is already active.');
      error.code = message?.error?.code || globalThis.Errors.ALREADY_RECORDING.code;
      finish(error);
    });

    port.onDisconnect.addListener(() => {
      if (!settled) {
        finish(new Error('Background recording lease connection closed.'));
        return;
      }
      if (micLeasePort !== port) return;
      micLeasePort = null;
      if (isRecording || isRecordingBusy) {
        debugEvt('record-lease-lost', {});
        showStatus('Recording stopped because the background connection was lost.', 'error');
        void stopRecording();
      }
    });

    timer = setTimeout(() => {
      const error = new Error('Timed out acquiring the recording lease.');
      error.code = globalThis.Errors.TIMEOUT?.code || 'TIMEOUT';
      finish(error);
    }, 5000);

    try {
      port.postMessage({ type: globalThis.MESSAGES.MIC_RECORD_ACQUIRE });
    } catch (error) {
      finish(error);
    }
  });
}

function releaseMicRecordingLease() {
  const port = micLeasePort;
  micLeasePort = null;
  if (!port) return;
  try {
    port.postMessage({ type: globalThis.MESSAGES.MIC_RECORD_RELEASE });
  } catch { /* background already gone */ }
  try {
    port.disconnect();
  } catch { /* already closed */ }
}

async function toggleRecording() {
  if (!isRecording) {
    await startRecording();
  } else {
    await stopRecording();
  }
}

// Tab 录音的 OPFS 引用必须落盘：popup 关闭后文件就成了没人能读、也没人能删的
// 孤儿（#109）。用 storage.local 让浏览器重启后仍可恢复。
const PENDING_TAB_RECORDING_KEY = 'pendingTabRecording';

function persistPendingTabRecording(ref) {
  if (!globalThis.RecordingStore.isRef(ref)) return;
  try {
    chrome.storage.local.set({ [PENDING_TAB_RECORDING_KEY]: ref })?.catch?.(
      (error) => debugEvt('pending-recording-persist-error', { message: error?.message || String(error) }),
    );
  } catch (error) {
    debugEvt('pending-recording-persist-error', { message: error?.message || String(error) });
  }
}

function clearPendingTabRecording() {
  try { chrome.storage.local.remove?.(PENDING_TAB_RECORDING_KEY)?.catch?.(() => {}); } catch { /* unavailable */ }
}

// 装载时恢复上次未保存的 Tab 录音，并清理无引用指向的孤儿文件。
async function restorePendingTabRecording() {
  let pending = null;
  try {
    pending = (await chrome.storage.local.get(PENDING_TAB_RECORDING_KEY))?.[PENDING_TAB_RECORDING_KEY] ?? null;
  } catch (error) {
    debugEvt('pending-recording-read-error', { message: error?.message || String(error) });
  }
  let missing = false;
  if (globalThis.RecordingStore.isRef(pending)) {
    // isRef 只校验结构；文件可能已被站点数据清理。OPFS 不可用时保持引用，让 Save 报真实错误。
    try {
      if (typeof globalThis.RecordingStore.list === 'function') {
        missing = !(await globalThis.RecordingStore.list()).includes(pending.file);
      }
    } catch { /* OPFS unavailable */ }
    if (!missing) {
      audioBlob = null;
      audioRecording = pending;
      showStatus('Previous tab recording is ready — use Save audio.', 'success');
      debugEvt('pending-recording-restored', { size: pending.size });
    } else {
      debugEvt('pending-recording-missing', { file: pending.file });
      clearPendingTabRecording();
      pending = null;
    }
  } else if (pending) {
    clearPendingTabRecording();
  }
  try {
    const removed = await globalThis.RecordingStore.sweep(audioRecording ? [audioRecording] : []);
    if (removed) debugEvt('recording-sweep', { removed });
  } catch (error) {
    debugEvt('recording-sweep-error', { message: error?.message || String(error) });
  }
}

function discardAudioResult() {
  const stale = audioRecording;
  audioBlob = null;
  audioRecording = null;
  if (stale) {
    void globalThis.RecordingStore.remove(stale).catch(() => {});
  }
  clearPendingTabRecording();
}

async function startRecording() {
  // 防重入：isRecording 要等 await getUserMedia 之后才置位，且按钮在这段窗口内仍可点。
  // 双击会开两条麦克风流，后到者覆盖 recorder → 第一条流无人停轨，麦克风常驻占用。
  // 与 startStreaming 同形的 busy 护栏，覆盖整个 await 窗口。
  if (isRecordingBusy || isRecording) return;
  isRecordingBusy = true;

  let stream = null;
  try {
    discardAudioResult();

    // 先领租约，再打开麦克风：否则两个 UI 可以同时通过本地检查。
    await acquireMicRecordingLease();
    // 按 #audioInput 选择打开麦克风；授权成功后设备名才可见 → 刷新下拉框
    stream = await acquireMicrophone();
    void refreshAudioInputs();
    debugEvt('mic-open', { deviceId: selectedAudioInput || 'default' });
    recorder = new AudioRecorder({ mimeType: els.audioTypeSelect.value });
    recorder.attach(stream);
    recorder.start();
    if (!micLeasePort) throw new Error('Recording ownership was lost before capture started.');
    const requestedMime = els.audioTypeSelect.value;
    const actualMime = recorder.actualMimeType();
    const formatChanged = !!requestedMime && !!actualMime
      && !AudioRecorder.sameMimeType(requestedMime, actualMime);
    if (formatChanged) {
      debugEvt('audio-format-fallback', { requested: requestedMime, actual: actualMime });
      showStatus(
        `This browser cannot record ${AudioRecorder.baseMimeType(requestedMime)}; `
        + `using ${AudioRecorder.baseMimeType(actualMime)}.`,
        'error',
      );
    }

    isRecording = true;
    els.recordBtn.textContent = 'Stop Recording';
    disableOtherRecordButtons(els.recordBtn);
    if (!formatChanged) {
      showStatus('Recording... speak now.', 'success');
    }
    debugEvt('record-started', { requestedMime, mimeType: actualMime });
  } catch (error) {
    debugEvt('record-error', { where: 'start', message: error?.message || String(error) });
    showStatus(`Cannot start recording: ${error.message}`, 'error');
    // 两条清理线都要走：recorder 持有 stream 时由 release 停轨；
    // 构造 recorder 就失败时只有裸 stream，需直接停轨（否则麦克风占用红点常驻）
    recorder?.release();
    recorder = null;
    stream?.getTracks().forEach((t) => t.stop());
    releaseMicRecordingLease();
    isRecording = false;
    els.recordBtn.textContent = 'Start Recording';
  } finally {
    isRecordingBusy = false;
    enableAllRecordButtons();
  }
}

async function stopRecording() {
  // 防重入：stop 期间 recorder 尚未置空（onstop 是异步的），第二次点击会重复
  // recorder.stop() → MediaRecorder 抛 InvalidStateError，且 catch 里 recorder
  // 可能已被首轮置空而触发 null.release() 崩溃。busy 护栏关掉整个 await 窗口。
  if (isRecordingBusy || !recorder) return;
  isRecordingBusy = true;

  els.recordBtn.textContent = 'Start Recording';
  isRecording = false;
  try {
    audioBlob = await recorder.stop();
    audioRecording = null;
    recorder.release();
    recorder = null;
    debugEvt('record-stopped', { size: audioBlob ? audioBlob.size : 0, mime: audioBlob ? audioBlob.type : '' });
    showStatus(recordingCompleteMessage('mic'), 'success');
  } catch (error) {
    debugEvt('record-error', { where: 'stop', message: error?.message || String(error) });
    // 超时/异常时已录分片是用户唯一能救回的数据：release({keepChunks}) 停轨但
    // 保留 chunks，getBlob() 仍可拼出部分音频供 Save。
    const partial = recorder.getBlob();
    recorder.release({ keepChunks: true });
    recorder = null;
    if (partial && partial.size > 0) {
      audioBlob = partial;
      audioRecording = null;
      showStatus(`Recording failed: ${error.message} — partial audio kept, use Save audio.`, 'error');
    } else {
      showStatus(`Recording failed: ${error.message}`, 'error');
    }
  } finally {
    if (!isRecording) releaseMicRecordingLease();
    isRecordingBusy = false;
    enableAllRecordButtons();
  }
}

// 装载时与 background 对账标签页录音状态。popup 只是 UI 壳：关掉即丢内存变量，
// 而录音仍在 offscreen 里跑。不对账的后果是按钮复位成"可点"，再点只会拿到
// ALREADY_RECORDING，用户再也停不掉这段录音（详见 background 的 TAB_RECORDING_KEY）。
async function syncTabRecordingState() {
  let recording = false;
  try {
    const data = await globalThis.MessageClient.send(globalThis.MESSAGES.TAB_RECORD_STATE, {});
    recording = !!data?.recording;
  } catch {
    // 查询失败（SW 刚被回收等）：按"空闲"处理（见下），返回值告诉调用方未对齐成功。
    return false;
  }

  // 以 background 为准**双向**对齐：录着就切成 Stop，没录就复位。
  // 只往一个方向改是不够的 —— 失败路径（如"另一路正在录"）恰恰要覆盖掉
  // 乐观置上的 busy 态，把用户引到唯一能停止录音的那个按钮上。
  isTabRecording = recording;
  if (recording) {
    els.tabRecordBtn.textContent = 'Stop Tab Rec';
    disableOtherRecordButtons(els.tabRecordBtn);
    showStatus('Recording tab audio... play something in the tab.', 'success');
    debugEvt('tab-record-restored', {});
  } else {
    els.tabRecordBtn.textContent = 'Record Tab';
    enableAllRecordButtons();
  }
  return true;
}

// ---------- Recording (tab audio, via offscreen) ----------

async function toggleTabRecording() {
  if (!isTabRecording) {
    await startTabRecording();
  } else {
    await stopTabRecording();
  }
}

async function startTabRecording() {
  // 防重入：isTabRecording 要等 await MessageClient.send 之后才置位。双击时第二次请求
  // 会命中 background 的 ALREADY_RECORDING 早退并走 catch → enableAllRecordButtons()，
  // 把"正在录音"的互斥状态清掉：按钮显示 Stop Tab Rec 却三路全可点，破坏互斥不变式。
  if (isTabRecordingBusy || isTabRecording) return;
  isTabRecordingBusy = true;

  try {
    discardAudioResult();

    // background 取 tabCapture streamId → 创建 offscreen → offscreen 开始录
    await globalThis.MessageClient.send(globalThis.MESSAGES.TAB_RECORD_START, {});

    isTabRecording = true;
    els.tabRecordBtn.textContent = 'Stop Tab Rec';
    disableOtherRecordButtons(els.tabRecordBtn);
    showStatus('Recording tab audio... play something in the tab.', 'success');
    debugEvt('tab-record-started', {});
  } catch (error) {
    debugEvt('tab-record-error', { where: 'start', message: error?.message || String(error) });
    // 失败时先按真实状态对账，再决定怎么报。这里**不按错误码分支**：同一个"另一路
    // 正在录"会因失败点不同而报不同码（start 早退是 ALREADY_RECORDING，而
    // tabCapture 先失败时是 TAB_CAPTURE "Cannot capture a tab with an active stream"），
    // 枚举码必然漏。对账成功且确实在录 → 不报错，按钮已指向可停止的 Stop。
    if (await syncTabRecordingState()) {
      if (!isTabRecording) showStatus(`Tab record failed: ${error.message}`, 'error');
    } else {
      showStatus(`Tab record failed: ${error.message}`, 'error');
    }
  } finally {
    isTabRecordingBusy = false;
    enableAllRecordButtons();
  }
}

async function stopTabRecording() {
  if (isTabRecordingBusy || !isTabRecording) return;
  isTabRecordingBusy = true;

  isTabRecording = false;
  els.tabRecordBtn.textContent = 'Record Tab';
  try {
    // offscreen 返回 { file, mime, size }；音频留在同源 OPFS，消息通道只传引用。
    // 超时仍放宽，覆盖 recorder.stop() 的 5s 兜底和后台 relay。
    const recording = await globalThis.MessageClient.send(
      globalThis.MESSAGES.TAB_RECORD_STOP,
      {},
      globalThis.TARGETS.BACKGROUND,
      20000,
    );
    if (!globalThis.RecordingStore.isRef(recording)) {
      throw new Error('Offscreen returned an invalid recording reference');
    }
    audioBlob = null;
    audioRecording = recording;
    persistPendingTabRecording(recording);
    debugEvt('tab-record-stopped', { size: recording.size, mime: recording.mime });
    showStatus(recordingCompleteMessage('tab'), 'success');
  } catch (error) {
    debugEvt('tab-record-error', { where: 'stop', message: error?.message || String(error) });
    // offscreen 失败响应可携带部分已录音频（recorder 超时路径）；对账说已不在录时
    // 才能确定录音确实停了，此时恢复部分音频供 Save，避免用户几分钟音频全丢。
    const partial = error.partialData;
    if (globalThis.RecordingStore.isRef(partial) && (await syncTabRecordingState()) && !isTabRecording) {
      audioBlob = null;
      audioRecording = partial;
      persistPendingTabRecording(partial);
      debugEvt('tab-record-partial', { size: partial.size, mime: partial.mime });
      showStatus(`Tab record stop failed: ${error.message} — partial audio kept, use Save audio.`, 'error');
      return;
    }
    // 停止失败（超时/offscreen 失联）时录音**可能还在跑** —— 乐观复位成空闲会再次
    // 制造"停不掉的录音"。与 start 同样处理：以 background 为准重新对齐。
    if (await syncTabRecordingState()) {
      if (!isTabRecording) showStatus(`Tab record stop failed: ${error.message}`, 'error');
    } else {
      showStatus(`Tab record stop failed: ${error.message}`, 'error');
    }
  } finally {
    isTabRecordingBusy = false;
    enableAllRecordButtons();
  }
}

// ---------- Save recording ----------

// 麦克风结果在内存 Blob，Tab 结果在 OPFS；两者都通过 createObjectURL +
// a[download] 落盘（无需 downloads 权限）。Tab 文件下载触发后即可删除。
async function handleSaveAudio() {
  if ((!audioBlob || !audioBlob.size) && !audioRecording) {
    showStatus('No recording yet. Record something first.', 'error');
    return;
  }
  const tabRef = audioRecording;
  let blob = audioBlob;
  let mime = blob?.type || '';
  if (tabRef) {
    try {
      blob = await globalThis.RecordingStore.read(tabRef);
      mime = tabRef.mime;
    } catch (error) {
      showStatus(`Cannot read tab recording: ${error.message}`, 'error');
      return;
    }
  }
  if (!blob || !blob.size) {
    showStatus('No recording yet. Record something first.', 'error');
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recording-${globalThis.Format.timestampForFile()}.${extensionForMime(mime)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); // 下载触发后再回收
  if (tabRef) {
    if (audioRecording === tabRef) {
      audioBlob = null;
      audioRecording = null;
      clearPendingTabRecording();
    }
    try {
      await globalThis.RecordingStore.remove(tabRef);
    } catch (error) {
      console.warn('Failed to remove saved tab recording:', error);
    }
  }
  debugEvt('audio-saved', { size: blob.size, mime });
  showStatus(`Saved recording (${Math.max(1, Math.round(blob.size / 1024))} KB).`, 'success');
}

function extensionForMime(mime) {
  const type = (mime || '').split(';')[0].trim();
  if (type === 'audio/webm') return 'webm';
  if (type === 'audio/mp4') return 'm4a';
  if (type === 'audio/wav') return 'wav';
  return 'webm';
}

function recordingCompleteMessage(kind) {
  const prefix = kind === 'tab' ? 'Tab recording complete' : 'Recording complete';
  return `${prefix} — audio only. Use Save audio, or Live Stream for transcription.`;
}
