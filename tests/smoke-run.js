#!/usr/bin/env node
/**
 * smoke-run.js — run the browser smoke page headlessly and map its DOM
 * summary to a process exit code, so CI can gate on it.
 *
 * Chain: serve-debug.js hosts tests/ (loopback only, exact allowlist extended
 * below) → puppeteer-core drives a real Chrome (WebCrypto/IndexedDB need it)
 * → read #summary ("N passed, M failed"), then exercise the diagnostic page's
 *    local-media picker and noisy-event counter in the same browser.
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

// temp/ 下是本地 harness 常放的 Chrome-for-Testing（AGENTS.md「npm ci」一节提到），
// 版本目录名不固定，这里对两个常见布局各探一次。放最前：本机调试优先用受控版本。
const CFT_DIRS = [
  path.join(ROOT, 'temp', 'chrome-headless-shell'), // puppeteer 布局：*-win64/ 下有 exe
  path.join(ROOT, 'temp', 'chrome-for-testing'),
];
function chromeForTestingCandidate() {
  for (const dir of CFT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const name = fs.readdirSync(dir).find((e) => /win64|linux64|mac/.test(e));
    if (!name) continue;
    const sub = path.join(dir, name);
    const inner = fs.existsSync(sub) && fs.statSync(sub).isDirectory()
      ? fs.readdirSync(sub).find((e) => /^(chrome|chrome-headless-shell|Google Chrome for Testing)(\.exe)?$/i.test(e))
      : null;
    if (inner) return path.join(sub, inner);
  }
  return null;
}

const CHROME_CANDIDATES = [
  process.env.SMOKE_CHROME_PATH,
  chromeForTestingCandidate(),
  process.platform === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.platform === 'win32' && 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  // Edge 在 Windows 上几乎必装且内核同源，作为正式 Chrome 缺失时的兜底
  process.platform === 'win32' && 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.platform === 'linux' && '/usr/bin/google-chrome',
  process.platform === 'linux' && '/usr/bin/google-chrome-stable',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && fs.existsSync(p)) return fs.statSync(p).isFile() ? p : null;
  }
  return null;
}

function waitReady(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve-debug.js did not signal readiness')), 10000);
    let buf = '';
    server.stdout.on('data', (d) => {
      buf += d.toString();
      // serve-debug 的就绪行带机器可读 [ready] 标记 —— 不依赖中文文案，
      // 改日志措辞不会悄悄弄断 CI。
      if (buf.includes('[ready]')) {
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

async function probeDebugLocalMedia(browser, port) {
  const page = await browser.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/404|favicon/i.test(msg.text())) {
      failures.push(msg.text());
    }
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/tests/stream-debug.html`, {
      waitUntil: 'load',
      timeout: 30000,
    });
    const result = await page.evaluate(async () => {
      const input = document.getElementById('localMedia');
      const video = document.getElementById('sampleVideo');

      // Tiny valid PCM WAV: one second of a 440 Hz tone.
      const sampleRate = 8000;
      const sampleCount = sampleRate;
      const wav = new ArrayBuffer(44 + sampleCount * 2);
      const view = new DataView(wav);
      const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) {
          view.setUint8(offset + i, text.charCodeAt(i));
        }
      };
      writeString(0, 'RIFF');
      view.setUint32(4, 36 + sampleCount * 2, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, sampleCount * 2, true);
      for (let i = 0; i < sampleCount; i += 1) {
        const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 10000;
        view.setInt16(44 + i * 2, sample, true);
      }

      const file = new File([wav], 'tone.wav', { type: 'audio/wav' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        video.addEventListener('loadedmetadata', done, { once: true });
        video.addEventListener('error', done, { once: true });
      });

      return {
        currentSrc: video.currentSrc,
        readyState: video.readyState,
        error: video.error && { code: video.error.code, message: video.error.message },
      };
    });
    if (result.readyState < 1 || result.error) {
      failures.push(`local media did not load: ${JSON.stringify(result)}`);
    }
    return { failures, result };
  } finally {
    await page.close();
  }
}

async function probeDebugEventThrottle(browser, port) {
  const page = await browser.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/404|favicon/i.test(msg.text())) {
      failures.push(msg.text());
    }
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/tests/stream-debug.html`, {
      waitUntil: 'load',
      timeout: 30000,
    });
    await page.evaluate(() => {
      for (let i = 0; i < 205; i += 1) {
        window.postMessage({
          type: 'asr:debug-log',
          entry: { phase: 'pcm-stats', detail: { seq: i }, at: Date.now() },
        }, location.origin);
      }
    });
    await page.waitForFunction(
      () => document.getElementById('noisyDropped').textContent === '5',
      { timeout: 10000 },
    );
    const result = await page.evaluate(() => ({
      rows: document.getElementById('evtLog').children.length,
      count: document.getElementById('evtCount').textContent,
      dropped: document.getElementById('noisyDropped').textContent,
    }));
    if (result.rows !== 200 || result.count !== '200' || result.dropped !== '5') {
      failures.push(`noisy-event throttle mismatch: ${JSON.stringify(result)}`);
    }
    return { failures, result };
  } finally {
    await page.close().catch(() => {});
  }
}

async function probeOpfsHandoff(browser, port) {
  const writer = await browser.newPage();
  const reader = await browser.newPage();
  try {
    await writer.goto(`http://localhost:${port}/tests/p1-smoke-test.html`, { waitUntil: 'load', timeout: 30000 });
    const ref = await writer.evaluate(async () => {
      const blob = new Blob(['opfs-handoff'], { type: 'audio/webm' });
      return globalThis.RecordingStore.save(blob);
    });

    await reader.goto(`http://localhost:${port}/tests/p1-smoke-test.html`, { waitUntil: 'load', timeout: 30000 });
    const result = await reader.evaluate(async (recording) => {
      const file = await globalThis.RecordingStore.read(recording);
      const text = await file.text();
      const removed = await globalThis.RecordingStore.remove(recording);
      return { text, removed };
    }, ref);
    if (result.text !== 'opfs-handoff' || result.removed !== true) {
      throw new Error(`OPFS cross-page handoff failed: ${JSON.stringify(result)}`);
    }
    return { ref, result };
  } finally {
    await writer.close().catch(() => {});
    await reader.close().catch(() => {});
  }
}

(async () => {
  // serve-debug 的白名单不含 smoke 页与其依赖脚本；runner 枚举 <script src> 后
  // 用环境开关请它临时追加（仅本进程、仍是精确文件列表）。
  const smokeHtml = fs.readFileSync(path.join(ROOT, 'tests/p1-smoke-test.html'), 'utf8');
  const deps = [];
  let pos = 0;
  while ((pos = smokeHtml.indexOf('<script', pos)) !== -1) {
    const end = smokeHtml.indexOf('>', pos);
    if (end === -1) break;
    const src = /src="([^"]+)"/.exec(smokeHtml.slice(pos, end));
    if (src) {
      deps.push(path.relative(ROOT, path.resolve(ROOT, 'tests', src[1])).replace(/\\/g, '/'));
    }
    pos = end + 1;
  }
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
    const mediaProbe = await probeDebugLocalMedia(browser, PORT);
    console.log(`debug local media: ${JSON.stringify(mediaProbe.result)}`);
    if (mediaProbe.failures.length) {
      console.error('debug local media failures:\n  ' + mediaProbe.failures.slice(0, 10).join('\n  '));
      process.exit(1);
    }
    const throttleProbe = await probeDebugEventThrottle(browser, PORT);
    console.log(`debug event throttle: ${JSON.stringify(throttleProbe.result)}`);
    if (throttleProbe.failures.length) {
      console.error('debug event throttle failures:\n  ' + throttleProbe.failures.slice(0, 10).join('\n  '));
      process.exit(1);
    }
    const opfsProbe = await probeOpfsHandoff(browser, PORT);
    console.log(`OPFS cross-page handoff: ${JSON.stringify(opfsProbe.result)}`);
    process.exit(Number(m[2]) > 0 ? 1 : 0);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('✗ smoke runner failed: ' + (err && err.message));
  process.exit(1);
});
