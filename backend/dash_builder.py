from __future__ import annotations

import asyncio
import os
import struct
from collections import defaultdict
from xml.etree import ElementTree as ET

from transcoder import PROFILES, RenditionResult

_PROFILE_META = {p["name"]: p for p in PROFILES}
# Sorted highest bitrate first for Representation ordering
_PROFILES_SORTED = sorted(PROFILES, key=lambda p: p["bitrate"], reverse=True)


def _split_fmp4(data: bytes) -> tuple[bytes, bytes]:
    """
    Split a self-contained fMP4 into (init_bytes, media_bytes).

    Scans MP4 boxes; accumulates ftyp/moov into init, stops at the first moof box.
    Returns (data[:init_end], data[init_end:]).
    """
    offset = 0
    init_end = 0
    length = len(data)

    while offset < length:
        if offset + 8 > length:
            break
        size = struct.unpack_from(">I", data, offset)[0]
        box_type = data[offset + 4 : offset + 8]

        if size == 1:
            # Extended size: next 8 bytes hold the real 64-bit size
            if offset + 16 > length:
                break
            size = struct.unpack_from(">Q", data, offset + 8)[0]
        elif size == 0:
            # size==0 means "rest of file"
            size = length - offset

        if box_type in (b"ftyp", b"moov"):
            init_end = offset + size
        elif box_type == b"moof":
            break

        offset += size

    return data[:init_end], data[init_end:]


class DASHBuilder:
    """
    Builds DASH manifests and per-rendition fMP4 segment files as segments
    finish transcoding.

    Directory layout under video_dir/dash/:
        manifest.mpd
        720p/
            init.m4s
            segment_0.m4s
            segment_1.m4s
            ...
        480p/
            ...
    """

    def __init__(self):
        # video_id → rendition_name → sorted [(index, duration), ...]
        self._segments: dict[str, dict[str, list[tuple[int, float]]]] = \
            defaultdict(lambda: defaultdict(list))
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def add_segment(
        self,
        video_id: str,
        segment_index: int,
        renditions: list[RenditionResult],
        video_dir: str,
    ):
        # No-op: file splitting and MPD writing are now handled by
        # transcoder._remux_and_split and main._generate_dash_mpd respectively.
        pass

    def is_ready(self, video_id: str) -> bool:
        return False

    async def _write_mpd(
        self, video_id: str, video_dir: str, loop: asyncio.AbstractEventLoop
    ):
        segs_by_rendition = self._segments[video_id]
        if not segs_by_rendition:
            return

        dash_dir = os.path.join(video_dir, "dash")
        os.makedirs(dash_dir, exist_ok=True)

        # Use the longest rendition to determine total duration.
        longest = max(segs_by_rendition.values(), key=len, default=[])
        total_dur_s = sum(dur for _, dur in longest)
        dur_iso = f"PT{total_dur_s:.3f}S"

        mpd = ET.Element("MPD", {
            "xmlns": "urn:mpeg:dash:schema:mpd:2011",
            "type": "static",
            "mediaPresentationDuration": dur_iso,
            "minBufferTime": "PT2S",
            "profiles": "urn:mpeg:dash:profile:isoff-live:2011",
        })

        period = ET.SubElement(mpd, "Period", {"start": "PT0S"})
        adaptation = ET.SubElement(period, "AdaptationSet", {
            "mimeType": "video/mp4",
            "segmentAlignment": "true",
            "startWithSAP": "1",
        })

        for profile in _PROFILES_SORTED:
            name = profile["name"]
            if name not in segs_by_rendition or not segs_by_rendition[name]:
                continue

            rep = ET.SubElement(adaptation, "Representation", {
                "id": name,
                "bandwidth": str(profile["bitrate"]),
                "width": str(profile["width"]),
                "height": str(profile["height"]),
                "codecs": "avc1.4D401F",
            })

            seg_template = ET.SubElement(rep, "SegmentTemplate", {
                "initialization": f"{name}/init.m4s",
                "media": f"{name}/segment_$Number$.m4s",
                "startNumber": "0",
                "timescale": "1000",
            })

            timeline = ET.SubElement(seg_template, "SegmentTimeline")
            for _, dur in segs_by_rendition[name]:
                ET.SubElement(timeline, "S", {"d": str(round(dur * 1000))})

        ET.indent(mpd, space="  ")
        content = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(
            mpd, encoding="unicode"
        )

        mpd_path = os.path.join(dash_dir, "manifest.mpd")
        await loop.run_in_executor(None, _write_file, mpd_path, content.encode())


def _read_file(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _write_file(path: str, data: bytes):
    with open(path, "wb") as f:
        f.write(data)
