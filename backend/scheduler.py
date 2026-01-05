# backend/scheduler.py
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Dict, Optional, List, Set
from collections import defaultdict


@dataclass
class SegmentMeta:
    index: int
    base_priority: int = 10        # 
    hot_count: int = 0             # increase 1 for every seek 
    state: str = "PENDING"         # PENDING / ASSIGNED / UPLOADED
    assigned_to: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None

    @property
    def effective_priority(self) -> int:
        """
        Priority used for sorting: smaller numbers mean higher priority. 
        More viewers → hot_count rises → effective_priority goes down.
        """
        eff = self.base_priority - self.hot_count
        return eff if eff > 0 else 0


@dataclass
class VideoState:
    video_id: str
    segment_duration: Optional[float] = None
    segment_count: Optional[int] = None
    segments: Dict[int, SegmentMeta] = field(default_factory=dict)


class UploadScheduler:
    """
    Responsibilities:
    - Track status/priority/heat for every segment of each video
    - Pick the next batch of segments to upload based on need_slots and already_uploading
    - Raise the heat near an index reported by viewers
    - Protect per-video operations with asyncio.Lock
    """

    def __init__(self):
        self.videos: Dict[str, VideoState] = {}
        self.uploaders: Dict[str, Dict] = {}
        # One lock per video_id
        self._locks: Dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    # --------- Internal helpers (sync, only within locked contexts) ---------

    def _get_video(self, video_id: str) -> VideoState:
        vs = self.videos.get(video_id)
        if vs is None:
            vs = VideoState(video_id=video_id)
            self.videos[video_id] = vs
        return vs

    def _ensure_segment(self, vs: VideoState, index: int) -> SegmentMeta:
        if vs.segment_count is None or index >= vs.segment_count:
            vs.segment_count = max(vs.segment_count or 0, index + 1)
        if index not in vs.segments:
            vs.segments[index] = SegmentMeta(index=index)
        return vs.segments[index]

    # ------------------- Public async API -------------------

    async def register_video(
        self,
        video_id: str,
        segment_count: Optional[int] = None,
        segment_duration: Optional[float] = None,
    ) -> VideoState:
        """
        Register/update a video's info:
        - segment_count: known number of segments (optional)
        - segment_duration: duration per segment (optional)
        """
        lock = self._locks[video_id]
        async with lock:
            vs = self._get_video(video_id)

            if segment_duration is not None:
                vs.segment_duration = segment_duration

            if segment_count is not None:
                old = vs.segment_count or 0
                vs.segment_count = max(old, segment_count)

            # If segment_count is known, pre-create metadata
            if vs.segment_count is not None:
                for i in range(vs.segment_count):
                    if i not in vs.segments:
                        vs.segments[i] = SegmentMeta(index=i)

            return vs

    async def mark_uploaded(self, video_id: str, index: int):
        """
        Mark a segment as uploaded.
        """
        lock = self._locks[video_id]
        async with lock:
            vs = self._get_video(video_id)
            seg = self._ensure_segment(vs, index)
            seg.state = "UPLOADED"
            seg.assigned_to = None

    async def bump_priority_around(
        self,
        video_id: str,
        index: int,
        window_before: int = 2,
        window_after: int = 5,
    ):
        """
        Called when a viewer plays/seeks to index:
        - hot_count += 1 for segments around index
        - Multiple viewers/requests accumulate
        """
        lock = self._locks[video_id]
        async with lock:
            vs = self._get_video(video_id)

            # If total segment count unknown, ensure current index has metadata
            if vs.segment_count is None:
                seg = self._ensure_segment(vs, index)
                if seg.state != "UPLOADED":
                    seg.hot_count += 1
                return

            start = max(0, index - window_before)
            end = min(vs.segment_count - 1, index + window_after)

            for i in range(start, end + 1):
                seg = self._ensure_segment(vs, i)
                if seg.state != "UPLOADED":
                    seg.hot_count += 1

    async def get_next_tasks(
        self,
        video_id: str,
        uploader_id: str,
        need_slots: int,
        already_uploading: Set[int],
    ) -> List[SegmentMeta]:
        """
        Uploader pulls tasks:
        - Choose from segments not yet UPLOADED
        - Exclude already_uploading
        - Avoid stealing tasks ASSIGNED to another uploader (simple strategy)
        - Sort by effective_priority, index
        """
        if need_slots <= 0:
            return []

        lock = self._locks[video_id]
        async with lock:
            vs = self._get_video(video_id)
            if vs.segment_count is None:
                
                return []

            candidates: List[SegmentMeta] = []
            for seg in vs.segments.values():
                if seg.state == "UPLOADED":
                    continue
                if seg.index in already_uploading:
                    continue
                if seg.state == "ASSIGNED" and seg.assigned_to not in (None, uploader_id):
                    continue
                candidates.append(seg)

            
            candidates.sort(key=lambda s: (s.effective_priority, s.index))

            selected: List[SegmentMeta] = []
            for seg in candidates:
                if len(selected) >= need_slots:
                    break
                seg.state = "ASSIGNED"
                seg.assigned_to = uploader_id
                selected.append(seg)

            return selected

    async def register_uploader(self, video_id: str, uploader_id: str, max_concurrency: int):
        """
        register an uploader。
        """
        # to ensure video is registered
        await self.register_video(video_id)
        self.uploaders[uploader_id] = {
            "video_id": video_id,
            "max_concurrency": max_concurrency,
        }

    async def all_uploaded(self, video_id: str) -> bool:
        """
        if every segment  UPLOADED。
        """
        lock = self._locks[video_id]
        async with lock:
            vs = self.videos.get(video_id)
            if not vs or vs.segment_count is None:
                return False
            for i in range(vs.segment_count):
                seg = vs.segments.get(i)
                if not seg or seg.state != "UPLOADED":
                    return False
            return True
