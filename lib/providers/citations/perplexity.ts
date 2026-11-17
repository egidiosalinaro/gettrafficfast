import {
  CitationAnswer,
  CitationProvider,
  CitationProviderError,
  CitationQuery,
  CitationSource,
  domainOf,
  retryAfterSecondsFrom,
} from "./types";

/**
 * Perplexity — an answer engine that returns its sources with the answer,
 * which is exactly what makes citation probing possible at all. Optional:
 * without PERPLEXITY_API_KEY the sweep simply reports the engine as disabled.
 */

const ENDPOINT = "https://api.perplexity.ai/chat/completions";

/** Cheapest search-grounded model: we want the sources, not the prose. */
const DEFAULT_MODEL = "sonar";

interface PerplexitySearchResult {
  title?: string;
  url?: string;
}

export interface PerplexityResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  /** Newer field: sources with titles. */
  search_results?: PerplexitySearchResult[];
  /** Older field: bare URLs, still returned by some models. */
  citations?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Published list prices for `sonar`, used only to ESTIMATE what a probe cost:
 * a per-request search fee plus tokens. Kept in one place so a price change is
 * one edit, and recorded on the probe as an estimate, never as an invoice.
 */
const SONAR_REQUEST_FEE_USD = 0.005;
const SONAR_USD_PER_MILLION_TOKENS = 1;

export function estimatePerplexityCost(payload: PerplexityResponse): number {
  const tokens = (payload.usage?.prompt_tokens ?? 0) + (payload.usage?.completion_tokens ?? 0);
  return Number(
    (SONAR_REQUEST_FEE_USD + (tokens / 1_000_000) * SONAR_USD_PER_MILLION_TOKENS).toFixed(6)
  );
}

/**
 * Pure mapping from Perplexity's payload to the platform shape, exported so
 * the contract is pinned by tests without a network.
 *
 * Both source fields are read and merged by URL: the API has carried each of
 * them at different times, and a probe that silently found "no sources"
 * because it read the wrong field would look exactly like "not cited", which
 * is the one confusion this metric cannot afford.
 */
export function parsePerplexityResponse(
  query: string,
  payload: PerplexityResponse,
  engine = "perplexity"
): CitationAnswer {
  const seen = new Set<string>();
  const sources: CitationSource[] = [];

  const push = (url: string, title: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const key = trimmed.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return;
    const domain = domainOf(trimmed);
    if (!domain) return;
    seen.add(key);
    sources.push({ url: trimmed, domain, title: title.trim() });
  };

  for (const result of payload.search_results ?? []) {
    push(result.url ?? "", result.title ?? "");
  }
  for (const url of payload.citations ?? []) {
    push(url, "");
  }

  return {
    engine,
    query,
    answer: (payload.choices?.[0]?.message?.content ?? "").trim(),
    sources,
    raw: payload,
    model: payload.model?.trim() || undefined,
    costUsd: estimatePerplexityCost(payload),
  };
}

export class PerplexityCitationProvider implements CitationProvider {
  readonly name = "perplexity";

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL
  ) {
    if (!apiKey) {
      throw new CitationProviderError("PERPLEXITY_API_KEY is not set", "perplexity");
    }
  }

  async probe(query: CitationQuery): Promise<CitationAnswer> {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "system",
            // The probe must observe the engine, not steer it: no brand is
            // named, or the answer would cite us because we asked it to.
            content:
              `Answer the user's question factually and concisely in the language with code "${query.language}". Cite your sources.`,
          },
          { role: "user", content: query.query },
        ],
      }),
      signal: query.signal ?? null,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new CitationProviderError(
        `Perplexity probe failed (${response.status}): ${body.slice(0, 300)}`,
        "perplexity",
        undefined,
        {
          status: response.status,
          retryAfterSeconds: retryAfterSecondsFrom(response.headers.get("retry-after")),
        }
      );
    }

    const parsed = parsePerplexityResponse(
      query.query,
      (await response.json()) as PerplexityResponse,
      this.name
    );
    return { ...parsed, model: parsed.model ?? this.model };
  }
}
