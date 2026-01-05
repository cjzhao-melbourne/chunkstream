import React, { useEffect, useRef, useState } from 'react';
import { playerService } from '../services/playerService';

declare const dashjs: any;

interface VideoPlayerProps {
  manifestUrl: string | null;
  videoId: string | null;
  startTimestamp?: number | null;
  onFirstFrame?: (ms: number) => void;
  onSeekLatency?: (ms: number) => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  manifestUrl,
  videoId,
  startTimestamp,
  onFirstFrame,
  onSeekLatency
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);
  const lastReportedIndexRef = useRef<number | null>(null);
  const pendingSeekIndexRef = useRef<number | null>(null);
  const [segmentBoundaries, setSegmentBoundaries] = useState<number[]>([]);
  const firstFrameReportedRef = useRef(false);
  const seekStartRef = useRef<number | null>(null);

  // Fetch and parse MPD once to build precise segment boundaries from SegmentTimeline
  useEffect(() => {
    const fetchManifest = async () => {
      if (!manifestUrl) return;
      try {
        const resp = await fetch(manifestUrl);
        const text = await resp.text();
        const doc = new DOMParser().parseFromString(text, "application/xml");
        const template = doc.querySelector("SegmentTemplate");
        const timescaleAttr = template?.getAttribute("timescale");
        const timescale = timescaleAttr ? parseInt(timescaleAttr, 10) || 1 : 1;
        const sNodes = Array.from(doc.querySelectorAll("SegmentTimeline > S"));
        const boundaries: number[] = [];
        let currentTime = 0;
        for (const s of sNodes) {
          const dAttr = s.getAttribute("d");
          if (!dAttr) continue;
          const d = parseInt(dAttr, 10);
          if (!Number.isFinite(d) || d <= 0) continue;
          const repeatAttr = s.getAttribute("r");
          const repeat = repeatAttr ? parseInt(repeatAttr, 10) : 0;
          const count = repeat >= 0 ? repeat + 1 : 1;
          for (let i = 0; i < count; i++) {
            boundaries.push(currentTime / timescale);
            currentTime += d;
          }
        }
        setSegmentBoundaries(boundaries);
      } catch (e) {
        console.warn("Failed to parse manifest for boundaries", e);
      }
    };
    fetchManifest();
  }, [manifestUrl]);

  const estimateIndexFromTime = (time: number) => {
    if (segmentBoundaries.length === 0) {
      return Math.floor(time / 10); // fallback
    }
    // Find last boundary <= time
    let idx = segmentBoundaries.length - 1;
    for (let i = 0; i < segmentBoundaries.length; i++) {
      if (segmentBoundaries[i] > time) {
        idx = Math.max(0, i - 1);
        break;
      }
    }
    return idx;
  };

  useEffect(() => {
    if (manifestUrl && videoRef.current && !playerRef.current) {
      const player = dashjs.MediaPlayer().create();
      player.updateSettings({
        streaming: {
          // Keep seek fetches lightweight to improve scrub responsiveness.
          buffer: {
            bufferToKeep: 0, // seconds of back-buffer to retain
            stableBufferTime: 4,
            bufferTimeAtTopQuality: 4
          },
          scheduling: {
            scheduleWhilePaused: false
          },
          fastSwitchEnabled: true
        }
      });
      player.initialize(videoRef.current, manifestUrl, true);

      const sendPrioritize = (index: number) => {
        if (!videoId || index < 0) return;
        if (lastReportedIndexRef.current === index) return;
        lastReportedIndexRef.current = index;
        playerService.prioritizeSegment(videoId, index);
      };

      // Use dash.js playback event to get the actual seek target time
      player.on(dashjs.MediaPlayer.events.PLAYBACK_SEEKING, (e: any) => {
        const seekTime = (e && typeof e.seekTime === "number") ? e.seekTime : videoRef.current?.currentTime || 0;
        const estimatedIndex = estimateIndexFromTime(seekTime);
        console.log(`Dash seeking -> ${seekTime}s -> segment ${estimatedIndex}`);
        // Fire early to give backend a head start
        sendPrioritize(estimatedIndex);
        seekStartRef.current = performance.now();
      });

      // Only fire prioritize when seek completes (user released the scrubber)
      player.on(dashjs.MediaPlayer.events.PLAYBACK_SEEKED, (e: any) => {
        const seekTime = (e && typeof e.seekTime === "number") ? e.seekTime : videoRef.current?.currentTime || 0;
        const estimatedIndex = estimateIndexFromTime(seekTime);
        sendPrioritize(estimatedIndex);
      });

      playerRef.current = player;
      console.log("Dash Player Initialized");
    }

    return () => {
      if (playerRef.current) {
        playerRef.current.reset();
        playerRef.current = null;
      }
      pendingSeekIndexRef.current = null;
      firstFrameReportedRef.current = false;
      seekStartRef.current = null;
    };
  }, [manifestUrl, videoId]);

  useEffect(() => {
    firstFrameReportedRef.current = false;
  }, [manifestUrl, startTimestamp]);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const handlePlaying = () => {
      const now = performance.now();
      if (!firstFrameReportedRef.current) {
        if (typeof startTimestamp === "number") {
          const latency = now - startTimestamp;
          onFirstFrame?.(latency);
        }
        firstFrameReportedRef.current = true;
      }
      // Capture seek latency on every resume after a seek.
      if (seekStartRef.current) {
        onSeekLatency?.(now - seekStartRef.current);
        seekStartRef.current = null;
      }
    };
    videoEl.addEventListener("playing", handlePlaying);
    return () => {
      videoEl.removeEventListener("playing", handlePlaying);
    };
  }, [startTimestamp, onFirstFrame]);

  // Fallback: if dashjs event misses, track native seeking to start timer.
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const handleSeeking = () => {
      seekStartRef.current = performance.now();
    };
    videoEl.addEventListener("seeking", handleSeeking);
    return () => videoEl.removeEventListener("seeking", handleSeeking);
  }, []);

  if (!manifestUrl) return null;

  return (
    <div className="rounded-lg overflow-hidden border border-slate-700 shadow-2xl bg-black aspect-video relative group">
      <video 
        ref={videoRef} 
        className="w-full h-full" 
        controls
      />
      <div className="absolute top-2 right-2 bg-black/70 text-xs text-white px-2 py-1 rounded pointer-events-none">
        DASH Stream
      </div>
    </div>
  );
};
