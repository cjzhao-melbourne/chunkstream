import { MP4BoxInfo, MP4File, SegmentInfo, MP4BoxSample, MP4BoxBuffer } from "../types";
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
  private initFragment: Blob | null = null;
  private segmentFragments: Map<number, Blob> = new Map();
  private fragmentWaiters: Map<number, ((blob: Blob) => void)[]> = new Map();
  private onDemandGeneration: Map<number, Promise<Blob | null>> = new Map();
  private fragmentGenerationDone = false;
  private segments: SegmentInfo[] = [];
  private segmentSampleBoundaries: number[] = [];
  private inFlight = new Set<number>();
  private stopRequested = false;
  private totalDurationSec = 0;

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
      const t0 = performance.now();
      const { info, segments, headerBuffer } = await this.parseMoovAndVirtualize();
      this.log(`loadMoovOnly: ${(performance.now() - t0).toFixed(1)}ms`);
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

      // 2) Start streaming fragmenter (produces moof/mdat progressively)
      this.initFragment =await this.startStreamingFragmenter(this.segments);

      // 3) Backend session
      const { video_id } = await uploaderService.initSession(
        this.file.name,
        this.file.size,
        segments.length,
        this.segmentDuration
      );
      this.videoId = video_id;
      this.log(`Session initialized. Video ID: ${this.videoId}`);

     
     if (!this.headerBuffer) {
       throw new Error("Header buffer missing before uploading init segment");
     }

     // Build a proper fragmented init segment (ftyp+moov with mvex) using mp4box
     const formData = new FormData();
     formData.append("init", this.initFragment, "init.m4s");
     await uploaderService.uploadInit(this.videoId, formData);
     this.log(`Init segment uploaded .`);
      
      // 5) Register uploader and start scheduling loop (uploads in background)
      const { uploader_id } = await uploaderService.registerUploader(this.videoId, this.maxConcurrency);
      this.uploaderId = uploader_id;
      this.log(`Uploader registered. ID: ${this.uploaderId}`);
      this.scheduleLoop();

      // 6) Upload MPD immediately after init
      const mpd = this.generateDASHManifest(info, this.segments);
      this.log(`Generated MPD:\n${mpd}`);
      await uploaderService.uploadManifest(this.videoId, mpd);
      this.log("Manifest uploaded.");

      // 7) Notify player after first segment uploaded (or timeout)
      await this.waitForSegmentCompletion(0, 20000);
      this.onReadyToPlay(playerService.getManifestUrl(this.videoId), this.videoId);

    } catch (err: any) {
      this.log(`Error: ${err.message}`);
      console.error(err);
    }
  }

  stop() {
    this.stopRequested = true;
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

    return MP4Box.loadMoovOnly({
      blob: this.file,
      // Let MP4Box know the total size so it keeps fetching beyond the first chunk if needed
      size: this.file.size,
    }).then(({ info, mp4, header }: { info: MP4BoxInfo; mp4: MP4File; header?: MP4BoxBuffer }) => {
      this.log("MOOV atom parsed. Building virtual segments from stsz/stco...");
      

      const videoTrackInfo = info.videoTracks[0];
      if (!videoTrackInfo) throw new Error("No video track found.");

      // MP4Box.getInfo() does not include the built sample list; fetch it from the MP4File track.
      const videoTrack = mp4.getTrackById(videoTrackInfo.id);
      const samples = videoTrack?.samples || [];
      if (samples.length === 0) {
        throw new Error("Sample table (stsz/stco) missing; cannot virtual slice. Please remux the file (faststart).");
      }
      this.log(`stsz/stco samples parsed: ${samples.length}`);       

      const trackTimescale = videoTrack.timescale || videoTrackInfo.timescale || info.timescale;
      const totalDuration = info.duration / info.timescale;
      const { segments, boundaries } = this.buildSegmentsFromSamples(samples, trackTimescale, totalDuration);
      if (segments.length === 0) {
        throw new Error("No segments were constructed from the sample table.");
      }
      this.segmentSampleBoundaries = boundaries;

      if (!header) {
        throw new Error("Failed to receive MP4 header buffer from loadMoovOnly");
      }

      return { info, segments, headerBuffer: header };
    });
  }

  private buildSegmentsFromSamples(samples: MP4BoxSample[], timescale: number, totalDuration: number): { segments: SegmentInfo[]; boundaries: number[] } {
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

      if (s.is_sync && elapsed >= this.segmentDuration * 0.75) {
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
    const timelineParts: string[] = [];
    let prevD: number | null = null;
    let run = 0;
    const flush = () => {
      if (prevD == null) return;
      const r = run > 1 ? ` r="${run - 1}"` : "";
      timelineParts.push(`<S d="${prevD}"${r}/>`); 
    };
    for (const seg of segments) {
      const dTicks = Math.max(1, Math.round((seg.endTime - seg.startTime) * timescale));
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
    const timelineXml = timelineParts.join("\n        ");
    
    // Static DASH MPD with accurate SegmentTimeline
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
  </Period>
</MPD>`;
  }

  private async scheduleLoop() {
    this.log("Starting scheduling loop...");
    while (!this.stopRequested) {
      // Check if all done
      const allDone = this.segments.every(s => s.status === 'completed');
      if (allDone) {
        this.log("All segments uploaded!");
        break;
      }

      const slotsAvailable = this.maxConcurrency - this.inFlight.size;
      if (slotsAvailable <= 0) {
        await this.sleep(200);
        continue;
      }

      try {
    const { tasks } = await uploaderService.getNextTasks(
      this.videoId!, 
      this.uploaderId!, 
      slotsAvailable, 
      Array.from(this.inFlight)
        );

        if (!tasks || tasks.length === 0) {
          await this.sleep(1000); // Wait for tasks
          continue;
        }

        for (const task of tasks) {
          if (this.inFlight.has(task.index)) continue;
          
          // Mark as uploading
          this.updateSegmentStatus(task.index, 'uploading');
          this.inFlight.add(task.index);
          
          // Trigger upload (async, don't await here to allow concurrency)
          this.processTask(task.index).catch(err => {
            this.log(`Task ${task.index} failed: ${err.message}`);
            this.updateSegmentStatus(task.index, 'error');
          }).finally(() => {
            this.inFlight.delete(task.index);
          });
        }

      } catch (e) {
        console.error(e);
        await this.sleep(2000);
      }
    }
  }

  private async processTask(index: number) {
    const segment = this.segments.find(s => s.index === index);
    if (!segment) return;
    const fragment = await this.waitForFragment(index, 20000);
    if (!fragment) {
      this.log(`Segment ${index} not ready, will retry`);
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
    
    this.updateSegmentStatus(index, 'completed');
    this.log(`Segment ${index} uploaded.`);

    // Free memory after upload
    this.segmentFragments.delete(index);
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
    formData.append("init", this.initFragment, "init.m4s");
    await uploaderService.uploadInit(this.videoId, formData);
    this.log(`Init segment uploaded (${this.initFragment.size} bytes).`);
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
  private async buildFragmentOnDemand(index: number): Promise<Blob | null> {
    if (!this.headerBuffer || !this.mp4Info) {
      this.log("On-demand build skipped: missing header/mp4 info");
      return null;
    }
    const seg = this.segments.find(s => s.index === index);
    if (!seg) {
      this.log(`On-demand build skipped: segment ${index} not found`);
      return null;
    }

    const MP4Box = (window as any).MP4Box;
    if (!MP4Box || typeof MP4Box.createFile !== "function") {
      this.log("mp4box.js not available for on-demand build");
      return null;
    }

    return new Promise<Blob | null>((resolve) => {
      try {
        const mp4boxFile = MP4Box.createFile();
        let videoTrackId: number | null = null;
        let resolved = false;

        mp4boxFile.onError = (e: any) => {
          this.log(`on-demand mp4box error: ${typeof e === "string" ? e : e?.message || "unknown"}`);
          if (!resolved) resolve(null);
        };

        mp4boxFile.onReady = (info: MP4BoxInfo) => {
          const videoTrack = info.videoTracks[0];
          if (!videoTrack) {
            this.log("On-demand build: no video track found");
            if (!resolved) resolve(null);
            return;
          }
          videoTrackId = videoTrack.id;

          // Compute sample range for this segment based on recorded boundaries
          const startSample = index === 0 ? 1 : (this.segmentSampleBoundaries[index - 1] + 1);
          const endSample = this.segmentSampleBoundaries[index];
          const nbSamples = endSample - startSample + 1;

          // Configure extraction for the specific sample window
          if (typeof mp4boxFile.setExtractionOptions === "function") {
            mp4boxFile.setExtractionOptions(videoTrackId, null, {
              start: startSample,
              nbSamples,
              rapAlignement: true
            });
          }

          // Use segmentation to emit moof/mdat for the extracted samples
          mp4boxFile.setSegmentOptions(videoTrackId, null, {
            startWithSAP: 1,
            rapAlignement: true,
            nbSamples
          });
          mp4boxFile.initializeSegmentation();
          mp4boxFile.start();
        };

        mp4boxFile.onSegment = (_id: number, _user: any, buffer: ArrayBuffer, sampleNum: number) => {
          if (resolved) return;
          resolved = true;
          const blob = new Blob([buffer], { type: "video/iso.segment" });
          if (videoTrackId !== null) {
            mp4boxFile.releaseUsedSamples(videoTrackId, sampleNum);
          }
          resolve(blob);
        }

        // Append header
        const headerBuf = this.headerBuffer.slice(0);
        (headerBuf as any).fileStart = 0;
        mp4boxFile.appendBuffer(headerBuf);

        const CHUNK = 1024 * 1024;

        // Feed a byte range into mp4box (targeted or from start)
        const feedRange = async (start: number, end: number) => {
          let offset = start;
          while (offset < end && !resolved) {
            const sliceEnd = Math.min(offset + CHUNK, end);
            const buf = await this.file.slice(offset, sliceEnd).arrayBuffer();
            (buf as any).fileStart = offset;
            mp4boxFile.appendBuffer(buf);
            offset = sliceEnd;
          }
          mp4boxFile.flush();
        };

        // First try minimal range (only the segment bytes). If that cannot produce a fragment,
        // fall back to feeding from file start to this segment end to give mp4box full context.
        const run = async () => {
          await feedRange(seg.startByte, seg.endByte);
          if (!resolved) {
            this.log(`On-demand build for segment ${index} could not produce a fragment; retrying with full prefix.`);
            await feedRange(0, seg.endByte);
            if (!resolved) {
              this.log(`On-demand build for segment ${index} failed even with full prefix.`);
              resolve(null);
            }
          }
        };

        run().catch(err => {
          this.log(`On-demand feed error for segment ${index}: ${err?.message || err}`);
          if (!resolved) resolve(null);
        });
      } catch (err: any) {
        this.log(`On-demand build exception: ${err?.message || err}`);
        resolve(null);
      }
    });
  }

  /**
   * Streaming fragmentation with mp4box.js: reads file in small chunks and emits segments progressively.
   * 
   */
  private startStreamingFragmenter(segments: SegmentInfo[]): Promise<Blob> {
    const MP4Box = (window as any).MP4Box;
    if (!MP4Box || typeof MP4Box.createFile !== "function") {
      throw new Error("mp4box.js not available");
    }

    return new Promise((resolve, reject) => {

      try {

         const mp4boxFile = MP4Box.createFile();
         let videoTrackId: number | null = null;
         let segmentIndex = 0;

         const CHUNK_SIZE = 1024 * 1024; // 1MB per read

         const feedChunks = async () => {
           let offset = 0;
           while (offset < this.file.size) {
           if (this.stopRequested) break;
           const end = Math.min(offset + CHUNK_SIZE, this.file.size);
           const buf = await this.file.slice(offset, end).arrayBuffer();
           (buf as any).fileStart = offset;
           mp4boxFile.appendBuffer(buf);
           offset = end;
           }
           mp4boxFile.flush();
           this.fragmentGenerationDone = true;
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
          
           videoTrackId = videoTrack.id;
           if (typeof mp4boxFile.setExternalSegmentBoundaries === "function" && this.segmentSampleBoundaries.length > 0) {
           mp4boxFile.setExternalSegmentBoundaries(videoTrackId, null, this.segmentSampleBoundaries, { rapAlignement: true });
           this.log(`Segmenter using external boundaries count=${this.segmentSampleBoundaries.length}`);
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
           mp4boxFile.setSegmentOptions(videoTrackId, null, {
           nbSamples: nbSamplesPerFragment,
           nbSamplesPerFragment,
           rapAlignement: true
           });
           }
           // Initialize segmentation so mp4box starts emitting moof/mdat in onSegment; init is built separately from cached header.
           const initSegs = mp4boxFile.initializeSegmentation();
           const initInfo =
             (initSegs as any)?.buffer
               ? (initSegs as any)
               : (initSegs as any)?.[videoTrackId] ?? (initSegs ? Object.values(initSegs as any)[0] : undefined);
           if (!initInfo?.buffer) {
            const availableKeys = initSegs ? Object.keys(initSegs).join(",") : "none";
            this.log(`initializeSegmentation returned no buffer; trackId=${videoTrackId} available=${availableKeys}. Falling back to header-based init build.`);
            
            return;
             
           }
           mp4boxFile.start();
           resolve(new Blob([initInfo.buffer], { type: "video/iso.segment" }));
           };

           mp4boxFile.onSegment = (_id: number, _user: any, buffer: ArrayBuffer, sampleNum: number, isLast: boolean) => {
     
           const blob = new Blob([buffer], { type: "video/iso.segment" });
           this.segmentFragments.set(segmentIndex, blob);
           this.notifyFragmentReady(segmentIndex, blob);
           this.log(`notify Fragment:${segmentIndex}`);
           segmentIndex += 1;
           if (videoTrackId !== null) {
           mp4boxFile.releaseUsedSamples(videoTrackId, sampleNum);
           }
           if (isLast || segmentIndex >= segments.length) {
           this.fragmentGenerationDone = true;
           }
           };

           // Start chunked read asynchronously
           feedChunks().catch(err => this.log(`feedChunks error: ${err?.message || err}`));
           } catch (err: any) {
            reject(err);
           }
     });
  }

  private notifyFragmentReady(index: number, blob: Blob) {
    const waiters = this.fragmentWaiters.get(index);
    if (waiters) {
      waiters.forEach(res => res(blob));
      this.fragmentWaiters.delete(index);
    }
  }

  private waitForFragment(index: number, timeoutMs = 15000): Promise<Blob | null> {
    const existing = this.segmentFragments.get(index);
    if (existing) return Promise.resolve(existing);

    // Kick off on-demand generation if not already running and fragment not yet produced.
    if (!this.onDemandGeneration.has(index)) {
      const genPromise = this.buildFragmentOnDemand(index)
        .then(blob => {
          if (blob) {
            this.segmentFragments.set(index, blob);
            this.notifyFragmentReady(index, blob);
          }
          return blob;
        })
        .catch(err => {
          this.log(`On-demand fragment ${index} failed: ${err?.message || err}`);
          return null;
        })
        .finally(() => {
          this.onDemandGeneration.delete(index);
        });
      this.onDemandGeneration.set(index, genPromise);
    }

    return new Promise(resolve => {
      const waiters = this.fragmentWaiters.get(index) || [];
      waiters.push(resolve);
      this.fragmentWaiters.set(index, waiters);
      setTimeout(() => {
        const late = this.segmentFragments.get(index);
        if (late) {
          resolve(late);
        } else {
          this.log(`Timeout waiting for fragment ${index}`);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  
}
