/**
 * The discovery boundary. A discovery provider answers one question: where are
 * people asking about this, right now, in public?
 *
 * It does not judge. Whether a discussion is worth answering, and what to say,
 * belongs to the agents above. Providers map their platform's payload to this
 * shape and nothing more, which is why this layer stays cheap enough to run
 * wide: no model is involved.
 *
 * Two kinds of provider live behind it. A platform API (Reddit, GitHub) knows
 * the thread's engagement and date; a web search knows a URL, a title and a
 * snippet and infers the rest from the URL. The shape allows for both: what a
 * provider does not know is null, never a made-up zero, so a thread found by
 * search is not filtered out for "having no comments".
 */

import type { DatePrecision } from "@/lib/providers/serp/dates";

export interface DiscoveryQuery {
  /** What to look for, in the platform's own search syntax where it has one. */
  query: string;
  /** Two-letter content language, for platforms that can filter by it. */
  language: string;
  /** Ignore anything older: a dead thread is not worth an answer. */
  maxAgeDays?: number;
  limit?: number;
  signal?: AbortSignal;
}

/** What kind of public page this is. Drives tone, freshness rules and drafts. */
export type DiscussionKind =
  | "thread"
  | "issue"
  | "discussion"
  | "repository"
  | "article"
  | "post"
  | "page";

export interface Discussion {
  /**
   * Stable id within the surface, used to avoid finding the same thread twice.
   * The same thread found by two providers must get the same id: see
   * ./canonical.ts.
   */
  externalId: string;
  /**
   * The surface this came from: one of the canonicaliser's `Surface` values
   * ("reddit", "github", "linkedin", "x", "hackernews", "stackexchange",
   * "quora", "indiehackers", "devto"), or "web" for any other host.
   */
  surface: string;
  kind: DiscussionKind;
  /** Canonical URL: tracking stripped, one form per thread. */
  url: string;
  title: string;
  /** Opening text, truncated by the provider. Enough to judge, not to archive. */
  excerpt: string;
  /** Where inside the surface: a subreddit, a repository, a publication. */
  community: string;
  /** Who posted it, when the platform says. */
  author: string | null;
  /**
   * ISO timestamp of creation, or null when the provider cannot know. When
   * `createdAtPrecision` is set this is the LATEST instant the source allows
   * ("4 months ago" is a bound, not a moment), so an age computed from it is
   * a lower bound and never overstates.
   */
  createdAt: string | null;
  /**
   * How wide the interval before `createdAt` is, when the source gave a
   * calendar day or a distance rather than an instant. Absent or null for a
   * platform API's exact timestamp.
   */
  createdAtPrecision?: DatePrecision | null;
  /** Platform engagement, comparable only within one surface; null when unknown. */
  score: number | null;
  commentCount: number | null;
}

export interface DiscoveryProvider {
  readonly name: string;
  search(query: DiscoveryQuery): Promise<Discussion[]>;
}

export class DiscoveryProviderError extends Error {
  /** HTTP status when the failure was an HTTP response. */
  readonly status?: number;
  /** The platform's Retry-After, in seconds, when it sent one. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
    details: { status?: number; retryAfterSeconds?: number } = {}
  ) {
    super(message);
    this.name = "DiscoveryProviderError";
    this.status = details.status;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }

  /** Rate limited or the platform's side failed: stop this provider for the run. */
  get rateLimited(): boolean {
    return this.status === 429 || this.status === 403;
  }
}
