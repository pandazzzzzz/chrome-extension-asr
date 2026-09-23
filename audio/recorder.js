/**
 * AudioRecorder — MediaRecorder 封装，供 popup（麦克风）与 offscreen（标签页）共用。
 *
 * 用法:
 *   const rec = new AudioRecorder();
 *   const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
 *   rec.attach(stream);
 *   rec.start();               // 开始
 *   const blob = await rec.stop();  // 停止并合并分片
 *
 * 说明：
 *   - start()/stop() 返回 Promise，stop() 在 onstop 触发后 resolve 最终 Blob
 *   - MediaRecorder 默认按 timeslice 分片，便于将来接流式（P3b）
 */
globalThis.AudioRecorder = class AudioRecorder {
  constructor({ mimeType = '', timeslice = 1000 } = {}) {
    this.mimeType = mimeType;
    this.timeslice = timeslice;
    this.stream = null;
    this.chunks = [];
    this.recorder = null;
    this.isRecording = false;
  }

  /** 绑定媒体流（可重复调用以换流）。 */
  attach(stream) {
    this.release();
    this.stream = stream;
  }

  /** 选择支持的 mimeType：优先给定值，回退常见格式。 */
  static pickMimeType(preferred) {
    const candidates = [preferred, 'audio/webm', 'audio/mp4', 'audio/wav'];
    if (typeof MediaRecorder === 'undefined') return '';
    for (const type of candidates) {
      if (type && MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  /** 开始录制；若无 stream 抛错。 */
  start() {
    if (!this.stream) throw new Error('No media stream attached; call attach(stream) first');
    if (this.isRecording) return;

    this.chunks = [];
    const mimeType = AudioRecorder.pickMimeType(this.mimeType);
    this.recorder = new MediaRecorder(
      this.stream,
      mimeType ? { mimeType } : {},
    );

    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };

    this.recorder.start(this.timeslice);
    this.isRecording = true;
  }

  /**
   * 停止录制并合并分片。
   * @returns {Promise<Blob>} 录制结果
   */
  stop() {
    if (!this.recorder) return Promise.reject(new Error('Not recording'));
    if (!this.isRecording) return Promise.resolve(this.getBlob());

    return new Promise((resolve, reject) => {
      this.recorder.onstop = () => {
        this.isRecording = false;
        try {
          resolve(this.getBlob());
        } catch (err) {
          reject(err);
        }
      };
      try {
        this.recorder.stop();
      } catch (err) {
        this.isRecording = false;
        reject(err);
      }
    });
  }

  /** 合并当前分片为 Blob。 */
  getBlob() {
    const type = this.recorder?.mimeType || this.mimeType || 'audio/webm';
    return new Blob(this.chunks, { type });
  }

  /** 停止音轨并清空状态。 */
  release() {
    if (this.recorder && this.isRecording) {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
      this.isRecording = false;
    }
    this.recorder = null;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.chunks = [];
  }
};
