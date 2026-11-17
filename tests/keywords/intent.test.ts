import { describe, expect, it } from "vitest";
import {
  WEEKLY_MIX,
  chooseForPool,
  classifyTopicIntent,
  comparedNames,
  intentOf,
  mentionsName,
  mixOrder,
  parseTopicIntent,
  settleIntent,
  takeWeek,
  unknownComparedNames,
  type TopicIntent,
} from "@/lib/keywords/intent";

/**
 * The kind of search a topic answers (lib/keywords/intent.ts), decided by
 * rules on the phrase: the three kinds climbx.so's blog mixes (platform
 * how-to, comparison, problem) beside the core topics, with a platform
 * how-to recognised only for a platform the site's data names, and a
 * comparison a model proposes refused when it names a product nobody named.
 */

const X_NAMES = ["Twitter/X", "Typefully", "Buffer", "SuperX", "Supabird"];

describe("classifyTopicIntent", () => {
  it.each<[string, TopicIntent]>([
    // Bottom-funnel commercial pages.
    ["typefully alternatives", "comparison"],
    ["best superx alternatives", "comparison"],
    ["climbx vs superx", "comparison"],
    ["supabird review", "comparison"],
    ["best x growth tools", "comparison"],
    ["best twitter scheduler", "comparison"],
    ["What are the best AI writer tools?", "comparison"],
    ["Which AI tools are easy to create content?", "comparison"],
    // Problem and outcome questions.
    ["why do my x posts get no views", "problem"],
    ["how to get more impressions on x", "problem"],
    ["how to get cited by ChatGPT", "problem"],
    ["Can AI-generated content rank well in SEO?", "problem"],
    ["get more organic traffic with AI", "problem"],
    // Platform how-to and support, for platforms the data names.
    ["how to change X username", "platform_howto"],
    ["how to cancel X premium", "platform_howto"],
    ["X account locked", "platform_howto"],
    ["x api limits", "platform_howto"],
    ["best day to post on x", "platform_howto"],
    // The core category.
    ["AI content writer", "product_adjacent"],
    ["how to automate SEO content", "product_adjacent"],
  ])("%s → %s", (keyword, intent) => {
    expect(classifyTopicIntent(keyword, { names: X_NAMES })).toBe(intent);
  });

  it("never guesses a platform: without names a how-to is not a platform how-to", () => {
    expect(classifyTopicIntent("how to change X username")).toBe("product_adjacent");
    expect(classifyTopicIntent("how to cancel Fooly premium", { names: X_NAMES })).toBe("product_adjacent");
  });

  it("reads a name that is also a word only when it is written as the name", () => {
    expect(mentionsName("how to make money blogging", "Make")).toBe(false);
    expect(mentionsName("how to connect Airtable with Make", "Make")).toBe(true);
    expect(classifyTopicIntent("how to make a content calendar", { names: ["Make"] })).toBe("product_adjacent");
  });
});

describe("parseTopicIntent and intentOf", () => {
  it("keeps the four, reads anything else as not classified, and falls back to the rules", () => {
    expect(parseTopicIntent("comparison")).toBe("comparison");
    expect(parseTopicIntent("navigational")).toBeNull();
    expect(parseTopicIntent(null)).toBeNull();
    expect(intentOf("problem", "AI content writer")).toBe("problem");
    expect(intentOf(null, "jasper alternatives")).toBe("comparison");
  });
});

describe("settleIntent", () => {
  it("lets the rules stand, and takes a model's label only where it can invent nothing", () => {
    expect(settleIntent("jasper alternatives", "problem")).toBe("comparison");
    // The model's problem where the rules saw a core topic: it names nothing.
    expect(settleIntent("content that converts readers", "problem")).toBe("problem");
    // Its comparison without a comparison's shape, its how-to without a named platform: not taken.
    expect(settleIntent("AI content writer", "comparison")).toBe("product_adjacent");
    expect(settleIntent("how to quote tweet", "platform_howto")).toBe("product_adjacent");
    expect(settleIntent("AI content writer", "nonsense")).toBe("product_adjacent");
  });
});

describe("the no-invented-competitor rule", () => {
  const evidence = { names: ["Jasper", "Surfer SEO", "Junia AI"], businessName: "GetTrafficFast", profile: "AI SEO content agent" };

  it("reads the products a comparison names", () => {
    expect(comparedNames("best Jasper alternatives for SEO")).toEqual(["jasper"]);
    expect(comparedNames("alternatives to Surfer SEO")).toEqual(["surfer seo"]);
    expect(comparedNames("GetTrafficFast vs Jasper")).toEqual(["gettrafficfast", "jasper"]);
    expect(comparedNames("Junia AI review")).toEqual(["junia ai"]);
    expect(comparedNames("best AI writing tools")).toEqual([]);
  });

  it("passes products the data names, the business, and plain categories", () => {
    expect(unknownComparedNames("Jasper alternatives", evidence)).toEqual([]);
    expect(unknownComparedNames("Surfer alternatives", evidence)).toEqual([]);
    expect(unknownComparedNames("Junia review", evidence)).toEqual([]);
    expect(unknownComparedNames("GetTrafficFast vs Surfer SEO", evidence)).toEqual([]);
    expect(unknownComparedNames("AI writer vs human writer", evidence)).toEqual([]);
    expect(unknownComparedNames("best AI SEO tools", evidence)).toEqual([]);
  });

  it("refuses a product nothing in the data names", () => {
    expect(unknownComparedNames("Fooly alternatives", evidence)).toEqual(["fooly"]);
    expect(unknownComparedNames("GetTrafficFast vs Writesonic", evidence)).toEqual(["writesonic"]);
    // Not a comparison at all: nothing to check.
    expect(unknownComparedNames("how to write with Fooly", evidence)).toEqual([]);
  });
});

describe("the weekly mix", () => {
  const k = (id: string, score: number, intent?: TopicIntent) => ({ id, score, intent });

  it("fills a week's minimums first, then by score, best first within the week", () => {
    const queue = [
      k("core-1", 20),
      k("core-2", 19),
      k("core-3", 18),
      k("core-4", 17),
      k("core-5", 16),
      k("cmp-1", 3, "comparison"),
      k("cmp-2", 2, "comparison"),
      k("how-1", 4, "platform_howto"),
      k("how-2", 3.5, "platform_howto"),
      k("how-3", 3.4, "platform_howto"),
      k("prob-1", 5, "problem"),
      k("prob-2", 4.5, "problem"),
    ];
    const week = takeWeek(queue, {}, 7).map((c) => c.id);
    expect(week).toEqual(["core-1", "core-2", "prob-1", "prob-2", "how-1", "how-2", "cmp-1"]);
    expect(queue.map((c) => c.id)).toContain("core-3");
  });

  it("counts what the week already holds", () => {
    const queue = [k("core", 20), k("prob", 2, "problem"), k("how", 1, "platform_howto")];
    // Two problem pieces are already booked: the free day goes to the how-to, not the third problem.
    expect(takeWeek(queue, { problem: 2, platform_howto: 1, comparison: 1 }, 1).map((c) => c.id)).toEqual(["how"]);
  });

  it("does not pass a maximum while anything else is left, and fills the day anyway when nothing is", () => {
    const comparisons = [k("c1", 9, "comparison"), k("c2", 8, "comparison"), k("c3", 7, "comparison"), k("core", 1)];
    expect(takeWeek([...comparisons], {}, 3).map((c) => c.id)).toEqual(["c1", "c2", "core"]);
    expect(takeWeek([k("c1", 9, "comparison"), k("c2", 8, "comparison"), k("c3", 7, "comparison")], {}, 3)).toHaveLength(3);
  });

  it("is the score order exactly when the pool has no intents", () => {
    const pool = [k("a", 1), k("b", 9), k("c", 5), k("d", 7)];
    expect(mixOrder(pool).map((c) => c.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("buys the kinds the pool lacks first, among the ideas the one call returned", () => {
    const ideas = [
      { keyword: "core a", intent: "product_adjacent" as const },
      { keyword: "core b", intent: "product_adjacent" as const },
      { keyword: "jasper alternatives", intent: "comparison" as const },
      { keyword: "how to connect wordpress", intent: "platform_howto" as const },
    ];
    // The pool has problems and comparisons enough, and no how-to.
    expect(chooseForPool(ideas, { problem: 3, comparison: 2, product_adjacent: 9 }, 1).map((i) => i.keyword)).toEqual([
      "how to connect wordpress",
    ]);
    expect(chooseForPool(ideas, {}, 2).map((i) => i.keyword)).toEqual(["how to connect wordpress", "jasper alternatives"]);
    expect(chooseForPool(ideas, {}, 10)).toHaveLength(4);
  });

  it("aims for one or two comparisons, two how-tos and two or three problem pieces", () => {
    expect(WEEKLY_MIX).toMatchObject({
      comparison: { min: 1, max: 2 },
      platform_howto: { min: 2, max: 2 },
      problem: { min: 2, max: 3 },
    });
  });
});
