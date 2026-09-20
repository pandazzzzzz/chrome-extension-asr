# Chrome Extension Qwen ASR

一个基于 Manifest V3 的 Chrome 浏览器插件，支持在弹窗内录音并直接调用通义语音识别（DashScope OpenAI 兼容接口）返回文本。

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

1. 安装依赖（仅用于脚本管理）：

```bash
npm install
```

2. 打开 `chrome://extensions`，开启开发者模式，点击「加载已解压的扩展程序」选择本目录。
3. 点击插件图标，填入 DashScope API Key（`sk-...`）。
4. 选择区域（中国内地/国际）和模型（默认 `qwen3-asr-flash`）。
5. 点击「开始录音」后再点击「停止录音」，然后点击「转写」。

## 接口与权限说明

- 请求地址（中国内地）：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- 请求地址（国际）：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
- 已在 `manifest.json` 中配置对应 `host_permissions`。
- API Key 保存在 `chrome.storage.sync`（仅当前浏览器账号同步空间）。

## 参考资源

- [Chrome Extension 官方文档](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 迁移指南](https://developer.chrome.com/docs/extensions/mv3/intro/mv3-migration/)
- [Chrome Extension 示例](https://github.com/GoogleChrome/chrome-extensions-samples)

## 许可证

MIT License
