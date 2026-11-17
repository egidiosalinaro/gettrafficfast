import { CitationProvider } from "./types";
import { PerplexityCitationProvider } from "./perplexity";
import { GeminiCitationProvider, isGeminiCitationsEnabled } from "./gemini";

/**
 * Resolves every configured answer engine.
 *
 * A LIST, not a single provider: `ai_citations.engine` exists because one
 * engine's citation rate says little on its own, and because engines disagree.
 * Adding the next one (a search-grounded Gemini or OpenAI model, Bing Copilot)
 * is a file here plus an env var, never a change above this layer.
 *
 * An empty list is a normal state: citation probing is optional, and the sweep
 * reports it as disabled instead of failing.
 */

let cached: CitationProvider[] | undefined;

export function getCitationProviders(): CitationProvider[] {
  if (cached !== undefined) return cached;

  const providers: CitationProvider[] = [];

  // Gemini with Google Search grounding: no new vendor, it reuses the key the
  // platform already has. Opt-in because grounded queries are billed.
  if (isGeminiCitationsEnabled()) {
    providers.push(new GeminiCitationProvider(process.env.GEMINI_API_KEY as string));
  }

  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  if (perplexityKey) {
    providers.push(
      new PerplexityCitationProvider(perplexityKey, process.env.PERPLEXITY_MODEL || undefined)
    );
  }

  cached = providers;
  return cached;
}

/** Test seam. */
export function setCitationProviders(providers: CitationProvider[] | undefined): void {
  cached = providers;
}
