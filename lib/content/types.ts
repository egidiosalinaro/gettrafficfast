/**
 * The content platform's shared vocabulary.
 *
 * Everything an LLM produces converges on ONE internal representation — the
 * Canonical Article — before it can reach any destination. Publisher adapters
 * consume only this type; they never see Markdown, raw model output, parsers,
 * or sanitisation concerns.
 */

/**
 * Version of the Canonical Article contract.
 * Bump when the shape changes in a way stored documents must be migrated for.
 */
export const CANONICAL_SCHEMA_VERSION = 1;

export interface CanonicalHeading {
  level: 2 | 3;
  /** Stable anchor id, unique within the document. */
  id: string;
  /** Plain text of the heading. */
  text: string;
}

/** An image the platform generated and stored for this article. */
export interface CanonicalImage {
  /** Stable public URL on the platform's own storage — never a provider CDN. */
  url: string;
  alt: string;
  caption: string | null;
  /** Heading id whose section this image sits in; null for the hero. */
  slot: string | null;
  /**
   * The stored file's size in pixels, written by the enrichment step so a
   * page can reserve the image's box. Absent or null on images stored before
   * sizes were recorded: readers emit no size then, never a guessed one.
   */
  width?: number | null;
  height?: number | null;
}

/**
 * Media the enrichment step meant to add and did not, in the platform's own
 * words (the vendor's are never stored here). Written by
 * `lib/media/skips.ts`; the shape is repeated here because this layer does
 * not import the media one.
 */
export interface CanonicalMediaSkip {
  media: "images" | "videos";
  /**
   * Why: the account cannot pay, held by the pause that started, no provider
   * set up, the provider failed, the scene could not be made concrete, or
   * the person has not chosen an image style yet (no_style).
   * The same codes as `MediaSkipReason` (lib/media/skips.ts).
   */
  reason: "billing" | "paused" | "not_configured" | "provider_error" | "brief_rejected" | "no_style";
  count: number;
  /** A sentence for the owner. */
  message: string;
}

/** A video selected (not generated) for this article. */
export interface CanonicalVideo {
  provider: "youtube";
  videoId: string;
  url: string;
  embedUrl: string;
  title: string;
  thumbnailUrl: string;
  /** Heading id whose section this video belongs to. */
  slot: string;
}

/**
 * Media enrichment. Inline images are ALSO embedded in `bodyHtml` as
 * `<figure>` elements (they are first-class content); the hero never is — it
 * travels only here, because destinations render heroes their own way. Videos
 * are never embedded in `bodyHtml`: embed mechanics are destination-specific,
 * so adapters and receivers render them from this structure.
 */
export interface CanonicalMedia {
  hero: CanonicalImage | null;
  images: CanonicalImage[];
  videos: CanonicalVideo[];
  /** What was skipped and why; absent when nothing was. */
  skipped?: CanonicalMediaSkip[];
}

/**
 * The single internal representation of an article.
 *
 * Invariants (enforced by the pipeline, asserted by the quality gates):
 *  - `bodyHtml` is sanitised, well-formed HTML restricted to a semantic tag
 *    allowlist, and contains NO <h1> (the title travels as its own field).
 *  - every h2/h3 in `bodyHtml` carries an id, and `headings` mirrors them
 *    in document order.
 *  - `title`, `excerpt` and `metaDescription` are plain text (no markup).
 */
export interface CanonicalArticle {
  schemaVersion: number;
  /** GetTrafficFast's stable article id — lets destinations upsert idempotently. */
  articleId: string;
  title: string;
  bodyHtml: string;
  headings: CanonicalHeading[];
  excerpt: string;
  /**
   * The description for search results and social cards. Built from the
   * first paragraph at canonicalisation; replaced by the audit's own once
   * the audit has run.
   */
  metaDescription: string;
  /**
   * The title for the `<title>` tag and search results, written by the audit
   * (at most 70 characters, keyword included). Absent until the audit has
   * run and on documents stored before 2026-11-10: readers fall back to
   * `title`.
   */
  metaTitle?: string;
  wordCount: number;
  slug: string;
  keyword: string;
  language: string;
  scheduledDate: string | null;
  /** Present once the enrichment step has run; absent on older documents. */
  media?: CanonicalMedia;
}

// ── Pipeline diagnostics ────────────────────────────────────────────────────

export type StageName =
  | "validate"
  | "extract"
  | "normalize"
  | "sanitize"
  | "canonicalize"
  | "quality";

/**
 * What a failed check means for the article.
 *  - `regenerate`: the generation itself is unusable — retry it (and let the
 *    existing attempt/dead-letter logic take over after MAX_ATTEMPTS).
 *  - `review`: we have a plausible article, but something is off enough that a
 *    human must look before it reaches a customer's site. NEVER auto-published.
 *  - `warn`: recorded for observability, does not block publishing.
 *
 * Ordered by severity: a document's decision is the worst outcome it triggers.
 */
export type IssueAction = "warn" | "review" | "regenerate";

export const ISSUE_ACTION_RANK: Record<IssueAction, number> = {
  warn: 0,
  review: 1,
  regenerate: 2,
};

/** Stable machine-readable identifiers — safe to alert or report on. */
export const IssueCode = {
  EMPTY_OUTPUT: "EMPTY_OUTPUT",
  OUTPUT_TOO_SHORT: "OUTPUT_TOO_SHORT",
  NO_DOCUMENT_START: "NO_DOCUMENT_START",
  PROMPT_LEAKAGE: "PROMPT_LEAKAGE",
  CHAIN_OF_THOUGHT: "CHAIN_OF_THOUGHT",
  MARKDOWN_RESIDUE: "MARKDOWN_RESIDUE",
  MISSING_TITLE: "MISSING_TITLE",
  TITLE_TOO_LONG: "TITLE_TOO_LONG",
  EMPTY_BODY: "EMPTY_BODY",
  ARTICLE_TOO_SHORT: "ARTICLE_TOO_SHORT",
  INSUFFICIENT_SECTIONS: "INSUFFICIENT_SECTIONS",
  HEADING_ANCHOR_MISMATCH: "HEADING_ANCHOR_MISMATCH",
  DUPLICATE_H1: "DUPLICATE_H1",
  MISSING_EXCERPT: "MISSING_EXCERPT",
  UNSAFE_MARKUP_REMOVED: "UNSAFE_MARKUP_REMOVED",
  // Editorial checks (2026-11-10). Each one sends the draft to the revision
  // pass; only an unsupported figure, a figure from About you or a
  // look-alike link also blocks
  // publication when the revision does not remove it.
  STOCK_PHRASE: "STOCK_PHRASE",
  TITLE_STYLE: "TITLE_STYLE",
  TITLE_UNDELIVERED: "TITLE_UNDELIVERED",
  LOOKALIKE_LINK: "LOOKALIKE_LINK",
  UNSUPPORTED_NUMBER: "UNSUPPORTED_NUMBER",
  ARTICLE_TOO_LONG: "ARTICLE_TOO_LONG",
  HEADING_BLOAT: "HEADING_BLOAT",
  THIN_FAQ: "THIN_FAQ",
  PRODUCT_MENTION: "PRODUCT_MENTION",
  // 2026-11-12: a figure from About you, which articles may not state.
  PRIVATE_FACT: "PRIVATE_FACT",
  // 2026-11-15, the article's anatomy (lib/content/anatomy.ts): the answer
  // first, headings that are questions, and a data section only with data.
  SHORT_VERSION: "SHORT_VERSION",
  QUESTION_HEADINGS: "QUESTION_HEADINGS",
  DATA_SECTION: "DATA_SECTION",
} as const;

/**
 * Issues a rewrite can fix, because they are about what the article says and
 * not about whether the output is a document. Finding one sends the draft to
 * the revision pass (once), whatever its action.
 */
export const REVISABLE_ISSUES: ReadonlySet<string> = new Set([
  "STOCK_PHRASE",
  "TITLE_STYLE",
  "TITLE_UNDELIVERED",
  "LOOKALIKE_LINK",
  "UNSUPPORTED_NUMBER",
  "ARTICLE_TOO_LONG",
  "HEADING_BLOAT",
  "THIN_FAQ",
  "PRODUCT_MENTION",
  "PRIVATE_FACT",
  "SHORT_VERSION",
  "QUESTION_HEADINGS",
  "DATA_SECTION",
]);

export type IssueCodeValue = (typeof IssueCode)[keyof typeof IssueCode];

export interface PipelineIssue {
  code: IssueCodeValue;
  stage: StageName;
  action: IssueAction;
  message: string;
  /** Short, loggable evidence — never the whole document. */
  evidence?: string;
}

export type PipelineDecision = "publish" | "needs_review" | "regenerate";

/** One recorded step of the run: what a stage received and produced. */
export interface StageSnapshot {
  stage: StageName;
  inputLength: number;
  outputLength: number;
  durationMs: number;
  issues: PipelineIssue[];
  /** Populated only when verbose tracing is on (development). */
  output?: string;
}

export interface PipelineResult {
  decision: PipelineDecision;
  /** Present unless the run failed before canonicalisation. */
  article: CanonicalArticle | null;
  issues: PipelineIssue[];
  trace: StageSnapshot[];
  /** Raw model output, exactly as received. */
  raw: string;
}

export function worstAction(issues: PipelineIssue[]): IssueAction {
  return issues.reduce<IssueAction>(
    (worst, i) =>
      ISSUE_ACTION_RANK[i.action] > ISSUE_ACTION_RANK[worst] ? i.action : worst,
    "warn"
  );
}

export function decisionFor(issues: PipelineIssue[]): PipelineDecision {
  switch (worstAction(issues)) {
    case "regenerate":
      return "regenerate";
    case "review":
      return "needs_review";
    default:
      return "publish";
  }
}
