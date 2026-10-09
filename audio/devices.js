/**
 * AudioDevices — 音频输入设备枚举与约束构造。
 *
 * 麦克风设备名只在**已授权**后可见：未授权时 enumerateDevices() 返回的 label
 * 为空且 deviceId 可能被裁剪成 ''/'default'。因此本模块把「授权」与「枚举」
 * 分开：由调用方在首次 getUserMedia 成功后调用 refresh()，再把带名字的列表
 * 填进下拉框（见 popup/app.js 的 populateAudioInputs / refreshAudioInputs）。
 *
 * 约束构造优先用精确 deviceId；deviceId 已失效（设备被拔掉、权限撤销后 id
 * 轮换）时回退默认设备，避免 getUserMedia 直接抛 OverconstrainedError。
 */

/** 是否具备选择设备的能力（无 mediaDevices 的环境直接跳过整条通路）。 */
globalThis.isAudioInputSelectionSupported = function isAudioInputSelectionSupported() {
  return !!(navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function');
};

/**
 * 列出音频输入设备（audioinput）。
 * @returns {Promise<Array<{deviceId:string,label:string,isDefault:boolean}>>}
 *          永远 resolve；枚举失败/不支持时返回 []（调用方据此隐藏下拉框）。
 */
globalThis.listAudioInputs = async function listAudioInputs() {
  if (!globalThis.isAudioInputSelectionSupported()) return [];
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({
      deviceId: d.deviceId || '',
      // 未授权时 label 为 ''，用序号兜底，至少能区分"第几个设备"
      label: d.label || `Microphone ${i + 1}`,
      // 'default' 是 Chrome 的默认设备哨兵；也可用空 deviceId 表示"跟随系统默认"
      isDefault: d.deviceId === 'default' || d.deviceId === '',
    }));
};

/**
 * 由 deviceId 构造 getUserMedia 约束。
 * @param {string} deviceId  '' 表示系统默认设备
 * @returns {MediaStreamConstraints}
 */
globalThis.audioConstraintsForDevice = function audioConstraintsForDevice(deviceId) {
  // 不指定 deviceId：跟随系统默认与浏览器默认处理（AEC/NS 由浏览器决定）
  if (!deviceId) return { audio: true };
  return {
    audio: {
      deviceId: { exact: deviceId },
      // 语音场景的降噪/回声消除：与"跟随默认"一致地显式开启，避免选设备后行为漂移
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
};

/**
 * 按 deviceId 打开麦克风；失效的 deviceId 回退默认设备（并告知调用方）。
 * @param {string} deviceId
 * @returns {Promise<{stream: MediaStream, fellBack: boolean}>}
 * @throws 用户拒绝授权 / 无可用设备时抛原始错误
 */
globalThis.openMicrophone = async function openMicrophone(deviceId) {
  const constraints = globalThis.audioConstraintsForDevice(deviceId);
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(constraints), fellBack: false };
  } catch (error) {
    // 仅在"指定了设备但该设备不可用"时回退；没有指定 deviceId 的失败（权限被拒、
    // 无设备）不该再试一次默认设备。OverconstrainedError / NotFoundError 都表示 id 失效。
    const recoverable = !!deviceId
      && (error?.name === 'OverconstrainedError' || error?.name === 'NotFoundError');
    if (!recoverable) throw error;
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }), fellBack: true };
  }
};
