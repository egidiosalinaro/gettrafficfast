import { parseEngineDate } from "./dates";
import { SerpData, SerpProvider, SerpProviderError, SerpQuery, domainOf } from "./types";

/**
 * Serper.dev — Google SERP data over a simple API. Optional: without
 * SERPER_API_KEY the research step is simply skipped.
 */

/** Locale pairs per content language: gl = country, hl = interface language. */
const LOCALES: Record<string, { gl: string; hl: string }> = {
  en: { gl: "us", hl: "en" },
  it: { gl: "it", hl: "it" },
  es: { gl: "es", hl: "es" },
  fr: { gl: "fr", hl: "fr" },
  de: { gl: "de", hl: "de" },
};

interface SerperOrganic {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
  /** The date Google shows under the title, in the interface language: "Jun 6, 2025", "4 months ago". */
  date?: string;
}

export interface SerperResponse {
  organic?: SerperOrganic[];
  peopleAlsoAsk?: Array<{ question?: string }>;
  relatedSearches?: Array<{ query?: string }>;
}

/**
 * Google's time filter for "pages dated within the last N days". Whole
 * units, rounded up, so the window asked for is never narrower than the one
 * wanted; a filter Google does not understand is ignored, which is the same
 * result as asking for nothing.
 */
export function timeFilter(maxAgeDays: number): string {
  if (maxAgeDays <= 1) return "qdr:d";
  if (maxAgeDays < 7) return `qdr:d${Math.ceil(maxAgeDays)}`;
  if (maxAgeDays < 30) return `qdr:w${Math.ceil(maxAgeDays / 7)}`;
  if (maxAgeDays < 365) return `qdr:m${Math.ceil(maxAgeDays / 30)}`;
  return `qdr:y${Math.ceil(maxAgeDays / 365)}`;
}

/**
 * Pure mapping from Serper's payload to the platform shape — exported so the
 * contract is pinned by tests without a network. `now` is when the search
 * ran: Google dates results as "4 months ago", which means nothing without
 * it.
 */
export function parseSerperResponse(keyword: string, payload: SerperResponse, now: Date = new Date()): SerpData {
  // Position falls back to the item's place in the provider's list — the
  // real SERP order — so it is computed before incomplete rows are dropped.
  const results = (payload.organic ?? [])
    .map((item, index) => {
      const date = parseEngineDate(item.date, now);
      return {
        position: item.position ?? index + 1,
        title: item.title ?? "",
        url: item.link ?? "",
        domain: domainOf(item.link ?? ""),
        snippet: item.snippet ?? "",
        publishedAt: date?.at ?? null,
        publishedAtPrecision: date?.precision ?? null,
      };
    })
    .filter((item) => item.title.length > 0 && item.domain.length > 0);

  return {
    keyword,
    results,
    peopleAlsoAsk: (payload.peopleAlsoAsk ?? [])
      .map((item) => item.question?.trim() ?? "")
      .filter((q) => q.length > 0),
    relatedSearches: (payload.relatedSearches ?? [])
      .map((item) => item.query?.trim() ?? "")
      .filter((q) => q.length > 0),
    raw: payload,
  };
}

export class SerperProvider implements SerpProvider {
  readonly name = "serper";

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new SerpProviderError("SERPER_API_KEY is not set", "serper");
  }

  async search(query: SerpQuery): Promise<SerpData> {
    const locale = LOCALES[query.language.slice(0, 2).toLowerCase()] ?? LOCALES.en;

    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query.keyword,
        gl: locale.gl,
        hl: locale.hl,
        num: query.maxResults ?? 10,
        ...(query.maxAgeDays ? { tbs: timeFilter(query.maxAgeDays) } : {}),
      }),
      signal: query.signal ?? null,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SerpProviderError(
        `Serper search failed (${response.status}): ${body.slice(0, 300)}`,
        "serper",
        undefined,
        { status: response.status }
      );
    }

    return parseSerperResponse(query.keyword, (await response.json()) as SerperResponse);
  }
}
