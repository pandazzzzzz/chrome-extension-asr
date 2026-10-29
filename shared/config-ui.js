/**
 * 共享 config-UI 渲染规则（popup/app-*.js 与 options/options.js 共用）。
 *
 * "两个入口页必须把同一份存储配置渲染一致" 是仓库的明确不变量 —— 但 region
 * 的 legacy-endpoint 归属规则和模型下拉的填充此前各写了一遍，写法已开始分叉。
 * 这里把**决策规则**抽成纯函数（不碰 DOM），两页只保留各自的 DOM 绑定；
 * invariant 从"靠人肉同步"变成"靠单一实现"。
 *
 * 挂载在 globalThis 上，与 shared/format.js 一致 —— 不用 ES module，因为
 * 扩展页靠 <script src> 按顺序加载普通脚本（见 AGENTS.md「Global scripts」）。
 */
globalThis.ConfigUI = (() => {
  /**
   * 决定 region 下拉的选中值。
   *
   * 优先级：已存且仍在 provider 列表里的 region > legacy custom（老配置没有
   * region 字段但存了 endpoint —— 可能是 wss URL，也可能是批量时代残留的
   * https REST URL，一律归为 custom 保留原值，不猜地域、不静默改写用户数据）
   * > provider 首个地域 > 'custom' 兜底。
   *
   * @param {Array<{id: string}>} regions 当前 provider 的 regions 元数据
   * @param {string} savedRegion 存储里的 region（老配置为 ''）
   * @param {string} savedEndpoint 存储里的 endpoint
   * @returns {{value: string, legacyCustom: boolean}} legacyCustom=true 表示走了
   *   legacy 规则（调用方可据此打点/提示），value 为 <select> 应取的值
   */
  function resolveRegionSelection(regions, savedRegion, savedEndpoint) {
    const list = regions || [];
    if (savedRegion && list.some((r) => r.id === savedRegion)) {
      return { value: savedRegion, legacyCustom: false };
    }
    if (!savedRegion && savedEndpoint) {
      return { value: 'custom', legacyCustom: true };
    }
    return { value: list[0]?.id || 'custom', legacyCustom: false };
  }

  /**
   * 重建 region <select> 的 <option> 列表并选中 resolved 值。
   * 仅操作 DOM，不含决策 —— 决策在 resolveRegionSelection（两页共用）。
   *
   * @param {HTMLSelectElement} selectEl
   * @param {Array<{id: string, label: string}>} regions
   * @param {string} selectedValue resolveRegionSelection().value
   */
  function populateRegionOptions(selectEl, regions, selectedValue) {
    selectEl.innerHTML = '';
    for (const r of regions || []) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.label;
      selectEl.appendChild(opt);
    }
    selectEl.value = selectedValue;
  }

  /**
   * 模型下拉的选中态：provider 元数据（modelSelectionFor）映射 savedModel 到
   * 「预置项 value / Custom + 手填文本」。provider 未实现该方法（或无 provider）
   * 时退化为纯 Custom 态，手填框保留原文本。
   *
   * @param {object|null} provider
   * @param {string} savedModel
   * @returns {{value: string, customText: string}}
   */
  function resolveModelSelection(provider, savedModel) {
    if (provider?.modelSelectionFor) {
      return provider.modelSelectionFor(savedModel);
    }
    return { value: '', customText: savedModel || '' };
  }

  /**
   * 重建模型 <select> 的 <option> 列表。选项来自 provider.modelOptions；
   * 无预置选项时保留一个 Custom 项（值走手填文本框），下拉不至于空白。
   * 仅操作 DOM，选中态由调用方按 resolveModelSelection 的结果设置。
   *
   * @param {HTMLSelectElement} selectEl
   * @param {object|null} provider
   */
  function populateModelOptions(selectEl, provider) {
    const options = provider?.modelOptions || [];
    const list = options.length ? options : [{ model: '', label: 'Custom…' }];
    selectEl.innerHTML = '';
    for (const o of list) {
      const opt = document.createElement('option');
      opt.value = o.model;
      opt.textContent = o.label || o.model || 'Custom…';
      selectEl.appendChild(opt);
    }
  }

  return {
    resolveRegionSelection,
    populateRegionOptions,
    resolveModelSelection,
    populateModelOptions,
  };
})();
