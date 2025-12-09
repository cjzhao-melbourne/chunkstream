# backend/scheduler.py
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Dict, Optional, List, Set
from collections import defaultdict


@dataclass
class SegmentMeta:
    index: int
    base_priority: int = 10        # 顺序上传的基础优先级
    hot_count: int = 0             # 热度计数：每次有人看/seek 附近就 +1
    state: str = "PENDING"         # PENDING / ASSIGNED / UPLOADED
    assigned_to: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None

    @property
    def effective_priority(self) -> int:
        """
        实际用于排序的优先级：数字越小优先级越高。
        多人观看 -> hot_count 增加 -> effective_priority 变小。
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
    负责：
    - 维护每个 video 的所有片段的状态、优先级、热度
    - 根据 need_slots 和 already_uploading 选择“下一批应上传的片段”
    - 根据 viewer 报告的 index 提升对应片段附近的热度
    - 用 per-video asyncio.Lock 做并发保护
    """

    def __init__(self):
        self.videos: Dict[str, VideoState] = {}
        self.uploaders: Dict[str, Dict] = {}
        # 每个 video_id 一个锁
        self._locks: Dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    # --------- 内部工具函数（同步，只在已加锁的上下文中调用） ---------

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

    # ------------------- 对外异步 API -------------------

    async def register_video(
        self,
        video_id: str,
        segment_count: Optional[int] = None,
        segment_duration: Optional[float] = None,
    ) -> VideoState:
        """
        注册/更新一个视频的信息：
        - segment_count: 已知的片段数量（可选）
        - segment_duration: 片长（可选）
        """
        lock = self._locks[video_id]
        async with lock:
            vs = self._get_video(video_id)

            if segment_duration is not None:
                vs.segment_duration = segment_duration

            if segment_count is not None:
                old = vs.segment_count or 0
                vs.segment_count = max(old, segment_count)

            # 如果已经知道 segment_count，就预先创建 meta
            if vs.segment_count is not None:
                for i in range(vs.segment_count):
                    if i not in vs.segments:
                        vs.segments[i] = SegmentMeta(index=i)

            return vs

    async def mark_uploaded(self, video_id: str, index: int):
        """
        某片段上传完成。
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
        viewer 播放/seek 到 index 时调用：
        - 给 index 前后一定范围内的片段 hot_count += 1
        - 多用户多次访问会不断叠加
        """
        lock = self._locks[video_id]
        async with lock:
            vs = self._get_video(video_id)

            # 如果还不知道总片段数，至少保证当前 index 有 meta
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
        上传客户端“拉任务”：
        - 从尚未 UPLOADED 的片段中选择
        - 排除 already_uploading
        - 避免去抢其他 uploader 已经 ASSIGNED 的任务（简单策略）
        - 按 effective_priority, index 排序
        """
        if need_slots <= 0:
            return []

        lock = self._locks[video_id]
        async with lock:
            vs = self._get_video(video_id)
            if vs.segment_count is None:
                # 还不知道有哪些片段可上传
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

            # 按“实际优先级 + index”排序
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
        注册一个上传客户端。
        """
        # 确保 video 已注册
        await self.register_video(video_id)
        self.uploaders[uploader_id] = {
            "video_id": video_id,
            "max_concurrency": max_concurrency,
        }

    async def all_uploaded(self, video_id: str) -> bool:
        """
        判断某个视频是否所有片段都已 UPLOADED。
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
