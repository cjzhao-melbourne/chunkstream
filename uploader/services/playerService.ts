const DEFAULT_BACKEND_BASE = "http://127.0.0.1:8000";

const BACKEND_BASE = (
  import.meta?.env?.VITE_BACKEND_BASE ||
  (typeof window !== "undefined" ? (window as any).__CHUNKSTREAM_BACKEND_BASE__ : undefined) ||
  DEFAULT_BACKEND_BASE
).replace(/\/$/, "");

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
