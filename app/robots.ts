import type { MetadataRoute } from "next";
import { CRAWLABLE_ASSETS, CRAWLABLE_PREFIXES, LLMS_TXT_PATH } from "@/lib/public-paths";
import { aiCrawlerGroups } from "@/lib/ai-crawlers";
import { SITE_URL } from "@/lib/site";

/**
 * Tells a crawler where the sitemap is, and not to spend its fetches on the
 * signed-in product. Those paths redirect to an HTML sign-up page, which is
 * not a document worth indexing.
 *
 * The AI search and answer crawlers, and the training ones, are named in
 * groups of their own with the same rules as `*` (lib/ai-crawlers.ts, where
 * the training choice is made and can be flipped). A crawler that finds its
 * name stops reading `*`, so every group carries the full rule set.
 */
export default function robots(): MetadataRoute.Robots {
  const site = {
    allow: ["/$", "/sitemap.xml", LLMS_TXT_PATH, ...CRAWLABLE_PREFIXES, ...CRAWLABLE_ASSETS],
    disallow: ["/", "/pricing/success", "/pricing/cancel"],
  };
  return {
    rules: [{ userAgent: "*", ...site }, ...aiCrawlerGroups(site)],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
