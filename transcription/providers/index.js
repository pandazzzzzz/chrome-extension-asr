/**
 * Provider 注册表 — 流式 provider 索引。
 *
 * 批量 providers（OpenAI / Deepgram）已随旧伪流式删除；当前只注册 Qwen
 * （真 WebSocket 流式）。如需新增 provider，在此 push 进 PROVIDERS 即可，
 * 并在 popup.html / sidepanel.html 补上对应 <script>（见 AGENTS.md）。
 *
 * 注意：BaseProvider 必须先加载（globalThis.BaseProvider），再加载各 provider，
 * 最后加载本文件组装 PROVIDERS。
 */
globalThis.PROVIDERS = [
  globalThis.QwenProvider,
].filter(Boolean);
