const DEFAULT_BACKEND_BASE = "http://127.0.0.1:8000";

// Allow overriding the backend base URL via Vite env or a window flag for demos.
const BACKEND_BASE = (
  import.meta?.env?.VITE_BACKEND_BASE ||
  (typeof window !== "undefined" ? (window as any).__CHUNKSTREAM_BACKEND_BASE__ : undefined) ||
  DEFAULT_BACKEND_BASE
).replace(/\/$/, "");

const throwIfNotOk = (resp: Response, message: string) => {
  if (!resp.ok) {
    throw new Error(`${message} (status ${resp.status})`);
  }
};

export interface InitResponse {
  video_id: string;
}

export interface RegisterResponse {
  uploader_id: string;
}

export interface TasksResponse {
  tasks: { index: number }[];
}

export const backendService = {
  async uploadInit(videoId: string, formData: FormData): Promise<void> {
    const resp = await fetch(`${BACKEND_BASE}/videos/${videoId}/init`, {
      method: "POST",
      body: formData
    });
    throwIfNotOk(resp, "Failed to upload init segment");
  },

  async initSession(filename: string, size: number, segmentCount: number, segmentDuration: number): Promise<InitResponse> {
    const resp = await fetch(`${BACKEND_BASE}/videos/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename,
        size,
        segment_count: segmentCount,
        segment_duration: segmentDuration
      })
    });
    throwIfNotOk(resp, "Failed to init session");
    return resp.json();
  },

  async uploadManifest(videoId: string, mpdContent: string): Promise<void> {
    const resp = await fetch(`${BACKEND_BASE}/videos/${videoId}/manifest`, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: mpdContent
    });
    throwIfNotOk(resp, "Failed to upload manifest");
  },

  async registerUploader(videoId: string, maxConcurrency: number): Promise<RegisterResponse> {
    const resp = await fetch(`${BACKEND_BASE}/videos/${videoId}/uploaders/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_concurrency: maxConcurrency })
    });
    throwIfNotOk(resp, "Failed to register uploader");
    return resp.json();
  },

  async getNextTasks(videoId: string, uploaderId: string, needSlots: number, inFlight: number[]): Promise<TasksResponse> {
    const resp = await fetch(
      `${BACKEND_BASE}/videos/${videoId}/uploaders/${uploaderId}/next-tasks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          need_slots: needSlots,
          already_uploading: inFlight
        })
      }
    );
    throwIfNotOk(resp, "Failed to get tasks");
    return resp.json();
  },

  async uploadSegment(videoId: string, index: number, formData: FormData): Promise<void> {
    const resp = await fetch(
      `${BACKEND_BASE}/videos/${videoId}/segments/${index}`,
      {
        method: "POST",
        body: formData
      }
    );
    throwIfNotOk(resp, "Failed to upload segment");
  },

  async prioritizeSegment(videoId: string, index: number): Promise<void> {
    try {
      await fetch(`${BACKEND_BASE}/videos/${videoId}/prioritize/${index}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index })
      });
    } catch (e) {
      console.warn("Prioritize failed", e);
    }
  },
  
  getManifestUrl(videoId: string): string {
    return `${BACKEND_BASE}/videos/${videoId}/manifest.mpd`;
  }
};
