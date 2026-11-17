import type { SupabaseClient } from "@supabase/supabase-js";
import { transitionArticle } from "@/lib/domain/lifecycle";
import { holdReasons } from "@/lib/content/hold-reasons";
import {
  BlockingReason,
  blockingReasons,
  clearFirstHandFindings,
  type AuditFindingLike,
} from "@/lib/content/quality/blocking";
import { runQualityGates } from "@/lib/content/quality/gates";
import type { QualityReport } from "@/lib/content/pipeline";
import type { CanonicalArticle } from "@/lib/content/types";
import { hasActiveJob } from "@/lib/jobs/queue";
import { PRODUCE_ARTICLE, gateContextFor, researchOf } from "@/lib/jobs/workflows/produce-article";
import { parseVoiceSettings } from "@/lib/voice/settings";

/**
 * Re-settles an article waiting in `needs_review` under the rules in force
 * now, from what is stored, without calling a model: the deterministic
 * gates run again on the stored canonical document (with the owner's Facts
 * for articles, About you and the research the production job stored), the
 * stored audit findings are read again (the author's own figures cleared,
 * only the allowlisted categories blocking: lib/content/quality/blocking.ts),
 * and the blocking decision is made again.
 *
 * Free, and it publishes nothing: an article that no longer has a reason to
 * be held becomes `generated`, and the publishing tick delivers it on its
 * date like any other. One that still has a reason stays `needs_review`,
 * with the reasons brought up to date.
 *
 * Written for the article held on 2026-11-12 by an E-E-A-T opinion, so that
 * rules that changed after it was written can be applied to it without
 * paying for a Regenerate. The service role does the work (the transition
 * writes `article_events`), so ownership is stated in every read: the user
 * and the site.
 */

export type ResettleResult =
  | {
      ok: true;
      articleId: string;
      status: "generated" | "needs_review";
      changed: boolean;
      /** Why it is still held: empty when it became `generated`. */
      reasons: string[];
      /** Why it was held before this call. */
      previousReasons: string[];
      /** False when the research the article was written from could not be read back. */
      evidenceFound: boolean;
    }
  | { ok: false; status: 404 | 409; code: "not_found" | "invalid_state" | "still_producing" | "no_content"; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The production job's stored research for this article, or undefined. */
async function storedEvidence(admin: SupabaseClient, userId: string, articleId: string) {
  const { data: jobs } = await admin
    .from("jobs")
    .select("id, created_at")
    .eq("article_id", articleId)
    .eq("user_id", userId)
    .eq("type", PRODUCE_ARTICLE)
    .order("created_at", { ascending: false })
    .limit(1);
  const jobId = (jobs?.[0] as { id?: string } | undefined)?.id;
  if (!jobId) return undefined;
  const { data: step } = await admin
    .from("job_steps")
    .select("output")
    .eq("job_id", jobId)
    .eq("step", "research")
    .maybeSingle();
  return researchOf({ research: (step as { output?: unknown } | null)?.output }).evidence;
}

export async function resettleArticle(params: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  articleId: string;
  now?: Date;
}): Promise<ResettleResult> {
  const { admin, userId, businessId, articleId } = params;

  const { data: article } = await admin
    .from("articles")
    .select("id, user_id, business_id, status, canonical, quality_report, last_error")
    .eq("id", articleId)
    .eq("user_id", userId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!article) return { ok: false, status: 404, code: "not_found", error: "No article with that id on this site." };
  if (article.status !== "needs_review") {
    return {
      ok: false,
      status: 409,
      code: "invalid_state",
      error: `Only an article waiting in needs_review is re-settled; this one is ${article.status}.`,
    };
  }
  if (await hasActiveJob(admin, articleId, PRODUCE_ARTICLE)) {
    return { ok: false, status: 409, code: "still_producing", error: "This article is being produced again. Wait for that to finish." };
  }
  const canonical = article.canonical as CanonicalArticle | null;
  if (!isRecord(canonical) || typeof canonical.bodyHtml !== "string") {
    return { ok: false, status: 409, code: "no_content", error: "This article has no stored document to check. Regenerate it instead." };
  }

  const { data: business } = await admin
    .from("businesses")
    .select("name, website_url, voice_settings")
    .eq("id", businessId)
    .eq("user_id", userId)
    .maybeSingle();
  const voice = parseVoiceSettings(business?.voice_settings);
  const evidence = await storedEvidence(admin, userId, articleId);

  const issues = runQualityGates(
    canonical,
    gateContextFor(
      {
        businessName: (business?.name as string | undefined) ?? undefined,
        websiteUrl: (business?.website_url as string | undefined) ?? undefined,
        firstHandFacts: voice.articleFacts.trim(),
        privateFacts: voice.aboutYou.trim(),
      },
      evidence
    )
  );

  const report = (isRecord(article.quality_report) ? article.quality_report : {}) as Partial<QualityReport> &
    Record<string, unknown>;
  const aeo = isRecord(report.aeo) ? report.aeo : null;
  const storedFindings = (Array.isArray(aeo?.findings) ? aeo.findings : []) as AuditFindingLike[];
  const findings = clearFirstHandFindings(storedFindings, voice.articleFacts);

  const blocking: BlockingReason[] = blockingReasons({ issues, findings });
  const reasons = blocking.map((reason) => reason.message);
  const previousReasons = holdReasons({ qualityReport: report, lastError: article.last_error });
  const status = reasons.length > 0 ? "needs_review" : "generated";

  const qualityReport = {
    ...report,
    decision: status === "needs_review" ? "needs_review" : "publish",
    issues: issues.map((i) => ({
      code: i.code,
      action: i.action,
      stage: i.stage,
      message: i.message,
      ...(i.evidence ? { evidence: i.evidence.slice(0, 300) } : {}),
    })),
    ...(aeo ? { aeo: { ...aeo, findings } } : {}),
    blocking,
    resettled: {
      at: (params.now ?? new Date()).toISOString(),
      evidenceFound: Boolean(evidence),
      previousReasons,
    },
  };
  const lastError = reasons.length > 0 ? reasons.join(" | ").slice(0, 2000) : null;

  if (status === "generated") {
    await transitionArticle({
      supabase: admin,
      articleId,
      userId,
      businessId,
      from: "needs_review",
      to: "generated",
      cause: "re-settled from the stored document under the current rules: nothing holds it",
      actor: "user",
      metadata: { resettled: true, previous: previousReasons.slice(0, 5) },
      patch: { quality_report: qualityReport, last_error: null },
    });
  } else {
    await admin
      .from("articles")
      .update({ quality_report: qualityReport, last_error: lastError, updated_at: new Date().toISOString() })
      .eq("id", articleId)
      .eq("user_id", userId);
  }

  return {
    ok: true,
    articleId,
    status,
    changed: status === "generated" || lastError !== (article.last_error ?? null),
    reasons,
    previousReasons,
    evidenceFound: Boolean(evidence),
  };
}
