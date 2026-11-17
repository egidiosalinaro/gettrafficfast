import type { SupabaseClient } from "@supabase/supabase-js";
import type { Caller } from "@/lib/api-auth";
import type { ApiKeyScope } from "@/lib/api-keys";
import { FakeSupabase } from "../support/fake-supabase";
import { OTHER, SITE_A, SITE_B, SITE_C, USER, businesses, uuid } from "./support";

/**
 * One account with sites A and B, another with site C, and a row of every
 * table the write tools touch on each, so a test can name an id of site A
 * (the caller's), site B (same account, another site) and site C (another
 * account). The ids are uuids, as the tools' schemas require.
 */

export const K_A = uuid("1", 1);
export const K_A2 = uuid("1", 2);
export const K_A3 = uuid("1", 3);
export const K_B = uuid("1", 4);
export const K_C = uuid("1", 5);

export const ART_A = uuid("2", 1);
export const ART_A_FAILED = uuid("2", 2);
export const ART_B = uuid("2", 3);
export const ART_C = uuid("2", 4);

export const P_A = uuid("3", 1);
export const P_A2 = uuid("3", 2);
export const P_B = uuid("3", 3);
export const P_C = uuid("3", 4);

export const F_A = uuid("4", 1);
export const F_B = uuid("4", 2);
export const F_C = uuid("4", 3);

export const KEY_ALL_SITES = "key-all";
export const KEY_SITE_A = "key-1";

function keyword(id: string, userId: string, businessId: string, keyword: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: userId,
    business_id: businessId,
    keyword,
    search_volume: 900,
    competition: "Medium",
    difficulty: 40,
    cpc: null,
    opportunity: "High",
    status: "available",
    is_starred: false,
    article_id: null,
    created_at: "2026-11-01T09:00:00.000Z",
    ...over,
  };
}

function article(id: string, userId: string, businessId: string, keywordId: string, day: string, status = "queued") {
  return { id, user_id: userId, business_id: businessId, keyword_id: keywordId, scheduled_date: day, status };
}

function prompt(id: string, userId: string, businessId: string, query: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: userId,
    business_id: businessId,
    query,
    cluster: "pricing",
    intent: "commercial",
    enabled: true,
    source: "manual",
    created_at: "2026-11-02T09:00:00.000Z",
    ...over,
  };
}

function feedback(id: string, userId: string, businessId: string, reason: string) {
  return {
    id,
    user_id: userId,
    business_id: businessId,
    target_id: uuid("5", 1),
    placement_id: null,
    reason,
    body_before: "Before.",
    body_after: "After.",
    promoted_to_notes: false,
    created_at: "2026-11-08T09:00:00.000Z",
  };
}

export function seedWrites(over: { lockedA?: boolean } = {}) {
  const sites = businesses().map((b) =>
    b.id === SITE_A
      ? { ...b, niche: "SEO software", description: "Acme helps sites get found.", sitemap_url: null, blog_url: null, is_locked: over.lockedA ?? false }
      : b
  );
  return new FakeSupabase({
    businesses: sites,
    api_keys: [
      { id: KEY_ALL_SITES, user_id: USER, business_id: null },
      { id: KEY_SITE_A, user_id: USER, business_id: SITE_A },
    ],
    keywords: [
      keyword(K_A, USER, SITE_A, "ai seo tools"),
      keyword(K_A2, USER, SITE_A, "answer engine optimization"),
      keyword(K_A3, USER, SITE_A, "llm citations", { status: "queued", article_id: ART_A }),
      keyword(K_B, USER, SITE_B, "bravo keyword"),
      keyword(K_C, OTHER, SITE_C, "charlie keyword"),
    ],
    articles: [
      article(ART_A, USER, SITE_A, K_A3, "2026-11-10"),
      article(ART_A_FAILED, USER, SITE_A, uuid("1", 9), "2026-11-12", "failed"),
      article(ART_B, USER, SITE_B, K_B, "2026-11-11"),
      article(ART_C, OTHER, SITE_C, K_C, "2026-11-11", "failed"),
    ],
    aeo_queries: [
      prompt(P_A, USER, SITE_A, "What is the best AI SEO tool for a small team?"),
      prompt(P_A2, USER, SITE_A, "How do I get cited by ChatGPT?", { cluster: null, enabled: false }),
      prompt(P_B, USER, SITE_B, "Bravo prompt for site B?"),
      prompt(P_C, OTHER, SITE_C, "Charlie prompt for someone else?"),
    ],
    draft_feedback: [
      feedback(F_A, USER, SITE_A, "Too long, keep it to two lines"),
      feedback(F_B, USER, SITE_B, "Bravo note"),
      feedback(F_C, OTHER, SITE_C, "Charlie note"),
    ],
    integrations: [
      { id: uuid("6", 1), user_id: USER, business_id: SITE_A, type: "wordpress", config: { password: "secret" }, status: "connected" },
      { id: uuid("6", 2), user_id: USER, business_id: SITE_B, type: "wordpress", config: { password: "secret" }, status: "connected" },
    ],
    analytics_connections: [
      { id: uuid("7", 1), user_id: USER, business_id: SITE_A, provider: "search_console", site_url: null, status: "connected" },
      { id: uuid("7", 2), user_id: USER, business_id: SITE_B, provider: "search_console", site_url: "sc-domain:bravo.test", status: "connected" },
    ],
    competitors: [],
    aeo_runs: [],
    entities: [],
    placement_targets: [],
    placements: [],
    subscriptions: [],
  });
}

/** An API-key caller on site A unless told otherwise, through the owner-scoped service role. */
export { apiCaller } from "./support";

/** The same person signed in: their own client (the fake stands in for RLS), every scope. */
export function sessionCaller(db: FakeSupabase, scopes?: ApiKeyScope[]): Caller {
  return {
    via: "session",
    userId: USER,
    businessId: SITE_A,
    businessIds: [SITE_A, SITE_B],
    client: db as unknown as SupabaseClient,
    scopes: scopes ?? ["read", "write", "spend", "publish"],
    keyId: null,
  };
}

export { OTHER, SITE_A, SITE_B, SITE_C, USER };
