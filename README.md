# Chrome Extension

一个基于 Manifest V3 的 Chrome 浏览器插件模板。

## 功能特性

- ✅ 使用最新的 Manifest V3 规范
- ✅ 包含 Popup 界面
- ✅ Background Service Worker
- ✅ Content Scripts 内容脚本
- ✅ Chrome Storage API 数据存储
- ✅ 消息通信机制

## 项目结构

```
.
├── manifest.json          # 插件配置文件
├── popup/                 # 弹出窗口
│   ├── popup.html        # 弹出窗口HTML
│   ├── popup.css         # 弹出窗口样式
│   └── popup.js          # 弹出窗口脚本
├── background/            # 后台脚本
│   └── background.js     # Service Worker
├── content/               # 内容脚本
│   ├── content.js        # 注入到网页的脚本
│   └── content.css       # 注入到网页的样式
└── icons/                 # 图标文件
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 快速开始

### 安装依赖

本项目是纯 JavaScript 实现，无需安装依赖。

### 加载插件到 Chrome

1. 打开 Chrome 浏览器
2. 访问 `chrome://extensions/`
3. 开启右上角的"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择本项目的根目录

### 开发调试

- **Popup 调试**: 右键点击插件图标 → 检查弹出内容
- **Background 调试**: 在 `chrome://extensions/` 页面点击"Service Worker"链接
- **Content Script 调试**: 在网页上按 F12 打开开发者工具，在 Console 中查看

## 核心概念

### Manifest V3

Manifest V3 是 Chrome 插件的最新规范，主要改进包括：

- 使用 Service Worker 替代 Background Pages
- 更严格的内容安全策略
- 改进的权限系统
- 更好的性能和安全性

参考文档：[Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro/)

### 组件说明

#### Popup (弹出窗口)
点击插件图标时显示的界面，适合快速交互和设置。

#### Background Service Worker
在后台运行的脚本，处理事件监听、数据管理等长期任务。

#### Content Scripts
注入到网页中的脚本，可以读取和修改网页内容。

## 权限说明

当前使用的权限：

- `storage`: 使用 Chrome Storage API 存储数据
- `activeTab`: 访问当前活动标签页

根据需要可以添加更多权限，参考：[Chrome Extension Permissions](https://developer.chrome.com/docs/extensions/mv3/declare_permissions/)

## 发布到 Chrome Web Store

1. 准备好所有图标和截图
2. 创建开发者账号（需支付一次性注册费）
3. 打包插件为 .zip 文件
4. 访问 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
5. 上传并填写插件信息
6. 提交审核

## 常见问题

### 如何添加新的权限？

在 `manifest.json` 的 `permissions` 数组中添加所需权限。

### 如何与网页通信？

使用 `chrome.runtime.sendMessage()` 和 `chrome.runtime.onMessage` API。

### 如何存储数据？

使用 `chrome.storage.sync` 或 `chrome.storage.local` API。

## 参考资源

- [Chrome Extension 官方文档](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 迁移指南](https://developer.chrome.com/docs/extensions/mv3/intro/mv3-migration/)
- [Chrome Extension 示例](https://github.com/GoogleChrome/chrome-extensions-samples)

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 贡献

欢迎提交 Issue 和 Pull Request！

## 作者

Your Name

## 更新日志

### v1.0.0 (2024-02-06)
- 初始版本发布
- 实现基础的 Popup、Background 和 Content Script 功能
