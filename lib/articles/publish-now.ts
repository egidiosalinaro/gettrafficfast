import type { SupabaseClient } from "@supabase/supabase-js";
import { IntegrationRow } from "@/lib/integrations/types";
import { holdReasons } from "@/lib/content/hold-reasons";
import { ensureCanonical, publishArticle } from "@/lib/content/service";
import { enqueueBacklinkPass } from "@/lib/jobs/workflows/backlink-article";
import { hasActiveJob } from "@/lib/jobs/queue";
import { PRODUCE_ARTICLE } from "@/lib/jobs/workflows/produce-article";

/**
 * Manual publish / republish of one article to the destination connected to
 * its own site: the logic of `POST /api/publish-now` (the calendar's
 * Publish button) and the `publish_article` tool
 * (lib/tools/articles-produce.ts). The only path, besides the daily run,
 * that writes to the customer's site.
 *
 * From `needs_review` it doubles as the human approval path: the person has
 * seen the quality report and is explicitly overriding it. The screen's
 * click is that acknowledgement; a tool has to say so,
 * `acknowledgeQualityIssues: true`, because an agent has not seen the
 * report unless it asked for it. Every other state must pass the gates on
 * its own, and an article that fails them is parked in `needs_review`
 * rather than shipped.
 *
 * The paywall is the caller's. Every query runs on the service role (the
 * delivery writes `publish_attempts`, which users have no insert policy
 * for, and toggles the integration's status), so ownership is stated in
 * each: the user, and the site when the caller names one.
 */

const PUBLISHABLE = ["generated", "published", "needs_review"];

export interface PublishIssue {
  code: string;
  message: string;
}

export type PublishRefusalCode =
  | "not_found"
  | "not_publishable"
  | "acknowledge_required"
  | "still_producing"
  | "no_site"
  | "no_destination"
  | "no_content"
  | "needs_review"
  | "delivery_failed";

export type PublishNowResult =
  | { ok: true; url: string; republished: boolean }
  | {
      ok: false;
      status: 400 | 404 | 409 | 422 | 502;
      code: PublishRefusalCode;
      /** The sentence the screen shows. */
      error: string;
      /** What the gates found, when they ran (or, for `acknowledge_required`, what they found last time). */
      issues?: PublishIssue[];
      /** `needs_review`: the article was parked there by this call. */
      parked?: boolean;
      /** `delivery_failed`: the destination's own reason. */
      deliveryError?: string;
    };

function keywordOf(row: unknown): string {
  const kw = (row as { keywords?: { keyword?: string } | { keyword?: string }[] }).keywords;
  if (Array.isArray(kw)) return kw[0]?.keyword ?? "";
  return kw?.keyword ?? "";
}

/** Why a parked article is held, as issues: the sentences the calendar shows (lib/content/hold-reasons.ts). */
function storedIssues(article: { quality_report?: unknown; last_error?: unknown }): PublishIssue[] {
  return holdReasons({ qualityReport: article.quality_report, lastError: article.last_error }).map((message) => ({
    code: "quality_check",
    message,
  }));
}

export async function publishArticleNow(params: {
  admin: SupabaseClient;
  userId: string;
  articleId: string;
  /**
   * The site the caller acts on. The tool passes it, so an article of
   * another of the user's sites is not found; the route has always looked
   * the article up by its owner alone, and publishes it to its own site's
   * destination either way.
   */
  businessId?: string | null;
  /** Publishing from `needs_review` overrides the quality report: true says the caller saw it. */
  acknowledgeQualityIssues: boolean;
}): Promise<PublishNowResult> {
  const { admin, userId, articleId } = params;

  let lookup = admin
    .from("articles")
    .select(
      `id, keyword_id, business_id, content, canonical, status, scheduled_date, last_error, quality_report,
       keywords!articles_keyword_id_fkey ( keyword )`
    )
    .eq("id", articleId)
    .eq("user_id", userId);
  if (params.businessId) lookup = lookup.eq("business_id", params.businessId);
  const { data: article } = await lookup.maybeSingle();

  if (!article) return { ok: false, status: 404, code: "not_found", error: "Article not found" };
  if (!PUBLISHABLE.includes(article.status)) {
    return {
      ok: false,
      status: 409,
      code: "not_publishable",
      error: "Article must be generated before it can be published",
    };
  }

  if (article.status === "needs_review" && !params.acknowledgeQualityIssues) {
    return {
      ok: false,
      status: 409,
      code: "acknowledge_required",
      error:
        "This article did not pass the quality checks and is waiting for review. Publishing it anyway overrides them, and needs that said explicitly.",
      issues: storedIssues(article),
    };
  }

  // The production job may still be enriching (media arrives after the
  // article turns `generated`). Publishing now would ship it without the
  // media it is about to get.
  if (await hasActiveJob(admin, articleId, PRODUCE_ARTICLE)) {
    return {
      ok: false,
      status: 409,
      code: "still_producing",
      error: "This article is still being produced. Try again in a minute.",
    };
  }

  // The destination is the one connected to the article's own site. Falling
  // back to "any destination this account has" would publish one business's
  // article to another business's website.
  if (!article.business_id) {
    return {
      ok: false,
      status: 409,
      code: "no_site",
      error: "This article is not attached to a site. Open Settings → Business.",
    };
  }

  const { data: integrationRows } = await admin
    .from("integrations")
    .select("id, user_id, business_id, type, config, status, last_error, last_sync_at, created_at, updated_at")
    .eq("business_id", article.business_id)
    // The service-role client bypasses RLS, so ownership is stated here: a
    // row someone else attached to this business id is never a destination.
    .eq("user_id", userId)
    .in("status", ["connected", "error"])
    .order("created_at", { ascending: true })
    .limit(1);

  const integration = (integrationRows?.[0] ?? null) as IntegrationRow | null;
  if (!integration) {
    return {
      ok: false,
      status: 400,
      code: "no_destination",
      error: "No integration connected. Connect a destination first.",
    };
  }

  const canonical = await ensureCanonical({
    supabase: admin,
    article: {
      id: article.id,
      keyword_id: article.keyword_id,
      content: article.content,
      canonical: article.canonical,
      scheduled_date: article.scheduled_date,
      status: article.status,
    },
    keyword: keywordOf(article),
  });

  if (!canonical.article) {
    return {
      ok: false,
      status: 422,
      code: "no_content",
      error: "This article has no valid content to publish. Regenerate it before trying again.",
      issues: canonical.issues.map((i) => ({ code: i.code, message: i.message })),
    };
  }

  // Gates failed and nobody has acknowledged them: park it for review rather
  // than shipping it. Publishing from `needs_review` is the acknowledgement.
  if (canonical.decision !== "publish" && article.status !== "needs_review") {
    const blocking = canonical.issues.filter((i) => i.action !== "warn");
    await admin
      .from("articles")
      .update({
        status: "needs_review",
        last_error: blocking
          .map((i) => i.message)
          .join(" | ")
          .slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", articleId);

    return {
      ok: false,
      status: 409,
      code: "needs_review",
      error: "This article did not pass the quality checks and needs review.",
      parked: true,
      issues: blocking.map((i) => ({ code: i.code, message: i.message })),
    };
  }

  const republished = article.status === "published";
  const result = await publishArticle({
    supabase: admin,
    articleId,
    userId,
    businessId: article.business_id,
    keywordId: article.keyword_id,
    canonical: canonical.article,
    integration,
  });

  // Only a delivery failure belongs in Integrations. Every bail-out above
  // (still producing, failed gates, no content) has its own reason, and
  // pointing those at Integrations sends the person to a page with nothing
  // wrong on it.
  if (!result.ok) {
    return {
      ok: false,
      status: 502,
      code: "delivery_failed",
      error: `Your site rejected the article: ${result.error}`,
      deliveryError: result.error,
    };
  }

  // A first publication: older related articles get a link to this one
  // (docs/KNOWLEDGE.md). Queued, once per article; a republish queues nothing.
  if (!republished) {
    await enqueueBacklinkPass({ supabase: admin, userId, businessId: article.business_id, articleId });
  }

  return { ok: true, url: result.url, republished };
}
