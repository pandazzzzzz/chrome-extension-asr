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
 *   SERVE_LOG=1 node tests/serve-debug.js # 打印访问日志（诊断 404/请求序列用）
 *   然后浏览器打开 http://localhost:18923/tests/stream-debug.html
 *
 * 安全边界 —— 这是本仓库唯一对外开 socket 的开发组件，下面两条都不能松：
 *   1. **只托管诊断页所需的精确文件**（`SERVE_FILES`）。绝不要退回成
 *      "托管仓库根目录"：根下有 `.env.local`（真实 API Key）、`.git/`、
 *      `docs/HANDOFF.md`、`temp/` 等，那等于把 Key 与全部本地草稿暴露给
 *      任何能访问 localhost 的进程或网页。也不要改回 `tests/` 目录前缀：
 *      手测计划和导出的诊断日志也放在那里，它们可能含凭据或用户数据。
 *   2. **校验 Host 头只认回环名**（`ALLOWED_HOSTNAMES`）。不校验的话，恶意页
 *      把某个域名解析到 127.0.0.1（DNS rebinding）就能以"同源"身份读走这些
 *      文件 —— 浏览器不会拦，且**不需要任何 CORS 头**。
 *   无鉴权，仅本机开发用。无任何外部依赖。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 18923);

// 端口必须在拉起任何 server 之前校验：listen(NaN) 会同步抛未捕获异常，
// 调用方只能看到一段栈，分不清是参数错了还是端口被占。
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`无效端口 "${process.argv[2] || process.env.PORT}"：需要 1-65535 的整数。`);
  process.exit(1);
}

// 访问日志默认关闭：静默是常态；诊断"页面到底请求了什么 / 有没有 404"时再开。
const LOG_REQUESTS = process.env.SERVE_LOG === '1';

// 精确文件白名单（相对 ROOT）。未命中一律 404 —— 不区分"不存在"与"不许访问"，
// 避免用状态码差异探测仓库里有哪些文件。诊断页的脚本必须列在这里。
const SERVE_FILES = new Set([
  'tests/stream-debug.html',
  'tests/debug-redact.js',
]);
// 本地工具（如 smoke-run.js）可用 SERVE_EXTRA_FILES 追加精确文件列表（逗号分隔、
// 相对 ROOT）；仍是精确白名单，不开放目录，也不影响默认行为。
if (process.env.SERVE_EXTRA_FILES) {
  for (const p of process.env.SERVE_EXTRA_FILES.split(',')) {
    if (!p) continue;
    const rel = path.relative(ROOT, path.resolve(ROOT, p)).replace(/\\/g, '/');
    SERVE_FILES.add(rel);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Host 头白名单：只认回环。浏览器对 IPv6 回环的 Host 会带方括号（WHATWG URL 规范）。
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** 从 Host 头取出主机名（剥掉端口；IPv6 保留方括号形式）。大小写不敏感。 */
function hostnameOf(hostHeader) {
  // 小写化：URL 规范里 host 是小写的，Chrome 也照此发送，但别把规范化寄托在
  // 客户端上 —— 一个大小写变体不该让合法请求吃 403。
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

const handleRequest = (req, res) => {
  // 静态文件服务只回答 GET/HEAD：POST/PUT/DELETE 也走文件分发等于多开了一条
  // 与读文件无异的通路，405 把面收掉。
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  // 1) Host 校验（防 DNS rebinding）。放在最前：非法 Host 不该拿到任何信息。
  if (!ALLOWED_HOSTNAMES.has(hostnameOf(req.headers.host))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: unexpected Host header');
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  // 防路径穿越：resolve 后必须仍在 ROOT 内。
  // decodeURIComponent 遇非法 % 序列会抛 URIError —— 单独兜底，别让畸形请求打崩服务器。
  let raw;
  try {
    raw = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request: malformed path');
    return;
  }
  const filePath = path.resolve(ROOT, raw);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // 2) 白名单判定必须用**解析后的相对路径**，不能用原始串 —— 否则
  //    `tests/../.env.local` 会因以 "tests/" 开头而放行，实际却读到根下的密钥文件。
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  if (!SERVE_FILES.has(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + url.pathname);
    return;
  }

  const isHead = req.method === 'HEAD';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + url.pathname);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 防 MIME 嗅探：浏览器不得把 .txt/.json 当脚本执行。
      'X-Content-Type-Options': 'nosniff',
      // 开发期不缓存：改了 stream-debug.html / 素材后刷新即见，不用清缓存。
      'Cache-Control': 'no-store',
    });
    // HEAD 只回头不回体（保持与 GET 同形，便于探活/缓存判断）
    res.end(isHead ? undefined : data);
  });
};

// 仅绑回环：文件头声明"仅本机开发用""不鉴权"。默认 0.0.0.0/:: 会把服务暴露到
// LAN/公网 —— 必须限制到回环。
// 同时绑 IPv4 与 IPv6 回环：bridge 会认 hostname '[::1]'（见 1d6383c），只绑
// 127.0.0.1 会让 http://[::1]:PORT/... 连不上。
//
// 每个回环必须用**独立的 server 实例**：对同一个 server 连调两次 listen() 时，
// Node 让后一次接管，前一次静默失效（实测 address() 只剩 '::1'，127.0.0.1 直接
// ECONNREFUSED），而 bridge 的白名单同时接受 127.0.0.1 与 localhost。
const LOOPBACKS = ['127.0.0.1', '::1'];
LOOPBACKS.forEach((host) => {
  const server = http.createServer(handleRequest);
  if (LOG_REQUESTS) {
    server.on('request', (req, res) => {
      res.on('finish', () => {
        console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${res.statusCode}`);
      });
    });
  }
  server.on('error', (err) => {
    // 某回环族不可用（如系统禁用 IPv6）→ EADDRNOTAVAIL，忽略该族即可。
    if (err.code === 'EADDRNOTAVAIL') {
      console.warn(`跳过 ${host}：本机不支持该地址族（EADDRNOTAVAIL）`);
      return;
    }
    // 其余错误必须**明确报错退出**：以前这里直接 `throw err`，而在 'error'
    // 回调里抛出 = 未捕获异常 → 进程崩栈，调用方（本地探针 / 后台任务）只看
    // 到一串栈，容易误判成"服务器已就绪"。
    console.error(`诊断页服务器无法监听 ${host}:${PORT} —— ${err.code || err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用：先停掉占用的进程，或用 \`node tests/serve-debug.js <其他端口>\` 另选端口。`);
    }
    process.exit(1);
  });
  server.listen(PORT, host, () => {
    const shown = host.includes(':') ? `[${host}]` : host;
    // "ready" 是给 smoke-run.js 的机器可读标记（ASCII，不受日志文案改动影响）；
    // 其余输出保持中文给本地开发者读。
    console.log(`诊断页静态服务器已启动 [ready]： http://${shown}:${PORT}/tests/stream-debug.html`);
    console.log(`  只托管诊断页与 debug-redact.js；其余路径（含 tests/ 下的本地计划/日志、.env.local、.git/、docs/、temp/）一律 404。`);
  });
});
console.log(`（按 Ctrl+C 停止）`);
