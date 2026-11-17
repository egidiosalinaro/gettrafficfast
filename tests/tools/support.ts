import type { SupabaseClient } from "@supabase/supabase-js";
import type { Caller } from "@/lib/api-auth";
import type { ApiKeyScope } from "@/lib/api-keys";
import { ownerScopedClient } from "@/lib/supabase/owner-scoped";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Two accounts, three sites: the user owns A and B, someone else owns C. A
 * tool test runs as an API-key caller on A, through the same owner-scoped
 * service role a real key gets, so the tenancy it asserts is the one in
 * production.
 */

export const USER = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SITE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * Every table but the audit log, as a string to compare before and after a
 * call: the runner records every call in `tool_calls`, refused ones
 * included (lib/tools/usage.ts), so "nothing changed" means nothing else.
 */
export const customerData = (db: FakeSupabase) =>
  JSON.stringify(Object.entries(db.tables).filter(([table]) => table !== "tool_calls"));

/** A uuid made of one hex digit, for readable ids that still pass `.uuid()`. */
export const uuid = (digit: string, n = 0) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${String(n).padStart(12, digit)}`;

export function businesses(over: { aboutYou?: string } = {}) {
  const voice = { aboutYou: over.aboutYou ?? "I run Acme's content and use it every day.", instructions: "" };
  return [
    {
      id: SITE_A,
      user_id: USER,
      name: "Acme",
      website_url: "https://acme.test",
      aeo_settings: {},
      voice_settings: voice,
      content_language: "en",
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: SITE_B,
      user_id: USER,
      name: "Bravo",
      website_url: "https://bravo.test",
      aeo_settings: {},
      voice_settings: voice,
      content_language: "en",
      created_at: "2026-02-01T00:00:00Z",
    },
    {
      id: SITE_C,
      user_id: OTHER,
      name: "Charlie",
      website_url: "https://charlie.test",
      aeo_settings: {},
      voice_settings: voice,
      content_language: "en",
      created_at: "2026-01-15T00:00:00Z",
    },
  ];
}

export function apiCaller(
  db: FakeSupabase,
  options: { businessId?: string | null; scopes?: ApiKeyScope[]; userId?: string } = {}
): Caller {
  const businessId = options.businessId === undefined ? SITE_A : options.businessId;
  const userId = options.userId ?? USER;
  const businessIds = businessId ? [businessId] : [];
  return {
    via: "api_key",
    userId,
    businessId,
    businessIds,
    client: ownerScopedClient(db as unknown as SupabaseClient, { userId, businessIds }),
    scopes: options.scopes ?? ["read", "write", "spend"],
    keyId: "key-1",
  };
}

/**
 * A live plan for `userId`: since 2026-11-16 every tool needs one
 * (lib/tools/runner.ts `planRefusal`), so a seed whose calls should reach
 * the tool carries this row. Read through the real `hasActiveSubscription`.
 */
export function activePlan(userId: string = USER) {
  return {
    id: `sub-${userId.slice(0, 8)}`,
    user_id: userId,
    stripe_customer_id: "cus_test",
    stripe_subscription_id: `sub_test_${userId.slice(0, 8)}`,
    status: "active",
    current_period_start: "2026-01-01T00:00:00Z",
    current_period_end: "2999-01-01T00:00:00Z",
    cancel_at_period_end: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
