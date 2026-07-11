export interface StartOptions {
  callId: string;
  source: 'mic' | 'mic+system';
  micDeviceId: string | null;
  onLevel?: (rms: number) => void;
  onError?: (err: Error) => void;
  onWarning?: (msg: string) => void;
}

const CHUNK_MS = 5000;

export class RecordingManager {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private mixStreams: MediaStream[] = [];
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;
  private callId: string | null = null;
  private chunkPromise: Promise<unknown> = Promise.resolve();
  private startedAt = 0;

  async start(opts: StartOptions): Promise<void> {
    if (this.recorder) throw new Error('既に録音中です');
    this.callId = opts.callId;
    const composed = await this.composeStream(opts);
    this.stream = composed;

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(composed, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0 || !this.callId) return;
      const callId = this.callId;
      this.chunkPromise = this.chunkPromise.then(async () => {
        try {
          const buf = await e.data.arrayBuffer();
          await window.api.recording.appendChunk(callId, buf);
        } catch (err) {
          opts.onError?.(err as Error);
        }
      });
    };
    this.recorder.onerror = (e) => {
      opts.onError?.(new Error((e as ErrorEvent).message ?? 'MediaRecorder error'));
    };

    if (opts.onLevel) this.setupLevelMeter(composed, opts.onLevel);

    this.recorder.start(CHUNK_MS);
    this.startedAt = performance.now();
  }

  isRecording(): boolean {
    return !!this.recorder && this.recorder.state !== 'inactive';
  }

  isPaused(): boolean {
    return this.recorder?.state === 'paused';
  }

  /** 一時停止/再開をトグルし、トグル後の paused 状態を返す。録音していなければ null。 */
  togglePause(): boolean | null {
    const rec = this.recorder;
    if (!rec || rec.state === 'inactive') return null;
    if (rec.state === 'paused') {
      rec.resume();
      return false;
    }
    rec.pause();
    return true;
  }

  /** Stop recording, wait for last chunk, and finalize on main. */
  async stop(): Promise<void> {
    const rec = this.recorder;
    const callId = this.callId;
    if (!rec || !callId) return;
    await new Promise<void>((resolve) => {
      const onStop = () => { rec.removeEventListener('stop', onStop); resolve(); };
      rec.addEventListener('stop', onStop);
      if (rec.state !== 'inactive') rec.stop();
      else resolve();
    });
    // Wait for all queued chunk uploads
    await this.chunkPromise;
    try {
      await window.api.recording.finalize(callId);
    } finally {
      this.cleanup();
    }
  }

  /** Abort without finalizing (e.g. on permission error). */
  async abort(): Promise<void> {
    const callId = this.callId;
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch { /* ignore */ }
    if (callId) await window.api.recording.abort(callId).catch(() => {});
    this.cleanup();
  }

  private cleanup(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    for (const s of [this.stream, ...this.mixStreams]) {
      s?.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;
    this.mixStreams = [];
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
    this.audioCtx = null;
    this.analyser = null;
    this.recorder = null;
    this.callId = null;
  }

  private async composeStream(opts: StartOptions): Promise<MediaStream> {
    const micConstraints: MediaStreamConstraints = {
      audio: opts.micDeviceId
        ? { deviceId: { exact: opts.micDeviceId }, echoCancellation: true, noiseSuppression: true }
        : { echoCancellation: true, noiseSuppression: true },
    };
    const mic = await navigator.mediaDevices.getUserMedia(micConstraints);
    if (opts.source === 'mic') {
      this.mixStreams = [mic];
      return mic;
    }
    // mic + system: use getDisplayMedia for system audio (Chromium / Electron supports loopback)
    let sys: MediaStream | null = null;
    try {
      sys = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      // Drop video track – we only need audio
      sys.getVideoTracks().forEach((t) => t.stop());
      if (sys.getAudioTracks().length === 0) {
        sys = null;
        opts.onWarning?.(
          'システム音声トラックを取得できませんでした。マイクのみで録音します。'
          + 'Windows 以外の環境では loopback 取得が制限される場合があります。',
        );
      }
    } catch (err) {
      console.warn('[recorder] system audio capture failed, falling back to mic only:', err);
      opts.onWarning?.(
        `システム音声のキャプチャに失敗しました（マイクのみで録音します）: ${(err as Error).message}`,
      );
      this.mixStreams = [mic];
      return mic;
    }
    if (!sys) {
      this.mixStreams = [mic];
      return mic;
    }
    this.audioCtx = new AudioContext();
    const dest = this.audioCtx.createMediaStreamDestination();
    const micSrc = this.audioCtx.createMediaStreamSource(mic);
    const sysSrc = this.audioCtx.createMediaStreamSource(new MediaStream(sys.getAudioTracks()));
    const micGain = this.audioCtx.createGain();
    const sysGain = this.audioCtx.createGain();
    micGain.gain.value = 1.0;
    sysGain.gain.value = 0.85;
    micSrc.connect(micGain).connect(dest);
    sysSrc.connect(sysGain).connect(dest);
    this.mixStreams = [mic, sys];
    return dest.stream;
  }

  private setupLevelMeter(stream: MediaStream, onLevel: (rms: number) => void): void {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    const src = this.audioCtx.createMediaStreamSource(stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    this.analyser = analyser;
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      onLevel(Math.min(1, rms * 2.5)); // boost for visibility
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  elapsedMs(): number {
    return this.startedAt ? performance.now() - this.startedAt : 0;
  }
}

function pickMimeType(): string | null {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}
