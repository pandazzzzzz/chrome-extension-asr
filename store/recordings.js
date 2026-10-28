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

  return { save, read, remove, isRef };
})();
