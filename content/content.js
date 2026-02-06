// Content script - 运行在网页上下文中
console.log('Content script loaded');

// 监听来自popup或background的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Content script received message:', request);
  
  if (request.action === 'performAction') {
    // 在页面上执行操作
    performPageAction();
    sendResponse({ success: true });
  }
  
  return true;
});

// 在页面上执行的示例操作
function performPageAction() {
  // 示例：改变页面背景色
  document.body.style.transition = 'background-color 0.3s';
  document.body.style.backgroundColor = '#f0f8ff';
  
  // 3秒后恢复
  setTimeout(() => {
    document.body.style.backgroundColor = '';
  }, 3000);
}

// 页面加载完成后的初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}

function initialize() {
  console.log('Content script initialized on:', window.location.href);
  // 在这里添加页面加载后的初始化逻辑
}
