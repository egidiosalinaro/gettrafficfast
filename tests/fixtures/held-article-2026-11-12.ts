/**
 * A synthetic held article, "AI SEO Content Writer: A Workflow From Draft to
 * Clicks", as its row would stand: `quality_report` in the shape `settle`
 * wrote it before 12 November 2026, and `last_error`. Every figure, score
 * and text here is invented for the tests; the shape is the one the code
 * writes.
 */

export const HELD_FINDING = {
  area: "eeat",
  severity: "critical" as const,
  message:
    "The article's central figures (9 to 342 weekly impressions, 0 clicks, positions 30 to 40) are presented without a Search Console export, date range or source, so readers cannot verify them.",
};

export const HELD_PRODUCT_MENTION = {
  code: "PRODUCT_MENTION",
  action: "warn",
  stage: "quality",
  message: "The article sells: GetTrafficFast is mentioned in 2 sentences; one is the limit.",
};

export const HELD_QUALITY_REPORT = {
  decision: "needs_review",
  ranAt: "2026-11-12T06:00:00.000Z",
  wordCount: 1290,
  // The revised draft's gate run: one warning, nothing review-grade.
  issues: [HELD_PRODUCT_MENTION],
  stages: [{ stage: "quality", inputLength: 9000, outputLength: 9000, durationMs: 0 }],
  aeo: {
    score: 48,
    metaTitle: "AI SEO Content Writer: A Workflow From Draft to Clicks",
    findings: [HELD_FINDING],
    suggestedFaq: [],
    entities: [],
  },
  revision: {
    ran: true,
    model: "quality-model",
    fallback: false,
    problems: [`[eeat, critical] ${HELD_FINDING.message}`],
    before: { wordCount: 1310, issues: [], critical: 1, warnings: 0, aeoScore: 58 },
    after: { wordCount: 1290, issues: ["PRODUCT_MENTION"], critical: 1, warnings: 0, aeoScore: 48 },
  },
};

export const HELD_LAST_ERROR = `The audit found a critical problem: ${HELD_FINDING.message}`;

/** A fictional owner's About you (Sam, who runs this site and co-founded Postwren): for replies, not for the blog. */
export const OWNER_ABOUT_YOU =
  "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.";
