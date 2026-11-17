import {
  Discussion,
  DiscoveryProvider,
  DiscoveryProviderError,
  DiscoveryQuery,
} from "./types";

/**
 * Reddit, over the official app-only OAuth flow.
 *
 * Deliberately not the public .json endpoints: they are convenient and they
 * are outside Reddit's terms for commercial use. A product that plants content
 * on Reddit cannot start by breaking Reddit's rules, and an app that gets its
 * access revoked takes every customer's discovery down with it.
 *
 * Read only. Nothing here posts: publishing on Reddit stays a human action,
 * for reasons set out in docs/PLACEMENTS.md.
 *
 * Credentials are not self-serve. Since November 2025 Reddit's
 * Responsible Builder Policy closed `reddit.com/prefs/apps` for new OAuth
 * apps; `/prefs/apps` now redirects to that policy. New client id/secret
 * need written approval. Until then this provider stays off and web-search
 * finds Reddit threads without scores or comment counts.
 */

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const SEARCH_URL = "https://oauth.reddit.com/search";

/** Reddit requires a descriptive, unique agent and rate-limits generic ones. */
const USER_AGENT =
  process.env.REDDIT_USER_AGENT || "web:gettrafficfast:v1.0 (by /u/gettrafficfast)";

export function isRedditConfigured(): boolean {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

interface RedditChild {
  data?: {
    id?: string;
    permalink?: string;
    url?: string;
    title?: string;
    selftext?: string;
    subreddit?: string;
    author?: string;
    created_utc?: number;
    score?: number;
    num_comments?: number;
    over_18?: boolean;
  };
}

export interface RedditListing {
  data?: { children?: RedditChild[] };
}

/** Opening text kept short: enough to judge a thread, not to archive it. */
const EXCERPT_LIMIT = 600;

/**
 * Pure mapping from Reddit's listing to the platform shape, exported so the
 * contract is pinned by tests without a network.
 *
 * Threads with no id or no title are dropped, and so are NSFW ones: a customer
 * does not want their brand in that context, and no amount of relevance makes
 * up for it.
 */
export function parseRedditListing(payload: RedditListing): Discussion[] {
  return (payload.data?.children ?? [])
    .map((child): Discussion | null => {
      const data = child.data;
      if (!data?.id || !data.title) return null;
      if (data.over_18) return null;

      const permalink = data.permalink ? `https://www.reddit.com${data.permalink}` : data.url;
      if (!permalink) return null;

      return {
        // The post id, lowercased: the same key ./canonical.ts
        // derives from a thread URL, so a thread found by web search too is
        // one row, not two.
        externalId: data.id.toLowerCase(),
        surface: "reddit",
        kind: "thread",
        url: permalink,
        title: data.title.trim(),
        excerpt: (data.selftext ?? "").trim().slice(0, EXCERPT_LIMIT),
        community: data.subreddit ? `r/${data.subreddit}` : "",
        author: data.author?.trim() || null,
        createdAt: data.created_utc ? new Date(data.created_utc * 1000).toISOString() : null,
        score: data.score ?? 0,
        commentCount: data.num_comments ?? 0,
      };
    })
    .filter((d): d is Discussion => d !== null);
}

/**
 * Drops threads older than the window: a dead thread is not worth answering.
 * A thread whose date the provider does not know is kept; the age rule in
 * qualification flags it rather than guessing.
 */
export function withinAge(
  discussions: Discussion[],
  maxAgeDays: number | undefined,
  now: Date
): Discussion[] {
  if (!maxAgeDays) return discussions;
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  return discussions.filter((d) => d.createdAt === null || new Date(d.createdAt).getTime() >= cutoff);
}

export class RedditDiscoveryProvider implements DiscoveryProvider {
  readonly name = "reddit";

  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string
  ) {
    if (!clientId || !clientSecret) {
      throw new DiscoveryProviderError("Reddit credentials are not set", "reddit");
    }
  }

  /** App-only token, cached until shortly before it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new DiscoveryProviderError(
        `Reddit token request failed (${response.status}): ${body.slice(0, 200)}`,
        "reddit"
      );
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new DiscoveryProviderError("Reddit returned no access token", "reddit");
    }

    this.token = {
      value: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  async search(query: DiscoveryQuery): Promise<Discussion[]> {
    const token = await this.accessToken();
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", query.query);
    url.searchParams.set("limit", String(Math.min(query.limit ?? 25, 100)));
    url.searchParams.set("sort", "relevance");
    // Reddit's own window; the precise age filter is applied after, because
    // the API only offers coarse buckets.
    url.searchParams.set("t", "year");
    url.searchParams.set("type", "link");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
      signal: query.signal ?? null,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new DiscoveryProviderError(
        `Reddit search failed (${response.status}): ${body.slice(0, 200)}`,
        "reddit"
      );
    }

    return withinAge(
      parseRedditListing((await response.json()) as RedditListing),
      query.maxAgeDays,
      new Date()
    );
  }
}
