import { PipelineResult } from "./types";

/**
 * Observability for the content platform.
 *
 * One article's journey is: model output → normalized → canonical → publisher
 * payload → provider response. Each hop is logged with the same correlation id,
 * so a bad publication can be traced end to end without reproducing it.
 *
 * Outside production the logs carry real snippets of the content; in production
 * they carry only shapes (lengths, codes, decisions) — enough to diagnose,
 * never enough to leak an article or a credential into a log drain.
 */

const SNIPPET = 600;

export function isVerboseTracing(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.CONTENT_TRACE === "1";
}

function emit(level: "info" | "warn" | "error", payload: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...payload });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface TraceContext {
  articleId: string;
  keyword?: string;
  jobId?: string;
}

/** Stage-by-stage record of one pipeline run. */
export function logPipelineRun(ctx: TraceContext, result: PipelineResult): void {
  const verbose = isVerboseTracing();
  const level =
    result.decision === "regenerate" ? "error" : result.decision === "needs_review" ? "warn" : "info";

  emit(level, {
    event: "content.pipeline",
    article_id: ctx.articleId,
    job_id: ctx.jobId,
    keyword: ctx.keyword,
    decision: result.decision,
    word_count: result.article?.wordCount ?? null,
    issues: result.issues.map((i) => `${i.code}:${i.action}`),
    stages: result.trace.map((s) => ({
      stage: s.stage,
      in: s.inputLength,
      out: s.outputLength,
      ms: s.durationMs,
    })),
    ...(verbose
      ? {
          detail: {
            raw: result.raw.slice(0, SNIPPET),
            normalized:
              result.trace.find((s) => s.stage === "normalize")?.output?.slice(0, SNIPPET) ?? null,
            canonical_title: result.article?.title ?? null,
            canonical_body: result.article?.bodyHtml.slice(0, SNIPPET) ?? null,
            issue_details: result.issues.map((i) => ({
              code: i.code,
              message: i.message,
              evidence: i.evidence,
            })),
          },
        }
      : {}),
  });
}

/** What a publisher adapter actually sent, and what came back. */
export function logDelivery(
  ctx: TraceContext,
  info: {
    adapter: string;
    ok: boolean;
    url?: string | null;
    error?: string | null;
    payload?: unknown;
    response?: unknown;
  }
): void {
  const verbose = isVerboseTracing();
  emit(info.ok ? "info" : "warn", {
    event: "content.delivery",
    article_id: ctx.articleId,
    job_id: ctx.jobId,
    adapter: info.adapter,
    ok: info.ok,
    url: info.url ?? null,
    error: info.error ?? null,
    ...(verbose
      ? {
          detail: {
            payload: truncateDeep(info.payload),
            response: truncateDeep(info.response),
          },
        }
      : {}),
  });
}

/** Shrinks long strings inside a payload so a log line stays readable. */
export function truncateDeep(value: unknown, max = SNIPPET): unknown {
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}…(+${value.length - max})` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => truncateDeep(v, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateDeep(v, max)])
    );
  }
  return value;
}
