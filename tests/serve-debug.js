/**
 * 诊断页本地静态服务器 —— 让 tests/stream-debug.html 走 http:// 打开。
 *
 * 为什么需要 http 而非 file://：
 *   manifest 的 content_scripts matches 是 <all_urls>，它注入 http/https 页面；
 *   Chrome 默认**不向 file:// 页面注入 content script**（除非用户在扩展详情里
 *   手动勾选"允许访问文件网址"）。诊断页依赖 content script（debug/bridge.js）
 *   转发扩展遥测，所以必须走 http://。
 *
 * 用法：
 *   node tests/serve-debug.js            # 默认端口 18923
 *   node tests/serve-debug.js 8080       # 指定端口
 *   然后浏览器打开 http://localhost:18923/tests/stream-debug.html
 *
 * 只托管仓库根目录的静态文件（供诊断页引用的 ../samples/media/sample.mp4 等），
 * 不鉴权、仅本机开发用。无任何外部依赖。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 18923);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // 防路径穿越：resolve 后必须仍在 ROOT 内
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + url.pathname);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`诊断页静态服务器已启动：`);
  console.log(`  http://localhost:${PORT}/tests/stream-debug.html`);
  console.log(`（按 Ctrl+C 停止）`);
});
