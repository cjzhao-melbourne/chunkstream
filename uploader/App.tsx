import React, { useState, useEffect, useRef } from 'react';
import { ChunkstreamEngine } from './services/chunkstreamEngine';
import { SegmentInfo } from './types';
import { Button } from './components/Button';
import { ProgressBar } from './components/ProgressBar';
import { VideoPlayer } from './components/VideoPlayer';

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [startTimestamp, setStartTimestamp] = useState<number | null>(null);
  const [firstFrameLatencyMs, setFirstFrameLatencyMs] = useState<number | null>(null);
  const [seekLatencyMs, setSeekLatencyMs] = useState<number | null>(null);
  const [lastSeekLabel, setLastSeekLabel] = useState<string | null>(null);
  const engineRef = useRef<ChunkstreamEngine | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setSegments([]);
      setLogs([]);
      setManifestUrl(null);
      setVideoId(null);
      addLog("File selected: " + e.target.files[0].name);
    }
  };

  const handleStart = async () => {
    if (!file) return;
    setIsProcessing(true);
    setLogs([]);
    setFirstFrameLatencyMs(null);
    setSeekLatencyMs(null);
    setLastSeekLabel(null);
    setStartTimestamp(performance.now());

    const engine = new ChunkstreamEngine(file, {
      segmentDuration: 10,
      maxConcurrency: 3
    });

    engine.onLog = addLog;
    engine.onProgress = setSegments;
    engine.onReadyToPlay = (url, vId) => {
      setManifestUrl(url);
      setVideoId(vId);
      addLog(`Ready to play! URL: ${url}`);
    };

    engineRef.current = engine;

    try {
      await engine.start();
    } catch (e) {
      addLog("Critical Error: " + (e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStop = () => {
    if (engineRef.current) {
      engineRef.current.stop();
      addLog("Stop requested by user.");
      setIsProcessing(false);
    }
  };

  const handleClosePlayback = () => {
    setManifestUrl(null);
    setVideoId(null);
    setFirstFrameLatencyMs(null);
    setSeekLatencyMs(null);
    setLastSeekLabel(null);
    addLog("Preview closed by user.");
  };

  const handleShareLink = async () => {
    if (!manifestUrl) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(manifestUrl);
        addLog("Manifest URL copied to clipboard.");
      } else {
        window.prompt("Copy manifest URL:", manifestUrl);
      }
    } catch (e) {
      addLog("Failed to copy manifest URL, showing prompt instead.");
      window.prompt("Copy manifest URL:", manifestUrl);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 p-6 font-sans selection:bg-indigo-500/30">
      <div className="max-w-4xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-6">
          <div>
            <h1 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-emerald-400">
              Smart Chunkstream
            </h1>
            <p className="text-slate-500 mt-1">Browser-based MP4 Virtualization & DASH Uploader</p>
          </div>
          <div className="text-xs font-mono text-slate-600 text-right">
            <p>React 18 + MP4Box + Tailwind</p>
            <p>v1.0.0</p>
          </div>
        </div>

        {/* Main Controls */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          
          {/* Left: Uploader */}
          <div className="space-y-6">
            <div className="bg-slate-800/50 p-6 rounded-xl border border-slate-700 backdrop-blur-sm">
              <h2 className="text-xl font-semibold mb-4 text-indigo-300">Source File</h2>
              
              <div className="space-y-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4"
                  onChange={handleFileChange}
                  disabled={isProcessing}
                  className="hidden"
                />

                <div className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isProcessing}
                  >
                    Select File
                  </Button>
                  <span className="text-sm text-slate-400 truncate">
                    {file ? file.name : "No file chosen"}
                  </span>
                </div>
                
                <div className="flex gap-3">
                  <Button 
                    onClick={handleStart} 
                    disabled={!file || isProcessing}
                    className="flex-1"
                  >
                    {isProcessing ? 'Processing...' : 'Start Stream'}
                  </Button>
                  
                  {isProcessing && (
                    <Button onClick={handleStop} variant="danger">
                      Stop
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Stats / Segments */}
            {segments.length > 0 && (
              <div className="bg-slate-800/50 p-6 rounded-xl border border-slate-700">
                <h2 className="text-lg font-semibold mb-3 text-slate-300">Segment Status</h2>
                <ProgressBar segments={segments} />
              </div>
            )}
          </div>

          {/* Right: Player with latency overlay */}
          <div className="space-y-6">
             <div className="bg-slate-800/50 p-6 rounded-xl border border-slate-700 h-full flex flex-col">
                <div className="flex items-center justify-between mb-4 gap-3">
                  <h2 className="text-xl font-semibold text-emerald-300">Preview Player</h2>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      className="px-3 py-1 text-sm"
                      onClick={handleShareLink}
                      disabled={!manifestUrl}
                      title="Copy manifest URL to share"
                    >
                      Share Link
                    </Button>
                    <Button
                      variant="secondary"
                      className="px-3 py-1 text-sm"
                      onClick={handleClosePlayback}
                      disabled={!manifestUrl}
                    >
                      Reset
                    </Button>
                  </div>
                </div>
                {manifestUrl ? (
                  <div className="flex-1 flex flex-col justify-center">
                    <VideoPlayer 
                      manifestUrl={manifestUrl} 
                      videoId={videoId} 
                      startTimestamp={startTimestamp}
                      onFirstFrame={(ms) => setFirstFrameLatencyMs(ms)}
                      onSeekLatency={(ms) => {
                        setSeekLatencyMs(ms);
                        setLastSeekLabel(new Date().toLocaleTimeString());
                      }}
                    />
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="p-3 rounded-lg border border-slate-700 bg-slate-900/60 text-center">
                        <p className="text-xs text-slate-400 mb-1">First Frame Latency</p>
                        <p className="text-lg font-bold text-indigo-300">
                          {firstFrameLatencyMs != null ? `${(firstFrameLatencyMs / 1000).toFixed(2)}s` : "--"}
                        </p>
                      </div>
                      <div className="p-3 rounded-lg border border-slate-700 bg-slate-900/60 text-center">
                        <p className="text-xs text-slate-400 mb-1">Seek Playback Latency</p>
                        <p className="text-lg font-bold text-emerald-300">
                          {seekLatencyMs != null ? `${(seekLatencyMs / 1000).toFixed(2)}s` : "--"}
                        </p>
                        <p className="text-[10px] text-slate-500">
                          {lastSeekLabel ? `Last seek @ ${lastSeekLabel}` : ""}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-center mt-2 text-slate-500 break-all">
                      {manifestUrl}
                    </p>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center border-2 border-dashed border-slate-700 rounded-lg min-h-[200px]">
                    <p className="text-slate-600">Waiting for manifest...</p>
                  </div>
                )}
             </div>
          </div>
        </div>

        {/* Terminal Logs */}
        <div className="bg-black rounded-xl border border-slate-800 p-4 font-mono text-xs h-64 overflow-y-auto shadow-inner opacity-90">
          <div className="text-slate-500 mb-2 sticky top-0 bg-black pb-1 border-b border-slate-900">
            System Logs
          </div>
          {logs.length === 0 && <div className="text-slate-700 italic">System ready.</div>}
          {logs.map((log, i) => (
            <div key={i} className="text-emerald-500/80 mb-0.5 border-l-2 border-transparent hover:border-emerald-500 pl-2">
              {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>

      </div>
    </div>
  );
};

export default App;
