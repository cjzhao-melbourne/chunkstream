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

/**
 * uploadInit(..) POSTs the initialization segment (init.m4s) to /videos/{videoId}/init. 
 * It sends the ftyp/moov header for the video so the backend can serve it to the player 
 * before any media segments are uploaded.
 */
export const uploaderService = {
  async uploadInit(videoId: string, formData: FormData): Promise<void> {
    const resp = await fetch(`${BACKEND_BASE}/videos/${videoId}/init`, {
      method: "POST",
      body: formData
    });
    throwIfNotOk(resp, "Failed to upload init segment");
  },
  async uploadAudioInit(videoId: string, formData: FormData): Promise<void> {
    const resp = await fetch(`${BACKEND_BASE}/videos/${videoId}/audio/init`, {
      method: "POST",
      body: formData
    });
    throwIfNotOk(resp, "Failed to upload audio init segment");
  },

  /*
   initSession(..) is the first call before uploading.
   It POSTs to /videos/init with the source file name, size, intended segment count, and segment duration.
    The backend creates a storage directory, records the metadata, 
    registers the video with the scheduler, and returns a new video_id 
    you’ll use for all subsequent init/segment uploads and prioritize requests.
  */ 

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

  /*
     registerUploader calls the backend POST /videos/{videoId}/uploaders/register with max_concurrency; 
     the backend assigns an uploader_id and records that this uploader can work on that video.
     The returned uploader_id is then used in subsequent getNextTasks requests so the scheduler
     can hand out segments to this uploader.
     Note： uploader_id is not videoId, this id is disigned for parallel uploading(even accross machines)
  */

  async registerUploader(videoId: string, maxConcurrency: number): Promise<RegisterResponse> {
    const resp = await fetch(`${BACKEND_BASE}/videos/${videoId}/uploaders/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_concurrency: maxConcurrency })
    });
    throwIfNotOk(resp, "Failed to register uploader");
    return resp.json();
  },

  /**
   * getNextTasks is the uploader-side polling call to ask the backend scheduler 
   * “which segments should I upload next”. 
   * It POSTs to /videos/{videoId}/uploaders/{uploaderId}/next-tasks with:
   * need_slots: how many upload slots are free
   * already_uploading: which segment indexes this uploader is currently working on
   * The backend responds with a list of tasks (segment indexes, ordered by its priority logic).
   * The uploader loop then picks those segments to generate/upload.
   **/
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
  async uploadAudioSegment(videoId: string, index: number, formData: FormData): Promise<void> {
    const resp = await fetch(
      `${BACKEND_BASE}/videos/${videoId}/audio/segments/${index}`,
      {
        method: "POST",
        body: formData
      }
    );
    throwIfNotOk(resp, "Failed to upload audio segment");
  },
};
