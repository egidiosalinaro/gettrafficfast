/**
 * The citation boundary. A citation provider answers one question: when this
 * question is asked of an answer engine, which sources does it actually cite?
 *
 * Whether OUR domain is among them, and what that rate means over time, is
 * decided next door in lib/lifecycle/citations.ts. Providers map their vendor
 * payload to this shape and nothing more.
 *
 * The honest limit, stated here because every caller inherits it: no answer
 * engine exposes "was I cited" as an API. This is sampling — we ask the
 * question ourselves and look at the sources we get back. It is evidence, not
 * ground truth, and it must be presented to customers as such.
 */

// One implementation per concern: the platform already has a single notion of
// "the identity of a site", and citations use exactly that one.
export { domainOf } from "@/lib/providers/serp/types";

export interface CitationQuery {
  /** The question to ask, phrased as a person would ask it. */
  query: string;
  /** Two-letter content language (en, it, …). */
  language: string;
  signal?: AbortSignal;
}

export interface CitationSource {
  url: string;
  /** Registrable host of `url`, lowercased, without "www.". */
  domain: string;
  title: string;
}

export interface CitationAnswer {
  /** Engine identity, stored per row: rates are only comparable within one. */
  engine: string;
  query: string;
  /** The engine's answer, kept so a cited snippet can be shown to the customer. */
  answer: string;
  sources: CitationSource[];
  /** The provider's payload verbatim, for debugging a surprising verdict. */
  raw: unknown;
  /** The concrete model that answered, when the vendor reports one. */
  model?: string;
  /**
   * What this call cost, ESTIMATED from the vendor's published prices and the
   * usage it reported. An estimate is recorded as one; when a vendor reports
   * nothing usable the field is absent rather than zero.
   */
  costUsd?: number;
}

export interface CitationProvider {
  readonly name: string;
  probe(query: CitationQuery): Promise<CitationAnswer>;
}

export class CitationProviderError extends Error {
  /** HTTP status when the failure was an HTTP response; undefined otherwise. */
  readonly status?: number;
  /** The vendor's Retry-After, in seconds, when it sent one. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
    details: { status?: number; retryAfterSeconds?: number } = {}
  ) {
    super(message);
    this.name = "CitationProviderError";
    this.status = details.status;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }

  /** Worth asking again later: rate limited, or the vendor's side failed. */
  get transient(): boolean {
    return this.status === 429 || (this.status !== undefined && this.status >= 500);
  }
}

export { retryAfterSecondsFrom } from "@/lib/providers/http";
