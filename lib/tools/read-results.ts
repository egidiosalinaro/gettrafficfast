import { z } from "zod";
import { citationRatesByEngine } from "@/lib/domain/operating-loop";
import { loadResults } from "@/lib/lifecycle/load-results";
import { defineTool } from "./tool";

/**
 * Results (`/results`) as a tool: what the published articles achieved,
 * read through lib/lifecycle/load-results.ts, the function the Results
 * screen and the Overview call.
 *
 * What it says and how it says it is CLAUDE.md's rule for measurements:
 * rank is a position or null (never looked, or not ranking: `samples`
 * tells which); traffic is Search Console's count, null when it is not
 * connected; citation rates are per engine and sampled. The pooled
 * citation rate the screen's payload still carries is left out here: a rate
 * averaged across engines describes nothing. Free.
 */

export const CITATION_NOTE =
  "Citation rates are sampled, not ground truth: each check asks an engine once on one day, and no engine reports whether it cited you. Per engine, never averaged; null means not measured, 0 means asked and not cited.";

/** The Search Console connection as the screens show it; never the credential. */
export const SearchConsoleView = z.object({
  status: z.enum(["absent", "connected", "error"]),
  siteUrl: z.string().nullable().describe("The property the traffic is read from; null until one is picked."),
  lastSyncedOn: z.string().nullable().describe("The newest day fetched; Google settles the days after it over about three days."),
  pulledAt: z.string().nullable(),
  stale: z.boolean(),
  lastError: z.string().nullable(),
  syncing: z.boolean().describe("A first pull is queued or running."),
});

const EngineRate = z.object({
  engine: z.string(),
  rate: z.number().nullable().describe("cited / probes for this engine; null when never probed."),
  probes: z.number(),
  cited: z.number(),
});

const ArticleResultView = z.object({
  articleId: z.string(),
  keyword: z.string(),
  publishedUrl: z.string().nullable(),
  rank: z.object({
    current: z.number().nullable().describe("Latest position, one decimal; null when measured as absent or never measured (samples 0)."),
    previous: z.number().nullable(),
    delta: z.number().nullable().describe("previous minus current, one decimal: positive is up the page, 0 unchanged; null unless both positions are known."),
    measuredOn: z.string().nullable(),
    samples: z.number().describe("How many times we looked. 0 means never looked, not not ranking."),
  }),
  rankSource: z.enum(["search_console", "serp"]).nullable().describe("search_console: Google's average position; serp: one scraped results page."),
  traffic: z.object({
    impressions: z.number().nullable().describe("Counted by Search Console; null when it is not connected, never 0 for that."),
    clicks: z.number().nullable(),
    windowDays: z.number(),
  }),
  citations: z.object({
    probes: z.number(),
    cited: z.number(),
    lastCheckedOn: z.string().nullable(),
    byEngine: z.array(z.object({ engine: z.string(), rate: z.number(), probes: z.number() })),
  }),
});

export const getResults = defineTool({
  name: "get_results",
  title: "Get results",
  description:
    "What the site's published articles achieved, as the Results screen shows it: each article's position (Search Console's average when connected, else a scraped results page; null = not ranking or never measured), its Search Console clicks and impressions over 28 days (null = not connected), and its AI citations per engine, plus the totals, the per-day traffic series and the Search Console connection. Citations are sampled and per engine, never averaged.",
  input: z.object({}),
  output: z.object({
    articles: z.array(ArticleResultView),
    totals: z.object({
      published: z.number(),
      rankMeasured: z.number().describe("Articles with at least one rank measurement."),
      ranking: z.number(),
      topTen: z.number(),
      averagePosition: z.number().nullable().describe("Among the articles that rank; null when none does."),
      citationProbes: z.number(),
      impressions: z.number().nullable(),
      clicks: z.number().nullable(),
    }),
    citationsByEngine: z.array(EngineRate).describe("Every article's citation probes, pooled per engine only."),
    searchConsole: SearchConsoleView,
    traffic: z.object({
      days: z.array(z.object({ day: z.string(), clicks: z.number(), impressions: z.number() })),
      settledThrough: z.string().nullable().describe("The last day ingested; the series stops there instead of drawing zeros."),
      windowDays: z.number(),
    }),
    citationsSampled: z.literal(true),
    citationNote: z.string(),
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const view = await loadResults(ctx.client, ctx.businessId);
    const t = view.totals;
    // Per engine only: the pooled rates (per article and in totals) are not copied.
    return {
      articles: view.articles.map((article) => ({
        ...article,
        citations: {
          probes: article.citations.probes,
          cited: article.citations.cited,
          lastCheckedOn: article.citations.lastCheckedOn,
          byEngine: article.citations.byEngine,
        },
      })),
      totals: {
        published: t.published,
        rankMeasured: t.rankMeasured,
        ranking: t.ranking,
        topTen: t.topTen,
        averagePosition: t.averagePosition,
        citationProbes: t.citationProbes,
        impressions: t.impressions,
        clicks: t.clicks,
      },
      citationsByEngine: citationRatesByEngine(view.articles),
      searchConsole: view.searchConsole,
      traffic: view.traffic,
      citationsSampled: true as const,
      citationNote: CITATION_NOTE,
    };
  },
});

export const RESULTS_READ_TOOLS = [getResults] as const;
