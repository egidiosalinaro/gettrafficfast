import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { claimDailyAlert } from "@/lib/llm-billing";
import { operatorEmailAddress, sendNotificationEmail } from "@/lib/notifications/email";
import { escapeText } from "./figures";
import { MediaSkip, needsOperator } from "./skips";

/**
 * What happens when media cannot be produced for a reason that is the
 * platform's: the image account cannot pay, no provider is set up, the
 * provider fails.
 *
 * Two things, both durable and both idempotent, on the tables the LLM
 * billing pause already uses (lib/llm-billing.ts):
 *
 *   1. a billing refusal pauses image generation for an hour: one
 *      `provider_pauses` row of kind "image". While it holds, the enrich step
 *      renders nothing and says why, instead of paying a brief and being
 *      refused on every article. Only images: the article is still written
 *      and published. When it expires the next article simply tries.
 *   2. the operator hears once per UTC day per (media, reason): one Sentry
 *      event and one email, deduped by `operator_alerts`.
 *
 * Reading the pause fails open (a pause that cannot be read is no pause),
 * and nothing here throws: media is never a reason for an article to fail.
 */

export const IMAGE_PAUSE_KIND = "image";
export const IMAGE_PAUSE_MS = 60 * 60 * 1000;

function log(level: "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event: "media_degraded", ...fields });
  if (level === "error") console.error(line);
  else console.warn(line);
}

/** The end of the current image pause, or null when images may be rendered. */
export async function imagePausedUntil(supabase: SupabaseClient, now = new Date()): Promise<Date | null> {
  try {
    const { data, error } = await supabase
      .from("provider_pauses")
      .select("paused_until")
      .eq("kind", IMAGE_PAUSE_KIND)
      .maybeSingle();
    if (error) {
      log("warn", { outcome: "pause_read_failed", error: error.message });
      return null;
    }
    const raw = (data as { paused_until?: string | null } | null)?.paused_until;
    if (!raw) return null;
    const until = new Date(raw);
    return Number.isFinite(until.getTime()) && until.getTime() > now.getTime() ? until : null;
  } catch (err) {
    log("warn", { outcome: "pause_read_failed", error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Holds image generation for an hour. Never throws. */
export async function pauseImages(
  supabase: SupabaseClient,
  input: { provider: string; detail: string },
  now = new Date()
): Promise<Date> {
  const pausedUntil = new Date(now.getTime() + IMAGE_PAUSE_MS);
  try {
    const { error } = await supabase.from("provider_pauses").upsert(
      {
        kind: IMAGE_PAUSE_KIND,
        paused_until: pausedUntil.toISOString(),
        reason: input.detail.slice(0, 2000),
        providers: [input.provider],
        updated_at: now.toISOString(),
      },
      { onConflict: "kind" }
    );
    if (error) log("error", { outcome: "pause_write_failed", error: error.message });
  } catch (err) {
    log("error", { outcome: "pause_write_failed", error: err instanceof Error ? err.message : String(err) });
  }
  return pausedUntil;
}

export interface MediaAlertContext {
  articleId: string;
  jobId?: string;
  businessId?: string | null;
}

const HEADLINES: Record<string, string> = {
  "images:billing": "Image generation refused: the image account cannot pay",
  "images:not_configured": "Image generation is not configured",
  "images:provider_error": "Image generation is failing",
  "videos:billing": "Video search refused: the account cannot pay",
  "videos:not_configured": "Video search is not configured, and businesses have videos turned on",
  "videos:provider_error": "Video search is failing",
};

/** The dedupe key of a skip: one alert a day for each. */
export function mediaAlertKey(skip: Pick<MediaSkip, "media" | "reason">): string {
  return `media:${skip.media}:${skip.reason}`;
}

function alertEmail(skip: MediaSkip, headline: string, context: MediaAlertContext) {
  return {
    subject: `[GetTrafficFast] ${headline}`,
    html: `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
    <h2 style="margin:0 0 16px">${escapeText(headline)}</h2>
    <p>Articles are being written and published <strong>without their ${skip.media}</strong>.
       Owners see a note on the article; nothing was emailed to them.</p>
    <p style="font-size:13px;color:#555">First seen on article ${escapeText(context.articleId)}.</p>
    <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;font-size:13px;color:#991b1b">
      ${escapeText(skip.detail.slice(0, 1000))}
    </p>
    <p style="font-size:12px;color:#888">One email per UTC day for this reason.</p>
  </div>`,
  };
}

/**
 * Tells the operator about each skip that is the platform's to fix, once per
 * UTC day per (media, reason). Returns the keys this call alerted on. If the
 * dedupe table cannot be written, Sentry still gets the event (it groups by
 * fingerprint) and the email is not sent, because without the dedupe every
 * article would send one. Never throws.
 */
export async function alertMediaSkips(
  supabase: SupabaseClient,
  skips: MediaSkip[],
  context: MediaAlertContext,
  now = new Date()
): Promise<string[]> {
  const day = now.toISOString().slice(0, 10);
  const alerted: string[] = [];
  const seen = new Set<string>();

  for (const skip of skips) {
    if (!needsOperator(skip.reason)) continue;
    const key = mediaAlertKey(skip);
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const claimed = await claimDailyAlert(supabase, key, day, skip.detail);
      if (claimed === false) continue;

      const headline = HEADLINES[`${skip.media}:${skip.reason}`] ?? `Media skipped: ${skip.media} (${skip.reason})`;
      Sentry.captureMessage(headline, {
        level: skip.reason === "billing" ? "fatal" : "error",
        fingerprint: ["media-degraded", skip.media, skip.reason],
        tags: { media: skip.media, media_skip_reason: skip.reason },
        extra: {
          article_id: context.articleId,
          job_id: context.jobId,
          business_id: context.businessId,
          detail: skip.detail.slice(0, 1000),
        },
      });

      let emailed = false;
      const to = operatorEmailAddress();
      if (claimed === true && to) {
        emailed = await sendNotificationEmail({ to, ...alertEmail(skip, headline, context) });
      }
      alerted.push(key);
      log("error", { outcome: "alerted", key, emailed, article_id: context.articleId });
    } catch (err) {
      log("error", { outcome: "alert_failed", key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return alerted;
}
