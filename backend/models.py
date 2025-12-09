# backend/models.py
from typing import Optional, List
from pydantic import BaseModel


class InitUploadRequest(BaseModel):
    filename: str
    size: int
    # 可选：前端可以在 init 时告知预期片段数和目标片长（秒）
    segment_count: Optional[int] = None
    segment_duration: Optional[float] = None


class InitUploadResponse(BaseModel):
    video_id: str


class PriorityRequest(BaseModel):
    index: int  # 当前观看或 seek 到的片段 index


class RegisterUploaderRequest(BaseModel):
    max_concurrency: int = 1


class RegisterUploaderResponse(BaseModel):
    uploader_id: str


class NextTasksRequest(BaseModel):
    need_slots: int
    already_uploading: List[int] = []  # 当前这个 uploader 已经在上传的片段索引


class TaskInfo(BaseModel):
    index: int
    priority: int


class NextTasksResponse(BaseModel):
    tasks: List[TaskInfo]
