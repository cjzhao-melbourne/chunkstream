# backend/models.py
from typing import Optional, List
from pydantic import BaseModel


class InitUploadRequest(BaseModel):
    filename: str
    size: int
    segment_count: Optional[int] = None
    segment_duration: Optional[float] = None
    source_width: Optional[int] = None
    source_height: Optional[int] = None
    source_bitrate: Optional[int] = None


class InitUploadResponse(BaseModel):
    video_id: str


class PriorityRequest(BaseModel):
    index: int  


class RegisterUploaderRequest(BaseModel):
    max_concurrency: int = 1


class RegisterUploaderResponse(BaseModel):
    uploader_id: str


class NextTasksRequest(BaseModel):
    need_slots: int
    already_uploading: List[int] = []  


class TaskInfo(BaseModel):
    index: int
    priority: int


class NextTasksResponse(BaseModel):
    tasks: List[TaskInfo]
