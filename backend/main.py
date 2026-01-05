# backend/main.py
import os
import uuid
import logging
import asyncio
import json
import subprocess
import tempfile
import shutil
from datetime import datetime
from typing import Dict, Any, Set
from collections import defaultdict

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .models import (
    InitUploadRequest,
    InitUploadResponse,
    PriorityRequest,
    RegisterUploaderRequest,
    RegisterUploaderResponse,
    NextTasksRequest,
    NextTasksResponse,
    TaskInfo,
)
from .scheduler import UploadScheduler

# ---------------- Basic Initialization ----------------

app = FastAPI(title="Chunkstream Backend")

# Simple logging with timestamps
logger = logging.getLogger("chunkstream")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
logger.setLevel(logging.INFO)

# Local storage directory
BASE_DIR = os.path.dirname(__file__)
BASE_STORAGE = os.path.join(BASE_DIR, "storage")
os.makedirs(BASE_STORAGE, exist_ok=True)

# In-memory metadata store per video
videos_meta: Dict[str, Dict[str, Any]] = {}

# Scheduler instance
scheduler = UploadScheduler()

# WebSocket connections keyed by video_id for uploaders
uploader_ws_clients: Dict[str, Set[WebSocket]] = defaultdict(set)

# CORS for local frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Middleware: log request timestamps
@app.middleware("http")
async def log_requests(request: Request, call_next):
    ts = datetime.utcnow().isoformat()
    logger.info(f"REQ {ts} {request.method} {request.url.path}")
    response = await call_next(request)
    logger.info(f"RES {datetime.utcnow().isoformat()} {request.method} {request.url.path} status={response.status_code}")
    return response


async def broadcast_priority(video_id: str, indexes: Any):
  """
  Push priority segment indexes to all connected uploader WebSockets.
  indexes: iterable of integers.
  """
  clients = uploader_ws_clients.get(video_id)
  if not clients:
    return
  payload = json.dumps({"type": "priority", "indexes": list(indexes)})
  dead = []
  for ws in list(clients):
    try:
      await ws.send_text(payload)
    except Exception as e:  # disconnected/unable to send
      logger.warning(f"WS send failed for video {video_id}: {e}")
      dead.append(ws)
  for ws in dead:
    clients.discard(ws)


def priority_window_indexes(video_id: str, index: int, window_before: int = 2, window_after: int = 5):
  """
  Build the priority index window: window_before before, window_after after.
  If total segments are known, clamp to the upper bound.
  """
  meta = videos_meta.get(video_id, {})
  seg_count = meta.get("segment_count")
  start = max(0, index - window_before)
  end = index + window_after
  if seg_count is not None:
    end = min(end, seg_count - 1)
  return range(start, end + 1)


async def _ffprobe_json(args):
  """
  Run ffprobe and return parsed JSON. Raises on failure.
  """
  proc = await asyncio.create_subprocess_exec(
      *args,
      stdout=asyncio.subprocess.PIPE,
      stderr=asyncio.subprocess.PIPE,
  )
  out, err = await proc.communicate()
  if proc.returncode != 0:
    raise RuntimeError(f"ffprobe failed: {err.decode().strip()}")
  return json.loads(out.decode() or "{}")


async def verify_segment_alignment(video_id: str, index: int):
  """
  Check a segment's video starts at a keyframe and audio/video PTS are aligned (best-effort).
  Logs warnings if misaligned. Non-blocking for upload response.
  """
  video_dir = videos_meta.get(video_id, {}).get("dir")
  seg_duration = videos_meta.get(video_id, {}).get("segment_duration")
  if not video_dir:
    return
  v_seg = os.path.join(video_dir, f"segment_{index}.m4s")
  a_seg = os.path.join(video_dir, f"audio_segment_{index}.m4s")
  v_init = os.path.join(video_dir, "init.m4s")
  a_init = os.path.join(video_dir, "audio_init.m4s")
  if not os.path.exists(v_seg):
    return

  async def concat_init(init_path: str, seg_path: str) -> str:
    """
    Concatenate init + segment into a temp file for ffprobe.
    """
    if not os.path.exists(init_path) or not os.path.exists(seg_path):
      return ""
    loop = asyncio.get_running_loop()

    def _build():
      with tempfile.NamedTemporaryFile(delete=False, suffix=".m4s") as tmp:
        with open(init_path, "rb") as f_init:
          shutil.copyfileobj(f_init, tmp)
        with open(seg_path, "rb") as f_seg:
          shutil.copyfileobj(f_seg, tmp)
        return tmp.name

    return await loop.run_in_executor(None, _build)

  v_probe_path = await concat_init(v_init, v_seg)
  a_probe_path = await concat_init(a_init, a_seg) if os.path.exists(a_seg) else ""

  try:
    v_info = await _ffprobe_json([
      "ffprobe",
      "-v", "error",
      "-select_streams", "v:0",
      "-show_frames",
      "-read_intervals", "0%+0.01",
      "-show_entries", "frame=key_frame,pict_type,best_effort_timestamp_time",
      "-of", "json",
      v_probe_path or v_seg,
    ])
    frames = v_info.get("frames") or []
    if not frames:
      logger.warning(f"[probe] video segment {video_id}:{index} has no frames")
      return
    first_frame = frames[0]
    pict_type = first_frame.get("pict_type")
    v_pts = float(first_frame.get("best_effort_timestamp_time", 0.0))
    if v_pts == 0.0:
      # fallback to first packet pts
      v_pkt = await _ffprobe_json([
        "ffprobe",
        "-v", "error",
        "-select_streams", "v:0",
        "-show_packets",
        "-read_intervals", "0%+0.01",
        "-show_entries", "packet=pkt_pts_time,pts_time,best_effort_timestamp_time",
        "-of", "json",
        v_probe_path or v_seg,
      ])
      packets = v_pkt.get("packets") or []
      if packets:
        pkt = packets[0]
        v_pts = float(pkt.get("pkt_pts_time") or pkt.get("pts_time") or pkt.get("best_effort_timestamp_time") or 0.0)
    key_flag = int(first_frame.get("key_frame", 0))
    if pict_type != "I" and key_flag != 1:
      logger.warning(f"[probe] video segment {video_id}:{index} does not start on keyframe (pict_type={pict_type}, key={key_flag})")

    if a_probe_path:
      a_info = await _ffprobe_json([
        "ffprobe",
        "-v", "error",
        "-select_streams", "a:0",
        "-show_packets",
        "-read_intervals", "0%+0.01",
        "-show_entries", "packet=best_effort_timestamp_time",
        "-of", "json",
        a_probe_path,
      ])
      packets = a_info.get("packets") or []
      if packets:
        pkt = packets[0]
        a_pts = float(pkt.get("pkt_pts_time") or pkt.get("pts_time") or pkt.get("best_effort_timestamp_time") or 0.0)
        if abs(a_pts - v_pts) > 0.2:
          logger.warning(
            f"[probe] A/V start misaligned for {video_id}:{index} (video_pts={v_pts:.3f}, audio_pts={a_pts:.3f})"
          )
  except Exception as e:
    logger.warning(f"[probe] failed for segment {video_id}:{index}: {e}")
  finally:
    for p in (v_probe_path, a_probe_path):
      if p and os.path.exists(p):
        try:
          os.remove(p)
        except Exception:
          pass

# ---------------- API: Init video upload session ----------------


@app.post("/videos/init", response_model=InitUploadResponse)
async def init_video(req: InitUploadRequest):
    video_id = str(uuid.uuid4())
    video_dir = os.path.join(BASE_STORAGE, video_id)
    os.makedirs(video_dir, exist_ok=True)

    videos_meta[video_id] = {
        "filename": req.filename,
        "size": req.size,
        "dir": video_dir,
        "segment_count": req.segment_count,
        "segment_duration": req.segment_duration,
        "manifest_uploaded": False,
    }

    # Register the video in the scheduler
    await scheduler.register_video(
        video_id,
        segment_count=req.segment_count,
        segment_duration=req.segment_duration,
    )

    return InitUploadResponse(video_id=video_id)

# ---------------- API: Upload/get init segment (init.m4s) ----------------


@app.post("/videos/{video_id}/init")
async def upload_init_segment(video_id: str, init: UploadFile = File(...)):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    video_dir = videos_meta[video_id]["dir"]
    init_path = os.path.join(video_dir, "init.m4s")

    with open(init_path, "wb") as f:
        f.write(await init.read())

    return {"status": "ok"}


@app.get("/videos/{video_id}/init.m4s")
async def get_init_segment(video_id: str, request: Request):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    video_dir = videos_meta[video_id]["dir"]
    init_path = os.path.join(video_dir, "init.m4s")
    if not os.path.exists(init_path):
        raise HTTPException(status_code=404, detail="init segment does not exist")

    stat = os.stat(init_path)
    etag = f'W/"{stat.st_mtime_ns}-{stat.st_size}"'
    cache_headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": etag,
    }

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cache_headers)

    return FileResponse(init_path, media_type="video/iso.segment", headers=cache_headers)


# ---------------- API: Upload/get audio init segment (audio_init.m4s) ----------------


@app.post("/videos/{video_id}/audio/init")
async def upload_audio_init_segment(video_id: str, init: UploadFile = File(...)):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    video_dir = videos_meta[video_id]["dir"]
    init_path = os.path.join(video_dir, "audio_init.m4s")

    with open(init_path, "wb") as f:
        f.write(await init.read())

    return {"status": "ok"}


@app.get("/videos/{video_id}/audio/init.m4s")
@app.get("/videos/{video_id}/audio_init.m4s")  # manifest uses audio_init.m4s (no /audio/ prefix)
async def get_audio_init_segment(video_id: str, request: Request):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    video_dir = videos_meta[video_id]["dir"]
    init_path = os.path.join(video_dir, "audio_init.m4s")
    # Wait briefly for audio init to arrive (e.g., player requests before uploader finishes)
    max_wait_ms = 4000
    waited = 0
    while not os.path.exists(init_path) and waited < max_wait_ms:
        await asyncio.sleep(0.2)
        waited += 200
    if not os.path.exists(init_path):
        raise HTTPException(status_code=404, detail="audio init segment does not exist")

    stat = os.stat(init_path)
    etag = f'W/"{stat.st_mtime_ns}-{stat.st_size}"'
    cache_headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": etag,
    }

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cache_headers)

    return FileResponse(init_path, media_type="audio/mp4", headers=cache_headers)

# ---------------- API: Upload a single segment ----------------


async def _save_segment(video_id: str, index: int, segment: UploadFile):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    video_dir = videos_meta[video_id]["dir"]
    seg_filename = f"segment_{index}.m4s"
    seg_path = os.path.join(video_dir, seg_filename)

    # Save the segment file
    with open(seg_path, "wb") as f:
        f.write(await segment.read())

    # Update segment_count in metadata if needed
    meta = videos_meta[video_id]
    if meta["segment_count"] is None or index + 1 > meta["segment_count"]:
        meta["segment_count"] = index + 1

    # Mark this segment as uploaded in the scheduler
    await scheduler.mark_uploaded(video_id, index)

    # Fire-and-forget alignment check for audio/video timelines
    asyncio.create_task(verify_segment_alignment(video_id, index))

    return {"status": "ok", "index": index}


@app.post("/videos/{video_id}/segments")
async def upload_segment_legacy(
    video_id: str,
    segment: UploadFile = File(...),
    index: int = Form(...),
    start_time: float = Form(0.0),
    end_time: float = Form(0.0),
):
    """
    Backward-compatible path: POST /videos/{video_id}/segments, index read from form.
    """
    return await _save_segment(video_id, index, segment)


@app.post("/videos/{video_id}/segments/{index}")
async def upload_segment_with_path(
    video_id: str,
    index: int,
    segment: UploadFile = File(...),
    start_time: float = Form(0.0),
    end_time: float = Form(0.0),
):
    """
    New path: POST /videos/{video_id}/segments/{index}
    Makes the current segment index visible directly in server logs.
    """
    return await _save_segment(video_id, index, segment)

# ---------------- API: Player reports priority segments ----------------


@app.post("/videos/{video_id}/prioritize")
async def prioritize_segment(video_id: str, req: PriorityRequest):
    # Backward-compatible path (no path index), read index from body
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    # If the segment is missing, wait briefly for the uploader to produce it
    seg_path = os.path.join(videos_meta[video_id]["dir"], f"segment_{req.index}.m4s")
    if not os.path.exists(seg_path):
        await asyncio.sleep(0.2)

    await scheduler.bump_priority_around(video_id, req.index)
    await broadcast_priority(video_id, priority_window_indexes(video_id, req.index))
    return {"status": "ok", "index": req.index}


@app.post("/videos/{video_id}/prioritize/{index}")
async def prioritize_segment_with_path(video_id: str, index: int):
    # New path with index in URL, clearer logs
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    seg_path = os.path.join(videos_meta[video_id]["dir"], f"segment_{index}.m4s")
    if not os.path.exists(seg_path):
        await asyncio.sleep(0.2)

    await scheduler.bump_priority_around(video_id, index)
    await broadcast_priority(video_id, priority_window_indexes(video_id, index))
    return {"status": "ok", "index": index}

# ---------------- API: Upload/get MPD manifest ----------------


@app.post("/videos/{video_id}/manifest")
async def upload_manifest(video_id: str, request: Request):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="manifest body is empty")

    video_dir = videos_meta[video_id]["dir"]
    manifest_path = os.path.join(video_dir, "manifest.mpd")

    with open(manifest_path, "wb") as f:
        f.write(body)

    videos_meta[video_id]["manifest_uploaded"] = True

    # Update segment_count in scheduler if already known
    seg_count = videos_meta[video_id]["segment_count"]
    await scheduler.register_video(video_id, segment_count=seg_count)

    return {"status": "ok"}


@app.get("/videos/{video_id}/manifest.mpd")
async def get_manifest(video_id: str):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    video_dir = videos_meta[video_id]["dir"]
    manifest_path = os.path.join(video_dir, "manifest.mpd")
    if not os.path.exists(manifest_path):
        raise HTTPException(status_code=404, detail="MPD not found")
    return FileResponse(manifest_path, media_type="application/dash+xml")

# ---------------- API: Get a segment (for dash.js playback) ----------------


@app.get("/videos/{video_id}/segment_{index}.m4s")
async def get_segment(video_id: str, index: int):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    video_dir = videos_meta[video_id]["dir"]
    seg_path = os.path.join(video_dir, f"segment_{index}.m4s")
    # For player seeks requesting future segments, wait briefly for uploader;
    # also push the target segment into the priority queue to prompt upload.
    max_wait_ms = 10000
    waited = 0
    # Push priority task while waiting
    nudged = False
    rebroadcast_ms = 3000
    rebroadcasted = False
    while not os.path.exists(seg_path) and waited < max_wait_ms:
        if not nudged:
            nudged = True
            await scheduler.bump_priority_around(video_id, index, window_before=0, window_after=2)
            await broadcast_priority(video_id, priority_window_indexes(video_id, index, window_before=0, window_after=2))
        elif not rebroadcasted and waited >= rebroadcast_ms:
            rebroadcasted = True
            await broadcast_priority(video_id, priority_window_indexes(video_id, index, window_before=0, window_after=2))
        await asyncio.sleep(0.2)
        waited += 200
    if not os.path.exists(seg_path):
        raise HTTPException(status_code=404, detail="file does not exist")
    return FileResponse(seg_path, media_type="video/iso.segment")


@app.post("/videos/{video_id}/audio/segments/{index}")
async def upload_audio_segment(video_id: str, index: int, segment: UploadFile = File(...)):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    video_dir = videos_meta[video_id]["dir"]
    seg_filename = f"audio_segment_{index}.m4s"
    seg_path = os.path.join(video_dir, seg_filename)

    with open(seg_path, "wb") as f:
        f.write(await segment.read())

    # Re-check A/V alignment after writing audio
    asyncio.create_task(verify_segment_alignment(video_id, index))

    return {"status": "ok", "index": index}


@app.get("/videos/{video_id}/audio/segment_{index}.m4s")
@app.get("/videos/{video_id}/audio_segment_{index}.m4s")  # manifest uses audio_segment_*.m4s
async def get_audio_segment(video_id: str, index: int):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    video_dir = videos_meta[video_id]["dir"]
    seg_path = os.path.join(video_dir, f"audio_segment_{index}.m4s")
    max_wait_ms = 10000
    waited = 0
    nudged = False
    rebroadcast_ms = 3000
    rebroadcasted = False
    while not os.path.exists(seg_path) and waited < max_wait_ms:
        if not nudged:
            nudged = True
            await scheduler.bump_priority_around(video_id, index, window_before=0, window_after=2)
            await broadcast_priority(video_id, priority_window_indexes(video_id, index, window_before=0, window_after=2))
        elif not rebroadcasted and waited >= rebroadcast_ms:
            rebroadcasted = True
            await broadcast_priority(video_id, priority_window_indexes(video_id, index, window_before=0, window_after=2))
        await asyncio.sleep(0.2)
        waited += 200
    if not os.path.exists(seg_path):
        raise HTTPException(status_code=404, detail="file does not exist")
    return FileResponse(seg_path, media_type="audio/mp4")

# ---------------- API: Register an uploader client ----------------


@app.post("/videos/{video_id}/uploaders/register", response_model=RegisterUploaderResponse)
async def register_uploader(video_id: str, req: RegisterUploaderRequest):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    uploader_id = str(uuid.uuid4())
    await scheduler.register_uploader(video_id, uploader_id, req.max_concurrency)
    return RegisterUploaderResponse(uploader_id=uploader_id)

# ---------------- WebSocket: Uploader subscribes to priority tasks ----------------


@app.websocket("/videos/{video_id}/uploaders/{uploader_id}/ws")
async def uploader_priority_ws(video_id: str, uploader_id: str, websocket: WebSocket):
    if video_id not in videos_meta:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    clients = uploader_ws_clients[video_id]
    clients.add(websocket)
    logger.info(f"WS connected: video {video_id}, uploader {uploader_id}, total={len(clients)}")

    try:
        # Listen for ping/keepalive; ignore payload content
        while True:
            try:
                await websocket.receive_text()
            except WebSocketDisconnect:
                break
    finally:
        clients.discard(websocket)
        logger.info(f"WS disconnected: video {video_id}, uploader {uploader_id}, total={len(clients)}")

# ---------------- API: Uploader asks for next upload tasks ----------------


@app.post(
    "/videos/{video_id}/uploaders/{uploader_id}/next-tasks",
    response_model=NextTasksResponse,
)
async def get_next_tasks(video_id: str, uploader_id: str, req: NextTasksRequest):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    already_uploading: Set[int] = set(req.already_uploading)
    segs = await scheduler.get_next_tasks(
        video_id=video_id,
        uploader_id=uploader_id,
        need_slots=req.need_slots,
        already_uploading=already_uploading,
    )

    tasks = [TaskInfo(index=s.index, priority=s.effective_priority) for s in segs]
    return NextTasksResponse(tasks=tasks)
