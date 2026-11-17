import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { comparisonBlock } from "@/lib/agents/article-brief";
import { productRule, writingRules } from "@/lib/agents/writing";
import { productMentionProblems } from "@/lib/content/quality/claims";

/**
 * A comparison page (`keywords.intent` "comparison", owner's rule of
 * 2026-11-15): the real options, fairly, who should pick a competitor, the
 * business as one option described only with its own facts, no price
 * nobody gave. The gate reads the business as one option there, and only
 * there.
 */

const business = { businessName: "GetTrafficFast", websiteUrl: "https://gettrafficfa.st" };

describe("the comparison brief", () => {
  const rules = writingRules({ keyword: "jasper alternatives", language: "English", ...business, topicIntent: "comparison" });

  it("asks for the real options, fairly, and who should choose a competitor", () => {
    expect(rules).toContain("Never add a product that appears in neither");
    expect(rules).toContain("Say plainly who should choose a competitor over GetTrafficFast");
    expect(rules).toContain("include one comparison <table>");
  });

  it("lets the business be one option, with its own facts only, and never invents a price", () => {
    expect(rules).toContain("GetTrafficFast is one option of the comparison");
    expect(rules).toContain("a feature, plan or result not stated there is not stated");
    expect(rules).toContain('write "check their pricing page"');
    expect(rules).not.toContain("at most once, in the closing section");
  });

  it("changes nothing for any other intent", () => {
    for (const topicIntent of [undefined, "problem", "platform_howto", "product_adjacent"] as const) {
      const other = writingRules({ keyword: "content calendar", language: "English", ...business, topicIntent });
      expect(other).toContain("at most once, in the closing section");
      expect(other).not.toContain("This is a comparison page");
    }
    expect(comparisonBlock({ ...business, topicIntent: "problem" })).toBe("");
  });

  it("holds a revision to the same rule", () => {
    expect(productRule({ ...business, topicIntent: "comparison" })).toContain("one option of the comparison");
    expect(productRule(business)).toContain("at most once");
  });
});

describe("the product gate on a comparison", () => {
  const p = (text: string) => `<p>${text}</p>`;
  const table =
    "<table><thead><tr><th>Tool</th><th>Best for</th></tr></thead><tbody><tr><td>Jasper</td><td>Marketing teams</td></tr><tr><td>GetTrafficFast</td><td>Sites that want articles published daily</td></tr></tbody></table>";
  const body =
    p("Jasper is a writing assistant; here are the options.") +
    '<h2 id="t">The options side by side</h2>' + table +
    '<h2 id="g">GetTrafficFast</h2>' + p("GetTrafficFast writes and publishes one article a day. It does not edit your drafts.") +
    '<h2 id="n">What to do next</h2>' + p("Pick the one that fits how you work.");

  it("reads the business as one option: its row and its section are not selling", () => {
    expect(productMentionProblems(body, "jasper alternatives", { businessName: "GetTrafficFast", comparison: true })).toEqual([]);
  });

  it("still flags it in the introduction, and the old rule everywhere else", () => {
    const intro = p("GetTrafficFast is the answer.") + body;
    expect(productMentionProblems(intro, "jasper alternatives", { businessName: "GetTrafficFast", comparison: true }).join(" ")).toContain(
      "introduction"
    );
    expect(productMentionProblems(body, "jasper alternatives", { businessName: "GetTrafficFast" }).join(" ")).toContain(
      "outside the closing section"
    );
  });
});

describe("20261115100000_keyword_intent.sql", () => {
  const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/20261115100000_keyword_intent.sql"), "utf8");

  it("adds one nullable column with the four values, and drops nothing", () => {
    expect(sql).toContain("add column if not exists intent text");
    expect(sql).toContain("intent is null or intent in ('comparison', 'platform_howto', 'problem', 'product_adjacent')");
    expect(sql).not.toMatch(/\bdrop\b/i);
    expect(sql).not.toMatch(/\bpolicy\b/i);
  });
});
