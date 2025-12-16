import React, { useEffect, useRef } from 'react';
import { backendService } from '../services/backendService';

declare const dashjs: any;

interface VideoPlayerProps {
  manifestUrl: string | null;
  videoId: string | null;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ manifestUrl, videoId }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);

  useEffect(() => {
    if (manifestUrl && videoRef.current && !playerRef.current) {
      const player = dashjs.MediaPlayer().create();
      player.initialize(videoRef.current, manifestUrl, true);

      // Use dash.js playback event to get the actual seek target time
      player.on(dashjs.MediaPlayer.events.PLAYBACK_SEEKING, (e: any) => {
        if (!videoId) return;
        const seekTime = (e && typeof e.seekTime === "number") ? e.seekTime : videoRef.current?.currentTime || 0;
        const estimatedIndex = Math.floor(seekTime / 10); // segment duration assumed 10s
        console.log(`Dash seek -> ${seekTime}s -> segment ${estimatedIndex}`);
        backendService.prioritizeSegment(videoId, estimatedIndex);
      });

      playerRef.current = player;
      console.log("Dash Player Initialized");
    }

    return () => {
      if (playerRef.current) {
        playerRef.current.reset();
        playerRef.current = null;
      }
    };
  }, [manifestUrl, videoId]);

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
