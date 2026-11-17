/**
 * The SERP boundary. A SERP provider answers one question: what does the
 * search engine actually show for this keyword, right now, in this language?
 *
 * What that evidence MEANS — intent, difficulty, the angle worth taking — is
 * the serp-analysis agent's judgement, never the provider's. Providers map
 * their vendor payload to this shape and nothing more.
 */

import type { DatePrecision } from "./dates";

export interface SerpQuery {
  keyword: string;
  /** Two-letter content language (en, it, …) — drives locale and interface. */
  language: string;
  maxResults?: number;
  /**
   * Ask the engine for pages it dates within this window. The engine's own
   * filter, so pages it cannot date are left out too: set it where an old
   * page is worthless (a thread nobody can reply to any more), not to save
   * a result or two.
   */
  maxAgeDays?: number;
  signal?: AbortSignal;
}

export interface SerpResult {
  position: number;
  title: string;
  url: string;
  /** Registrable host of `url`, lowercased, without "www.". */
  domain: string;
  snippet: string;
  /**
   * The date the engine showed beside the result, as the latest instant it
   * allows (lib/providers/serp/dates.ts); null or absent when it showed none.
   */
  publishedAt?: string | null;
  /** How wide the interval before `publishedAt` is; null when there is no date. */
  publishedAtPrecision?: DatePrecision | null;
}

export interface SerpData {
  keyword: string;
  results: SerpResult[];
  /** "People also ask" questions, when the engine exposes them. */
  peopleAlsoAsk: string[];
  relatedSearches: string[];
  /** The provider's payload verbatim, for the snapshot record. */
  raw: unknown;
}

export interface SerpProvider {
  readonly name: string;
  search(query: SerpQuery): Promise<SerpData>;
}

export class SerpProviderError extends Error {
  /** HTTP status when the failure was an HTTP response; undefined otherwise. */
  readonly status?: number;

  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
    details: { status?: number } = {}
  ) {
    super(message);
    this.name = "SerpProviderError";
    this.status = details.status;
  }
}

/** Lowercased host without "www." — the identity used across the platform. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
