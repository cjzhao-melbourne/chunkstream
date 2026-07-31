from __future__ import annotations

import asyncio
import logging
import os
import shutil
import struct
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("transcoder")


PROFILES = [
    {"name": "720p",  "width": 1280, "height": 720,  "bitrate": 3_000_000},
    {"name": "480p",  "width": 854,  "height": 480,  "bitrate": 1_500_000},
    {"name": "360p",  "width": 640,  "height": 360,  "bitrate":   800_000},
]

SOURCE_RENDITION = "source"


def select_ladder(source_bitrate: int, source_height: int) -> list[dict]:
    """Return profiles strictly lower quality than the source (no upscaling)."""
    return [p for p in PROFILES if p["height"] < source_height and p["bitrate"] < source_bitrate]


async def remux_source_to_ts(
    init_path: str,
    seg_path: str,
    hls_dir: str,
    segment_index: int,
) -> str:
    """Remux fMP4 → MPEG-TS without re-encoding for the source-quality HLS rung."""
    source_dir = os.path.join(hls_dir, SOURCE_RENDITION)
    os.makedirs(source_dir, exist_ok=True)
    out_ts = os.path.join(source_dir, f"segment_{segment_index}.ts")
    tmp_input = await _concat_to_temp(init_path, seg_path)
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-i", tmp_input, "-c", "copy", "-f", "mpegts", out_ts,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"source remux failed: {stderr.decode()[-800:]}")
        return out_ts
    finally:
        try:
            os.remove(tmp_input)
        except FileNotFoundError:
            pass


@dataclass
class RenditionResult:
    name: str
    path: str          # absolute path to output .ts file
    width: int
    height: int
    bitrate: int
    duration: float    # seconds
    dash_path: str = ""  # absolute path to remuxed fMP4 for DASH (empty if not yet produced)


class Transcoder(ABC):
    @abstractmethod
    async def transcode(
        self,
        init_path: str,
        seg_path: str,
        output_dir: str,
        segment_index: int,
        segment_duration: Optional[float],
        profiles: Optional[list] = None,
    ) -> list[RenditionResult]: ...


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


async def _concat_to_temp(init_path: str, seg_path: str) -> str:
    """Concatenate init.m4s + segment_N.m4s into a temp file for FFmpeg."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
    tmp.close()

    def _merge():
        with open(tmp.name, "wb") as out:
            with open(init_path, "rb") as f:
                shutil.copyfileobj(f, out)
            with open(seg_path, "rb") as f:
                shutil.copyfileobj(f, out)

    await asyncio.get_running_loop().run_in_executor(None, _merge)
    return tmp.name


class FFmpegTranscoder(Transcoder):
    """Local dev transcoder using FFmpeg. Single-pass, all profiles."""

    async def transcode(
        self,
        init_path: str,
        seg_path: str,
        output_dir: str,
        segment_index: int,
        segment_duration: Optional[float],
        profiles: Optional[list] = None,
    ) -> list[RenditionResult]:
        _profiles = profiles if profiles is not None else PROFILES
        tmp_input = await _concat_to_temp(init_path, seg_path)
        output_paths: list[tuple[dict, str]] = []

        try:
            cmd = ["ffmpeg", "-y", "-i", tmp_input]
            for p in _profiles:
                rendition_dir = os.path.join(output_dir, p["name"])
                os.makedirs(rendition_dir, exist_ok=True)
                out = os.path.join(rendition_dir, f"segment_{segment_index}.ts")
                output_paths.append((p, out))
                cmd += [
                    "-map", "0:v:0", "-map", "0:a:0?",
                    "-vf", f"scale={p['width']}:{p['height']}",
                    "-b:v", str(p["bitrate"]),
                    "-c:v", "libx264", "-preset", "fast",
                    "-c:a", "aac", "-b:a", "128k",
                    "-f", "mpegts", out,
                ]

            proc = await asyncio.create_subprocess_exec(
                *cmd, stderr=asyncio.subprocess.PIPE
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(f"ffmpeg failed: {stderr.decode()[-800:]}")

            duration = segment_duration or 10.0
            results = [
                RenditionResult(
                    name=p["name"], path=out,
                    width=p["width"], height=p["height"],
                    bitrate=p["bitrate"], duration=duration,
                )
                for p, out in output_paths
            ]

            # Remux each .ts → fragmented MP4 for DASH (no re-encode, concurrent)
            # Write to temp, split into init.m4s (ftyp+moov) and segment_N.m4s (moof+mdat)
            dash_base = os.path.join(os.path.dirname(output_dir), "dash")

            async def _remux_and_split(r: RenditionResult) -> str:
                if not os.path.exists(r.path) or os.path.getsize(r.path) == 0:
                    return ""
                rendition_dash_dir = os.path.join(dash_base, r.name)
                os.makedirs(rendition_dash_dir, exist_ok=True)

                # Write full fMP4 to a temp file first
                tmp_dash = tempfile.NamedTemporaryFile(
                    delete=False, suffix=".mp4", dir=rendition_dash_dir
                )
                tmp_dash.close()
                remux_cmd = [
                    "ffmpeg", "-y", "-i", r.path,
                    "-c", "copy",
                    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                    "-f", "mp4", tmp_dash.name,
                ]
                rproc = await asyncio.create_subprocess_exec(
                    *remux_cmd, stderr=asyncio.subprocess.PIPE
                )
                _, rerr = await rproc.communicate()
                if rproc.returncode != 0:
                    logger.warning(
                        f"DASH remux skipped {r.name}:{segment_index}: {rerr.decode()[-200:]}"
                    )
                    try:
                        os.remove(tmp_dash.name)
                    except FileNotFoundError:
                        pass
                    return ""

                try:
                    loop = asyncio.get_running_loop()

                    def _split_and_write():
                        with open(tmp_dash.name, "rb") as f:
                            raw = f.read()
                        init_bytes, media_bytes = _split_fmp4(raw)

                        # Write init.m4s only once (when it doesn't exist yet)
                        init_path_out = os.path.join(rendition_dash_dir, "init.m4s")
                        if not os.path.exists(init_path_out) and init_bytes:
                            with open(init_path_out, "wb") as f:
                                f.write(init_bytes)

                        # Write media segment (moof+mdat only)
                        media_path = os.path.join(
                            rendition_dash_dir, f"segment_{segment_index}.m4s"
                        )
                        with open(media_path, "wb") as f:
                            f.write(media_bytes)
                        return media_path

                    media_out = await loop.run_in_executor(None, _split_and_write)
                    return media_out
                except Exception as exc:
                    logger.warning(
                        f"DASH split/write failed {r.name}:{segment_index}: {exc}"
                    )
                    return ""
                finally:
                    try:
                        os.remove(tmp_dash.name)
                    except FileNotFoundError:
                        pass

            dash_paths = await asyncio.gather(*[_remux_and_split(r) for r in results])
            for r, dp in zip(results, dash_paths):
                r.dash_path = dp if isinstance(dp, str) else ""

            return results
        finally:
            try:
                os.remove(tmp_input)
            except FileNotFoundError:
                pass


class LivepeerTranscoder(Transcoder):
    """
    Production transcoder via a self-hosted Livepeer node.
    Uses the Broadcaster→Orchestrator segment protocol (synchronous per segment).
    """

    def __init__(self, livepeer_url: str):
        self.livepeer_url = livepeer_url.rstrip("/")

    async def transcode(
        self,
        init_path: str,
        seg_path: str,
        output_dir: str,
        segment_index: int,
        segment_duration: Optional[float],
    ) -> list[RenditionResult]:
        # TODO: implement Livepeer B→O session + /segment call
        # Requires: session handshake, MPEG-TS remux, POST /segment, parse response
        raise NotImplementedError("Livepeer transcoder: implement when node is ready")


def get_transcoder() -> Transcoder:
    backend = os.environ.get("TRANSCODER", "ffmpeg").lower()
    if backend == "livepeer":
        url = os.environ.get("LIVEPEER_URL", "http://livepeer:8935")
        return LivepeerTranscoder(livepeer_url=url)
    return FFmpegTranscoder()
