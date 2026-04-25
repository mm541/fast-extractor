import { WebDemuxer } from 'web-demuxer';
import type { FastExtractorOptions } from './fast-extractor';

export class WorkspaceManager {
  private file: File;
  private worker: Worker;
  private options: FastExtractorOptions;
  public tempFileName: string;

  constructor(file: File, worker: Worker, options: FastExtractorOptions) {
    this.file = file;
    this.worker = worker;
    this.options = options;
    // Generate a unique temp file name for this extraction session
    this.tempFileName = `extract_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`;
  }

  /**
   * Orchestrates the complete extraction pipeline:
   * 1. Acquires a Web Lock for the temp file.
   * 2. Ingests the DOM file into OPFS immediately.
   * 3. Triggers audio extraction (via worker).
   * 4. Triggers video extraction (demuxer on main thread, decoder in worker).
   * 5. Cleans up the temp file if requested.
   * 
   * Returns a promise that resolves when the worker sends ALL_DONE.
   */
  public async extract(): Promise<void> {
    const runPipeline = async () => {
      try {
        await this.ingest();

        // Trigger audio extraction on the worker
        // The worker will read the OPFS file synchronously using createSyncAccessHandle
        if (this.options.extractAudio !== false) {
          const root = await navigator.storage.getDirectory();
          const feDir = await root.getDirectoryHandle('.fast_extractor');
          const fileHandle = await feDir.getFileHandle(this.tempFileName);

          await new Promise<void>((resolve, reject) => {
            const handleAudioMessage = (e: MessageEvent) => {
              if (e.data.type === 'AUDIO_DONE') {
                this.worker.removeEventListener('message', handleAudioMessage);
                resolve();
              } else if (e.data.type === 'ERROR') {
                this.worker.removeEventListener('message', handleAudioMessage);
                reject(new Error(e.data.error));
              }
            };
            this.worker.addEventListener('message', handleAudioMessage);
            this.worker.postMessage({ type: 'EXTRACT_AUDIO', fileName: this.file.name, fileHandle });
          });
        }

        // Run video extraction pipeline
        if (this.options.extractSlides !== false) {
            await this.extractVideo();
        } else {
            // Signal worker that video is skipped, so it can send ALL_DONE
            this.worker.postMessage({ type: 'VIDEO_DONE', skipped: true });
        }

        // Wait for ALL_DONE from the worker
        await new Promise<void>((resolve, reject) => {
          const handleDone = (e: MessageEvent) => {
            if (e.data.type === 'ALL_DONE') {
              this.worker.removeEventListener('message', handleDone);
              resolve();
            } else if (e.data.type === 'ERROR') {
              this.worker.removeEventListener('message', handleDone);
              reject(new Error(e.data.error));
            }
          };
          this.worker.addEventListener('message', handleDone);
        });

      } finally {
        await this.cleanup();
      }
    };

    if (navigator.locks) {
      await navigator.locks.request(`fe_${this.tempFileName}`, runPipeline);
    } else {
      await runPipeline();
    }
  }

  /**
   * Ingests the DOM File into OPFS using a WritableStream.
   * This MUST be called immediately after user selection to prevent Android SAF expiration.
   */
  private async ingest(): Promise<void> {
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS is not supported in this browser.');
    }

    const root = await navigator.storage.getDirectory();
    const feDir = await root.getDirectoryHandle('.fast_extractor', { create: true });
    const fileHandle = await feDir.getFileHandle(this.tempFileName, { create: true });
    
    // createWritable is available on the main thread
    const writable = await fileHandle.createWritable();
    
    // Android SAF: pipe the file immediately
    const stream = this.file.stream();
    const reader = stream.getReader();
    let offset = 0;
    
    this.worker.postMessage({ type: 'STATUS', status: 'Ingesting Media: 0%', progress: 0 });
    let lastReportTime = Date.now();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        await writable.write(value);
        offset += value.byteLength;
        
        if (Date.now() - lastReportTime > 250) {
            const pct = Math.floor((offset / this.file.size) * 100);
            this.worker.postMessage({ type: 'STATUS', status: `Ingesting Media: ${pct}%`, progress: pct });
            lastReportTime = Date.now();
        }
    }
    await writable.close();
  }

  /**
   * Runs the video extraction pipeline.
   * Instantiates WebDemuxer on the main thread (fixes Safari issues) and 
   * streams video chunks to the Web Worker for decoding.
   */
  private async extractVideo(): Promise<void> {
    let demuxer: WebDemuxer | null = null;
    try {
      this.worker.postMessage({ type: 'STATUS', status: 'Initializing Demuxer...' });

      // Demuxer runs on main thread now, no Base64 hack needed
      const wasmUrl = this.options.demuxerWasmUrl ?? '/wasm-files/web-demuxer.wasm';
      demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });

      // Read the file back from OPFS so demuxer has a stable reference
      const root = await navigator.storage.getDirectory();
      const feDir = await root.getDirectoryHandle('.fast_extractor');
      const fileHandle = await feDir.getFileHandle(this.tempFileName);
      const opfsFile = await fileHandle.getFile();

      await demuxer.load(opfsFile);
      
      const mediaInfo = await demuxer.getMediaInfo();
      const duration = mediaInfo.duration || 0;
      const decoderConfig = await demuxer.getDecoderConfig('video');

      // 1. Send config to worker
      this.worker.postMessage({ 
        type: 'CONFIG_DECODER', 
        config: decoderConfig, 
        duration 
      });

      // 2. Read packets and stream to worker
      const endTime = duration > 0 ? duration * 2 : 999999;
      const reader = demuxer.read('video', 0, endTime).getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        if (this.options.mode === 'turbo' && value.type !== 'key') continue;

        // Extract raw bytes into an ArrayBuffer for zero-copy transfer
        const chunkData = new ArrayBuffer(value.byteLength);
        value.copyTo(chunkData);

        this.worker.postMessage({
          type: 'VIDEO_CHUNK',
          chunk: chunkData,
          timestamp: Number(value.timestamp),
          chunkType: value.type
        }, [chunkData]); // Zero-copy transfer!
      }

      // 3. Signal completion
      this.worker.postMessage({ type: 'VIDEO_DONE' });

    } finally {
      if (demuxer) demuxer.destroy();
    }
  }

  /**
   * Deletes the temp file from OPFS.
   */
  private async cleanup(): Promise<void> {
    if (this.options.cleanupAfterExtraction === false) return;
    
    try {
        const root = await navigator.storage.getDirectory();
        const feDir = await root.getDirectoryHandle('.fast_extractor');
        await feDir.removeEntry(this.tempFileName);
        console.log(`[WorkspaceManager] Cleaned up temp file: ${this.tempFileName}`);
    } catch (e) {
        console.warn(`[WorkspaceManager] Failed to cleanup ${this.tempFileName}:`, e);
    }
  }
}
