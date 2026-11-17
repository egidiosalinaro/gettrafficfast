import { describe, expect, it } from "vitest";
import {
  JACCARD_DUPLICATE,
  SERP_SAME_INTENT_MIN,
  clusterDuplicates,
  duplicateIndex,
  duplicateReason,
  keywordTokens,
  normalizeKeyword,
  serpOverlap,
  topSerpUrls,
  wordSimilarity,
  type DuplicateEntry,
} from "@/lib/keywords/duplicates";

/**
 * The near-duplicate rule, pinned on the clusters an audit of production
 * found on 2026-11-10 (the phrases below are the real keywords).
 *
 * The word signal is lexical, and these tests say exactly what it catches
 * and what it leaves to the SERP signal: a rule tuned until every audited
 * pair matched would also merge "email marketing for Shopify" with "email
 * marketing for restaurants".
 */

const entries = (...phrases: string[]): DuplicateEntry[] => phrases.map((text) => ({ id: text, text }));
const clustersOf = (...phrases: string[]) => clusterDuplicates(entries(...phrases)).map((c) => c.members.map((m) => m.text));

const serp = (...paths: string[]) => paths.map((p) => `rival.test/${p}`);

describe("normalising a keyword", () => {
  it("drops case, punctuation, accents and stop words, folds plurals, and ignores word order", () => {
    expect(normalizeKeyword("Web Push Notifications for Online Stores!")).toBe(normalizeKeyword("online store: web-push notification"));
    expect(normalizeKeyword("How to get cited by ChatGPT?")).toBe("chatgpt cit get");
    expect(keywordTokens("Città per l'ufficio")).toEqual(["citta", "lufficio"]);
  });

  it("keeps 'AI' as a word: it is the subject of the keyword, not an Italian preposition", () => {
    expect(keywordTokens("AI agent for content writing")).toContain("ai");
  });

  it("folds a few endings so one verb is one token, and never below a stem of three letters", () => {
    expect(normalizeKeyword("citation")).toBe(normalizeKeyword("cited"));
    expect(normalizeKeyword("optimization")).toBe(normalizeKeyword("optimize"));
    expect(normalizeKeyword("publishing")).toBe(normalizeKeyword("publish"));
    expect(keywordTokens("nation need king")).toEqual(["king", "nation", "need"]);
  });

  it("treats a tool, a platform, software and an app as one word", () => {
    expect(normalizeKeyword("AI content publishing platform")).toBe(normalizeKeyword("AI content publishing tool"));
    expect(normalizeKeyword("seo software")).toBe(normalizeKeyword("seo app"));
  });

  it("gives a phrase of stop words no tokens, and no similarity to anything", () => {
    expect(keywordTokens("how to do it")).toEqual([]);
    expect(wordSimilarity([], ["seo"])).toEqual({ jaccard: 0, contained: false, same: false });
    expect(duplicateReason({ id: "a", text: "how to" }, { id: "b", text: "what is" })).toBeNull();
  });
});

describe("the audited clusters", () => {
  it("web push notifications for online store / stores: the same words", () => {
    expect(duplicateReason(...(entries("web push notifications for online store", "web push notifications for online stores") as [DuplicateEntry, DuplicateEntry]))).toBe(
      "same_words"
    );
  });

  it("AI content publishing platform / tool / automated content publishing tool: one cluster", () => {
    expect(clustersOf("AI content publishing platform", "AI content publishing tool", "automated content publishing tool")).toEqual([
      ["AI content publishing platform", "AI content publishing tool", "automated content publishing tool"],
    ]);
  });

  it("AI agent for content creation / content writing / SEO content: one cluster by their words", () => {
    expect(clustersOf("AI agent for content creation", "AI agent for content writing", "AI agent for SEO content")).toEqual([
      ["AI agent for content creation", "AI agent for content writing", "AI agent for SEO content"],
    ]);
  });

  it("AI agent for daily article writing is NOT joined by words alone (half its words differ), and is by the results page", () => {
    const daily = "AI agent for daily article writing";
    const writing = "AI agent for content writing";
    expect(duplicateReason({ id: "a", text: daily }, { id: "b", text: writing })).toBeNull();
    const top = serp("1", "2", "3", "4", "5", "6", "7", "8", "9", "10");
    expect(
      duplicateReason(
        { id: "a", text: daily, serpUrls: top },
        { id: "b", text: writing, serpUrls: [...serp("1", "2", "3", "4", "5", "6"), "other.test/a", "other.test/b"] }
      )
    ).toBe("same_serp");
  });

  it("the ChatGPT phrasings share too few words to be joined lexically: only the results page can say they are one intent", () => {
    const cited = "how to get cited by ChatGPT";
    const optimization = "ChatGPT citation optimization";
    const traffic = "get traffic from ChatGPT";
    expect(clustersOf(cited, optimization, traffic)).toEqual([]);
    const top = serp("a", "b", "c", "d", "e", "f", "g", "h", "i", "j");
    const withSerp = [cited, optimization, traffic].map((text) => ({ id: text, text, serpUrls: top }));
    expect(clusterDuplicates(withSerp)).toEqual([{ members: withSerp, reasons: ["same_serp"] }]);
  });

  it("the same subject with a different head stays apart", () => {
    expect(clustersOf("email marketing for shopify", "email marketing for restaurants", "seo for dentists", "seo for lawyers")).toEqual([]);
    expect(clustersOf("abandoned cart email", "abandoned cart recovery")).toEqual([]);
    // One shared word is a subject, not a topic.
    expect(clustersOf("RFM analysis", "RFM segmentation", "rfm model")).toEqual([]);
  });

  it("a phrase with a word or two added is the same topic", () => {
    expect(clustersOf("RFM analysis", "what is RFM analysis", "RFM analysis for ecommerce")).toEqual([
      ["RFM analysis", "what is RFM analysis", "RFM analysis for ecommerce"],
    ]);
    expect(clustersOf("welcome email series", "welcome series emails", "welcome email series examples")).toHaveLength(1);
    expect(clustersOf("abandoned cart email", "abandoned cart emails", "abandoned cart email examples", "abandoned cart email sequence")).toEqual([
      ["abandoned cart email", "abandoned cart emails", "abandoned cart email examples", "abandoned cart email sequence"],
    ]);
    expect(duplicateReason({ id: "a", text: "abandoned cart email" }, { id: "b", text: "abandoned cart email examples" })).toBe("contained");
  });

  it("names every signal that joined a cluster", () => {
    const [cluster] = clusterDuplicates(entries("AI content publishing platform", "AI content publishing tool", "automated content publishing tool"));
    expect(cluster.reasons.sort()).toEqual(["same_words", "similar_words"]);
  });
});

describe("the thresholds", () => {
  it("joins at three shared words of five, not at two of four", () => {
    expect(wordSimilarity(["a", "b", "c", "d"], ["a", "b", "c", "e"]).jaccard).toBe(JACCARD_DUPLICATE);
    expect(duplicateReason({ id: "1", text: "alpha beta gamma delta" }, { id: "2", text: "alpha beta gamma epsilon" })).toBe("similar_words");
    expect(duplicateReason({ id: "1", text: "alpha beta gamma" }, { id: "2", text: "alpha beta epsilon" })).toBeNull();
  });

  it("joins on the results page at 6 shared pages of the top 10, not at 5, and never without both snapshots", () => {
    const a = serp("1", "2", "3", "4", "5", "6", "7", "8", "9", "10");
    const six = [...serp("1", "2", "3", "4", "5", "6"), "x.test/1", "x.test/2", "x.test/3", "x.test/4"];
    const five = [...serp("1", "2", "3", "4", "5"), "x.test/1", "x.test/2", "x.test/3", "x.test/4", "x.test/5"];
    expect(serpOverlap(a, six)).toBe(SERP_SAME_INTENT_MIN);
    expect(duplicateReason({ id: "1", text: "alpha", serpUrls: a }, { id: "2", text: "omega", serpUrls: six })).toBe("same_serp");
    expect(duplicateReason({ id: "1", text: "alpha", serpUrls: a }, { id: "2", text: "omega", serpUrls: five })).toBeNull();
    expect(serpOverlap(a, null)).toBeNull();
    expect(duplicateReason({ id: "1", text: "alpha", serpUrls: a }, { id: "2", text: "omega" })).toBeNull();
  });

  it("reads the top 10 pages of a stored snapshot, www and trailing slashes aside, and nothing from a malformed one", () => {
    const results = Array.from({ length: 14 }, (_, i) => ({ position: i + 1, url: `https://www.Rival.test/p${i}/` }));
    expect(topSerpUrls(results)).toHaveLength(10);
    expect(topSerpUrls(results)[0]).toBe("rival.test/p0");
    expect(topSerpUrls([{ url: "https://a.test/x" }, { url: "https://www.a.test/x/" }, { url: "not a url" }, null])).toEqual(["a.test/x"]);
    expect(topSerpUrls("nope")).toEqual([]);
  });
});

describe("a published article's title", () => {
  const title = { id: "t", kind: "title" as const, text: "AI Agent for Content Writing: How It Works in 2026" };

  it("covers a phrase of three words or more that it holds entirely", () => {
    expect(duplicateReason({ id: "k", text: "ai agent content writing" }, title)).toBe("title_covers");
    expect(duplicateReason(title, { id: "k", text: "content writing ai agent" })).toBe("title_covers");
  });

  it("does not cover a short phrase, or one with a word of its own", () => {
    expect(duplicateReason({ id: "k", text: "ai content" }, title)).toBeNull();
    expect(duplicateReason({ id: "k", text: "ai agent for content pricing" }, title)).toBeNull();
  });

  it("is never clustered with another title", () => {
    expect(duplicateReason(title, { ...title, id: "t2" })).toBeNull();
    expect(clusterDuplicates([title, { ...title, id: "t2" }])).toEqual([]);
  });
});

describe("the index", () => {
  it("finds the first known entry a candidate duplicates, never itself, and learns what is added", () => {
    const index = duplicateIndex(entries("abandoned cart email", "welcome email series"));
    expect(index.find({ id: "new", text: "abandoned cart emails" })).toMatchObject({ entry: { text: "abandoned cart email" }, reason: "same_words" });
    expect(index.find({ id: "abandoned cart email", text: "abandoned cart email" })).toBeNull();
    expect(index.find({ id: "new", text: "rfm analysis" })).toBeNull();
    index.add({ id: "new", text: "rfm analysis" });
    expect(index.find({ id: "newer", text: "rfm analysis for ecommerce" })).toMatchObject({ entry: { id: "new" }, reason: "contained" });
  });
});
