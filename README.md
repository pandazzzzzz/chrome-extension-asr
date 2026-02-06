# Chrome Extension

一个基于 Manifest V3 的 Chrome 浏览器插件模板。

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

## 参考资源

- [Chrome Extension 官方文档](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 迁移指南](https://developer.chrome.com/docs/extensions/mv3/intro/mv3-migration/)
- [Chrome Extension 示例](https://github.com/GoogleChrome/chrome-extensions-samples)

## 许可证

MIT License

