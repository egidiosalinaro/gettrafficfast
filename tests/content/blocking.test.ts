import { describe, expect, it } from "vitest";
import {
  BLOCKING_AUDIT_CATEGORIES,
  blockingReasons,
  chooseDraft,
  clearFirstHandFindings,
  isBlockingFinding,
} from "@/lib/content/quality/blocking";
import { holdReasons, REASON_NOT_RECORDED } from "@/lib/content/hold-reasons";
import { HELD_FINDING, HELD_LAST_ERROR, HELD_QUALITY_REPORT } from "../fixtures/held-article-2026-11-12";

/**
 * What may hold an article (2026-11-12), against the article production
 * held that day: one critical E-E-A-T opinion about the owner's own figures,
 * a revision that scored 52 against 62 and was kept, and a modal that said
 * "these quality checks failed" over an empty list.
 */

const FACTS =
  "In my own Search Console, from September to November 2026, my blog went from 9 to 342 weekly impressions, with 0 clicks, at positions 30 to 40.";

describe("the allowlist", () => {
  it("is four objective categories, and nothing editorial", () => {
    expect([...BLOCKING_AUDIT_CATEGORIES].sort()).toEqual(["factual_error", "invented_fact", "unsafe", "wrong_link"]);
  });

  it("holds the article only for a critical finding in it", () => {
    expect(isBlockingFinding({ ...HELD_FINDING, category: "invented_fact" })).toBe(true);
    expect(isBlockingFinding({ ...HELD_FINDING, category: "editorial" })).toBe(false);
    expect(isBlockingFinding({ ...HELD_FINDING, severity: "warning", category: "invented_fact" })).toBe(false);
    // Stored before the categories existed: editorial.
    expect(isBlockingFinding(HELD_FINDING)).toBe(false);
  });

  it("names the category in the reason, and keeps the review-grade gates", () => {
    const reasons = blockingReasons({
      issues: [
        { code: "UNSUPPORTED_NUMBER", action: "review", message: "A figure with no source." },
        { code: "LOOKALIKE_LINK", action: "review", message: "A look-alike link." },
        { code: "PRODUCT_MENTION", action: "warn", message: "The article sells." },
      ],
      findings: [
        { area: "eeat", severity: "critical", category: "wrong_link", message: "The link to the pricing page is broken." },
        { area: "structure", severity: "critical", category: "editorial", message: "Two sections overlap." },
      ],
    });
    expect(reasons.map((r) => r.code)).toEqual(["UNSUPPORTED_NUMBER", "LOOKALIKE_LINK", "audit:wrong_link"]);
    expect(reasons[2].message).toBe("The audit found a wrong or broken link: The link to the pricing page is broken.");
  });

  it("would not have held the article of 2026-11-12", () => {
    expect(blockingReasons({ issues: HELD_QUALITY_REPORT.issues, findings: HELD_QUALITY_REPORT.aeo.findings })).toEqual([]);
  });
});

describe("the author's own figures", () => {
  it("turns the real finding into an info suggestion when every figure is in Facts for articles", () => {
    const [cleared] = clearFirstHandFindings([HELD_FINDING], FACTS);
    expect(cleared).toMatchObject({ severity: "info", category: "first_hand" });
    expect(cleared.message).toContain("9, 342, 30, 40 are the author's own figures");
    expect(cleared.message).toContain('"in my own Search Console, Sep–Nov 2026"');
  });

  it("leaves it alone when the facts are empty, a figure is missing, or the finding says the article contradicts them", () => {
    expect(clearFirstHandFindings([HELD_FINDING], "")).toEqual([HELD_FINDING]);
    expect(clearFirstHandFindings([HELD_FINDING], "From 9 to 342 weekly impressions.")).toEqual([HELD_FINDING]);
    const contradiction = { ...HELD_FINDING, category: "factual_error" as const };
    expect(clearFirstHandFindings([contradiction], FACTS)).toEqual([contradiction]);
    const noFigures = { area: "eeat", severity: "critical" as const, message: "The claims are vague." };
    expect(clearFirstHandFindings([noFigures], FACTS)).toEqual([noFigures]);
  });
});

describe("keeping the better draft", () => {
  it("keeps the original of 2026-11-12: same blocking and criticals, one more gate issue", () => {
    const choice = chooseDraft(
      { blocking: 0, critical: 1, gateIssues: 0, aeoScore: 58 },
      { blocking: 0, critical: 1, gateIssues: 1, aeoScore: 48 }
    );
    expect(choice).toEqual({ keep: "original", reason: "the revision has more gate issues (1, against 0); the original is kept" });
  });

  it("decides on blocking first, then criticals, then gate issues, then the score", () => {
    expect(chooseDraft({ blocking: 1, critical: 0, gateIssues: 0, aeoScore: 90 }, { blocking: 0, critical: 3, gateIssues: 5, aeoScore: 10 }).keep).toBe("revision");
    expect(chooseDraft({ blocking: 0, critical: 2, gateIssues: 0, aeoScore: 90 }, { blocking: 0, critical: 1, gateIssues: 5, aeoScore: 10 }).keep).toBe("revision");
    expect(chooseDraft({ blocking: 0, critical: 0, gateIssues: 3, aeoScore: 90 }, { blocking: 0, critical: 0, gateIssues: 1, aeoScore: 10 }).keep).toBe("revision");
    expect(chooseDraft({ blocking: 0, critical: 0, gateIssues: 1, aeoScore: 60 }, { blocking: 0, critical: 0, gateIssues: 1, aeoScore: 70 })).toEqual({
      keep: "revision",
      reason: "the revision scores higher on the audit (70, against 60)",
    });
  });

  it("keeps the original on a tie, and when a score is unknown", () => {
    const same = { blocking: 0, critical: 1, gateIssues: 1, aeoScore: 60 };
    expect(chooseDraft(same, same).keep).toBe("original");
    expect(chooseDraft(same, { ...same, aeoScore: null }).keep).toBe("original");
  });
});

describe("why it was held", () => {
  it("was an empty list because the modal read only the gate issues, all warnings", () => {
    const old = HELD_QUALITY_REPORT.issues.filter((i) => i.action !== "warn");
    expect(old).toEqual([]);
  });

  it("reads the real row: the reason in last_error, the same sentence publish_article answers with", () => {
    expect(holdReasons({ qualityReport: HELD_QUALITY_REPORT, lastError: HELD_LAST_ERROR })).toEqual([HELD_LAST_ERROR]);
  });

  it("prefers quality_report.blocking, splits a joined last_error, and falls back to review-grade issues", () => {
    expect(
      holdReasons({
        qualityReport: { ...HELD_QUALITY_REPORT, blocking: [{ source: "gate", code: "PRIVATE_FACT", message: "A figure from About you." }] },
        lastError: HELD_LAST_ERROR,
      })
    ).toEqual(["A figure from About you."]);
    expect(holdReasons({ lastError: "One. | Two." })).toEqual(["One.", "Two."]);
    expect(
      holdReasons({ qualityReport: { issues: [{ code: "MARKDOWN_RESIDUE", action: "review", message: "Markdown left." }, HELD_QUALITY_REPORT.issues[0]] } })
    ).toEqual(["Markdown left."]);
  });

  it("is empty when nothing was recorded, and the screen says so", () => {
    expect(holdReasons({ qualityReport: HELD_QUALITY_REPORT, lastError: null })).toEqual([]);
    expect(holdReasons({})).toEqual([]);
    expect(REASON_NOT_RECORDED).toBe("The reason was not recorded.");
  });
});
