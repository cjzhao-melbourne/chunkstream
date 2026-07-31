# backend/main.py
import os
import uuid
import logging
import asyncio
import json
import math
import subprocess
import tempfile
import shutil
from datetime import datetime
from typing import Dict, Any, Set, Optional
from collections import defaultdict
from xml.etree import ElementTree as ET

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import Counter, Gauge
from prometheus_fastapi_instrumentator import Instrumentator

from models import (
    InitUploadRequest,
    InitUploadResponse,
    PriorityRequest,
    RegisterUploaderRequest,
    RegisterUploaderResponse,
    NextTasksRequest,
    NextTasksResponse,
    TaskInfo,
)
from scheduler import UploadScheduler
from transcoder import get_transcoder, PROFILES, SOURCE_RENDITION, select_ladder, remux_source_to_ts
from transcode_queue import TranscodeQueue

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

# Transcoding pipeline
_transcoder    = get_transcoder()


def _generate_dash_mpd(
    video_dir: str,
    segment_count: int,
    segment_duration: float,
    ladder_profiles: list,
    source_bitrate: Optional[int] = None,
    source_width: Optional[int] = None,
    source_height: Optional[int] = None,
) -> None:
    """
    Write a static DASH MPD with all segment_count segments pre-listed.
    Source rendition (served from raw uploaded files) is listed first when
    source info is provided; transcoded ladder profiles follow in descending order.
    """
    dash_dir = os.path.join(video_dir, "dash")
    os.makedirs(dash_dir, exist_ok=True)

    total = segment_count * segment_duration
    dur_ms = round(segment_duration * 1000)

    mpd = ET.Element("MPD", {
        "xmlns": "urn:mpeg:dash:schema:mpd:2011",
        "type": "static",
        "mediaPresentationDuration": f"PT{total:.3f}S",
        "minBufferTime": "PT2S",
        "profiles": "urn:mpeg:dash:profile:isoff-live:2011",
    })

    period = ET.SubElement(mpd, "Period", {"start": "PT0S"})
    adaptation = ET.SubElement(period, "AdaptationSet", {
        "mimeType": "video/mp4",
        "segmentAlignment": "true",
        "startWithSAP": "1",
    })

    def _add_rep(name: str, bitrate: int, width: int, height: int):
        rep = ET.SubElement(adaptation, "Representation", {
            "id": name,
            "bandwidth": str(bitrate),
            "width": str(width),
            "height": str(height),
            "codecs": "avc1.4D401F",
        })
        seg_template = ET.SubElement(rep, "SegmentTemplate", {
            "initialization": f"{name}/init.m4s",
            "media": f"{name}/segment_$Number$.m4s",
            "startNumber": "0",
            "timescale": "1000",
        })
        timeline = ET.SubElement(seg_template, "SegmentTimeline")
        ET.SubElement(timeline, "S", {"d": str(dur_ms), "r": str(segment_count - 1)})

    if source_bitrate and source_width and source_height:
        _add_rep(SOURCE_RENDITION, source_bitrate, source_width, source_height)

    for profile in sorted(ladder_profiles, key=lambda p: p["bitrate"], reverse=True):
        _add_rep(profile["name"], profile["bitrate"], profile["width"], profile["height"])

    ET.indent(mpd, space="  ")
    content = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(mpd, encoding="unicode")

    mpd_path = os.path.join(dash_dir, "manifest.mpd")
    with open(mpd_path, "w", encoding="utf-8") as f:
        f.write(content)

    logger.info(f"Generated DASH MPD: {mpd_path} ({segment_count} segments, {segment_duration}s each)")


def _generate_hls_playlists(
    video_dir: str,
    segment_count: int,
    segment_duration: float,
    ladder_profiles: list,
    source_bitrate: Optional[int] = None,
    source_width: Optional[int] = None,
    source_height: Optional[int] = None,
) -> None:
    """
    Pre-generate static HLS master + per-rendition playlists at init time.
    Segment .ts files don't exist yet; they are produced JIT on first request.
    Source rendition (remuxed fMP4→TS on demand) is listed first when source info provided.
    """
    hls_dir = os.path.join(video_dir, "hls")
    target_duration = math.ceil(segment_duration)

    master_renditions: list[dict] = []

    def _write_rendition_playlist(name: str, bitrate: int, width: int, height: int):
        rendition_dir = os.path.join(hls_dir, name)
        os.makedirs(rendition_dir, exist_ok=True)
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{target_duration}",
            "#EXT-X-PLAYLIST-TYPE:VOD",
        ]
        for i in range(segment_count):
            lines.append(f"#EXTINF:{segment_duration:.3f},")
            lines.append(f"segment_{i}.ts")
        lines.append("#EXT-X-ENDLIST")
        with open(os.path.join(rendition_dir, "playlist.m3u8"), "w") as f:
            f.write("\n".join(lines) + "\n")
        master_renditions.append({"name": name, "bitrate": bitrate, "width": width, "height": height})

    if source_bitrate and source_width and source_height:
        _write_rendition_playlist(SOURCE_RENDITION, source_bitrate, source_width, source_height)

    for profile in sorted(ladder_profiles, key=lambda p: p["bitrate"], reverse=True):
        _write_rendition_playlist(profile["name"], profile["bitrate"], profile["width"], profile["height"])

    lines = ["#EXTM3U", "#EXT-X-VERSION:3"]
    for r in master_renditions:
        lines.append(
            f'#EXT-X-STREAM-INF:BANDWIDTH={r["bitrate"]},'
            f'RESOLUTION={r["width"]}x{r["height"]},'
            f'NAME="{r["name"]}"'
        )
        lines.append(f'{r["name"]}/playlist.m3u8')
    with open(os.path.join(hls_dir, "master.m3u8"), "w") as f:
        f.write("\n".join(lines) + "\n")

    logger.info(f"Generated HLS playlists: {hls_dir} ({segment_count} segments, {segment_duration}s each)")


transcode_queue = TranscodeQueue(transcoder=_transcoder)


@app.on_event("startup")
async def _startup():
    transcode_queue.start()

# -------- Metrics (Prometheus) --------
# Exposed at /metrics by Instrumentator below.
uploads_total = Counter("uploads_total", "Number of uploaded media segments", ["video_id"])
upload_bytes_total = Counter("upload_bytes_total", "Total uploaded bytes", ["video_id"])
players_total = Counter("players_total", "Segment fetch requests from players")
videos_total = Gauge("videos_total", "Number of registered videos")
storage_bytes_used = Gauge("storage_bytes_used", "Bytes used under storage/")


def _compute_storage_bytes() -> int:
    total = 0
    for root, _, files in os.walk(BASE_STORAGE):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except FileNotFoundError:
                continue
    return total


def update_storage_metrics():
    storage_bytes_used.set(_compute_storage_bytes())
    videos_total.set(len(videos_meta))

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
        "https://demo.chunkstream.com",
        "http://demo.chunkstream.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auto-instrument HTTP metrics and expose /metrics (schema excluded)
Instrumentator().instrument(app).expose(app, include_in_schema=False)

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
  v_seg = os.path.join(video_dir, "dash", SOURCE_RENDITION, f"segment_{index}.m4s")
  a_seg = os.path.join(video_dir, f"audio_segment_{index}.m4s")
  v_init = os.path.join(video_dir, "dash", SOURCE_RENDITION, "init.m4s")
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

    ladder_profiles = (
        select_ladder(req.source_bitrate, req.source_height)
        if req.source_bitrate is not None and req.source_height is not None
        else list(PROFILES)
    )

    videos_meta[video_id] = {
        "filename": req.filename,
        "size": req.size,
        "dir": video_dir,
        "segment_count": req.segment_count,
        "segment_duration": req.segment_duration,
        "manifest_uploaded": False,
        "source_width": req.source_width,
        "source_height": req.source_height,
        "source_bitrate": req.source_bitrate,
        "ladder_profiles": ladder_profiles,
    }

    # Register the video in the scheduler
    await scheduler.register_video(
        video_id,
        segment_count=req.segment_count,
        segment_duration=req.segment_duration,
    )

    # Pre-generate static manifests so the player can start without polling
    if req.segment_count is not None and req.segment_duration is not None:
        _generate_dash_mpd(
            video_dir, req.segment_count, req.segment_duration, ladder_profiles,
            source_bitrate=req.source_bitrate,
            source_width=req.source_width,
            source_height=req.source_height,
        )
        _generate_hls_playlists(
            video_dir, req.segment_count, req.segment_duration, ladder_profiles,
            source_bitrate=req.source_bitrate,
            source_width=req.source_width,
            source_height=req.source_height,
        )

    update_storage_metrics()

    return InitUploadResponse(video_id=video_id)

# ---------------- API: Upload/get init segment (init.m4s) ----------------


@app.post("/videos/{video_id}/init")
async def upload_init_segment(video_id: str, init: UploadFile = File(...)):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    video_dir = videos_meta[video_id]["dir"]
    dash_source_dir = os.path.join(video_dir, "dash", SOURCE_RENDITION)
    os.makedirs(dash_source_dir, exist_ok=True)

    data = await init.read()
    with open(os.path.join(dash_source_dir, "init.m4s"), "wb") as f:
        f.write(data)

    upload_bytes_total.labels(video_id=video_id).inc(len(data))
    update_storage_metrics()

    return {"status": "ok"}


@app.get("/videos/{video_id}/init.m4s")
async def get_init_segment(video_id: str, request: Request):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    video_dir = videos_meta[video_id]["dir"]
    init_path = os.path.join(video_dir, "dash", SOURCE_RENDITION, "init.m4s")
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

    data = await init.read()
    with open(init_path, "wb") as f:
        f.write(data)

    upload_bytes_total.labels(video_id=video_id).inc(len(data))
    update_storage_metrics()

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
    dash_source_dir = os.path.join(video_dir, "dash", SOURCE_RENDITION)
    os.makedirs(dash_source_dir, exist_ok=True)
    seg_path = os.path.join(dash_source_dir, seg_filename)

    data = await segment.read()
    with open(seg_path, "wb") as f:
        f.write(data)

    uploads_total.labels(video_id=video_id).inc()
    upload_bytes_total.labels(video_id=video_id).inc(len(data))

    # Update segment_count in metadata if needed
    meta = videos_meta[video_id]
    if meta["segment_count"] is None or index + 1 > meta["segment_count"]:
        meta["segment_count"] = index + 1

    # Mark this segment as uploaded in the scheduler
    await scheduler.mark_uploaded(video_id, index)

    # Fire-and-forget alignment check for audio/video timelines
    asyncio.create_task(verify_segment_alignment(video_id, index))

    update_storage_metrics()

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
    seg_path = os.path.join(videos_meta[video_id]["dir"], "dash", SOURCE_RENDITION, f"segment_{req.index}.m4s")
    if not os.path.exists(seg_path):
        await asyncio.sleep(0.2)

    await scheduler.bump_priority_around(video_id, req.index)
    await broadcast_priority(video_id, priority_window_indexes(video_id, req.index))

    # Seek window gets highest transcode priority
    meta = videos_meta[video_id]
    ladder = meta.get("ladder_profiles") or None
    for i in priority_window_indexes(video_id, req.index):
        await transcode_queue.enqueue(
            video_id=video_id, index=i,
            video_dir=meta["dir"],
            seg_duration=meta.get("segment_duration"),
            priority=0,
            profiles=ladder,
        )
    return {"status": "ok", "index": req.index}


@app.post("/videos/{video_id}/prioritize/{index}")
async def prioritize_segment_with_path(video_id: str, index: int):
    # New path with index in URL, clearer logs
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    seg_path = os.path.join(videos_meta[video_id]["dir"], "dash", SOURCE_RENDITION, f"segment_{index}.m4s")
    if not os.path.exists(seg_path):
        await asyncio.sleep(0.2)

    await scheduler.bump_priority_around(video_id, index)
    await broadcast_priority(video_id, priority_window_indexes(video_id, index))

    meta = videos_meta[video_id]
    ladder = meta.get("ladder_profiles") or None
    for i in priority_window_indexes(video_id, index):
        await transcode_queue.enqueue(
            video_id=video_id, index=i,
            video_dir=meta["dir"],
            seg_duration=meta.get("segment_duration"),
            priority=0,
            profiles=ladder,
        )
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

    upload_bytes_total.labels(video_id=video_id).inc(len(body))
    update_storage_metrics()

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
    seg_path = os.path.join(video_dir, "dash", SOURCE_RENDITION, f"segment_{index}.m4s")
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
    players_total.inc()
    return FileResponse(seg_path, media_type="video/iso.segment")


@app.post("/videos/{video_id}/audio/segments/{index}")
async def upload_audio_segment(video_id: str, index: int, segment: UploadFile = File(...)):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")

    video_dir = videos_meta[video_id]["dir"]
    seg_filename = f"audio_segment_{index}.m4s"
    seg_path = os.path.join(video_dir, seg_filename)

    data = await segment.read()
    with open(seg_path, "wb") as f:
        f.write(data)

    upload_bytes_total.labels(video_id=video_id).inc(len(data))
    uploads_total.labels(video_id=video_id).inc()

    # Re-check A/V alignment after writing audio
    asyncio.create_task(verify_segment_alignment(video_id, index))

    update_storage_metrics()

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


# ---------------- API: HLS playback (multi-bitrate) ----------------


@app.get("/videos/{video_id}/hls/master.m3u8")
async def get_hls_master(video_id: str):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    path = os.path.join(videos_meta[video_id]["dir"], "hls", "master.m3u8")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="HLS not ready yet")
    return FileResponse(path, media_type="application/vnd.apple.mpegurl",
                        headers={"Cache-Control": "no-cache"})


@app.get("/videos/{video_id}/hls/{rendition}/playlist.m3u8")
async def get_hls_playlist(video_id: str, rendition: str):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    path = os.path.join(videos_meta[video_id]["dir"], "hls", rendition, "playlist.m3u8")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="rendition not ready yet")
    return FileResponse(path, media_type="application/vnd.apple.mpegurl",
                        headers={"Cache-Control": "no-cache"})


@app.get("/videos/{video_id}/hls/{rendition}/segment_{index}.ts")
async def get_hls_segment(video_id: str, rendition: str, index: int):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    meta = videos_meta[video_id]

    if rendition == SOURCE_RENDITION:
        # Source quality: remux fMP4→TS without re-encoding
        path = os.path.join(meta["dir"], "hls", SOURCE_RENDITION, f"segment_{index}.ts")
        if not os.path.exists(path):
            init_path = os.path.join(meta["dir"], "dash", SOURCE_RENDITION, "init.m4s")
            seg_path  = os.path.join(meta["dir"], "dash", SOURCE_RENDITION, f"segment_{index}.m4s")
            for _ in range(600):
                if os.path.exists(init_path) and os.path.exists(seg_path):
                    break
                await asyncio.sleep(0.2)
            else:
                raise HTTPException(status_code=503, detail="source segment timed out")
            await remux_source_to_ts(init_path, seg_path, os.path.join(meta["dir"], "hls"), index)
        return FileResponse(path, media_type="video/MP2T",
                            headers={"Cache-Control": "public, max-age=31536000, immutable"})

    ladder = meta.get("ladder_profiles") or None
    path = os.path.join(meta["dir"], "hls", rendition, f"segment_{index}.ts")

    async def _prefetch_next():
        for offset, pri in enumerate([1, 2, 3], start=1):
            await transcode_queue.enqueue(
                video_id=video_id, index=index + offset,
                video_dir=meta["dir"],
                seg_duration=meta.get("segment_duration"),
                priority=pri,
                profiles=ladder,
            )

    if os.path.exists(path):
        asyncio.create_task(_prefetch_next())
    else:
        await transcode_queue.enqueue(
            video_id=video_id, index=index,
            video_dir=meta["dir"],
            seg_duration=meta.get("segment_duration"),
            priority=0,
            profiles=ladder,
        )
        asyncio.create_task(_prefetch_next())
        for _ in range(600):
            if os.path.exists(path):
                break
            await asyncio.sleep(0.2)
        else:
            raise HTTPException(status_code=503, detail="HLS segment timed out")

    return FileResponse(path, media_type="video/MP2T",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ---------------- API: DASH playback (multi-bitrate adaptive) ----------------


@app.get("/videos/{video_id}/dash/manifest.mpd")
async def get_dash_manifest(video_id: str):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    path = os.path.join(videos_meta[video_id]["dir"], "dash", "manifest.mpd")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="DASH manifest not ready yet")
    return FileResponse(
        path,
        media_type="application/dash+xml",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/videos/{video_id}/dash/{rendition}/init.m4s")
async def get_dash_init(video_id: str, rendition: str):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    meta = videos_meta[video_id]

    path = os.path.join(meta["dir"], "dash", rendition, "init.m4s")
    if not os.path.exists(path):
        if rendition != SOURCE_RENDITION:
            # JIT: trigger transcoding of segment 0 to produce init.m4s
            await transcode_queue.enqueue(
                video_id=video_id, index=0,
                video_dir=meta["dir"],
                seg_duration=meta.get("segment_duration"),
                priority=0,
                profiles=meta.get("ladder_profiles") or None,
            )
        # Wait for file — source: from upload; others: from transcoder
        for _ in range(600):
            if os.path.exists(path):
                break
            await asyncio.sleep(0.2)
        else:
            raise HTTPException(status_code=503, detail="DASH init segment timed out")
    return FileResponse(path, media_type="video/iso.segment",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/videos/{video_id}/dash/{rendition}/segment_{index}.m4s")
async def get_dash_segment(video_id: str, rendition: str, index: int):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    meta = videos_meta[video_id]

    ladder = meta.get("ladder_profiles") or None
    path = os.path.join(meta["dir"], "dash", rendition, f"segment_{index}.m4s")

    async def _prefetch_next():
        for offset, pri in enumerate([1, 2, 3], start=1):
            await transcode_queue.enqueue(
                video_id=video_id, index=index + offset,
                video_dir=meta["dir"],
                seg_duration=meta.get("segment_duration"),
                priority=pri,
                profiles=ladder,
            )

    if os.path.exists(path):
        if rendition != SOURCE_RENDITION:
            asyncio.create_task(_prefetch_next())
    else:
        if rendition != SOURCE_RENDITION:
            # JIT: transcode this segment, prefetch next 3
            await transcode_queue.enqueue(
                video_id=video_id, index=index,
                video_dir=meta["dir"],
                seg_duration=meta.get("segment_duration"),
                priority=0,
                profiles=ladder,
            )
            asyncio.create_task(_prefetch_next())
        # Wait for file — source: from upload; others: from transcoder
        for _ in range(600):
            if os.path.exists(path):
                break
            await asyncio.sleep(0.2)
        else:
            raise HTTPException(status_code=503, detail="DASH segment timed out")

    players_total.inc()
    return FileResponse(
        path,
        media_type="video/iso.segment",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


# ---------------- API: Transcode status (debug/monitoring) ----------------


@app.get("/videos/{video_id}/transcode/status")
async def get_transcode_status(video_id: str):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id does not exist")
    return {
        "job_states": transcode_queue.job_states(video_id),
    }
