export enum AppState {
  IDLE = 'IDLE',
  PARSING = 'PARSING',
  UPLOADING = 'UPLOADING',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR',
}

export interface SegmentTask {
  index: number;
  // Backend might send other info, but index is critical
}

export interface SegmentInfo {
  index: number;
  startTime: number;
  endTime: number;
  startByte: number;
  endByte: number;
  duration: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
}

export interface VideoMetadata {
  duration: number;
  segmentCount: number;
  mimeType: string;
  codecs: string;
  width: number;
  height: number;
  timescale: number;
}

// Partial MP4Box type definitions since they aren't fully available in standard @types
export interface MP4BoxInfo {
  duration: number;
  timescale: number;
  isFragmented: boolean;
  fragment_duration?: number;
  isProgressive: boolean;
  hasMoov: boolean;
  tracks: MP4BoxTrack[];
  mime: string;
  audioTracks: MP4BoxTrack[];
  videoTracks: MP4BoxTrack[];
}

export interface MP4BoxTrack {
  id: number;
  created: Date;
  modified: Date;
  movie_duration: number;
  layer: number;
  alternate_group: number;
  volume: number;
  track_width: number;
  track_height: number;
  timescale: number;
  duration: number;
  bitrate: number;
  codec: string;
  language: string;
  nb_samples: number;
  samples?: MP4BoxSample[]; 
}

export interface MP4BoxSample {
  number: number;
  dts: number;
  cts: number;
  duration: number;
  size: number;
  is_sync: boolean;
  description: any;
  offset: number; // Important: Byte offset
}

// mp4box.js custom buffer that extends ArrayBuffer with metadata
export interface MP4BoxBuffer extends ArrayBuffer {
  fileStart: number;
  usedBytes?: number;
}

export interface MP4File {
  onReady: (info: MP4BoxInfo) => void;
  onError: (e: any) => void;
  onSegment: (id: number, user: any, buffer: ArrayBuffer, sampleNum: number, isLast: boolean) => void;
  appendBuffer: (data: ArrayBuffer) => number;
  start: () => void;
  stop: () => void;
  flush: () => void;
  getTrackById: (id: number) => MP4BoxTrack;
  setSegmentOptions: (id: number, user: any, options: any) => void;
  releaseUsedSamples: (id: number, sampleNum: number) => void;
  initializeSegmentation: () => Record<number, { id: number; user: any; buffer: ArrayBuffer }>;
  setExternalSegmentBoundaries?: (id: number, user: any, boundarySamples: number[], opts?: { rapAlignement?: boolean }) => void;
}
