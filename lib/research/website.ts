import { parse } from "node-html-parser";
import { z } from "zod";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { contentLanguageName } from "@/lib/content-language";
import { collapseWhitespace } from "@/lib/content/text";
import { safeFetch } from "@/lib/providers/safe-fetch";
import { SITE_URL } from "@/lib/site";

/**
 * Business analysis: read a customer's site and describe what they do.
 *
 * The page is parsed into a tree and reduced to its text — the same rule as the
 * content pipeline, for the same reason. The model then produces a validated
 * structure, never free text a caller has to interpret.
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 5_000;

export const WebsiteAnalysis = z.object({
  niche: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
  sitemapUrl: z.string().nullable().default(null),
  blogUrl: z.string().nullable().default(null),
});
export type WebsiteAnalysis = z.infer<typeof WebsiteAnalysis>;

/** Visible text of a page, with scripts, styles and markup removed. */
export function extractReadableText(html: string): string {
  const root = parse(html, { comment: false });
  for (const el of root.querySelectorAll("*")) {
    const tag = el.tagName?.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") el.remove();
  }
  return collapseWhitespace(root.text);
}

async function fetchPageText(websiteUrl: string): Promise<string> {
  try {
    // The URL is whatever the customer typed: it must be a public address,
    // at every redirect hop, or it is not fetched.
    const response = await safeFetch(
      websiteUrl,
      {
        headers: {
          "User-Agent": `Mozilla/5.0 (compatible; GetTrafficFast/1.0; +${SITE_URL})`,
        },
      },
      { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 5 * 1024 * 1024 }
    );
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = extractReadableText(await response.text());
    if (!text) throw new Error("no readable text on the page");
    return text;
  } catch (err) {
    // Analysing from the URL alone is worse but still useful; failing here
    // would block onboarding on a site that merely blocks our user agent.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "website.fetch_failed",
        url: websiteUrl,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return `Website URL: ${websiteUrl}`;
  }
}

export async function analyzeWebsite(
  websiteUrl: string,
  contentLanguage?: string
): Promise<WebsiteAnalysis> {
  const language = contentLanguageName(contentLanguage);
  const origin = new URL(websiteUrl).origin;
  const pageText = await fetchPageText(websiteUrl);

  const prompt = `Analyse this website and extract its business profile.

Website URL: ${websiteUrl}
Base URL: ${origin}

Page content (first ${MAX_TEXT_CHARS} characters):
${pageText.slice(0, MAX_TEXT_CHARS)}

Rules:
- niche: the industry or category, at most 3 words.
- description: what the business actually does, detailed but under 1000 characters.
- sitemapUrl and blogUrl: FULL urls starting with http:// or https:// (for example ${origin}/sitemap.xml, ${origin}/blog). Convert any relative path you find into a full url. Use null when you cannot find one — never guess.
- Write niche and description in ${language}, regardless of the language of the website.`;

  const { value } = await getLlmProvider().generateStructured(prompt, WebsiteAnalysis, {
    tier: "fast",
    temperature: 0.3,
  });
  return value;
}
