/**
 * Result actions and navigation controls.
 */

// ---------- Navigation (optional buttons) ----------

function handleOpenOptions() {
  chrome.runtime.openOptionsPage();
}

// chrome.sidePanel.open 需要用户手势；popup 内点击即满足。手势只在这个同步
// 调用栈里有效 —— 前面不能 await（包括 chrome.tabs.query）。让 Chrome 自己
// 解析 WINDOW_ID_CURRENT，和 background 的快捷键处理保持一致。
async function handleOpenPanel() {
  try {
    await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    window.close(); // 侧栏已打开，收起 popup
  } catch (error) {
    showStatus(`Cannot open side panel: ${error.message}`, 'error');
  }
}

// ---------- Fill into page ----------

async function handleFillIntoPage() {
  const text = els.resultText.value.trim();
  if (!text) {
    showStatus('Nothing to fill.', 'error');
    return;
  }
  try {
    await globalThis.MessageClient.send(globalThis.MESSAGES.FILL_TEXT, { text });
    debugEvt('fill-ok', { len: text.length });
    showStatus('Filled into page input.', 'success');
  } catch (error) {
    debugEvt('fill-error', { code: error?.code || '', message: error?.message || String(error) });
    // 超时是"结果未知"而非"确定失败"：填充是不可取消的副作用，慢页面上它可能
    // 已经落地。直接说 failed 会诱导用户重试 → 文本插入两遍，所以分开措辞。
    if (error?.code === globalThis.Errors.TIMEOUT.code) {
      showStatus('Fill timed out — check the page before retrying (it may already be filled).', 'error');
      return;
    }
    showStatus(`Fill failed: ${error.message}`, 'error');
  }
}

// ---------- Copy ----------

async function handleCopy() {
  const text = els.resultText.value.trim();
  if (!text) {
    showStatus('Nothing to copy.', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    debugEvt('copy-ok', { len: text.length });
    showStatus('Copied to clipboard.', 'success');
  } catch (error) {
    debugEvt('copy-error', { message: error?.message || String(error) });
    showStatus(`Copy failed: ${error.message}`, 'error');
  }
}
