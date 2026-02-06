const DEFAULT_BACKEND_BASE = "http://127.0.0.1:8000";

const resolveBackendBase = () => {
  const envBase = import.meta?.env?.VITE_BACKEND_BASE;
  const winBase = typeof window !== "undefined" ? (window as any).__CHUNKSTREAM_BACKEND_BASE__ || window.location?.origin : undefined;
  return (envBase || winBase || DEFAULT_BACKEND_BASE).replace(/\/$/, "");
};

const BACKEND_BASE = resolveBackendBase();

export const playerService = {
  async prioritizeSegment(videoId: string, index: number): Promise<void> {
    try {
      await fetch(`${BACKEND_BASE}/videos/${videoId}/prioritize/${index}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index })
      });
    } catch (e) {
      console.warn("Prioritize failed", e);
    }
  },

  getManifestUrl(videoId: string): string {
    return `${BACKEND_BASE}/videos/${videoId}/manifest.mpd`;
  }
};
