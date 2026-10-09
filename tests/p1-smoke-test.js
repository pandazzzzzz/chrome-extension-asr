/**
 * P1 smoke tests — 由 tests/p1-smoke-test.html 以 <script src> 加载。
 *
 * 为什么独立成文件：扩展页面的 MV3 CSP 是 `script-src 'self'`，内联 <script>
 * 会被拦截（此前把本页作为 chrome-extension:// 打开时 0 个用例执行、无任何提示）。
 * 外置后同一份测试可在三种上下文运行：file:// / http:// / chrome-extension://。
 *
 * 依赖（由 HTML 以 <script src> 先加载）：shared/errors.js、shared/timeout.js、
 * messaging/messages.js、messaging/client.js、store/crypto.js、store/config.js、
 * audio/convert.js、audio/recorder.js。
 */
const results = document.getElementById('results');
const summary = document.getElementById('summary');
let passed = 0, failed = 0;

function addResult(name, ok, detail) {
  const div = document.createElement('div');
  div.className = 'case ' + (ok ? 'pass' : 'fail');
  div.innerHTML = `<div class="name">${ok ? '✓' : '✗'} ${name}</div>` +
    (detail ? `<div class="detail">${detail}</div>` : '');
  results.appendChild(div);
  ok ? passed++ : failed++;
}

function finish() {
  summary.textContent = `${passed} passed, ${failed} failed (${passed + failed} total)`;
  summary.style.color = failed ? '#8a2430' : '#1b6f3d';
  summary.style.fontWeight = 'bold';
}

async function runTests() {
  // --- 1. CryptoStore: encrypt / decrypt roundtrip ---
  try {
    const plain = 'sk-test-abc123xyz';
    const enc = await globalThis.CryptoStore.encrypt(plain);
    const dec = await globalThis.CryptoStore.decrypt(enc);
    const ok = dec === plain && enc !== plain;
    addResult('CryptoStore: encrypt/decrypt roundtrip', ok,
      ok ? `plain="${plain.slice(0,12)}..." -> enc len=${enc.length} -> dec matches` :
      `dec="${dec}"`);
  } catch (e) {
    addResult('CryptoStore: encrypt/decrypt roundtrip', false, e.message);
  }

  // --- 2. CryptoStore: empty string roundtrip ---
  try {
    const r1 = await globalThis.CryptoStore.encrypt('');
    const r2 = await globalThis.CryptoStore.decrypt('');
    addResult('CryptoStore: empty string returns empty', r1 === '' && r2 === '',
      `encrypt("")="${r1}", decrypt("")="${r2}"`);
  } catch (e) {
    addResult('CryptoStore: empty string', false, e.message);
  }

  // --- 3. CryptoStore: decrypt wrong ciphertext ---
  try {
    await globalThis.CryptoStore.decrypt(btoa('not-valid-ciphertext'));
    addResult('CryptoStore: invalid ciphertext throws', false, 'should have thrown');
  } catch (e) {
    addResult('CryptoStore: invalid ciphertext throws', true, e.message.slice(0, 80));
  }

  // --- 4. ConfigStore: module loaded on globalThis ---
  try {
    const ok = typeof globalThis.ConfigStore === 'object'
      && typeof globalThis.ConfigStore.load === 'function'
      && typeof globalThis.ConfigStore.save === 'function';
    addResult('ConfigStore: module loaded on globalThis', ok,
      ok ? 'ConfigStore.load/save functions available' : 'missing');
  } catch (e) {
    addResult('ConfigStore: module loaded', false, e.message);
  }

  // --- 5. Messages: constants defined and frozen ---
  try {
    const m = globalThis.MESSAGES;
    const ok = m.FILL_TEXT === 'asr:fill-text'
      && m.SUBTITLE_SHOW === 'asr:subtitle-show'
      && m.SUBTITLE_HIDE === 'asr:subtitle-hide'
      && m.TAB_RECORD_START === 'asr:tab-record-start'
      && m.TAB_RECORD_STOP === 'asr:tab-record-stop'
      && m.TRANSCRIBE === undefined
      && Object.isFrozen(m);
    addResult('MESSAGES: constants defined and frozen', ok,
      `FILL_TEXT="${m.FILL_TEXT}", SUBTITLE_SHOW="${m.SUBTITLE_SHOW}", SUBTITLE_HIDE="${m.SUBTITLE_HIDE}", TAB_RECORD_START="${m.TAB_RECORD_START}", TAB_RECORD_STOP="${m.TAB_RECORD_STOP}", TRANSCRIBE removed=${m.TRANSCRIBE === undefined}`);
  } catch (e) {
    addResult('MESSAGES: constants', false, e.message);
  }

  // --- 6. MessageClient: module loaded ---
  try {
    const ok = typeof globalThis.MessageClient === 'object'
      && typeof globalThis.MessageClient.send === 'function';
    addResult('MessageClient: module loaded on globalThis', ok,
      'MessageClient.send available');
  } catch (e) {
    addResult('MessageClient: module loaded', false, e.message);
  }

  // --- 7. Errors: unified codes + normalizeError ---
  try {
    const e = globalThis.Errors;
    const required = ['NO_PROVIDER', 'NO_API_KEY', 'NO_AUDIO',
      'API_ERROR', 'EMPTY_RESULT', 'UNKNOWN_ACTION', 'UNKNOWN'];
    const codesOk = required.every(k => e[k] && e[k].code === k && typeof e[k].message === 'string');
    const norm1 = globalThis.normalizeError({ code: 'NO_API_KEY', message: 'x' });
    const norm1Ok = norm1.code === 'NO_API_KEY';
    const norm2 = globalThis.normalizeError(new Error('boom'));
    const norm2Ok = norm2.code === 'API_ERROR' && norm2.message === 'boom';
    const allOk = codesOk && norm1Ok && norm2Ok;
    addResult('Errors: codes + normalizeError', allOk,
      `codes ok=${codesOk}, normalize(known)=${norm1Ok}, normalize(unknown)=${norm2Ok}`);
  } catch (e) {
    addResult('Errors: codes', false, e.message);
  }

  // --- 8. globalThis compatibility (shared modules on globalThis, not window) ---
  try {
    const ok = typeof globalThis.MessageClient === 'object'
      && typeof globalThis.ConfigStore === 'object'
      && typeof globalThis.CryptoStore === 'object'
      && typeof globalThis.MESSAGES === 'object'
      && typeof globalThis.Errors === 'object';
    addResult('globalThis: shared modules on globalThis (SW-compatible)', ok,
      'MessageClient/ConfigStore/CryptoStore/MESSAGES/Errors all on globalThis');
  } catch (e) {
    addResult('globalThis: compat', false, e.message);
  }

  // --- 9. withTimeout: 超时 reject（带 TIMEOUT code）+ 提前 settle 原样透传 ---
  try {
    let timedOut = false;
    try {
      await globalThis.withTimeout(new Promise(() => {}), 20, 'hang-test');
    } catch (e) {
      timedOut = e.code === 'TIMEOUT' && /hang-test/.test(e.message);
    }
    const quick = await globalThis.withTimeout(Promise.resolve('v'), 1000, 'quick');
    let rejectPassed = false;
    try {
      await globalThis.withTimeout(Promise.reject(new Error('inner')), 1000, 'rej');
    } catch (e) { rejectPassed = e.message === 'inner'; }
    const ok = timedOut && quick === 'v' && rejectPassed;
    addResult('withTimeout: timeout + resolve/reject passthrough', ok,
      `timeout=${timedOut}, resolve-passthrough=${quick === 'v'}, reject-passthrough=${rejectPassed}`);
  } catch (e) {
    addResult('withTimeout', false, e.message);
  }

  // --- 10. CryptoStore: 密钥 extractable:false（不可导出）---
  try {
    const dbOpenReq = indexedDB.open('asr-crypto', 2); // 与模块同版本，不触发 upgrade
    const db1 = await new Promise((res, rej) => {
      dbOpenReq.onsuccess = () => res(dbOpenReq.result);
      dbOpenReq.onerror = () => rej(dbOpenReq.error);
    });
    const k = await new Promise((res, rej) => {
      const r = db1.transaction('keys', 'readonly').objectStore('keys').get('main');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db1.close();
    // 前置：用例 1 的 encrypt 已生成并写入 'main'；取不到说明存储链路本身坏了
    const ok = !!k && k instanceof CryptoKey && k.extractable === false && k.algorithm.name === 'AES-GCM';
    addResult('CryptoStore: key non-extractable (AES-GCM)', ok,
      k ? `type=${k && k.constructor && k.constructor.name}, extractable=${k && k.extractable}` : 'no key record — test 1 must pass first');
  } catch (e) {
    addResult('CryptoStore: key non-extractable', false, e.message);
  }

  // --- 11. CryptoStore: DB 句柄缓存（多次加解密不再重复 open —— 连接泄漏回归）---
  try {
    let opens = 0;
    const realOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = function counted() { opens++; return realOpen.apply(null, arguments); };
    await Promise.all([
      globalThis.CryptoStore.encrypt('a'),
      globalThis.CryptoStore.encrypt('b'),
    ]);
    const rt = await globalThis.CryptoStore.decrypt(await globalThis.CryptoStore.encrypt('c'));
    indexedDB.open = realOpen; // 还原
    const ok = opens === 0 && rt === 'c';
    addResult('CryptoStore: cached DB handle (0 new opens across ops)', ok,
      `indexedDB.open 调用次数=${opens}（期望 0，句柄已缓存）, roundtrip=${rt === 'c'}`);
  } catch (e) {
    addResult('CryptoStore: connection cache', false, e.message);
  }

  // --- 12. encodeAudio / decodeAudio roundtrip ---
  try {
    const payload = new Uint8Array(1000).map((_, i) => i % 251);
    const enc = await globalThis.encodeAudio(new Blob([payload], { type: 'audio/mp4' }));
    const dec = globalThis.decodeAudio(enc);
    const back = new Uint8Array(await dec.arrayBuffer());
    const ok = back.length === payload.length
      && back.every((v, i) => v === payload[i])
      && enc.mime === 'audio/mp4';
    addResult('encodeAudio/decodeAudio: roundtrip + mime', ok,
      `bytes=${back.length}, mime=${enc.mime}`);
  } catch (e) {
    addResult('encodeAudio/decodeAudio roundtrip', false, e.message);
  }

  // --- 13. decodeAudio: 非法输入返回 null ---
  try {
    const ok = globalThis.decodeAudio(null) === null
      && globalThis.decodeAudio({ b64: 123 }) === null
      && globalThis.decodeAudio({ b64: 'not@valid!!' }) === null;
    addResult('decodeAudio: invalid input → null', ok);
  } catch (e) {
    addResult('decodeAudio invalid input', false, e.message);
  }

  // --- 14. floatToInt16: clamp + 端点 ---
  try {
    const out = globalThis.floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    // 注意 Int16Array 写入是**截断**（ToIntegerOrInfinity），不是四舍五入：
    // 0.5 * 32767 = 16383.5 → 16383（用 Math.round 断言会误判成 16384）。
    const ok = out[0] === 0 && out[1] === 32767 && out[2] === -32768
      && out[3] === 32767 && out[4] === -32768
      && out[5] === Math.trunc(0.5 * 32767);
    addResult('floatToInt16: clamp to int16 range', ok, `out=[${out}]`);
  } catch (e) {
    addResult('floatToInt16 clamp', false, e.message);
  }

  // --- 15. resampleFloat32: 同采样率 + 48k→16k 长度/内容 ---
  try {
    const src = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0]);
    const same = globalThis.resampleFloat32(src, 16000, 16000);
    const down = globalThis.resampleFloat32(src, 48000, 16000);
    const ok = same === src
      && down.length === Math.round(src.length / 3)
      && Math.abs(down[0] - 0) < 1e-6
      && Number.isFinite(down[1]);
    addResult('resampleFloat32: identity + 48k→16k', ok,
      `identity=${same === src}, outLen=${down.length}/${src.length}`);
  } catch (e) {
    addResult('resampleFloat32', false, e.message);
  }

  // --- 16. AudioRecorder: 未挂载时 stop() 拒绝；release 幂等 ---
  try {
    const rec = new globalThis.AudioRecorder();
    let threw = false;
    try { await rec.stop(); } catch (e) { threw = /Not recording/.test(e.message); }
    rec.release(); rec.release(); // 重复调用不应抛
    const ok = threw && rec.recorder === null && rec.isRecording === false;
    addResult('AudioRecorder: stop-before-start rejects, release idempotent', ok,
      `rejected=${threw}`);
  } catch (e) {
    addResult('AudioRecorder guards', false, e.message);
  }

  // --- 17. MessageClient.send: 超时参数生效（stub sendMessage 永不回调 → TIMEOUT 兜底）---
  try {
    // 三种上下文都要能跑：普通页面 chrome 存在但 chrome.runtime 不存在（file://、http://），
    // 扩展页面两者都在（chrome-extension://），非 Chrome 下 chrome 完全没有。
    // 只判断 chrome 是否存在会把前一种当成"有真 sendMessage"，随后在 undefined 上取属性而抛错。
    const hadChrome = !!globalThis.chrome;
    if (!globalThis.chrome) globalThis.chrome = {};
    const hadRuntime = !!globalThis.chrome.runtime;
    if (!hadRuntime) globalThis.chrome.runtime = {};
    const realSend = globalThis.chrome.runtime.sendMessage; // 普通页面上为 undefined
    // 永不回调的 stub：真实环境里接收方被杀就是这种表现
    globalThis.chrome.runtime.sendMessage = () => {};
    let timedOut = false;
    let timedMsg = '';
    try {
      await globalThis.MessageClient.send(
        globalThis.MESSAGES.FILL_TEXT, { text: 'x' }, globalThis.TARGETS.BACKGROUND, 40);
    } catch (e) { timedOut = e.code === 'TIMEOUT'; timedMsg = e.message || ''; }
    // 还原现场：有真 sendMessage 就还原，否则删掉我们自己加的 stub / runtime
    if (realSend === undefined) delete globalThis.chrome.runtime.sendMessage;
    else globalThis.chrome.runtime.sendMessage = realSend;
    if (!hadRuntime) delete globalThis.chrome.runtime;
    if (!hadChrome) delete globalThis.chrome;
    const ok = timedOut && /sendMessage asr:fill-text/.test(timedMsg);
    addResult('MessageClient: send() honors timeoutMs', ok,
      `timeout=${timedOut}, label-in-message=${/sendMessage asr:fill-text/.test(timedMsg)}`);
  } catch (e) {
    addResult('MessageClient timeout', false, e.message);
  }

  // --- 18. 音频输入设备：约束构造（'' = 系统默认；非空 = exact deviceId）---
  try {
    const def = globalThis.audioConstraintsForDevice('');
    const picked = globalThis.audioConstraintsForDevice('abc123');
    const ok = def.audio === true
      && picked.audio?.deviceId?.exact === 'abc123'
      && picked.audio?.echoCancellation === true
      && globalThis.isAudioInputSelectionSupported() ===
           !!(navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function');
    addResult('audio devices: constraint builder + support probe', ok,
      `default=${JSON.stringify(def.audio)}, picked deviceId=${picked.audio?.deviceId?.exact}`);
  } catch (e) {
    addResult('audio devices: constraints', false, e.message);
  }

  // --- 19. 音频输入设备：listAudioInputs 恒 resolve 且只回 audioinput ---
  try {
    const realMedia = globalThis.navigator.mediaDevices;
    if (!realMedia) globalThis.navigator.mediaDevices = {};
    globalThis.navigator.mediaDevices.enumerateDevices = async () => ([
      { kind: 'audioinput', deviceId: 'default', label: '' },
      { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
      { kind: 'audioinput', deviceId: 'mic2', label: 'USB Mic' },
    ]);
    const list = await globalThis.listAudioInputs();
    // 枚举抛错时也 resolve []（UI 据此隐藏整行，而不是崩掉 popup）
    globalThis.navigator.mediaDevices.enumerateDevices = async () => { throw new Error('boom'); };
    const onError = await globalThis.listAudioInputs();
    if (!realMedia) delete globalThis.navigator.mediaDevices;
    const ok = list.length === 2
      && list[0].isDefault === true && list[0].label === 'Microphone 1'
      && list[1].deviceId === 'mic2' && list[1].isDefault === false
      && onError.length === 0;
    addResult('audio devices: list filters audioinput, defaults label, never throws', ok,
      `count=${list.length}, labels=${list.map((d) => d.label).join('/')}, onError=${onError.length}`);
  } catch (e) {
    addResult('audio devices: listAudioInputs', false, e.message);
  }

  finish();
}

runTests();
