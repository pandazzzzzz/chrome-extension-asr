// Background service worker
console.log('Background service worker started');

// 监听插件安装事件
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed:', details.reason);
  
  if (details.reason === 'install') {
    // 首次安装时的初始化
    chrome.storage.sync.set({ data: 'Initial data' });
  } else if (details.reason === 'update') {
    // 更新时的处理
    console.log('Extension updated');
  }
});

// 监听来自content script或popup的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received:', request);
  
  if (request.action === 'getData') {
    chrome.storage.sync.get(['data'], (result) => {
      sendResponse({ data: result.data });
    });
    return true; // 保持消息通道开启以进行异步响应
  }
  
  if (request.action === 'setData') {
    chrome.storage.sync.set({ data: request.data }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// 监听标签页更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    console.log('Tab loaded:', tab.url);
  }
});
