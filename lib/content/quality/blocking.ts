import { figuresIn } from "./claims";

/**
 * What may hold an article before publishing, and what may not. One place,
 * read by the production workflow's `settle`, by `resettle_article`, and by
 * the audit agent's schema (the categories it tags a finding with).
 *
 * Until 12 November 2026 every audit finding the model called "critical"
 * held the article. On that day "AI SEO Content Writer: A Workflow From
 * Draft to Clicks" was held by a single E-E-A-T opinion ("the central
 * figures are presented without a Search Console export"), about figures
 * that were the owner's own, which no revision could fix without inventing
 * a source. An opinion about structure, intent or authority is a reason to
 * revise, never a reason to keep an article off the site. So:
 *
 *  - the deterministic gates that are "review" grade still hold (a figure
 *    with no source, a figure from About you, a look-alike link, and the
 *    structural checks: leaked prompt, Markdown residue, a missing excerpt…);
 *  - an audit finding holds only when it is critical AND its category is in
 *    `BLOCKING_AUDIT_CATEGORIES`: objective problems a reader would be
 *    misled or harmed by. Every other critical drives the one revision and
 *    is stored, but never holds the article.
 *
 * Pure: no I/O, no model.
 */

/** How the audit classifies a finding. `first_hand` is set by code, never by the model. */
export const AUDIT_CATEGORIES = [
  "invented_fact",
  "wrong_link",
  "factual_error",
  "unsafe",
  "editorial",
  "first_hand",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * The allowlist: the only audit categories a critical finding may hold an
 * article for. Each is checkable against something outside the model's
 * taste: the evidence, the owner's Facts for articles, the site's real
 * address, or plain safety.
 */
export const BLOCKING_AUDIT_CATEGORIES: ReadonlySet<AuditCategory> = new Set<AuditCategory>([
  "invented_fact",
  "wrong_link",
  "factual_error",
  "unsafe",
]);

/** How a category reads in a reason a person sees. */
export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  invented_fact: "an invented fact or figure",
  wrong_link: "a wrong or broken link",
  factual_error: "a factual error",
  unsafe: "unsafe content",
  editorial: "an editorial weakness",
  first_hand: "the author's own figures",
};

export interface GateIssueLike {
  code: string;
  action: string;
  message: string;
}

export interface AuditFindingLike {
  area: string;
  severity: "info" | "warning" | "critical";
  message: string;
  /** Absent on findings stored before 2026-11-12: read as `editorial`. */
  category?: AuditCategory;
}

/** One reason an article is held, as stored in `quality_report.blocking` and shown on the calendar. */
export interface BlockingReason {
  source: "gate" | "audit";
  /** The gate's issue code, or `audit:<category>`. */
  code: string;
  /** A plain sentence, the same one the API and the screen show. */
  message: string;
}

export function categoryOf(finding: AuditFindingLike): AuditCategory {
  return finding.category ?? "editorial";
}

export function isBlockingFinding(finding: AuditFindingLike): boolean {
  return finding.severity === "critical" && BLOCKING_AUDIT_CATEGORIES.has(categoryOf(finding));
}

/** What keeps a draft from publishing on its own. Empty means it may publish. */
export function blockingReasons(draft: { issues: GateIssueLike[]; findings: AuditFindingLike[] }): BlockingReason[] {
  return [
    ...draft.issues
      .filter((issue) => issue.action === "review")
      .map((issue) => ({ source: "gate" as const, code: issue.code, message: issue.message })),
    ...draft.findings.filter(isBlockingFinding).map((finding) => ({
      source: "audit" as const,
      code: `audit:${categoryOf(finding)}`,
      message: `The audit found ${AUDIT_CATEGORY_LABEL[categoryOf(finding)]}: ${finding.message}`,
    })),
  ];
}

// ── The author's own figures ────────────────────────────────────────────────

/** Categories a model uses for "this figure has no source": the ones a first-hand figure is cleared of. */
const UNSOURCED: ReadonlySet<AuditCategory> = new Set<AuditCategory>(["invented_fact", "editorial"]);

function isYear(value: string): boolean {
  return /^(?:19|20)\d{2}$/.test(value);
}

/**
 * A finding about figures that are all the author's own (Facts for
 * articles) is not a problem: the author is the source. It becomes an
 * `info` suggestion to state whose figures they are and when, in the
 * sentence. Deterministic, so it holds whatever the model decided: the
 * audit is told the same thing, and this is the part that does not depend
 * on being obeyed.
 *
 * Only a finding that names figures, every one of which (years and 0
 * aside, at least one left) is in the facts, and only of a category that
 * means "unsourced". A finding that the article contradicts the facts is a
 * `factual_error` and is left alone.
 */
export function clearFirstHandFindings<F extends AuditFindingLike>(findings: F[], firstHandFacts: string): F[] {
  const facts = firstHandFacts.trim();
  if (!facts) return findings;
  const own = figuresIn(facts);
  return findings.map((finding) => {
    if (finding.severity === "info" || !UNSOURCED.has(categoryOf(finding))) return finding;
    const named = [...figuresIn(finding.message)].filter((value) => !isYear(value) && value !== "0");
    if (named.length === 0 || !named.every((value) => own.has(value))) return finding;
    return {
      ...finding,
      severity: "info",
      category: "first_hand",
      message: `First-hand, from the author: ${named.join(", ")} ${named.length === 1 ? "is" : "are"} the author's own ${named.length === 1 ? "figure" : "figures"} (Facts for articles), so this is not a problem. To let a reader see whose ${named.length === 1 ? "it is" : "they are"}, state the source and the period in the sentence, e.g. "in my own Search Console, Sep–Nov 2026". The audit said: ${finding.message}`,
    };
  });
}

// ── Keeping the better draft ────────────────────────────────────────────────

/** What a draft is judged on, before and after the revision. */
export interface DraftStanding {
  blocking: number;
  critical: number;
  gateIssues: number;
  aeoScore: number | null;
}

export interface DraftChoice {
  keep: "original" | "revision";
  reason: string;
}

/**
 * The revision is kept only when it is better: fewer blocking problems
 * first, then fewer critical findings, then fewer gate issues, then a
 * higher audit score. The first measure that differs decides; a tie on all
 * of them keeps the original, because a rewrite that changes nothing
 * measurable is not worth the risk of what it changed. An unknown score
 * (an audit that could not run) does not count either way.
 *
 * Until 12 November 2026 the revision was kept unless it had MORE blocking
 * problems, so a rewrite that took the audit score from 62 to 52 and added
 * a product-mention warning was kept.
 */
export function chooseDraft(original: DraftStanding, revision: DraftStanding): DraftChoice {
  const fewer: [keyof DraftStanding, string][] = [
    ["blocking", "blocking problems"],
    ["critical", "critical audit findings"],
    ["gateIssues", "gate issues"],
  ];
  for (const [key, label] of fewer) {
    const before = original[key] as number;
    const after = revision[key] as number;
    if (after < before) return { keep: "revision", reason: `the revision has fewer ${label} (${after}, against ${before})` };
    if (after > before) return { keep: "original", reason: `the revision has more ${label} (${after}, against ${before}); the original is kept` };
  }
  if (original.aeoScore !== null && revision.aeoScore !== null && original.aeoScore !== revision.aeoScore) {
    return revision.aeoScore > original.aeoScore
      ? { keep: "revision", reason: `the revision scores higher on the audit (${revision.aeoScore}, against ${original.aeoScore})` }
      : { keep: "original", reason: `the revision scores lower on the audit (${revision.aeoScore}, against ${original.aeoScore}); the original is kept` };
  }
  return { keep: "original", reason: "the revision is no better on any measure; the original is kept" };
}
