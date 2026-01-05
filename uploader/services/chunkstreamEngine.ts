import { MP4BoxInfo, MP4File, SegmentInfo, MP4BoxSample, MP4BoxBuffer, MP4InitSegmentEntry, MP4InitSegmentationResult } from "../types";
import { uploaderService } from "./uploaderService";
import { playerService } from "./playerService";

export class ChunkstreamEngine {
  private file: File;
  private segmentDuration: number;
  private maxConcurrency: number;
  
  private videoId: string | null = null;
  private uploaderId: string | null = null;
  
  private mp4Info: MP4BoxInfo | null = null;
  private headerBuffer: MP4BoxBuffer | null = null;
  private videoInitFragment: Blob | null = null;
  private audioInitFragment: Blob | null = null;
  private videoSegmentFragments: Map<number, Blob> = new Map();
  private audioSegmentFragments: Map<number, Blob> = new Map();
  private videoFragmentWaiters: Map<number, ((blob: Blob | null) => void)[]> = new Map();
  private audioFragmentWaiters: Map<number, ((blob: Blob | null) => void)[]> = new Map();
  private onDemandGeneration: Map<number, Promise<void>> = new Map();
  private priorityQueue: number[] = [];
  private priorityQueueSet: Set<number> = new Set();
  private nextSequentialIndex = 0;
  private prioritySocket: WebSocket | null = null;
  private prioritySocketReconnectTimer: number | null = null;
  private prioritySocketHeartbeatTimer: number | null = null;
  private fragmentGenerationDone = false;
  private audioSegmentCount = 0;
  private segments: SegmentInfo[] = [];
  private videoSegmentBoundaries: number[] = [];
  private audioSegmentBoundaries: number[] = [];
  private audioSamples: MP4BoxSample[] = [];
  private inFlight = new Set<number>();
  private stopRequested = false;
  private totalDurationSec = 0;
  private mp4boxFile: any = null;
  private feedChain: Promise<void> = Promise.resolve();
  private videoTrackId: number | null = null;
  private audioTrackId: number | null = null;
  private streamingVideoSegmentsEmitted = 0;

  // Callbacks for UI updates
  onProgress: (segments: SegmentInfo[]) => void = () => {};
  onLog: (msg: string) => void = () => {};
  onReadyToPlay: (url: string, videoId: string) => void = () => {};

  constructor(file: File, options: { segmentDuration?: number; maxConcurrency?: number } = {}) {
    this.file = file;
    this.segmentDuration = options.segmentDuration || 10;
    this.maxConcurrency = options.maxConcurrency || 3;
  }

  log(msg: string) {
    console.log(`[Chunkstream] ${msg}`);
    this.onLog(msg);
  }

  async start() {
    try {
      this.log("Starting MOOV parse and streaming fragmentation...");

      // 1) Fast MOOV parse and virtual segments (no full read)
      const tStart = performance.now();
      const { info, segments, headerBuffer } = await this.parseMoovAndVirtualize();
      
      this.mp4Info = info;
      this.totalDurationSec = info.duration / info.timescale;
      this.segments = segments;
      this.headerBuffer = headerBuffer;
      this.onProgress([...this.segments]);
      this.log(`MOOV parsed. Virtual segments ready: ${segments.length}. Duration ${(this.totalDurationSec).toFixed(2)}s`);

      
      const videoTrack = info.videoTracks[0];
      if (!videoTrack) {
        throw new Error("No video track found when building init segment");
      }

      // 2) Kick off fragmenter and backend session in parallel
      const fragmenterPromise = this.startStreamingFragmenter(this.segments, info);
      const sessionPromise = uploaderService.initSession(
        this.file.name,
        this.file.size,
        segments.length,
        this.segmentDuration
      );
      const [{ videoInit, audioInit, audioSegmentCount }, { video_id }] = await Promise.all([
        fragmenterPromise,
        sessionPromise,
      ]);
      this.videoInitFragment = videoInit;
      this.audioInitFragment = audioInit || null;
      this.audioSegmentCount = audioInit ? audioSegmentCount : 0;
      this.videoId = video_id;
      this.log(`Session initialized. Video ID: ${this.videoId}`);

     
     if (!this.headerBuffer) {
       throw new Error("Header buffer missing before uploading init segment");
     }

     // Build a proper fragmented init segment (ftyp+moov with mvex) using mp4box
     const formData = new FormData();
     formData.append("init", this.videoInitFragment, "init.m4s");
     await uploaderService.uploadInit(this.videoId, formData);
     this.log(`Init segment uploaded .`);
     if (this.audioInitFragment) {
       const audioForm = new FormData();
       audioForm.append("init", this.audioInitFragment, "audio_init.m4s");
       await uploaderService.uploadAudioInit(this.videoId, audioForm);
      this.log("Audio init segment uploaded.");
    }
      
      // 5) Register uploader and start scheduling loop (uploads in background)
      const { uploader_id } = await uploaderService.registerUploader(this.videoId, this.maxConcurrency);
      this.uploaderId = uploader_id;
      this.log(`Uploader registered. ID: ${this.uploaderId}`);
      this.connectPrioritySocket();
      this.scheduleLoop();

      // 6) Upload MPD immediately after init
      const mpd = this.generateDASHManifest(info, this.segments);
      this.log(`Generated MPD:\n${mpd}`);
      await uploaderService.uploadManifest(this.videoId, mpd);
      this.log("Manifest uploaded.");

      // 7) Notify player after first segment uploaded (or timeout)
      await this.waitForSegmentCompletion(0, 20000);
      this.onReadyToPlay(playerService.getManifestUrl(this.videoId), this.videoId);
      this.log(`ReadytoPlay: ${(performance.now() - tStart).toFixed(1)}ms`);

    } catch (err: any) {
      this.log(`Error: ${err.message}`);
      console.error(err);
    }
  }

  stop() {
    this.stopRequested = true;
    this.cleanupPrioritySocket();
  }

  /**
   * Uses MP4Box to parse only the header (MOOV) and virtualize the segmentation
   * based on sync samples (keyframes).
   */
  private parseMoovAndVirtualize(): Promise<{ info: MP4BoxInfo; segments: SegmentInfo[]; headerBuffer: MP4BoxBuffer }> {
    const MP4Box = (window as any).MP4Box;
    if (!MP4Box || typeof MP4Box.loadMoovOnly !== "function") {
      return Promise.reject(new Error("MP4Box.loadMoovOnly not available"));
    }
    const t0 = performance.now();

    return MP4Box.loadMoovOnly({
      blob: this.file,
      // Let MP4Box know the total size so it keeps fetching beyond the first chunk if needed
      size: this.file.size,
    }).then(({ info, mp4, header }: { info: MP4BoxInfo; mp4: MP4File; header?: MP4BoxBuffer }) => {
      this.log(`loadMoovOnly: ${(performance.now() - t0).toFixed(1)}ms`);
      //this.log("MOOV atom parsed. Building virtual segments from stsz/stco...");
      

      const videoTrackInfo = info.videoTracks[0];
      if (!videoTrackInfo) throw new Error("No video track found.");

      // MP4Box.getInfo() does not include the built sample list; fetch it from the MP4File track.
      const videoTrack = mp4.getTrackById(videoTrackInfo.id);
      const videoSamples = videoTrack?.samples || [];
      if (videoSamples.length === 0) {
        throw new Error("Sample table (stsz/stco) missing; cannot virtual slice. Please remux the file (faststart).");
      }
      this.log(`stsz/stco samples parsed (video): ${videoSamples.length}`);       

      const MAX_SEGMENT_BYTES = 8 * 1024 * 1024; // cap per-segment size for on-demand safety

      const trackTimescale = videoTrack.timescale || videoTrackInfo.timescale || info.timescale;
      const totalDuration = info.duration / info.timescale;
      const estBitrate = videoTrackInfo.bitrate || ((this.file.size * 8) / totalDuration);
      const targetDuration = Math.min(10, Math.floor((MAX_SEGMENT_BYTES * 8) / estBitrate));
      this.segmentDuration = targetDuration;
      let { segments, boundaries } = this.buildSegmentsFromSamples(videoSamples, trackTimescale, totalDuration, this.segmentDuration);
      
      
      if (segments.length === 0) {
        throw new Error("No segments were constructed from the sample table.");
      }
      this.videoSegmentBoundaries = boundaries;

      
      // Build corresponding audio segment boundaries aligned to video segment end times
      const audioTrackInfo = info.audioTracks?.[0];
      if (audioTrackInfo) {
        const audioTrack = mp4.getTrackById(audioTrackInfo.id);
        const audioSamples = audioTrack?.samples || [];
        const audioTimescale = audioTrack?.timescale || audioTrackInfo.timescale || info.timescale;
        this.audioSamples = audioSamples;
        this.audioSegmentBoundaries = this.buildAudioBoundariesFromTimes(
          audioSamples,
          audioTimescale,
          segments.map(s => s.endTime)
        );
        this.log(`Audio segment boundaries constructed: ${this.audioSegmentBoundaries.length}`);
      }

      if (!header) {
        throw new Error("Failed to receive MP4 header buffer from loadMoovOnly");
      }

      return { info, segments, headerBuffer: header };
    });
  }

  private buildSegmentsFromSamples(
    samples: MP4BoxSample[],
    timescale: number,
    totalDuration: number,
    segmentDuration: number = this.segmentDuration
  ): { segments: SegmentInfo[]; boundaries: number[] } {
    if (!samples || samples.length === 0) {
      throw new Error("No samples available to build segments.");
    }
    if (!Number.isFinite(timescale) || timescale <= 0) {
      throw new Error(`Invalid timescale: ${timescale}`);
    }
    if (samples.some(s => typeof s.offset !== 'number' || typeof s.size !== 'number')) {
      throw new Error("Sample offsets missing; cannot virtual slice.");
    }

    const segments: SegmentInfo[] = [];
    const boundaries: number[] = [];
    let currentSegStartSample = 0;
    let currentSegStartTime = samples[0].dts / timescale;
    let lastSyncIndex = samples[0].is_sync ? 0 : -1;

    this.log(` sample.length: ${samples.length}`);
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i];
      if (s.is_sync) lastSyncIndex = i;
      
      const elapsed = s.dts / timescale - currentSegStartTime;

      if (s.is_sync && elapsed >= segmentDuration * 0.75) {
        // boundaryIndex：starting point for next segment
        const boundaryIndex = i;

        // starting sample and end sample for current segment
        const startSample = samples[currentSegStartSample];
        const endSample = samples[boundaryIndex - 1]; // note: it is the previous sample

        // current segment
        segments.push({
          index: segments.length,
          startTime: currentSegStartTime,
          endTime: endSample.dts / timescale,
          startByte: startSample.offset,
          endByte: endSample.offset + endSample.size,
          duration: (endSample.dts / timescale) - currentSegStartTime,
          status: 'pending'
        });
        boundaries.push(endSample.number);

        // update the starting sample for next segment
        currentSegStartSample = boundaryIndex;
        currentSegStartTime = s.dts / timescale;        
      }

    }

    //the very last segment
    const startSample = samples[currentSegStartSample];
    const endSample = samples[samples.length - 1];
    segments.push({
      index: segments.length,
      startTime: currentSegStartTime,
      endTime: totalDuration,
      startByte: startSample.offset,
      endByte: endSample.offset + endSample.size,
      duration: totalDuration - currentSegStartTime,
      status: 'pending'
    });
    boundaries.push(endSample.number);

    return { segments, boundaries };
  }

  // For audio: align segment boundaries to video segment end times by picking the last audio sample at/just before each boundary.
  private buildAudioBoundariesFromTimes(audioSamples: MP4BoxSample[], timescale: number, endTimes: number[]): number[] {
    if (!audioSamples || audioSamples.length === 0) return [];
    const boundaries: number[] = [];
    let ptr = 0;
    const eps = 0.000001; // small tolerance
    for (const endTime of endTimes) {
      while (
        ptr < audioSamples.length - 1 &&
        audioSamples[ptr].dts / timescale < endTime - eps
      ) {
        ptr += 1;
      }
      boundaries.push(audioSamples[Math.min(ptr, audioSamples.length - 1)].number);
    }
    return boundaries;
  }

  private generateDASHManifest(info: MP4BoxInfo, segments: SegmentInfo[]): string {
    const duration = (info.duration / info.timescale).toFixed(2);
    // Assuming AVC1 video for MVP, retrieving real codec string from MP4Box is better
    const videoTrack = info.videoTracks[0];
    const codec = videoTrack?.codec || "avc1.42E01E";
    const width = videoTrack?.track_width || 640;
    const height = videoTrack?.track_height || 360;
    const bandwidth = videoTrack?.bitrate || 1000000; // Default 1Mbps if unknown
    const timescale = videoTrack?.timescale || info.timescale || 1;

    // Build SegmentTimeline entries (s, d, r syntax)
    const buildTimeline = (scale: number) => {
      const parts: string[] = [];
      let prevD: number | null = null;
      let run = 0;
      const flush = () => {
        if (prevD == null) return;
        const r = run > 1 ? ` r="${run - 1}"` : "";
        parts.push(`<S d="${prevD}"${r}/>`); 
      };
      for (const seg of segments) {
        const dTicks = Math.max(1, Math.round((seg.endTime - seg.startTime) * scale));
        if (prevD === null) {
          prevD = dTicks;
          run = 1;
        } else if (dTicks === prevD) {
          run += 1;
        } else {
          flush();
          prevD = dTicks;
          run = 1;
        }
      }
      flush();
      return parts.join("\n        ");
    };

    const timelineXml = buildTimeline(timescale);
    
    // Static DASH MPD with accurate SegmentTimeline
    const audioTrack = info.audioTracks?.[0];
    const audioCodec = audioTrack?.codec || "mp4a.40.2";
    const audioTimescale = audioTrack?.timescale || info.timescale || 48000;
    const audioTimeline = buildTimeline(audioTimescale);

    const audioAdaptation = audioTrack && this.audioInitFragment
      ? `
    <AdaptationSet mimeType="audio/mp4" segmentAlignment="true" lang="${audioTrack.language || "und"}">
      <Representation id="a1" BANDWIDTH="${audioTrack.bitrate || 128000}" codecs="${audioCodec}">
        <SegmentTemplate initialization="audio_init.m4s" timescale="${audioTimescale}" media="audio_segment_$Number$.m4s" startNumber="0">
          <SegmentTimeline>
        ${audioTimeline}
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>`
      : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" minBufferTime="PT2S" mediaPresentationDuration="PT${duration}S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period id="1" start="PT0S">
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
      <Representation id="1" BANDWIDTH="${bandwidth}" codecs="${codec}" width="${width}" height="${height}" frameRate="30">
        <SegmentTemplate initialization="init.m4s" timescale="${timescale}" media="segment_$Number$.m4s" startNumber="0">
          <SegmentTimeline>
        ${timelineXml}
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    ${audioAdaptation}
  </Period>
</MPD>`;
  }

  private enqueuePriorityTask(index: number) {
    if (index < 0 || index >= this.segments.length) return;
    if (this.priorityQueueSet.has(index)) return;
    if (this.inFlight.has(index)) return;
    const seg = this.segments[index];
    if (seg?.status === "completed") return;
    this.priorityQueue.push(index);
    this.priorityQueueSet.add(index);
    this.log(`Priority task queued: segment ${index}`);
  }

  private takePriorityTasks(capacity: number): number[] {
    const picked: number[] = [];
    while (picked.length < capacity && this.priorityQueue.length > 0) {
      const idx = this.priorityQueue.shift()!;
      this.priorityQueueSet.delete(idx);
      const seg = this.segments[idx];
      if (!seg || seg.status === "completed" || this.inFlight.has(idx)) {
        continue;
      }
      picked.push(idx);
    }
    return picked;
  }

  private takeSequentialTasks(capacity: number): number[] {
    const picked: number[] = [];
    const tryPick = (start: number, end: number) => {
      for (let i = start; i < end && picked.length < capacity; i++) {
        const seg = this.segments[i];
        if (!seg) continue;
        if (seg.status === "completed") continue;
        if (this.inFlight.has(seg.index)) continue;
        if (this.priorityQueueSet.has(seg.index)) continue;
        picked.push(seg.index);
        this.nextSequentialIndex = i + 1;
      }
    };

    // Primary pass: continue from where we left off.
    tryPick(this.nextSequentialIndex, this.segments.length);

    // If we ran out but still have capacity (e.g., retry pending/error ones), wrap to the start.
    if (picked.length < capacity && this.nextSequentialIndex >= this.segments.length) {
      this.nextSequentialIndex = 0;
      tryPick(0, this.segments.length);
    }

    return picked;
  }

  private async scheduleLoop() {
    this.log("Starting scheduling loop (sequential uploads + priority overrides)...");
    while (!this.stopRequested) {
      // Check if all done
      const allDone = this.segments.every(s => s.status === 'completed');
      if (allDone) {
        this.log("All segments uploaded!");
        this.stopRequested = true; // stop auxiliary loops like priority polling
        break;
      }

      const slotsAvailable = this.maxConcurrency - this.inFlight.size;
      if (slotsAvailable <= 0) {
        await this.sleep(200);
        continue;
      }

      // Priority tasks come first, then fall back to sequential uploading.
      const tasks: number[] = [
        ...this.takePriorityTasks(slotsAvailable),
        ...this.takeSequentialTasks(slotsAvailable),
      ].slice(0, slotsAvailable);

      if (tasks.length === 0) {
        await this.sleep(400);
        continue;
      }

      for (const index of tasks) {
        if (this.inFlight.has(index)) continue;

        this.updateSegmentStatus(index, 'uploading');
        this.inFlight.add(index);

        // Trigger upload (async, don't await here to allow concurrency)
        this.processTask(index).catch(err => {
          this.log(`Task ${index} failed: ${err.message}`);
          this.updateSegmentStatus(index, 'error');
        }).finally(() => {
          this.inFlight.delete(index);
        });
      }
    }
    this.cleanupPrioritySocket();
    // Full completion: free caches to reduce memory.
    if (this.stopRequested || this.fragmentGenerationDone) {
      this.videoSegmentFragments.clear();
      this.audioSegmentFragments.clear();
      this.drainWaitersAfterComplete();
    }
  }

  private connectPrioritySocket() {
    if (!this.videoId || !this.uploaderId) return;
    const wsUrl = this.buildWebSocketUrl();
    if (!wsUrl) {
      this.log("Priority WS URL unavailable; skip WebSocket setup");
      return;
    }
    const ws = new WebSocket(wsUrl);
    this.prioritySocket = ws;

    ws.onopen = () => {
      this.log("Priority WebSocket connected.");
      // Heartbeat to keep server-side receive loop alive
      this.prioritySocketHeartbeatTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("ping");
        }
      }, 20000);
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.type === "priority" && Array.isArray(data.indexes)) {
          // New priority set replaces the old queue for faster response to latest seek
          this.priorityQueue = [];
          this.priorityQueueSet.clear();
          const PREFETCH_BACK = 0; 
          const PREFETCH_FORWARD = 2;
          const indexes = data.indexes
            .map((idx: number) => Number.isInteger(idx) ? idx : -1)
            .filter((idx: number) => idx >= 0 && idx < this.segments.length);
          const extras: number[] = [];
          if (indexes.length > 0) {
            const minIdx = Math.min(...indexes);
            const maxIdx = Math.max(...indexes);
            for (let i = Math.max(0, minIdx - PREFETCH_BACK); i < minIdx; i++) {
              extras.push(i);
            }
            for (let i = maxIdx + 1; i <= Math.min(this.segments.length - 1, maxIdx + PREFETCH_FORWARD); i++) {
              extras.push(i);
            }
          }
          const all = [...indexes, ...extras];
          all.sort((a, b) => a - b);
          const unique = Array.from(new Set(all));
          indexes.forEach((idx: number) => this.enqueuePriorityTask(idx));
          unique.forEach((idx: number) => this.enqueuePriorityTask(idx));
          if (unique.length > 0) {
            // Move sequential pointer close to the seek target to avoid re-uploading from the head.
            this.nextSequentialIndex = Math.min(...unique);
          }
        }
      } catch (err) {
        console.warn("Failed to parse priority WS message", err);
      }
    };

    ws.onclose = () => {
      this.prioritySocket = null;
      if (this.prioritySocketHeartbeatTimer !== null) {
        clearInterval(this.prioritySocketHeartbeatTimer);
        this.prioritySocketHeartbeatTimer = null;
      }
      if (this.stopRequested) return;
      // attempt reconnect after a short delay
      this.prioritySocketReconnectTimer = window.setTimeout(() => this.connectPrioritySocket(), 1500);
    };

    ws.onerror = (ev: Event) => {
      console.error("Priority WS error", ev);
      ws.close();
    };
  }

  private cleanupPrioritySocket() {
    if (this.prioritySocket) {
      this.prioritySocket.close();
      this.prioritySocket = null;
    }
    if (this.prioritySocketHeartbeatTimer !== null) {
      clearInterval(this.prioritySocketHeartbeatTimer);
      this.prioritySocketHeartbeatTimer = null;
    }
    if (this.prioritySocketReconnectTimer !== null) {
      clearTimeout(this.prioritySocketReconnectTimer);
      this.prioritySocketReconnectTimer = null;
    }
  }

  private buildWebSocketUrl(): string | null {
    const backendBase =
      (import.meta as any)?.env?.VITE_BACKEND_BASE ||
      (typeof window !== "undefined" ? (window as any).__CHUNKSTREAM_BACKEND_BASE__ : undefined) ||
      "http://127.0.0.1:8000";
    if (!backendBase) return null;
    const normalized = backendBase.replace(/\/$/, "");
    const wsBase = normalized.replace(/^http(s?)/i, (_m, s) => (s ? "wss" : "ws"));
    return `${wsBase}/videos/${this.videoId}/uploaders/${this.uploaderId}/ws`;
  }

  private async processTask(index: number) {
    const segment = this.segments.find(s => s.index === index);
    if (!segment) return;
    if (segment.status === "completed") return;
    const [fragment, audioFragment] = await Promise.all([
      this.waitForFragment(index, 20000, this.videoSegmentFragments, this.videoFragmentWaiters, "video", true),
      this.audioSegmentCount > 0
        ? this.waitForFragment(index, 20000, this.audioSegmentFragments, this.audioFragmentWaiters, "audio")
        : Promise.resolve(null)
    ]);
    if (!fragment) {
      this.log(`Segment ${index} not ready, will retry`);
      // Re-queue as priority so we keep focusing on the seek target instead of falling back to head.
      this.enqueuePriorityTask(index);
      this.updateSegmentStatus(index, 'pending');
      return;
    }

    this.log(`Processing segment ${index} (${segment.startTime.toFixed(2)}-${segment.endTime.toFixed(2)}s)`);

    const formData = new FormData();
    formData.append("segment", fragment, `segment_${index}.m4s`);
    formData.append("index", index.toString());
    formData.append("start_time", segment.startTime.toString());
    formData.append("end_time", segment.endTime.toString());

    await uploaderService.uploadSegment(this.videoId!, index, formData);
    
    if (this.audioSegmentCount > 0) {
      if (audioFragment) {
        const audioForm = new FormData();
        audioForm.append("segment", audioFragment, `audio_segment_${index}.m4s`);
        audioForm.append("index", index.toString());
        await uploaderService.uploadAudioSegment(this.videoId!, index, audioForm);
      } else {
        // Audio missing: push back into priority queue to retry soon instead of waiting for sequential sweep.
        this.log(`Audio fragment ${index} not ready; requeueing for retry.`);
        this.enqueuePriorityTask(index);
        this.updateSegmentStatus(index, 'pending');
        return;
      }
    }
    
    this.updateSegmentStatus(index, 'completed');
    this.log(`Segment ${index} uploaded.`);

    // Free memory after upload
    this.videoSegmentFragments.delete(index);
    if (this.audioSegmentCount > 0) {
      this.audioSegmentFragments.delete(index);
    }
  }

  private updateSegmentStatus(index: number, status: SegmentInfo['status']) {
    const segIndex = this.segments.findIndex(s => s.index === index);
    if (segIndex !== -1) {
      this.segments[segIndex].status = status;
      this.onProgress([...this.segments]);
    }
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async uploadInitSegment() {
    if (!this.videoId) {
      throw new Error("videoId missing before uploading init segment");
    }
    
    const formData = new FormData();
    formData.append("init", this.videoInitFragment, "init.m4s");
    await uploaderService.uploadInit(this.videoId, formData);
    this.log(`Init segment uploaded (${this.videoInitFragment.size} bytes).`);
  }

  private async waitForSegmentCompletion(index: number, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const seg = this.segments.find(s => s.index === index);
      if (seg?.status === 'completed') return;
      if (this.stopRequested) return;
      await this.sleep(200);
    }
    this.log(`Timeout waiting for segment ${index} to complete; proceeding anyway.`);
  }

  /**
   * Build a specific fragment on-demand by reading only the byte range for that segment.
   * Useful when a high-index segment is requested before sequential generation reaches it.
   */
  private async buildFragmentOnDemand(index: number): Promise<void> {
    if (!this.mp4boxFile) {
      this.log("On-demand build skipped: mp4box not initialized");
      return;
    }
    const seg = this.segments.find(s => s.index === index);
    if (!seg) {
      this.log(`On-demand build skipped: segment ${index} not found`);
      return;
    }

    const RANGE_PADDING = 2 * 1024 * 1024;
    const audioRange = this.computeAudioByteRange(index);
    const baseStart = Math.min(seg.startByte, audioRange?.startByte ?? seg.startByte);
    const baseEnd = Math.max(seg.endByte, audioRange?.endByte ?? seg.endByte);
    const readStart = Math.max(0, baseStart - RANGE_PADDING);
    const readEnd = Math.min(this.file.size, baseEnd + RANGE_PADDING);
    await this.enqueueFeedRange(readStart, readEnd, `priority-${index}`);
  }

  /**
   * Streaming fragmentation with mp4box.js: reads file in small chunks and emits segments progressively.
   * 
   */
  private startStreamingFragmenter(segments: SegmentInfo[], info: MP4BoxInfo): Promise<{ videoInit: Blob; audioInit?: Blob; audioSegmentCount: number }> {
    const MP4Box = (window as any).MP4Box;
    if (!MP4Box || typeof MP4Box.createFile !== "function") {
      throw new Error("mp4box.js not available");
    }

    return new Promise((resolve, reject) => {

      try {

         this.mp4boxFile = MP4Box.createFile();
         const mp4boxFile = this.mp4boxFile;
         this.videoTrackId = null;
         this.audioTrackId = null;
         this.streamingVideoSegmentsEmitted = 0;
         this.fragmentGenerationDone = false;

         const startSequentialFeed = () => {
           this.enqueueFeedRange(0, this.file.size, "sequential")
             .then(() => {
               this.fragmentGenerationDone = true;
               this.drainWaitersAfterComplete();
             })
             .catch(err => this.log(`feedChunks error: ${err?.message || err}`));
         };

         mp4boxFile.onError = (e: any) => {
         this.log(`mp4box error: ${typeof e === "string" ? e : e?.message || "unknown"}`);
         };

         mp4boxFile.onReady = (info: MP4BoxInfo) => {
           const videoTrack = info.videoTracks[0];
           if (!videoTrack) {
           this.log("No video track found during segmenter onReady");
           return;
          }
          
           this.videoTrackId = videoTrack.id;
           const audioTrack = info.audioTracks?.[0];
           this.audioTrackId = audioTrack ? audioTrack.id : null;
           if (typeof mp4boxFile.setExternalSegmentBoundaries === "function" && this.videoSegmentBoundaries.length > 0) {
           mp4boxFile.setExternalSegmentBoundaries(this.videoTrackId, { mode: "stream", track: "video" }, this.videoSegmentBoundaries, { rapAlignement: true });
           this.log(`Segmenter using external boundaries count=${this.videoSegmentBoundaries.length}`);
           } else {
           const desiredFragments = Math.max(1, this.segments.length);
           const totalSamples = videoTrack.nb_samples || desiredFragments;
           let nbSamplesPerFragment = Math.max(1, Math.floor(totalSamples / desiredFragments));
           let expectedFragments = Math.ceil(totalSamples / nbSamplesPerFragment);
           if (expectedFragments < desiredFragments) {
           nbSamplesPerFragment = Math.max(1, Math.ceil(totalSamples / desiredFragments));
           expectedFragments = Math.ceil(totalSamples / nbSamplesPerFragment);
           }
           this.log(`Segmenter config: samples=${totalSamples}, targetFragments=${desiredFragments}, nbSamplesPerFragment=${nbSamplesPerFragment}, expectedFragments=${expectedFragments}`);
           mp4boxFile.setSegmentOptions(this.videoTrackId, { mode: "stream", track: "video" }, {
           nbSamples: nbSamplesPerFragment,
           nbSamplesPerFragment,
           rapAlignement: true
           });
           }
           if (this.audioTrackId) {
             const audioTimescale = audioTrack?.timescale || info.timescale || 48000;
             if (typeof mp4boxFile.setExternalSegmentBoundaries === "function" && this.audioSegmentBoundaries.length > 0) {
               mp4boxFile.setExternalSegmentBoundaries(this.audioTrackId, { mode: "stream", track: "audio" }, this.audioSegmentBoundaries, { rapAlignement: true });
               this.log(`Audio segmenter using external boundaries count=${this.audioSegmentBoundaries.length}`);
             } else {
               const fragDuration = Math.max(1, Math.round(this.segmentDuration * audioTimescale));
               mp4boxFile.setSegmentOptions(this.audioTrackId, { mode: "stream", track: "audio" }, {
                 fragmentDuration: fragDuration,
                 rapAlignement: true
               });
               this.log(`Audio segmenter fallback: fragmentDuration=${fragDuration} timescale=${audioTimescale}`);
             }
           }
           // Initialize segmentation so mp4box starts emitting moof/mdat in onSegment; init is built separately from cached header.
           // Build init segments per track. Prefer new mp4box.initializeTrackSegmentation(trackId) when available.
           const trackInitMap = new Map<number, ArrayBuffer>();
           let combinedInitSegs: MP4InitSegmentationResult | null = null;
           const ensureCombinedInits = () => {
             if (combinedInitSegs) return;
             combinedInitSegs = mp4boxFile.initializeSegmentation() as MP4InitSegmentationResult;
             const trackEntries = Array.isArray(combinedInitSegs?.tracks) ? combinedInitSegs.tracks : [];
             trackInitMap.clear();
             for (const t of trackEntries) {
               if (t?.id != null && t.buffer) {
                 trackInitMap.set(t.id, t.buffer);
               }
             }
           };

           const pickInit = (trackId: number | null | undefined) => {
             if (trackId == null) return undefined;
             if (typeof mp4boxFile.initializeTrackSegmentation === "function") {
               const single = mp4boxFile.initializeTrackSegmentation(trackId) as MP4InitSegmentationResult;
               if (single?.buffer) return { id: trackId, buffer: single.buffer };
               const nested = Array.isArray(single?.tracks)
                 ? single.tracks.find((t) => t?.buffer)
                 : undefined;
               if (nested?.buffer) return { id: trackId, buffer: nested.buffer };
             }
             ensureCombinedInits();
             if (trackInitMap.has(trackId)) {
               return { id: trackId, buffer: trackInitMap.get(trackId)! };
             }
             return undefined;
           };

           const initInfo = pickInit(this.videoTrackId);
           // For audio, only accept track-specific init (no generic fallback), to avoid mixed-track init buffers.
           const audioInitInfo = this.audioTrackId ? pickInit(this.audioTrackId) : undefined;

           if (!initInfo?.buffer) {
            const availableKeys = trackInitMap.size
              ? Array.from(trackInitMap.keys()).join(",")
              : "none";
            const msg = `initializeSegmentation returned no buffer; trackId=${this.videoTrackId} available=${availableKeys}. Falling back to header-based init build.`;
            this.log(msg);
            reject(new Error(msg));
            return;
           }
           mp4boxFile.start();
           const videoInit = new Blob([initInfo.buffer], { type: "video/iso.segment" });
           let audioInit: Blob | undefined;
           if (audioInitInfo?.buffer) {
             audioInit = new Blob([audioInitInfo.buffer], { type: "audio/mp4" });
           }
           const audioCount = audioInit
             ? (this.audioSegmentBoundaries.length > 0 ? this.audioSegmentBoundaries.length : this.segments.length)
             : 0;
           resolve({ videoInit, audioInit, audioSegmentCount: audioCount });
           };

           mp4boxFile.onSegment = (id: number, user: any, buffer: ArrayBuffer, sampleNum: number, isLast: boolean) => {
           const isVideo = id === this.videoTrackId;
           const isAudio = id === this.audioTrackId;
           if (!isVideo && !isAudio) return;
           let targetIndex = -1;
           const boundaryIndex = isVideo
             ? this.findVideoSegmentIndex(sampleNum)
             : this.findAudioSegmentIndex(sampleNum);
           const isStreamFlow = isVideo && user?.mode === "stream";
           if (isStreamFlow) {
             targetIndex = this.streamingVideoSegmentsEmitted;
           } else if (boundaryIndex >= 0) {
             targetIndex = boundaryIndex;
           }
           if (targetIndex < 0) {
             if (isVideo && this.videoTrackId !== null) {
               mp4boxFile.releaseUsedSamples(this.videoTrackId, sampleNum);
             }
             if (isAudio && this.audioTrackId !== null) {
               mp4boxFile.releaseUsedSamples(this.audioTrackId, sampleNum);
             }
             return;
           }
           if (targetIndex >= this.segments.length) {
             if (isVideo && this.videoTrackId !== null) {
               mp4boxFile.releaseUsedSamples(this.videoTrackId, sampleNum);
             }
             if (isAudio && this.audioTrackId !== null) {
               mp4boxFile.releaseUsedSamples(this.audioTrackId, sampleNum);
             }
             return;
           }
          const blob = new Blob([buffer], { type: isVideo ? "video/iso.segment" : "audio/mp4" });
          if (isVideo) {
            const fresh = !this.videoSegmentFragments.has(targetIndex);
            this.videoSegmentFragments.set(targetIndex, blob);
            if (fresh) {
               if (isStreamFlow) {
                 this.streamingVideoSegmentsEmitted += 1;
               }
               this.notifyFragmentReady(targetIndex, blob);
               this.log(`notify Fragment:${targetIndex}`);
             }
             if (this.videoTrackId !== null) {
               mp4boxFile.releaseUsedSamples(this.videoTrackId, sampleNum);
             }
             if (fresh && user?.mode === "stream") {
               if (isLast || this.streamingVideoSegmentsEmitted >= segments.length) {
                 this.fragmentGenerationDone = true;
                 this.drainWaitersAfterComplete();
               }
             }
          } else if (isAudio) {
            const freshAudio = !this.audioSegmentFragments.has(targetIndex);
            this.audioSegmentFragments.set(targetIndex, blob);
           if (freshAudio) {
             this.notifyAudioFragmentReady(targetIndex, blob);
           }
            if (this.audioTrackId !== null) {
              mp4boxFile.releaseUsedSamples(this.audioTrackId, sampleNum);
            }
          }
          const producedAll = this.streamingVideoSegmentsEmitted >= segments.length;
          if (user?.mode === "stream" && (isLast || producedAll)) {
            this.fragmentGenerationDone = true;
            this.drainWaitersAfterComplete();
          }
           };

           // Start chunked read asynchronously
           startSequentialFeed();
           } catch (err: any) {
            reject(err);
           }
     });
  }

  private notifyFragmentReady(index: number, blob: Blob) {
    const waiters = this.videoFragmentWaiters.get(index);
    if (waiters) {
      waiters.forEach(res => res(blob));
      this.videoFragmentWaiters.delete(index);
    }
  }

  private notifyAudioFragmentReady(index: number, blob: Blob) {
    const waiters = this.audioFragmentWaiters.get(index);
    if (waiters) {
      waiters.forEach(res => res(blob));
      this.audioFragmentWaiters.delete(index);
    }
  }

  private drainWaitersAfterComplete() {
    // Resolve any lingering waiters with available fragments (or null) once generation is done.
    for (const [idx, waiters] of this.videoFragmentWaiters.entries()) {
      const blob = this.videoSegmentFragments.get(idx) || null;
      waiters.forEach(res => res(blob));
    }
    for (const [idx, waiters] of this.audioFragmentWaiters.entries()) {
      const blob = this.audioSegmentFragments.get(idx) || null;
      waiters.forEach(res => res(blob));
    }
    this.videoFragmentWaiters.clear();
    this.audioFragmentWaiters.clear();
  }

  private computeAudioByteRange(index: number): { startByte: number; endByte: number } | null {
    if (this.audioSegmentBoundaries.length === 0 || this.audioSamples.length === 0) return null;
    if (index < 0 || index >= this.audioSegmentBoundaries.length) return null;
    const startSampleNum = index === 0 ? 1 : (this.audioSegmentBoundaries[index - 1] + 1);
    const endSampleNum = this.audioSegmentBoundaries[index];
    const startSample = this.audioSamples.find(s => s.number === startSampleNum);
    const endSample = this.audioSamples.find(s => s.number === endSampleNum);
    if (!startSample || !endSample) return null;
    return {
      startByte: startSample.offset,
      endByte: endSample.offset + endSample.size
    };
  }

  private enqueueFeedRange(start: number, end: number, label: string): Promise<void> {
    if (!this.mp4boxFile) return Promise.resolve();
    const CHUNK_SIZE = 1024 * 1024;
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(this.file.size, end);
    if (safeStart >= safeEnd) return Promise.resolve();

    this.feedChain = this.feedChain
      .then(async () => {
        let offset = safeStart;
        while (offset < safeEnd) {
          if (this.stopRequested) break;
          const sliceEnd = Math.min(offset + CHUNK_SIZE, safeEnd);
          const buf = await this.file.slice(offset, sliceEnd).arrayBuffer();
          (buf as any).fileStart = offset;
          this.mp4boxFile!.appendBuffer(buf);
          offset = sliceEnd;
        }
        this.mp4boxFile!.flush();
      })
      .catch(err => {
        this.log(`Feed ${label} failed: ${err?.message || err}`);
      });

    return this.feedChain;
  }

  private ensureOnDemandGeneration(index: number) {
    // Once streaming fragmenter finished or segment already completed, skip on-demand to avoid needless work.
    if (this.fragmentGenerationDone) return;
    const seg = this.segments[index];
    if (!seg || seg.status === "completed") return;
    if (this.stopRequested) return;
    if (this.onDemandGeneration.has(index)) return;
    const genPromise = this.buildFragmentOnDemand(index)
      .catch(err => {
        this.log(`On-demand fragment ${index} failed: ${err?.message || err}`);
      })
      .finally(() => {
        this.onDemandGeneration.delete(index);
      });
    this.onDemandGeneration.set(index, genPromise);
  }

  private findVideoSegmentIndex(sampleNum: number): number {
    return this.videoSegmentBoundaries.findIndex(boundary => sampleNum <= boundary);
  }

  private findAudioSegmentIndex(sampleNum: number): number {
    if (this.audioSegmentBoundaries.length === 0) return -1;
    return this.audioSegmentBoundaries.findIndex(boundary => sampleNum <= boundary);
  }

  private waitForFragment(
    index: number,
    timeoutMs: number,
    fragments: Map<number, Blob>,
    waiters: Map<number, ((blob: Blob | null) => void)[]>,
    label: "video" | "audio",
    logTimeout = false
  ): Promise<Blob | null> {
    const existing = fragments.get(index);
    if (existing) return Promise.resolve(existing);
    const seg = this.segments.find(s => s.index === index);
    if (seg?.status === "completed" || this.fragmentGenerationDone || this.stopRequested) {
      // Already uploaded and purged; nothing to wait for.
      return Promise.resolve(null);
    }

    // Kick off on-demand generation if not already running and fragment not yet produced.
    this.ensureOnDemandGeneration(index);

    return new Promise(resolve => {
      const waiterList = waiters.get(index) || [];
      waiterList.push(resolve);
      waiters.set(index, waiterList);
      setTimeout(() => {
        // If done/aborted in the meantime, skip noisy logging.
        const curSeg = this.segments.find(s => s.index === index);
        if (this.fragmentGenerationDone || this.stopRequested || curSeg?.status === "completed") {
          resolve(null);
          return;
        }
        const late = fragments.get(index);
        if (late) {
          resolve(late);
        } else {
          if (logTimeout) this.log(`Timeout waiting for ${label} fragment ${index}`);
          resolve(null);
        }
      }, timeoutMs);
    });
  }
}
