'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVE_DEBUG = path.join(ROOT, 'tests', 'serve-debug.js');

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
  return !!ok;
}

function failureCount() {
  return failures;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 15000, interval = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function pollPage(page, predicate, timeout, label) {
  return waitFor(() => page.evaluate(predicate), { timeout, label });
}

function hookPage(page) {
  page.__e2eErrors = [];
  page.on('pageerror', (error) => page.__e2eErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/404|favicon|Access denied/i.test(message.text())) {
      page.__e2eErrors.push(message.text());
    }
  });
  return page;
}

async function startServer(port) {
  const child = spawn(process.execPath, [SERVE_DEBUG, String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`diagnostic server timeout: ${output}`));
    }, 10000);
    const poll = setInterval(() => {
      if (output.includes('[ready]')) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
    child.once('exit', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`diagnostic server exited early (${code}): ${output}`));
    });
  });
  return {
    child,
    stop() {
      if (!child.killed) child.kill();
    },
  };
}

function localCandidates() {
  return [
    path.join(ROOT, 'temp', 'verify', 'chrome-win64', 'chrome.exe'),
    path.join(ROOT, 'temp', 'verify', 'chrome-linux64', 'chrome'),
    path.join(ROOT, 'temp', 'verify', 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(ROOT, 'temp', 'verify', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  ];
}

function systemCandidates() {
  return [
    process.platform === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    process.platform === 'win32' && 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.platform === 'linux' && '/usr/bin/google-chrome',
    process.platform === 'linux' && '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
}

function findExecutable(dir, names, depth = 0) {
  if (!fs.existsSync(dir) || depth > 6) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && names.includes(entry.name)) return full;
    if (!entry.isDirectory()) continue;
    const found = findExecutable(full, names, depth + 1);
    if (found) return found;
  }
  return null;
}

async function installedChromeForTesting() {
  const cacheDirs = [
    path.join(ROOT, '.cache', 'chrome'),
    path.join(ROOT, '.cache', 'puppeteer'),
  ];
  for (const cacheDir of cacheDirs) {
    const executable = findExecutable(cacheDir, ['chrome', 'chrome.exe']);
    if (executable) return executable;
  }
  return null;
}

async function findChrome() {
  for (const candidate of [process.env.E2E_CHROME_PATH, process.env.SMOKE_CHROME_PATH, ...localCandidates()]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const installed = await installedChromeForTesting();
  if (installed) return installed;
  for (const candidate of systemCandidates()) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function removeTempDir(dir, { attempts = 6, delay = 400 } = {}) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(tempRoot)) {
    throw new Error(`refusing to remove non-temp directory: ${resolved}`);
  }
  // Windows keeps a Chrome profile locked while the browser still owns it, so a
  // single rmSync throws EPERM. Cleanup runs in `finally` blocks: letting that
  // error escape would replace a real assertion failure with a confusing stack
  // and leak a multi-hundred-MB directory. Retry while the browser shuts down,
  // then warn instead of throwing (issue #132).
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      return true;
    } catch (error) {
      const retriable = ['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'].includes(error.code);
      if (!retriable || attempt === attempts) {
        console.warn(`  WARN | left ${resolved} on disk (${error.code || error.message}); remove it manually`);
        return false;
      }
      await sleep(delay);
    }
  }
  return false;
}

async function launchExtension(executablePath, { fakeMedia = true, extraArgs = [] } = {}) {
  const userDataDir = tempDir('chrome-asr-e2e-profile-');
  const speech = process.env.ASR_TEST_SPEECH;
  const args = [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--autoplay-policy=no-user-gesture-required',
    ...extraArgs,
  ];
  if (fakeMedia) {
    args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');
    if (speech && fs.existsSync(path.resolve(ROOT, speech))) {
      // Chrome resolves a bare --use-file-for-fake-audio-capture path against
      // its process CWD, not the repository. Pass an absolute path explicitly.
      args.push(`--use-file-for-fake-audio-capture=${path.resolve(ROOT, speech)}`);
    }
  }
  const browser = await puppeteer.launch({
    executablePath,
    headless: process.env.E2E_HEADLESS === 'false' ? false : 'new',
    userDataDir,
    args,
    defaultViewport: null,
  });
  return { browser, userDataDir };
}

async function waitForExtension(browser) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === 'service_worker'
      && candidate.url().startsWith('chrome-extension://'),
    { timeout: 20000 },
  );
  const worker = await target.worker();
  const extensionId = new URL(target.url()).host;
  const extension = (await browser.extensions()).get(extensionId);
  if (!extension) throw new Error(`extension ${extensionId} was not registered with Puppeteer`);
  return { extensionId, extension, worker };
}

async function openPopup(browser, extensionId) {
  const page = hookPage(await browser.newPage());
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
    waitUntil: 'load',
    timeout: 20000,
  });
  await page.waitForFunction(
    () => document.querySelectorAll('#provider option').length > 0,
    { timeout: 10000 },
  );
  await sleep(800);
  return page;
}

async function openDiagnosticPage(browser, port) {
  const page = hookPage(await browser.newPage());
  await page.goto(`http://127.0.0.1:${port}/tests/stream-debug.html`, {
    waitUntil: 'load',
    timeout: 20000,
  });
  return page;
}

async function axText(page) {
  const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
  const parts = [];
  (function walk(node) {
    if (!node) return;
    if (node.name) parts.push(node.name);
    (node.children || []).forEach(walk);
  })(snapshot);
  return parts.join(' | ');
}

module.exports = {
  ROOT,
  axText,
  check,
  failureCount,
  findChrome,
  hookPage,
  launchExtension,
  openDiagnosticPage,
  openPopup,
  pollPage,
  removeTempDir,
  sleep,
  startServer,
  tempDir,
  waitFor,
  waitForExtension,
};
