import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The article lifecycle as an explicit state machine.
 *
 * States and their legal transitions live here and nowhere else, so a route
 * cannot invent a transition the rest of the system does not expect. Every
 * move is recorded in `article_events` with its cause, which is what makes
 * "why is this article stuck" answerable without reading logs.
 *
 * The target lifecycle in docs/ARCHITECTURE.md has further states (indexed,
 * monitored, needs_refresh, archived). They are deliberately absent until the
 * phases that produce them exist: a state no code can reach is dead weight.
 */

export const ARTICLE_STATES = [
  "queued",
  "generating",
  "generated",
  "needs_review",
  "published",
  "failed",
] as const;

export type ArticleState = (typeof ARTICLE_STATES)[number];

/** What may follow what. Terminal-for-now states can still be revived. */
const TRANSITIONS: Record<ArticleState, ArticleState[]> = {
  queued: ["generating", "failed"],
  generating: ["generated", "needs_review", "queued", "failed"],
  generated: ["published", "needs_review", "generating", "queued", "failed"],
  // → generated: re-settled under the current rules with nothing left to
  // hold it (resettle_article, 2026-11-12).
  needs_review: ["published", "generated", "generating", "queued", "failed"],
  published: ["generating", "queued", "published"],
  failed: ["queued", "generating"],
};

export function isArticleState(value: unknown): value is ArticleState {
  return typeof value === "string" && (ARTICLE_STATES as readonly string[]).includes(value);
}

export function canTransition(from: ArticleState, to: ArticleState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Whether production may be started (or restarted) from this state. The
 * calendar's "Generate now" / "Regenerate" and `/api/generate-now` share this
 * so a button cannot offer a transition the state machine refuses.
 */
export function canStartProduction(from: ArticleState): boolean {
  return canTransition(from, "generating");
}

export class IllegalTransition extends Error {
  constructor(from: ArticleState, to: ArticleState) {
    super(`Illegal article transition: ${from} → ${to}`);
    this.name = "IllegalTransition";
  }
}

export interface TransitionInput {
  supabase: SupabaseClient;
  articleId: string;
  userId: string;
  businessId?: string | null;
  from: ArticleState | null;
  to: ArticleState;
  cause?: string;
  actor?: "system" | "user" | "cron";
  metadata?: Record<string, unknown>;
  /** Extra columns to write in the same update (content, canonical, …). */
  patch?: Record<string, unknown>;
}

/**
 * Applies a transition and records it. Recording is best-effort: losing an
 * event must never block the article from moving.
 */
export async function transitionArticle(input: TransitionInput): Promise<void> {
  const {
    supabase,
    articleId,
    userId,
    businessId = null,
    from,
    to,
    cause,
    actor = "system",
    metadata,
    patch,
  } = input;

  if (from && !canTransition(from, to)) {
    throw new IllegalTransition(from, to);
  }

  const { error } = await supabase
    .from("articles")
    .update({ status: to, updated_at: new Date().toISOString(), ...(patch ?? {}) })
    .eq("id", articleId);

  if (error) throw new Error(`Failed to move article to "${to}": ${error.message}`);

  const { error: eventError } = await supabase.from("article_events").insert({
    article_id: articleId,
    user_id: userId,
    business_id: businessId,
    from_state: from,
    to_state: to,
    cause: cause?.slice(0, 2000) ?? null,
    actor,
    metadata: metadata ?? null,
  });

  if (eventError) {
    console.warn(
      JSON.stringify({ level: "warn", event: "article_event.record_failed", error: eventError.message })
    );
  }
}
