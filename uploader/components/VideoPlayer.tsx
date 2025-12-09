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
      playerRef.current = player;
      console.log("Dash Player Initialized");
    }

    return () => {
      if (playerRef.current) {
        playerRef.current.reset();
        playerRef.current = null;
      }
    };
  }, [manifestUrl]);

  const handleSeeking = () => {
    if (!videoRef.current || !videoId) return;
    const currentTime = videoRef.current.currentTime;
    // Assuming 10s segments approx, tell backend to prioritize
    const estimatedIndex = Math.floor(currentTime / 10);
    console.log(`Seeking to ${currentTime}s -> Prioritizing Segment ${estimatedIndex}`);
    backendService.prioritizeSegment(videoId, estimatedIndex);
  };

  if (!manifestUrl) return null;

  return (
    <div className="rounded-lg overflow-hidden border border-slate-700 shadow-2xl bg-black aspect-video relative group">
      <video 
        ref={videoRef} 
        className="w-full h-full" 
        controls
        onSeeking={handleSeeking}
      />
      <div className="absolute top-2 right-2 bg-black/70 text-xs text-white px-2 py-1 rounded pointer-events-none">
        DASH Stream
      </div>
    </div>
  );
};