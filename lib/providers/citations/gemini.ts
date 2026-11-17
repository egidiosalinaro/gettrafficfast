import {
  CitationAnswer,
  CitationProvider,
  CitationProviderError,
  CitationQuery,
  CitationSource,
  domainOf,
  retryAfterSecondsFrom,
} from "./types";
import { isGoogleHost } from "./resolve";

/**
 * Gemini with Google Search grounding, as a citation engine.
 *
 * The point of this one is that it costs no new vendor: it uses the key the
 * platform already has. It answers a different question from Perplexity
 * (Google's index rather than Perplexity's), which is exactly why the registry
 * keeps engines separate instead of averaging them.
 *
 * Called over REST rather than through the SDK, like every other provider
 * here: the payload shape is the contract, and a pure parser pins it.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Grounding is a search-and-answer job, not a writing one: the cheap tier. */
const DEFAULT_MODEL = "gemini-2.5-flash";

export function isGeminiCitationsEnabled(): boolean {
  // Explicit opt-in even though the key is always present: grounded requests
  // are billed per query, and a cost must never switch itself on because an
  // unrelated key happened to exist.
  return process.env.CITATIONS_GEMINI === "true" && Boolean(process.env.GEMINI_API_KEY);
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

export interface GeminiGroundedResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: { groundingChunks?: GroundingChunk[] };
  }>;
  modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Published list prices, used only to ESTIMATE a probe's cost: Google bills a
 * flat fee per grounded prompt on top of the flash-tier tokens. One place to
 * edit when the price moves; recorded on the probe as an estimate.
 */
const GROUNDED_PROMPT_FEE_USD = 0.035;
const FLASH_INPUT_USD_PER_MILLION = 0.3;
const FLASH_OUTPUT_USD_PER_MILLION = 2.5;

export function estimateGeminiGroundedCost(payload: GeminiGroundedResponse): number {
  const input = payload.usageMetadata?.promptTokenCount ?? 0;
  const output = payload.usageMetadata?.candidatesTokenCount ?? 0;
  return Number(
    (
      GROUNDED_PROMPT_FEE_USD +
      (input / 1_000_000) * FLASH_INPUT_USD_PER_MILLION +
      (output / 1_000_000) * FLASH_OUTPUT_USD_PER_MILLION
    ).toFixed(6)
  );
}

/**
 * The trap this parser exists for.
 *
 * Grounded responses do NOT return the source URL: `uri` is a Google redirect
 * (vertexaisearch.cloud.google.com/grounding-api-redirect/...) that resolves
 * to the real page only when followed. The site is carried in `title`, which
 * for web chunks is the domain.
 *
 * So the domain is read from the title whenever the uri is one of those
 * redirects. Parsing the redirect host instead would make every single source
 * look like it came from Google, and the citation rate would be a flat zero
 * for everyone, forever, with nothing in the logs to explain it.
 */
export function parseGeminiGroundedResponse(
  query: string,
  payload: GeminiGroundedResponse,
  engine = "gemini"
): CitationAnswer {
  const candidate = payload.candidates?.[0];
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];

  const seen = new Set<string>();
  const sources: CitationSource[] = [];

  for (const chunk of chunks) {
    const uri = chunk.web?.uri?.trim() ?? "";
    const title = chunk.web?.title?.trim() ?? "";
    if (!uri && !title) continue;

    const uriDomain = domainOf(uri);
    const isRedirect = isGoogleHost(uriDomain);
    // The title is the domain for web chunks; fall back to it whenever the uri
    // cannot tell us who was actually cited.
    const domain = !isRedirect && uriDomain ? uriDomain : domainOf(`https://${title}`) || title.toLowerCase();
    if (!domain) continue;

    if (seen.has(domain)) continue;
    seen.add(domain);
    sources.push({ url: uri, domain, title });
  }

  return {
    engine,
    query,
    answer: (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim(),
    sources,
    raw: payload,
    model: payload.modelVersion?.trim() || undefined,
    costUsd: estimateGeminiGroundedCost(payload),
  };
}

export class GeminiCitationProvider implements CitationProvider {
  readonly name = "gemini";

  constructor(
    private readonly apiKey: string,
    private readonly model: string = process.env.CITATIONS_GEMINI_MODEL || DEFAULT_MODEL
  ) {
    if (!apiKey) throw new CitationProviderError("GEMINI_API_KEY is not set", "gemini");
  }

  async probe(query: CitationQuery): Promise<CitationAnswer> {
    const response = await fetch(
      `${API_BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  // No brand is named: the probe observes the engine, it does
                  // not steer it into citing us.
                  text: `Answer factually and concisely, in the language with code "${query.language}": ${query.query}`,
                },
              ],
            },
          ],
          tools: [{ google_search: {} }],
        }),
        signal: query.signal ?? null,
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new CitationProviderError(
        `Gemini grounded probe failed (${response.status}): ${body.slice(0, 300)}`,
        "gemini",
        undefined,
        {
          status: response.status,
          retryAfterSeconds: retryAfterSecondsFrom(response.headers.get("retry-after")),
        }
      );
    }

    const parsed = parseGeminiGroundedResponse(
      query.query,
      (await response.json()) as GeminiGroundedResponse,
      this.name
    );
    return { ...parsed, model: parsed.model ?? this.model };
  }
}
