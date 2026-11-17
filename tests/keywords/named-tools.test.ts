import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * What a site's own data names (lib/keywords/named-tools.ts), and the rule
 * that a suggestion names nothing else: a comparison of a product the data
 * never met is refused, a comparison, how-to or problem idea keeps no
 * volume, and the suggestion call is told the list. No model is called
 * here; the suggestion call is mocked.
 */

const mocks = vi.hoisted(() => ({ fromBusiness: vi.fn() }));
vi.mock("@/lib/research/keywords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/research/keywords")>()),
  generateKeywordsFromBusiness: (...args: unknown[]) => mocks.fromBusiness(...args),
}));

import { domainLabel, loadNamedTools, namedTools, settleSuggestions } from "@/lib/keywords/named-tools";
import { suggestKeywords } from "@/lib/keywords/manage";
import { intentMixBlock } from "@/lib/research/keywords";

const SITE = "biz-1";
const USER = "user-1";
const own = { user_id: USER, business_id: SITE };

describe("domainLabel", () => {
  it("is the brand part of a domain", () => {
    expect(domainLabel("jasper.ai")).toBe("jasper");
    expect(domainLabel("app.gravitywrite.com")).toBe("gravitywrite");
    expect(domainLabel("https://www.frase.io/pricing")).toBe("frase");
    expect(domainLabel("shop.co.uk")).toBe("shop");
  });
});

describe("namedTools", () => {
  const rows = {
    entities: [
      { name: "Jasper", articles: 1 },
      { name: "Jasper AI", articles: 4 },
      { name: "Surfer SEO", articles: 1 },
      { name: "WordPress", articles: 6 },
      { name: "Notion AI", articles: 1 },
      { name: "GetTrafficFast", articles: 29 },
      { name: "Excel", articles: 1 },
    ],
    competitors: [
      { domain: "surfer.ai", source: "serp" },
      { domain: "coursera.org", source: "serp" },
      { domain: "seowriting.ai", name: "SEO Writing AI", source: "manual" },
    ],
    probes: [
      { query: "best ai writer", competitors: [{ domain: "jasper.ai" }, { domain: "coursera.org" }] },
      { query: "ai seo", competitors: [{ domain: "jasper.ai" }] },
    ],
    businessName: "GetTrafficFast",
    websiteUrl: "https://gettrafficfa.st/",
  };

  it("names a product when two sources agree, when articles name it twice, or when a person added it", () => {
    const names = namedTools(rows).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Jasper AI", "Surfer SEO", "WordPress", "SEO Writing AI"]));
  });

  it("never names the business itself, a domain the graph never named, or a product with one passing mention", () => {
    const names = namedTools(rows).map((t) => t.name.toLowerCase());
    expect(names).not.toContain("gettrafficfast");
    expect(names.some((n) => n.includes("coursera"))).toBe(false);
    expect(names).not.toContain("excel");
    expect(names).not.toContain("notion ai");
  });

  it("keeps one spelling a brand, and the best-evidenced first", () => {
    const tools = namedTools(rows);
    expect(tools.filter((t) => t.name.toLowerCase().startsWith("jasper"))).toHaveLength(1);
    expect(tools[0].manual).toBe(true);
    expect(tools.find((t) => t.name === "Jasper AI")).toMatchObject({ articles: 4, citedIn: 2 });
  });

  it("is capped", () => {
    expect(namedTools(rows, 2)).toHaveLength(2);
  });
});

describe("loadNamedTools", () => {
  it("reads the site's own graph, ranking domains and AI answers, never another site's", async () => {
    const db = new FakeSupabase({
      entities: [
        { ...own, name: "Jasper", type: "product", article_entities: [{ count: 3 }] },
        { user_id: USER, business_id: "biz-2", name: "Frase", type: "product", article_entities: [{ count: 9 }] },
      ],
      competitors: [{ ...own, domain: "jasper.ai", source: "serp" }],
      aeo_probes: [],
    });
    const tools = await loadNamedTools(db as unknown as SupabaseClient, SITE, { businessName: "Acme" });
    expect(tools.map((t) => t.name)).toEqual(["Jasper"]);
    expect(tools[0]).toMatchObject({ articles: 3, ranks: true });
  });
});

describe("settleSuggestions", () => {
  const base = { competition: "Medium" as const, difficulty: 40, opportunity: "High" as const };

  it("refuses a comparison of a product the data never named, and says which", () => {
    const { kept, refused } = settleSuggestions(
      [
        { keyword: "Jasper alternatives", searchVolume: 900, cpc: 4, intent: "comparison", ...base },
        { keyword: "Fooly vs Jasper", searchVolume: 300, cpc: 2, intent: "comparison", ...base },
      ],
      { names: ["Jasper"], businessName: "Acme", profile: "AI SEO content" }
    );
    expect(kept.map((s) => s.keyword)).toEqual(["Jasper alternatives"]);
    expect(refused).toEqual([{ keyword: "Fooly vs Jasper", names: ["fooly"], why: expect.stringContaining("nothing in this site's data names") }]);
  });

  it("gives each its intent and drops the volume nobody measured", () => {
    const { kept } = settleSuggestions(
      [
        { keyword: "Jasper alternatives", searchVolume: 900, cpc: 4, intent: null, ...base },
        { keyword: "how to connect WordPress to Search Console", searchVolume: 500, cpc: 1, intent: "platform_howto", ...base },
        { keyword: "why does my blog get no traffic", searchVolume: 700, cpc: 1, intent: "problem", ...base },
        { keyword: "AI content writer", searchVolume: 8100, cpc: 3, intent: "comparison", ...base },
      ],
      { names: ["Jasper", "WordPress"] }
    );
    expect(kept.map((s) => [s.keyword, s.intent, s.searchVolume, s.cpc])).toEqual([
      ["Jasper alternatives", "comparison", null, null],
      ["how to connect WordPress to Search Console", "platform_howto", null, null],
      ["why does my blog get no traffic", "problem", null, null],
      // A core topic keeps its estimate, labelled as one, as every suggestion always has.
      ["AI content writer", "product_adjacent", 8100, 3],
    ]);
  });
});

describe("suggestKeywords with the site's names", () => {
  let db: FakeSupabase;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.fromBusiness.mockReset();
    db = new FakeSupabase({
      businesses: [{ id: SITE, user_id: USER, name: "Acme", niche: "AI SEO", description: "AI SEO content", website_url: "https://acme.test", content_language: "en" }],
      entities: [{ ...own, name: "Jasper", type: "product", article_entities: [{ count: 2 }] }],
      competitors: [],
      aeo_probes: [],
      keywords: [],
      articles: [],
    });
  });

  it("tells the one suggestion call the names, and refuses a comparison naming another", async () => {
    mocks.fromBusiness.mockResolvedValue([
      { keyword: "Jasper alternatives", searchVolume: null, competition: "Medium", difficulty: 40, cpc: null, opportunity: "High", intent: "comparison" },
      { keyword: "Writesonic alternatives", searchVolume: null, competition: "Medium", difficulty: 40, cpc: null, opportunity: "High", intent: "comparison" },
    ]);
    const result = await suggestKeywords({
      supabase: db as unknown as SupabaseClient,
      admin: () => db as unknown as SupabaseClient,
      userId: USER,
      businessId: SITE,
      seeds: null,
      fromBusiness: true,
      source: "test",
    });
    expect(mocks.fromBusiness).toHaveBeenCalledTimes(1);
    expect(mocks.fromBusiness.mock.calls[0][4]).toEqual({ businessName: "Acme", names: ["Jasper"] });
    expect(result).toMatchObject({
      ok: true,
      suggestions: [{ keyword: "Jasper alternatives", intent: "comparison" }],
      refused: [{ keyword: "Writesonic alternatives", names: ["writesonic"] }],
    });
  });
});

describe("intentMixBlock", () => {
  it("lists the only names a keyword may carry, and says none when there are none", () => {
    const withNames = intentMixBlock({ businessName: "Acme", names: ["Jasper", "WordPress"] });
    expect(withNames).toContain("- Jasper\n- WordPress");
    expect(withNames).toContain('"Acme vs <tool>"');
    expect(withNames).toContain("Never name any other product");
    expect(intentMixBlock({})).toContain("No product or platform is named in this site's data yet, so name none.");
  });
});
