// Popup script
document.addEventListener('DOMContentLoaded', function() {
  const actionBtn = document.getElementById('actionBtn');
  const statusDiv = document.getElementById('status');

  // 按钮点击事件
  actionBtn.addEventListener('click', async function() {
    try {
      // 获取当前活动标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // 向content script发送消息
      chrome.tabs.sendMessage(tab.id, { action: 'performAction' }, function(response) {
        if (chrome.runtime.lastError) {
          showStatus('错误: ' + chrome.runtime.lastError.message, 'error');
        } else {
          showStatus('操作成功！', 'success');
        }
      });
    } catch (error) {
      showStatus('错误: ' + error.message, 'error');
    }
  });

  // 显示状态消息
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = type;
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 3000);
  }

  // 从storage加载数据
  chrome.storage.sync.get(['data'], function(result) {
    console.log('Loaded data:', result.data);
  });
});
