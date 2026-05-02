from __future__ import annotations

import asyncio
import os
from collections import defaultdict
from typing import Optional

from transcoder import PROFILES, RenditionResult

# Map profile name → stream metadata for master playlist
_PROFILE_META = {p["name"]: p for p in PROFILES}

# HLS spec: TARGETDURATION must be >= any segment duration, rounded up
_TARGET_DURATION = 12


class HLSBuilder:
    """
    Builds and maintains HLS playlists as segments finish transcoding.

    Directory layout under video_dir/hls/:
        master.m3u8
        720p/
            playlist.m3u8
            segment_0.ts
            segment_1.ts
            ...
        480p/
            playlist.m3u8
            ...
    """

    def __init__(self):
        # video_id → rendition_name → sorted [(index, duration), ...]
        self._segments: dict[str, dict[str, list[tuple[int, float]]]] = \
            defaultdict(lambda: defaultdict(list))
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._finalized: set[str] = set()

    async def add_segment(
        self,
        video_id: str,
        segment_index: int,
        renditions: list[RenditionResult],
        video_dir: str,
    ):
        """Called by TranscodeQueue after a segment finishes transcoding."""
        hls_dir = os.path.join(video_dir, "hls")
        async with self._locks[video_id]:
            for r in renditions:
                segs = self._segments[video_id][r.name]
                segs.append((segment_index, r.duration))
                segs.sort(key=lambda x: x[0])  # keep in presentation order
            await self._write_playlists(
                video_id, hls_dir,
                finalized=video_id in self._finalized,
            )

    async def finalize(self, video_id: str, video_dir: str):
        """
        Call once all segments for a video have been transcoded.
        Appends #EXT-X-ENDLIST so players know the stream is complete.
        """
        hls_dir = os.path.join(video_dir, "hls")
        async with self._locks[video_id]:
            self._finalized.add(video_id)
            await self._write_playlists(video_id, hls_dir, finalized=True)

    def is_ready(self, video_id: str) -> bool:
        """True once at least one segment exists for every rendition."""
        segs = self._segments.get(video_id)
        return bool(segs) and all(len(v) > 0 for v in segs.values())

    def segment_count(self, video_id: str) -> dict[str, int]:
        """Return {rendition: count} for monitoring/status endpoints."""
        return {k: len(v) for k, v in self._segments.get(video_id, {}).items()}

    # ------------------------------------------------------------------ #
    # Internal                                                             #
    # ------------------------------------------------------------------ #

    async def _write_playlists(self, video_id: str, hls_dir: str, finalized: bool):
        os.makedirs(hls_dir, exist_ok=True)
        segs_by_rendition = self._segments[video_id]
        if not segs_by_rendition:
            return

        loop = asyncio.get_running_loop()

        def _write(path: str, content: str):
            with open(path, "w") as f:
                f.write(content)

        # Per-rendition playlists
        for rendition_name, segs in segs_by_rendition.items():
            rendition_dir = os.path.join(hls_dir, rendition_name)
            os.makedirs(rendition_dir, exist_ok=True)

            lines = [
                "#EXTM3U",
                "#EXT-X-VERSION:3",
                f"#EXT-X-TARGETDURATION:{_TARGET_DURATION}",
                "#EXT-X-PLAYLIST-TYPE:EVENT",  # allows appending; ENDLIST closes it
            ]
            for idx, duration in segs:
                lines.append(f"#EXTINF:{duration:.3f},")
                lines.append(f"segment_{idx}.ts")
            if finalized:
                lines.append("#EXT-X-ENDLIST")

            content = "\n".join(lines) + "\n"
            path = os.path.join(rendition_dir, "playlist.m3u8")
            await loop.run_in_executor(None, _write, path, content)

        # Master playlist — written once per update so it always reflects
        # whichever renditions have actually produced at least one segment
        lines = ["#EXTM3U", "#EXT-X-VERSION:3"]
        for rendition_name in segs_by_rendition:
            meta = _PROFILE_META.get(rendition_name, {})
            bw   = meta.get("bitrate", 1_500_000)
            w    = meta.get("width",   854)
            h    = meta.get("height",  480)
            lines.append(
                f'#EXT-X-STREAM-INF:BANDWIDTH={bw},RESOLUTION={w}x{h},NAME="{rendition_name}"'
            )
            lines.append(f"{rendition_name}/playlist.m3u8")

        content = "\n".join(lines) + "\n"
        await loop.run_in_executor(
            None, _write, os.path.join(hls_dir, "master.m3u8"), content
        )
