from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable, Optional

logger = logging.getLogger("transcode_queue")


class JobState(str, Enum):
    PENDING     = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    DONE        = "DONE"
    FAILED      = "FAILED"


@dataclass(order=True)
class _QueueItem:
    """Sortable item for asyncio.PriorityQueue. Lower priority number = runs first."""
    priority: int
    index: int
    video_id: str = field(compare=False)


@dataclass
class TranscodeJob:
    video_id: str
    index: int
    video_dir: str
    seg_duration: Optional[float]
    priority: int = 10
    state: JobState = JobState.PENDING
    retry: int = 0


# Callback signature: (video_id, segment_index, rendition_results) -> None
OnDoneCallback = Callable[[str, int, list], Awaitable[None]]


class TranscodeQueue:
    MAX_CONCURRENT = 2
    MAX_RETRY      = 2

    def __init__(self, transcoder, on_done: OnDoneCallback):
        self._transcoder = transcoder
        self._on_done    = on_done
        self._jobs: dict[tuple, TranscodeJob] = {}
        self._queue: asyncio.PriorityQueue[_QueueItem] = asyncio.PriorityQueue()
        self._active = 0
        self._lock   = asyncio.Lock()

    def start(self):
        asyncio.create_task(self._worker())

    async def enqueue(
        self,
        video_id: str,
        index: int,
        video_dir: str,
        seg_duration: Optional[float],
        priority: int = 10,
    ) -> bool:
        """
        Enqueue a segment for transcoding.
        - Skips if already DONE or IN_PROGRESS.
        - If PENDING and new priority is higher (lower number), updates it.
        Returns True if newly enqueued.
        """
        key = (video_id, index)
        async with self._lock:
            job = self._jobs.get(key)
            if job:
                if job.state in (JobState.DONE, JobState.IN_PROGRESS):
                    return False
                if priority < job.priority:
                    job.priority = priority  # will take effect on next queue pop
                return False
            job = TranscodeJob(
                video_id=video_id, index=index,
                video_dir=video_dir, seg_duration=seg_duration,
                priority=priority,
            )
            self._jobs[key] = job

        await self._queue.put(_QueueItem(priority=priority, index=index, video_id=video_id))
        logger.info(f"Enqueued transcode {video_id}:{index} priority={priority}")
        return True

    def job_states(self, video_id: str) -> dict[int, str]:
        """Return {index: state} for all jobs belonging to video_id."""
        return {
            k[1]: v.state.value
            for k, v in self._jobs.items()
            if k[0] == video_id
        }

    async def _worker(self):
        while True:
            if self._active >= self.MAX_CONCURRENT:
                await asyncio.sleep(0.3)
                continue
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                await asyncio.sleep(0.3)
                continue

            key = (item.video_id, item.index)
            async with self._lock:
                job = self._jobs.get(key)
                if not job or job.state != JobState.PENDING:
                    continue
                job.state = JobState.IN_PROGRESS

            self._active += 1
            asyncio.create_task(self._run(job))

    async def _run(self, job: TranscodeJob):
        key = (job.video_id, job.index)
        try:
            init_path = os.path.join(job.video_dir, "init.m4s")
            seg_path  = os.path.join(job.video_dir, f"segment_{job.index}.m4s")

            # Wait up to 120s for source segments to arrive (slow uploads)
            for _ in range(240):
                if os.path.exists(init_path) and os.path.exists(seg_path):
                    break
                await asyncio.sleep(0.5)
            else:
                raise FileNotFoundError(f"Segments not ready for {key}")

            output_dir = os.path.join(job.video_dir, "hls")
            results = await self._transcoder.transcode(
                init_path, seg_path, output_dir,
                job.index, job.seg_duration,
            )

            async with self._lock:
                job.state = JobState.DONE

            await self._on_done(job.video_id, job.index, results)
            logger.info(f"Transcode done: {key}")

        except Exception as e:
            logger.error(f"Transcode error {key}: {e}")
            async with self._lock:
                job.retry += 1
                if job.retry <= self.MAX_RETRY:
                    job.state = JobState.PENDING
                    await self._queue.put(_QueueItem(
                        priority=job.priority + 5,
                        index=job.index,
                        video_id=job.video_id,
                    ))
                else:
                    job.state = JobState.FAILED
        finally:
            self._active -= 1
