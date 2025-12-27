# Chunkstream
.
> **Video share while uploading. Seek instantly**  
> Frontend MPEG-DASH slicing + backend intelligent upload scheduling.

---

## 1. What is Chunkstream?

**Chunkstream** is a prototype video sharing platform that lets users share **large MP4 files** as a **MPEG-DASH stream** within milisecond — long before the entire video has been uploaded.

Instead of uploading a multi-GB file and waiting forever for a link, Chunkstream:

1. **Analyzes the MP4 file directly in the browser**
2. **Virtually slices** it into ~10-second chunks (aligned to keyframes)
3. **Generates a MPEG-DASH manifest (MPD)** that references these segments
4. **Streams the video as soon as the first few chunks are available**

On the backend, Chunkstream orchestrates uploads with a **two-queue scheduler** (normal + priority) so that segments near the current playback position are always uploaded and processed first, keeping user-perceived latency low even when the full video is still in flight.

The backend is written in **Python**, designed to be extended with **video transcoding , video analysis and intelligence** later (e.g., content tagging, scene detection, recommendations, etc.).

---

## 2. Key Features

### Frontend (Browser)

- **Local MP4 analysis**
  - Runs completely in the browser with JavaScript
  - Parses the selected MP4 file header and basic metadata
- **Virtual chunking (~10s per segment)**
  - Splits the video into logical segments
  - Each segment is treated as a standalone playable fragment
- **MPEG-DASH manifest generation**
  - Builds a standard **MPD** manifest describing all segments
  - Compatible with common players like `dash.js`
- **Instant share link**
  - As soon as manifest + initial segments are uploaded, the user gets a **playback URL** they can share with friends
  - The video can be watched while the rest is still uploading in the background

### Backend (Python)

- **Upload session management**
  - Creates a `video_id` for each upload session
  - Stores MPD and segment files under that session
- **Two-queue upload scheduler**
  - **Normal queue**: segments uploaded in natural order
  - **Priority queue**: segments that the viewer is currently watching or has just seeked to
  - When users drag the progress bar, the relevant segments are promoted to the priority queue
- **Auto lifecycle**
  - Tracks how many segments a video has
  - When all segments are uploaded and processed, the scheduler can safely retire the job
- **Ready for analysis**
  - Each chunk is a clear unit that can be fed into downstream analysis pipelines (e.g., object detection, motion analysis, etc.)

---

## 3. Architecture Overview

**High-level flow:**

1. **User selects MP4 file in browser**
2. Browser:
   - parses MP4 header
   - decides chunk boundaries (~10s each, keyframe-aligned )
3. Browser:
   - uploads chunk metadata + binary segments to backend
   - generates and uploads MPD manifest
4. Backend:
   - stores segments + manifest under a `video_id`
   - registers segment count with the scheduler
   - exposes URLs:
     - `GET /videos/{video_id}/manifest.mpd`
     - `GET /videos/{video_id}/segment_{index}.m4s`
5. Viewer:
   - opens the share URL (MPD)
   - `dash.js` requests segments as needed
6. When the viewer seeks:
   - frontend notifies backend: `POST /videos/{video_id}/prioritize`
   - scheduler puts upcoming segments into the **priority queue**

---

## 4. Tech Stack

- **Frontend**
  - Vanilla JavaScript
  - [`mp4box.js`](https://github.com/gpac/mp4box.js) for MP4 parsing (do not use the standard version, use the version we customized)
  - [`dash.js`](https://github.com/Dash-Industry-Forum/dash.js) for MPEG-DASH playback
  - Simple static HTML/CSS UI

- **Backend**
  - [FastAPI](https://fastapi.tiangolo.com/) (Python)
  - `uvicorn` ASGI server
  - Custom **upload scheduler** with:
    - `asyncio.Queue` for normal / priority queues
    - simple disk-based storage (prototype) – can later be swapped for S3/OSS/MinIO

---

## 5. Project Structure (Prototype)

```text
chunkstream/
├── backend/
│   ├── main.py          # FastAPI app: APIs for videos, segments, manifest
│   ├── scheduler.py     # Two-queue upload scheduler
│   ├── models.py        # Pydantic models for API and tasks
│   └── storage/         # Local storage (MPD + segments)
└── uploader/
    ├── index.html       # Upload + preview UI
    └── app.tsx           # Browser logic: analyze, chunk, upload, play

