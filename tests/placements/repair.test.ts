import { describe, expect, it } from "vitest";
import { auditDraft, campaignMention, type AuditContext } from "@/lib/placements/audit";
import { repairDraft } from "@/lib/placements/repair";

/**
 * The draft in the inbox that could not be copied: the voice line pasted
 * in, and "truly". After the repair the same gate passes it. The repair
 * deletes the line and puts nothing in its place: it used to swap in "X is
 * what I use for that", which is the line all 21 published replies carried.
 */

const SCREEN = `Before picking an automation tool, focus on real-world testing. Run a month's worth of content through it to see the actual output quality. You also need to check how it integrates with your publishing workflow. I publish my own site's blog through GetTrafficFast (https://gettrafficfa.st/), so I know how important that final step is. A great tool that adds more manual steps isn't truly automating anything.`;

const NAMES = ["GetTrafficFast"];

const ctx: AuditContext = {
  thread: {
    surface: "linkedin",
    kind: "post",
    title: "Best tools for automating content creation and SEO",
    excerpt: "The best tools for automating content creation and SEO are ChatGPT, Jasper AI, Writesonic, Surfer SEO, Semrush, Ahrefs, Frase, and MarketMuse.",
  },
  business: { name: "GetTrafficFast", domains: ["gettrafficfa.st"], brandNames: [] },
  angle: "Check how a tool publishes, not only how it writes.",
  expertise: ["content", "publishing", "seo", "automation"],
  writer: { aboutYou: "I publish my own site's blog through GetTrafficFast." },
};

describe("repairDraft", () => {
  it("turns the blocked draft from the inbox into one the gate passes, with no name and no link left", () => {
    const before = auditDraft(
      { variant: "short_comment", body: SCREEN, linkUrl: "https://gettrafficfa.st/", claims: [] },
      ctx
    );
    expect(before.status).toBe("blocked");

    const body = repairDraft(SCREEN, NAMES);
    expect(body).not.toMatch(/publish my own site's blog through/i);
    expect(body).not.toMatch(/\btruly\b/i);
    expect(body).not.toContain("GetTrafficFast");
    expect(body).not.toContain("https://");
    expect(body).toContain("Run a month's worth of content through it");

    const after = auditDraft({ variant: "short_comment", body, linkUrl: null, claims: [] }, ctx);
    expect(after.checks.filter((check) => check.status === "fail").map((check) => `${check.id}: ${check.detail}`)).toEqual([]);
    expect(after.status).toBe("passed");
  });

  it("never puts a mention back: the repaired text carries none of the refused lines", () => {
    for (const line of [
      "GetTrafficFast (https://gettrafficfa.st/) is what I use for that.",
      "I use GetTrafficFast (https://gettrafficfa.st/) for my own site's blog publishing.",
      "That's the part I have [GetTrafficFast](https://gettrafficfa.st/) doing for my own site.",
      "I handle my own site's blog publishing with GetTrafficFast (https://gettrafficfa.st/) to keep things consistent.",
    ]) {
      const body = repairDraft(`Test a month of posts before you pay. ${line} Then look at what you still edit by hand.`, NAMES);
      expect(body, line).toBe("Test a month of posts before you pay. Then look at what you still edit by hand.");
      expect(campaignMention(body, NAMES), line).toBeNull();
    }
  });

  it("leaves a text with nothing to repair exactly as it was, paragraphs included", () => {
    const fine = "Test a month of posts before you pay.\n\nThen look at what you still edit by hand, and whether a spreadsheet would do.";
    expect(repairDraft(fine, NAMES)).toBe(fine);
  });

  it("keeps the paragraphs of an article when it deletes a line from one", () => {
    const article = "Why your posts stall\n\nPublish on a fixed day. GetTrafficFast is what I use for that.\n\nThen measure what got cited.";
    expect(repairDraft(article, NAMES)).toBe("Why your posts stall\n\nPublish on a fixed day.\n\nThen measure what got cited.");
  });
});
