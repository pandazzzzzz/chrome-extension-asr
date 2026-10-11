// 打包产物单元测试 —— 纯 Node，无浏览器依赖。
//
// 覆盖 `npm run pack` 的**分发契约**（消费方可见的行为，而非实现细节）：
//   1. manifest.json 引用的每个路径都在 zip 内（打包不能丢运行所需文件）；
//   2. zip 内不含 dev-only / agent 产物。
//
// 第 2 条针对的是 collectFromDisk() 回退路径（git 不可用时）—— 它读不到
// .gitignore，只能靠 scripts/pack.js 的静态 EXCLUDE。曾实测该路径会打进
// 203 篇 agent skill 文档（1.8MB）+ package*.json + samples/ + scripts/。
//
// 运行：npm test（或 node tests/pack.test.js）
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'extension.zip');

/** 解析 zip 中央目录，返回条目名列表（不落盘）。 */
function readZipEntries(buf) {
  const names = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue; // 中央目录头签名
    const nlen = buf.readUInt16LE(i + 28);
    names.push(buf.toString('utf8', i + 46, i + 46 + nlen));
  }
  return names;
}

// 走 --node 强制 node:zlib 后端：它同时会走 collectFromDisk() 那条回退收集
// （git 缺失时），正是本次修复的对象。
const run = spawnSync(process.execPath, ['scripts/pack.js', '--node'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, PATH: 'C:\\Windows\\System32' }, // 屏蔽 git
});
const entries = fs.existsSync(OUT) ? readZipEntries(fs.readFileSync(OUT)) : [];

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS | ' + name); }
  catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + e.message); }
};

t('pack 成功产出 zip', () => {
  assert.strictEqual(run.status, 0, 'pack 退出码非 0: ' + (run.stderr || '').slice(0, 200));
  assert.ok(entries.length > 0, 'zip 为空');
});

t('manifest 引用的每个路径都在 zip 内', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const refs = new Set();
  const add = (p) => { if (typeof p === 'string' && p) refs.add(p.replace(/^\.\//, '')); };
  add(m.background?.service_worker);
  add(m.action?.default_popup);
  add(m.side_panel?.default_path);
  add(m.options_ui?.page);
  Object.values(m.icons ?? {}).forEach(add);
  Object.values(m.action?.default_icon ?? {}).forEach(add);
  for (const cs of m.content_scripts ?? []) {
    (cs.js ?? []).forEach(add);
    (cs.css ?? []).forEach(add);
  }
  const missing = [...refs].filter((r) => !entries.includes(r));
  assert.deepStrictEqual(missing, [], 'zip 缺少 manifest 引用的路径');
});

t('zip 不含 agent skill 产物（.agents/ .claude/ skills-lock.json）', () => {
  const bad = entries.filter((e) => /^(\.agents|\.claude)\//.test(e) || e === 'skills-lock.json');
  assert.deepStrictEqual(bad, [], 'zip 混入 agent 产物');
});

t('zip 不含 dev-only 文件（package*.json / samples / scripts / .github / 编辑器配置 / README）', () => {
  const bad = entries.filter((e) => /^package(-lock)?\.json$/.test(e)
    || /^(samples|scripts|\.github)\//.test(e)
    || /^\.(editorconfig|prettierrc)$/.test(e)
    || /(^|\/)README\.md$/.test(e));
  assert.deepStrictEqual(bad, [], 'zip 混入 dev-only 文件');
});

t('zip 保留 LICENSE（法律声明，非 dev 工具）', () => {
  assert.ok(entries.includes('LICENSE'), 'LICENSE 应随分发产物发布');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' total)');
process.exit(fail ? 1 : 0);
