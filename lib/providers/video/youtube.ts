import {
  VideoCandidate,
  VideoProvider,
  VideoProviderError,
  VideoSearchRequest,
} from "./types";

/**
 * YouTube Data API v3 search. Optional: without YOUTUBE_API_KEY the video
 * enrichment is simply skipped.
 */

interface YouTubeSearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    description?: string;
    publishedAt?: string;
    thumbnails?: { high?: { url?: string }; default?: { url?: string } };
  };
}

export class YouTubeProvider implements VideoProvider {
  readonly name = "youtube";

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new VideoProviderError("YOUTUBE_API_KEY is not set", "youtube");
  }

  async search(request: VideoSearchRequest): Promise<VideoCandidate[]> {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      safeSearch: "strict",
      maxResults: String(request.maxResults ?? 6),
      q: request.query,
      relevanceLanguage: request.language.slice(0, 2),
      key: this.apiKey,
    });

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/search?${params.toString()}`,
      { signal: request.signal ?? null }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new VideoProviderError(
        `YouTube search failed (${response.status}): ${body.slice(0, 300)}`,
        "youtube"
      );
    }

    const data = (await response.json()) as { items?: YouTubeSearchItem[] };

    return (data.items ?? [])
      .filter((item) => item.id?.videoId && item.snippet?.title)
      .map((item) => {
        const id = item.id!.videoId!;
        const snippet = item.snippet!;
        return {
          provider: this.name,
          videoId: id,
          url: `https://www.youtube.com/watch?v=${id}`,
          embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
          title: snippet.title ?? "",
          channel: snippet.channelTitle ?? "",
          description: snippet.description ?? "",
          thumbnailUrl: snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url ?? "",
          publishedAt: snippet.publishedAt ?? "",
        };
      });
  }
}
