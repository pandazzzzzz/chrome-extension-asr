/**
 * RecordingStore — OPFS storage for tab recordings.
 *
 * Audio bytes stay on the extension origin; runtime messages carry only a
 * small { file, mime, size } reference. Both offscreen and popup/sidepanel can
 * access the same OPFS directory because they share the extension origin.
 */
globalThis.RecordingStore = (() => {
  const DIRECTORY = 'asr-recordings';
  const FILE_PATTERN = /^tab-[a-z0-9-]+\.audio$/;

  function invalidRef() {
    return new Error('Invalid recording reference');
  }

  function isRef(value) {
    return !!value
      && typeof value.file === 'string'
      && FILE_PATTERN.test(value.file)
      && typeof value.mime === 'string'
      && Number.isSafeInteger(value.size)
      && value.size >= 0;
  }

  async function directory(create) {
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS is unavailable in this browser context');
    }
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(DIRECTORY, { create });
  }

  async function save(blob) {
    if (!blob || typeof blob.size !== 'number' || typeof blob.arrayBuffer !== 'function') {
      throw new Error('Recording data must be a Blob');
    }
    if (blob.size <= 0) throw new Error('Recording is empty');

    const dir = await directory(true);
    const suffix = Math.random().toString(36).slice(2, 10) || '0';
    const file = `tab-${Date.now().toString(36)}-${suffix}.audio`;
    const handle = await dir.getFileHandle(file, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch {}
      try { await dir.removeEntry(file); } catch {}
      throw error;
    }
    return { file, mime: blob.type || 'audio/webm', size: blob.size };
  }

  async function read(ref) {
    if (!isRef(ref)) throw invalidRef();
    const dir = await directory(false);
    const handle = await dir.getFileHandle(ref.file);
    return handle.getFile();
  }

  async function remove(ref) {
    if (!isRef(ref)) throw invalidRef();
    const dir = await directory(false);
    try {
      await dir.removeEntry(ref.file);
      return true;
    } catch (error) {
      if (error?.name === 'NotFoundError') return false;
      throw error;
    }
  }

  async function list() {
    let dir;
    try {
      dir = await directory(false);
    } catch (error) {
      if (error?.name === 'NotFoundError') return [];
      throw error;
    }
    const names = [];
    for await (const name of dir.keys()) {
      if (FILE_PATTERN.test(name)) names.push(name);
    }
    return names;
  }

  /**
   * 删除没有任何引用指向的录音文件（popup 关闭时没来得及保存的孤儿）。
   * 只删除早于 minAgeMs 的文件：stop 响应到 popup 持久化引用之间有一个短暂的
   * 窗口，另一个 UI 上下文此刻 scan 不应把刚写完的文件删掉。
   */
  async function sweep(keep = [], { minAgeMs = 5 * 60 * 1000 } = {}) {
    const keepSet = new Set(
      (keep || [])
        .map((ref) => (typeof ref === 'string' ? ref : ref?.file))
        .filter(Boolean),
    );
    let dir;
    try {
      dir = await directory(false);
    } catch (error) {
      if (error?.name === 'NotFoundError') return 0;
      throw error;
    }
    let removed = 0;
    for await (const name of dir.keys()) {
      if (!FILE_PATTERN.test(name) || keepSet.has(name)) continue;
      let handle;
      let file;
      try {
        handle = await dir.getFileHandle(name);
        file = await handle.getFile();
      } catch {
        continue;
      }
      // 无法判断年龄的文件一律保留：宁可漏清理，也不能误删刚写入、引用尚未落盘的录音。
      if (typeof file.lastModified !== 'number' || Date.now() - file.lastModified < minAgeMs) continue;
      try {
        await dir.removeEntry(name);
        removed += 1;
      } catch {
        // 并发删除或文件已消失：下一轮 sweep 再处理。
      }
    }
    return removed;
  }

  return { save, read, remove, list, sweep, isRef };
})();
