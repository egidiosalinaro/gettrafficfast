/**
 * The video boundary. Video is a retrieval problem, not a generation one:
 * providers search their platform and return candidates; whether any of them
 * genuinely serves the article is the video-select agent's judgement.
 */

export interface VideoSearchRequest {
  query: string;
  language: string;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface VideoCandidate {
  provider: string;
  videoId: string;
  /** Canonical watch URL. */
  url: string;
  /** Embeddable player URL (receivers that render iframes use this). */
  embedUrl: string;
  title: string;
  channel: string;
  description: string;
  thumbnailUrl: string;
  publishedAt: string;
}

export interface VideoProvider {
  readonly name: string;
  search(request: VideoSearchRequest): Promise<VideoCandidate[]>;
}

export class VideoProviderError extends Error {
  constructor(message: string, readonly provider: string, readonly cause?: unknown) {
    super(message);
    this.name = "VideoProviderError";
  }
}
