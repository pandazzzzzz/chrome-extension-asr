// 诊断页静态服务器单元测试 —— 纯 Node，无浏览器依赖。
//
// 覆盖 `tests/serve-debug.js` 的**安全边界与分发契约**（消费方可见的行为）：
//   1. 只托管 `tests/` 与 `samples/` —— `.env.local`（真实 API Key）、`.git/`、
//      `docs/`、`temp/`、`package.json` 等一律不可达；
//   2. 路径穿越（`tests/../.env.local`、`%2e%2e`、`..%2f`）读不到仓库根文件；
//   3. Host 头校验 —— 非回环 Host（DNS rebinding）返回 403；
//   4. 端口被占用时**明确报错并以退出码 1 结束**，不再崩栈。
//
// 这些行为此前完全没有自动化覆盖，是 §「诊断服务加固」暴露出的那几条。
// 服务器以子进程方式拉起，走真实 socket —— **不联网、不落盘、不改 tracked 文件**。
//
// 运行：npm test（或 node tests/serve-debug.test.js）
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(__dirname, 'serve-debug.js');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS | ' + name); }
  catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + (e && e.message)); }
};

/** 找一个空闲端口（先占后放；仅用于避免与常驻诊断服务抢 18923）。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 拉起服务器子进程，**等到就绪行再返回**（返回的即已可用的句柄）。 */
async function startServer(port) {
  const child = spawn(process.execPath, [SERVER, String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { stdout += String(b); });
  child.stderr.on('data', (b) => { stderr += String(b); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('启动超时；stderr=' + stderr.slice(0, 300))), 10000);
    const onData = () => {
      if (!stdout.includes('诊断页静态服务器已启动')) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('提前退出 code=' + code + ' stderr=' + stderr.slice(0, 300)));
    });
  });
  return {
    child,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    }),
  };
}

/** 发一个请求，返回 { status, headers, body }。headers 可覆盖 Host 等。 */
function req(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const port = await findFreePort();
  const srv = await startServer(port);
  try {
    // --- 1. 白名单内的文件可访问 ---
    await t('tests/ 与 samples/ 下的文件可访问，且带 nosniff', async () => {
      const page = await req(port, '/tests/stream-debug.html');
      assert.strictEqual(page.status, 200, '诊断页应可访问');
      assert.match(page.headers['content-type'], /text\/html/, 'Content-Type 应为 html');
      assert.strictEqual(page.headers['x-content-type-options'], 'nosniff', '缺 nosniff');
      assert.ok(page.body.includes('流式诊断页'), '返回的不是诊断页内容');

      const mp4 = await req(port, '/samples/media/sample.mp4');
      assert.strictEqual(mp4.status, 200, '样例视频应可访问（Record Tab 源）');
      assert.match(mp4.headers['content-type'], /video\/mp4/);
    });

    // --- 2. 白名单**之外**的仓库根文件一律不可达 ---
    // 注意边界：白名单是**目录前缀** tests/ 与 samples/，所以 tests/ 下的任何文件
    // （含测试源码、用户放在那里的手测草稿）都会被托管 —— 这是刻意的，诊断页本身
    // 就在 tests/ 下。红线是**仓库根**的敏感文件（密钥、git 元数据、本地草稿）。
    await t('白名单外的敏感路径不可达：.env.local / .git / docs / temp / package.json', async () => {
      const sensitive = [
        '/.env.local',
        '/.git/config',
        '/.git/HEAD',
        '/docs/HANDOFF.md',
        '/temp/verify/lib.js',
        '/package.json',
        '/package-lock.json',
        '/extension.zip',
        '/manifest.json',
      ];
      for (const p of sensitive) {
        const res = await req(port, p);
        assert.notStrictEqual(res.status, 200, `${p} 不应可读（实际 ${res.status}）`);
        assert.ok(!res.body.includes('ASR_TEST_API_KEY'), `${p} 泄漏了 Key 变量名`);
      }
    });

    // --- 2b. .env.local 这条红线的直接断言（本次加固的核心动机）---
    await t('.env.local 在 http 上不可读（Key 不外泄）', async () => {
      const res = await req(port, '/.env.local');
      assert.strictEqual(res.status, 404, `应 404（实际 ${res.status}）`);
      assert.ok(!/ASR_TEST_API_KEY/.test(res.body), '响应体里出现了 Key 变量名');
    });

    // --- 3. 路径穿越：解析后的相对路径必须仍在白名单前缀内 ---
    await t('路径穿越被拦：tests/../.env.local、%2e%2e、..%2f 均读不到根文件', async () => {
      const escapes = [
        '/tests/../.env.local',
        '/tests/..%2f.env.local',
        '/tests/%2e%2e/.env.local',
        '/samples/../../.env.local',
        '/../.env.local',
        '/%2e%2e/%2e%2e/Windows/win.ini',
      ];
      for (const p of escapes) {
        const res = await req(port, p);
        assert.notStrictEqual(res.status, 200, `${p} 穿越成功（实际 ${res.status}）`);
        assert.ok(!res.body.includes('ASR_TEST_API_KEY'), `${p} 读到了 .env.local`);
      }
    });

    // --- 4. Host 头校验（DNS rebinding 面）---
    await t('Host 非回环 → 403；localhost / 127.0.0.1 / [::1] → 200', async () => {
      const evil = await req(port, '/tests/stream-debug.html', { Host: 'evil.example.com' });
      assert.strictEqual(evil.status, 403, `非回环 Host 应 403（实际 ${evil.status}）`);

      const evilKey = await req(port, '/.env.local', { Host: 'attacker.test' });
      assert.notStrictEqual(evilKey.status, 200, '伪造 Host 后仍可读 .env.local');

      for (const host of ['localhost:' + port, '127.0.0.1:' + port, `[::1]:${port}`]) {
        const ok = await req(port, '/tests/stream-debug.html', { Host: host });
        assert.strictEqual(ok.status, 200, `合法 Host ${host} 应放行（实际 ${ok.status}）`);
      }
    });

    // --- 5. 畸形路径不崩服务 ---
    await t('畸形 % 编码 → 400，服务继续存活', async () => {
      const bad = await req(port, '/%zz');
      assert.strictEqual(bad.status, 400, `畸形编码应 400（实际 ${bad.status}）`);
      const after = await req(port, '/tests/stream-debug.html');
      assert.strictEqual(after.status, 200, '畸形请求后服务应仍可用');
    });
  } finally {
    await srv.stop();
  }

  // --- 6. 端口占用：明确报错 + 退出码 1（不再崩栈）---
  await t('端口被占用 → 退出码 1 且 stderr 给出可操作提示', async () => {
    const busyPort = await findFreePort();
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.on('error', reject);
      blocker.listen(busyPort, '127.0.0.1', resolve);
    });
    try {
      const child = spawn(process.execPath, [SERVER, String(busyPort)], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (b) => { stderr += String(b); });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('未在 10s 内退出')); }, 10000);
        child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
      });
      assert.strictEqual(code, 1, `退出码应为 1（实际 ${code}）`);
      assert.match(stderr, /EADDRINUSE|已被占用/, 'stderr 未说明端口占用');
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
