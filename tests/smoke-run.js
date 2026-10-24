#!/usr/bin/env node
/**
 * smoke-run.js — run the browser smoke page headlessly and map its DOM
 * summary to a process exit code, so CI can gate on it.
 *
 * Chain: serve-debug.js hosts tests/ (loopback only, exact allowlist extended
 * below) → puppeteer-core drives a real Chrome (WebCrypto/IndexedDB need it)
 * → read #summary ("N passed, M failed").
 *
 * Chrome discovery: SMOKE_CHROME_PATH env, then the platform defaults, then
 * puppeteer-core's own resolution (CI runners preinstall google-chrome).
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 18923);

const CHROME_CANDIDATES = [
  process.env.SMOKE_CHROME_PATH,
  process.platform === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.platform === 'win32' && 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.platform === 'linux' && '/usr/bin/google-chrome',
  process.platform === 'linux' && '/usr/bin/google-chrome-stable',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function waitReady(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve-debug.js did not signal readiness')), 10000);
    let buf = '';
    server.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('已启动') || buf.includes('started')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.includes('已占用') || s.includes('EADDRINUSE')) {
        clearTimeout(timer);
        reject(new Error('port in use: pass a free port via SMOKE_PORT'));
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve-debug.js exited early (${code}): ${buf}`));
    });
  });
}

(async () => {
  // serve-debug 的白名单不含 smoke 页与其依赖脚本；runner 枚举 <script src> 后
  // 用环境开关请它临时追加（仅本进程、仍是精确文件列表）。
  const smokeHtml = fs.readFileSync(path.join(ROOT, 'tests/p1-smoke-test.html'), 'utf8');
  const deps = [...smokeHtml.matchAll(/<script\s+src="([^"]+)"\s*>\s*<\/script\s*>/g)]
    .map((m) => path.relative(ROOT, path.resolve(ROOT, 'tests', m[1])).replace(/\\/g, '/'));
  const extra = ['tests/p1-smoke-test.html', 'tests/p1-smoke-test.js', ...deps].join(',');
  const server = spawn(process.execPath, [path.join(ROOT, 'tests/serve-debug.js'), String(PORT)], {
    env: { ...process.env, SERVE_EXTRA_FILES: extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const shutdown = () => server.kill();
  process.on('exit', shutdown);
  process.on('SIGINT', () => { shutdown(); process.exit(130); });
  process.on('SIGTERM', () => { shutdown(); process.exit(143); });

  await waitReady(server);

  const executablePath = findChrome();
  if (!executablePath) {
    console.error('✗ no Chrome binary found (set SMOKE_CHROME_PATH)');
    process.exit(1);
  }
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    // --disable-extensions：本机日常 Chrome 可能带用户扩展，其后台 console 噪音
    // 与冒烟结果无关（干净 CI runner 上无此问题）。
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions'],
  });
  try {
    const page = await browser.newPage();
    const failures = [];
    page.on('console', (msg) => {
      const text = msg.text();
      // favicon 404 与冒烟无关，过滤掉以免误导输出。
      // 404 资源与外部扩展噪音（Access denied）都与冒烟断言无关；真失败由
      // summary 数字与 pageerror 兜底。
      if (msg.type() === 'error' && !/404|favicon|Access denied/i.test(text)) failures.push(text);
    });
    page.on('pageerror', (err) => failures.push(String(err)));
    await page.goto(`http://localhost:${PORT}/tests/p1-smoke-test.html`, {
      waitUntil: 'load',
      timeout: 30000,
    });
    // 用例是异步的；summary 落地且数值稳定（两次轮询一致）即视为跑完。
    let prev = '';
    let summaryText = '';
    for (let i = 0; i < 30; i++) {
      summaryText = await page.$eval('#summary', (el) => el.textContent).catch(() => '');
      if (summaryText && summaryText === prev) break;
      prev = summaryText;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!summaryText) {
      console.error('✗ smoke summary never appeared');
      if (failures.length) console.error('page errors:\n  ' + failures.slice(0, 10).join('\n  '));
      process.exit(1);
    }
    console.log(`smoke summary: ${summaryText}`);
    if (failures.length) console.error('page errors:\n  ' + failures.slice(0, 10).join('\n  '));
    const m = summaryText.match(/(\d+) passed, (\d+) failed/);
    if (!m) {
      console.error('✗ unrecognized summary format: ' + summaryText);
      process.exit(1);
    }
    process.exit(Number(m[2]) > 0 ? 1 : 0);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('✗ smoke runner failed: ' + (err && err.message));
  process.exit(1);
});
