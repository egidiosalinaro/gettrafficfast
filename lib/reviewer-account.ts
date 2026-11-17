import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { SITE_URL } from "@/lib/site";
import { isPasswordLoginEmail, normalizeEmail, SET_PASSWORD_PATH } from "@/lib/password-login";
import { listBusinesses } from "@/lib/tenancy";
import { saveBusiness } from "@/lib/business/save";
import { MIN_DAILY_SPEND_USD, readDailySpendCeiling } from "@/lib/limits/spend";
import { saveDailySpendLimit } from "@/lib/limits/settings";

/**
 * The MCP directory reviewers' account (docs/API.md "The reviewer account").
 *
 * Anthropic and OpenAI review a listed MCP server by signing into it: they
 * need a permanent account with a live plan, an email and a password, no
 * 2FA and no inbox. The platform owner sets it up with one owner-only call
 * (POST /api/owner/reviewer-account, from /settings/costs), idempotent, for
 * an address on PASSWORD_LOGIN_EMAILS only:
 *
 *   1. the auth user, created confirmed and without a password if missing;
 *   2. a complimentary plan (`subscriptions.source = 'comp'`, no Stripe ids,
 *      no period end), unless a live plan is already there;
 *   3. the lowest daily AI spend ceiling ($1), unless the owner already set
 *      one for the account;
 *   4. one site, unless it has one: gettrafficfa.st itself, public pages the
 *      pipeline can read without anything being invented. Autopilot, Find
 *      posts on X and Push page 3 stay at their defaults, which are off, and
 *      no publishing destination is connected, so nothing can be written to
 *      a real site;
 *   5. a set-password email from Supabase to that address. The owner sets
 *      the password himself from the email: no password is ever chosen,
 *      returned or logged here.
 */

export const REVIEWER_SITE = {
  name: "GetTrafficFast (demo)",
  websiteUrl: SITE_URL,
  blogUrl: `${SITE_URL}/blog`,
  sitemapUrl: `${SITE_URL}/sitemap.xml`,
  niche: "SEO and AI search visibility software",
  description:
    "Demo site for the MCP directory reviewers' account. It reads gettrafficfa.st's public pages; nothing is published from this account.",
  contentLanguage: "en" as const,
};

/** Where the set-password email's link lands, through the confirm route (an allowed redirect). */
export const SET_PASSWORD_REDIRECT = `${SITE_URL}/auth/confirm?next=${encodeURIComponent(SET_PASSWORD_PATH)}`;

export const ReviewerAccountInput = z.object({ email: z.string().email().max(320) });

export interface ReviewerAccountResult {
  userId: string;
  user: "created" | "existing";
  plan: "comp_granted" | "already_live";
  ceiling: { usd: number; set: boolean };
  site: { id: string | null; created: boolean };
  /** Whether Supabase accepted the request to send the set-password email. */
  passwordEmail: { requested: boolean; error: string | null };
}

export type ProvisionResult =
  | { ok: true; result: ReviewerAccountResult }
  | { ok: false; status: 400 | 500; code: string; error: string };

const LIVE = ["active", "trialing"];
const USERS_PER_PAGE = 1000;
const MAX_USER_PAGES = 20;

async function findUserId(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= MAX_USER_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const users = data?.users ?? [];
    const match = users.find((u) => typeof u.email === "string" && normalizeEmail(u.email) === email);
    if (match) return match.id;
    if (users.length < USERS_PER_PAGE) return null;
  }
  return null;
}

async function ensureUser(admin: SupabaseClient, email: string): Promise<{ id: string; created: boolean }> {
  const existing = await findUserId(admin, email);
  if (existing) return { id: existing, created: false };
  // Confirmed, no password: the password comes from the set-password email.
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data?.user) throw new Error(`createUser: ${error?.message ?? "no user returned"}`);
  return { id: data.user.id, created: true };
}

async function ensureCompPlan(admin: SupabaseClient, userId: string, now: Date): Promise<ReviewerAccountResult["plan"]> {
  const { data, error } = await admin.from("subscriptions").select("id").eq("user_id", userId).in("status", LIVE).limit(1);
  if (error) throw new Error(`subscriptions read: ${error.message}`);
  if ((data ?? []).length > 0) return "already_live";
  const stamp = now.toISOString();
  const { error: insertError } = await admin.from("subscriptions").insert({
    user_id: userId,
    status: "active",
    source: "comp",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_start: stamp,
    current_period_end: null,
    cancel_at_period_end: false,
    created_at: stamp,
    updated_at: stamp,
  });
  if (insertError) throw new Error(`subscriptions insert: ${insertError.message}`);
  return "comp_granted";
}

async function ensureCeiling(admin: SupabaseClient, userId: string, now: Date): Promise<ReviewerAccountResult["ceiling"]> {
  const current = await readDailySpendCeiling(admin, userId);
  // The owner's own setting for this account wins over the setup's.
  if (current.source === "account") return { usd: current.usd, set: false };
  const saved = await saveDailySpendLimit({
    supabase: admin,
    userId,
    input: { dailySpendUsd: MIN_DAILY_SPEND_USD, confirm: true },
    now,
  });
  if (!saved.ok) throw new Error(`account_limits: ${saved.error}`);
  return { usd: saved.ceiling.usd, set: true };
}

async function ensureSite(admin: SupabaseClient, userId: string, now: Date): Promise<ReviewerAccountResult["site"]> {
  const sites = await listBusinesses(admin, userId);
  if (sites.length > 0) return { id: sites[0].id, created: false };
  const saved = await saveBusiness({ supabase: admin, userId, targetId: null, fields: REVIEWER_SITE, now });
  if (!saved.ok) throw new Error(`site: ${saved.error}`);
  return { id: (saved.business.id as string | undefined) ?? null, created: true };
}

async function requestPasswordEmail(admin: SupabaseClient, email: string): Promise<ReviewerAccountResult["passwordEmail"]> {
  const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo: SET_PASSWORD_REDIRECT });
  return { requested: !error, error: error ? error.message : null };
}

/**
 * Sets up (or brings back up to date) the reviewer account for `email`.
 * `admin` is the service role: the caller has checked `isPlatformOwner`.
 */
export async function provisionReviewerAccount(params: {
  admin: SupabaseClient;
  input: unknown;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<ProvisionResult> {
  const parsed = ReviewerAccountInput.safeParse(params.input);
  if (!parsed.success) return { ok: false, status: 400, code: "invalid_input", error: "Send the reviewer's email." };
  const email = normalizeEmail(parsed.data.email);
  if (!isPasswordLoginEmail(email, params.env)) {
    return {
      ok: false,
      status: 400,
      code: "not_listed",
      error: "That address is not on PASSWORD_LOGIN_EMAILS. Add it on Vercel first, so it can sign in with a password.",
    };
  }
  const now = params.now ?? new Date();
  try {
    const user = await ensureUser(params.admin, email);
    const plan = await ensureCompPlan(params.admin, user.id, now);
    const ceiling = await ensureCeiling(params.admin, user.id, now);
    const site = await ensureSite(params.admin, user.id, now);
    const passwordEmail = await requestPasswordEmail(params.admin, email);
    return {
      ok: true,
      result: { userId: user.id, user: user.created ? "created" : "existing", plan, ceiling, site, passwordEmail },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", event: "reviewer_account.failed", error: message.slice(0, 300) }));
    return { ok: false, status: 500, code: "internal", error: `The reviewer account could not be set up: ${message.slice(0, 200)}` };
  }
}
