import { VideoProvider } from "./types";
import { YouTubeProvider } from "./youtube";

/**
 * Resolves the video provider, or null when none is configured — video
 * enrichment degrades to "skipped", never to a failure.
 */

let cached: VideoProvider | null | undefined;

export function getVideoProvider(): VideoProvider | null {
  if (cached !== undefined) return cached;
  const key = process.env.YOUTUBE_API_KEY;
  cached = key ? new YouTubeProvider(key) : null;
  return cached;
}

/** Test seam. */
export function setVideoProvider(provider: VideoProvider | null | undefined): void {
  cached = provider;
}
