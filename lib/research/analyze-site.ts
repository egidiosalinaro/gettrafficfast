import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContentLanguageCode } from "@/lib/content-language";
import { inRequestBillingRefusal } from "@/lib/llm-billing-refusal";
import { analyzeWebsite, type WebsiteAnalysis } from "./website";

/**
 * "Analyse my site" for the business form, called by
 * `POST /api/business/analyze` and the analyze_website tool: the page is
 * fetched with `safeFetch` (public addresses only) and read by one model
 * call, and nothing is saved; the person (or agent) decides what to keep.
 *
 * A billing refusal is recorded and answered as a 503 in words; any other
 * failure is thrown, for the caller to answer as it always has.
 */
export async function analyzeSite(input: {
  admin: () => SupabaseClient;
  websiteUrl: unknown;
  contentLanguage: ContentLanguageCode;
  /** Who asked, for the billing record: "api.business.analyze", "tool.analyze_website". */
  source: string;
}): Promise<{ ok: true; analysis: WebsiteAnalysis } | { ok: false; status: 400 | 503; error: string }> {
  const { websiteUrl } = input;
  if (!websiteUrl || typeof websiteUrl !== "string") {
    return { ok: false, status: 400, error: "Website URL is required" };
  }
  try {
    new URL(websiteUrl);
  } catch {
    return { ok: false, status: 400, error: "Invalid URL format" };
  }

  try {
    return { ok: true, analysis: await analyzeWebsite(websiteUrl, input.contentLanguage) };
  } catch (error) {
    const refused = await inRequestBillingRefusal(input.admin, error, input.source);
    if (refused) return refused;
    throw error;
  }
}
