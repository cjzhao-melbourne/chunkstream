# backend/main.py
import os
import uuid
import logging
import asyncio
from datetime import datetime
from typing import Dict, Any, Set

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Response
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

# ---------------- 基础初始化 ----------------

app = FastAPI(title="Chunkstream Backend")

# 简单日志：带时间戳输出
logger = logging.getLogger("chunkstream")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
logger.setLevel(logging.INFO)

# 本地存储目录
BASE_DIR = os.path.dirname(__file__)
BASE_STORAGE = os.path.join(BASE_DIR, "storage")
os.makedirs(BASE_STORAGE, exist_ok=True)

# 简单保存每个 video 的元数据
videos_meta: Dict[str, Dict[str, Any]] = {}

# 调度器实例
scheduler = UploadScheduler()

# CORS：方便前端本地调试
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

# 中间件：打印请求时间戳
@app.middleware("http")
async def log_requests(request: Request, call_next):
    ts = datetime.utcnow().isoformat()
    logger.info(f"REQ {ts} {request.method} {request.url.path}")
    response = await call_next(request)
    logger.info(f"RES {datetime.utcnow().isoformat()} {request.method} {request.url.path} status={response.status_code}")
    return response

# ---------------- API: 初始化视频上传会话 ----------------


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

    # 在调度器里注册这个 video
    await scheduler.register_video(
        video_id,
        segment_count=req.segment_count,
        segment_duration=req.segment_duration,
    )

    return InitUploadResponse(video_id=video_id)

# ---------------- API: 上传/获取初始化片段（init.m4s） ----------------


@app.post("/videos/{video_id}/init")
async def upload_init_segment(video_id: str, init: UploadFile = File(...)):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")

    video_dir = videos_meta[video_id]["dir"]
    init_path = os.path.join(video_dir, "init.m4s")

    with open(init_path, "wb") as f:
        f.write(await init.read())

    return {"status": "ok"}


@app.get("/videos/{video_id}/init.m4s")
async def get_init_segment(video_id: str, request: Request):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")
    video_dir = videos_meta[video_id]["dir"]
    init_path = os.path.join(video_dir, "init.m4s")
    if not os.path.exists(init_path):
        raise HTTPException(status_code=404, detail="init segment 不存在")

    stat = os.stat(init_path)
    etag = f'W/"{stat.st_mtime_ns}-{stat.st_size}"'
    cache_headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": etag,
    }

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cache_headers)

    return FileResponse(init_path, media_type="video/iso.segment", headers=cache_headers)

# ---------------- API: 上传单个片段 ----------------


async def _save_segment(video_id: str, index: int, segment: UploadFile):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")

    video_dir = videos_meta[video_id]["dir"]
    seg_filename = f"segment_{index}.m4s"
    seg_path = os.path.join(video_dir, seg_filename)

    # 保存片段文件
    with open(seg_path, "wb") as f:
        f.write(await segment.read())

    # 更新 meta 中的 segment_count（如果有必要）
    meta = videos_meta[video_id]
    if meta["segment_count"] is None or index + 1 > meta["segment_count"]:
        meta["segment_count"] = index + 1

    # 在调度器里标记该片段已上传
    await scheduler.mark_uploaded(video_id, index)

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
    兼容旧路径：POST /videos/{video_id}/segments，index 从表单读取。
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
    新路径：POST /videos/{video_id}/segments/{index}
    这样从服务端日志就能直接看到当前处理的片段 index。
    """
    return await _save_segment(video_id, index, segment)

# ---------------- API: 播放端上报“优先片段” ----------------


@app.post("/videos/{video_id}/prioritize")
async def prioritize_segment(video_id: str, req: PriorityRequest):
    # 兼容旧路径（无 path index），从 body 读 index
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")

    # 如果片段不存在，稍微等待一段时间给上传端生成/上传
    seg_path = os.path.join(videos_meta[video_id]["dir"], f"segment_{req.index}.m4s")
    if not os.path.exists(seg_path):
        await asyncio.sleep(0.2)

    await scheduler.bump_priority_around(video_id, req.index)
    return {"status": "ok", "index": req.index}


@app.post("/videos/{video_id}/prioritize/{index}")
async def prioritize_segment_with_path(video_id: str, index: int):
    # 新路径，index 在 URL 里，日志更直观
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")

    seg_path = os.path.join(videos_meta[video_id]["dir"], f"segment_{index}.m4s")
    if not os.path.exists(seg_path):
        await asyncio.sleep(0.2)

    await scheduler.bump_priority_around(video_id, index)
    return {"status": "ok", "index": index}

# ---------------- API: 上传/获取 MPD manifest ----------------


@app.post("/videos/{video_id}/manifest")
async def upload_manifest(video_id: str, request: Request):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="manifest body is empty")

    video_dir = videos_meta[video_id]["dir"]
    manifest_path = os.path.join(video_dir, "manifest.mpd")

    with open(manifest_path, "wb") as f:
        f.write(body)

    videos_meta[video_id]["manifest_uploaded"] = True

    # 更新调度器中的 segment_count（如果已经知道）
    seg_count = videos_meta[video_id]["segment_count"]
    await scheduler.register_video(video_id, segment_count=seg_count)

    return {"status": "ok"}


@app.get("/videos/{video_id}/manifest.mpd")
async def get_manifest(video_id: str):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")
    video_dir = videos_meta[video_id]["dir"]
    manifest_path = os.path.join(video_dir, "manifest.mpd")
    if not os.path.exists(manifest_path):
        raise HTTPException(status_code=404, detail="MPD 未上传")
    return FileResponse(manifest_path, media_type="application/dash+xml")

# ---------------- API: 获取某个片段（供 dash.js 播放） ----------------


@app.get("/videos/{video_id}/segment_{index}.m4s")
async def get_segment(video_id: str, index: int):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")
    video_dir = videos_meta[video_id]["dir"]
    seg_path = os.path.join(video_dir, f"segment_{index}.m4s")
    # 为了播放器 seek 触发的“未来片段”请求，短暂等待上传端生成完毕再返回
    max_wait_ms = 4000
    waited = 0
    while not os.path.exists(seg_path) and waited < max_wait_ms:
        await asyncio.sleep(0.2)
        waited += 200
    if not os.path.exists(seg_path):
        raise HTTPException(status_code=404, detail="片段不存在")
    return FileResponse(seg_path, media_type="video/iso.segment")

# ---------------- API: 注册一个上传客户端（uploader） ----------------


@app.post("/videos/{video_id}/uploaders/register", response_model=RegisterUploaderResponse)
async def register_uploader(video_id: str, req: RegisterUploaderRequest):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")

    uploader_id = str(uuid.uuid4())
    await scheduler.register_uploader(video_id, uploader_id, req.max_concurrency)
    return RegisterUploaderResponse(uploader_id=uploader_id)

# ---------------- API: 上传客户端询问“下一批要上传哪些片段” ----------------


@app.post(
    "/videos/{video_id}/uploaders/{uploader_id}/next-tasks",
    response_model=NextTasksResponse,
)
async def get_next_tasks(video_id: str, uploader_id: str, req: NextTasksRequest):
    if video_id not in videos_meta:
        raise HTTPException(status_code=404, detail="video_id 不存在")

    already_uploading: Set[int] = set(req.already_uploading)
    segs = await scheduler.get_next_tasks(
        video_id=video_id,
        uploader_id=uploader_id,
        need_slots=req.need_slots,
        already_uploading=already_uploading,
    )

    tasks = [TaskInfo(index=s.index, priority=s.effective_priority) for s in segs]
    return NextTasksResponse(tasks=tasks)
