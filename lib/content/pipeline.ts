import {
  CanonicalArticle,
  PipelineIssue,
  PipelineResult,
  StageName,
  StageSnapshot,
  decisionFor,
} from "./types";
import { validateRawOutput } from "./stages/validate";
import { extractDocument } from "./stages/extract";
import { normalizeToHtml } from "./stages/normalize";
import { sanitizeHtml } from "./stages/sanitize";
import { canonicalize } from "./stages/canonicalize";
import { runQualityGates } from "./quality/gates";
import type { GateContext } from "./quality/claims";
import { isVerboseTracing } from "./trace";

/**
 * The content pipeline.
 *
 *   Raw model output
 *     → Validation    (is there anything to work with?)
 *     → Extraction    (isolate the article from its envelope)
 *     → Normalization (any format → HTML, via a real parser)
 *     → Sanitization  (tree-level allowlist)
 *     → Canonicalization (→ Canonical Article)
 *     → Quality gates (publish / needs review / regenerate)
 *
 * Every stage is a pure function of its input, so the same model output always
 * yields the same decision, and each stage can be tested in isolation.
 *
 * Nothing downstream — no publisher, no adapter, no UI — is allowed to see the
 * raw output: the Canonical Article is the only currency past this point.
 */

export interface ContentPipelineInput {
  raw: string;
  articleId: string;
  keyword: string;
  slug: string;
  language: string;
  scheduledDate?: string | null;
  /**
   * What the editorial gates check the article against: the business's name
   * and real site, its own facts, the research evidence. Absent, those gates
   * that need it check nothing.
   */
  gateContext?: GateContext;
  /** Capture full stage outputs in the trace. Defaults to on outside production. */
  verbose?: boolean;
}

export function runContentPipeline(input: ContentPipelineInput): PipelineResult {
  const verbose = input.verbose ?? isVerboseTracing();
  const trace: StageSnapshot[] = [];
  const issues: PipelineIssue[] = [];

  const record = <T>(
    stage: StageName,
    inputValue: string,
    run: () => { output: string; issues: PipelineIssue[]; value?: T }
  ): { output: string; value?: T } => {
    const startedAt = Date.now();
    const result = run();
    trace.push({
      stage,
      inputLength: inputValue.length,
      outputLength: result.output.length,
      durationMs: Date.now() - startedAt,
      issues: result.issues,
      ...(verbose ? { output: result.output } : {}),
    });
    issues.push(...result.issues);
    return { output: result.output, value: result.value };
  };

  const raw = input.raw ?? "";

  // 1 — Validation
  const validated = record("validate", raw, () => {
    const r = validateRawOutput(raw);
    return { output: r.text, issues: r.issues };
  });

  if (!validated.output) {
    return { decision: "regenerate", article: null, issues, trace, raw };
  }

  // 2 — Extraction
  const extracted = record("extract", validated.output, () => {
    const r = extractDocument(validated.output);
    return { output: r.text, issues: r.issues };
  });

  // 3 — Normalization
  const normalized = record("normalize", extracted.output, () => {
    const r = normalizeToHtml(extracted.output);
    return { output: r.html, issues: r.issues };
  });

  // 4 — Sanitization
  const sanitized = record("sanitize", normalized.output, () => {
    const r = sanitizeHtml(normalized.output);
    return { output: r.html, issues: r.issues };
  });

  // 5 — Canonicalization
  let article: CanonicalArticle | null = null;
  record<CanonicalArticle>("canonicalize", sanitized.output, () => {
    const r = canonicalize(sanitized.output, {
      articleId: input.articleId,
      keyword: input.keyword,
      slug: input.slug,
      language: input.language,
      scheduledDate: input.scheduledDate ?? null,
    });
    article = r.article;
    return { output: r.article.bodyHtml, issues: r.issues, value: r.article };
  });

  // 6 — Quality gates
  if (article) {
    const gateIssues = runQualityGates(article, input.gateContext);
    trace.push({
      stage: "quality",
      inputLength: (article as CanonicalArticle).bodyHtml.length,
      outputLength: (article as CanonicalArticle).bodyHtml.length,
      durationMs: 0,
      issues: gateIssues,
    });
    issues.push(...gateIssues);
  }

  return { decision: decisionFor(issues), article, issues, trace, raw };
}

/** Compact, storable summary of a run (persisted on the article row). */
export interface QualityReport {
  decision: PipelineResult["decision"];
  ranAt: string;
  wordCount: number | null;
  issues: {
    code: string;
    action: string;
    stage: string;
    message: string;
    evidence?: string;
  }[];
  stages: { stage: string; inputLength: number; outputLength: number; durationMs: number }[];
  /**
   * Why the article is held, written by the production workflow's `settle`
   * (and `resettle_article`) since 2026-11-12; empty when it may publish.
   * Absent on older reports. Read through `holdReasons`
   * (lib/content/hold-reasons.ts).
   */
  blocking?: { source: "gate" | "audit"; code: string; message: string }[];
}

export function buildQualityReport(
  result: PipelineResult,
  now: string = new Date().toISOString()
): QualityReport {
  return {
    decision: result.decision,
    ranAt: now,
    wordCount: result.article?.wordCount ?? null,
    issues: result.issues.map((i) => ({
      code: i.code,
      action: i.action,
      stage: i.stage,
      message: i.message,
      ...(i.evidence ? { evidence: i.evidence.slice(0, 300) } : {}),
    })),
    stages: result.trace.map((s) => ({
      stage: s.stage,
      inputLength: s.inputLength,
      outputLength: s.outputLength,
      durationMs: s.durationMs,
    })),
  };
}
