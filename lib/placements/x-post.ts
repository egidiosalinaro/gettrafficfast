import type { SupabaseClient } from "@supabase/supabase-js";
import {
  X_NOT_CONNECTED,
  X_RECONNECT,
  markXConnectionExpired,
  xAccessTokenFor,
  type XPostingAccount,
} from "@/lib/integrations/x-posting";
import type { XOAuthClient } from "@/lib/providers/x/oauth";
import { X_POST_USD_PER_POST, createXPost, xPostUrl, type XPostErrorKind, type XPostResult } from "@/lib/providers/x/post";
import { applyManualAction } from "./actions";
import { xReplyIntentUrl } from "./intent";
import { loadTarget } from "./manual";
import { xStatusIdOf } from "./published-url";
import type { PlacementTargetRecord } from "./read";
import { meteredXCall, type MeteredRefusal } from "./x-budget";
import { xReplyAllowance } from "./x-reply-allowed";
import { OPEN_STATUSES } from "./workflow";

/**
 * Posting on X from the site's connected account (docs/PLACEMENTS.md, "Post
 * on X: only where X allows it"). Two uses, both a person's explicit act:
 *
 * - `postReplyOnX`: the Post on X button on a draft whose post mentions or
 *   quotes the site's account (`xReplyAllowance`), and the `post_on_x` tool
 *   with `targetId` and `draftId`. One press, one post. The stored draft's
 *   text is what goes out (the screen saves an edited draft first, so the
 *   checks have read it). The row is claimed as posted before X is called,
 *   so a double press or two agents posting at once make one post; a post X
 *   refuses gives the claim back. Once posted, the reply's real link is
 *   saved at once (`set_published_url`), so there is no search for it.
 *   When X answers that the reply is not allowed, the answer carries X's
 *   composer link with the text (`intentUrl`): the screen opens it in the
 *   same click, as for any other post.
 * - `postStandaloneOnX`: a post of the account's own, from `post_on_x` with
 *   `text`. No screen composes one yet (the content strategy is undecided).
 *
 * Every call goes through `meteredXCall`: counted in the platform's X
 * ledger, refused over the monthly cap or during X's billing pause. GTF never
 * posts on its own, on a schedule, or anywhere but X from this account.
 */

export type XPostRefusalCode =
  | "not_found"
  | "invalid_state"
  | "unavailable"
  | "not_connected"
  | "not_allowed"
  | Exclude<XPostErrorKind, "other">
  | "other";

export type PostReplyOnXResult =
  | { ok: true; target: PlacementTargetRecord; url: string; postId: string; account: XPostingAccount }
  | {
      ok: false;
      code: XPostRefusalCode;
      status: 400 | 403 | 404 | 409 | 429 | 500 | 502 | 503;
      error: string;
      /** X's composer with the text, for the fallback: set on reply_not_allowed and not_allowed. */
      intentUrl?: string | null;
      resetAt?: string | null;
    };

/** The line when the platform's monthly X allowance stops posting: when it comes back, never the amount. */
export function xPostCapLine(resetsAt: Date): string {
  const day = resetsAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Posting from GTF on X is paused until ${day}: this month's allowance for X is used up. You can still open X and post it yourself.`;
}

export const REPLY_NOT_ALLOWED_LINE =
  "X does not let GTF reply to this post (its author did not mention or quote your account), so X opens with your reply typed in: post it there.";

interface PostDeps {
  oauthClient?: XOAuthClient | null;
  fetchImpl?: typeof fetch;
  now?: Date;
}

type Refusal = Extract<PostReplyOnXResult, { ok: false }>;

function fromMetered(reason: MeteredRefusal, message: string): Refusal {
  switch (reason) {
    case "cap":
    case "paused":
    case "billing":
      return { ok: false, code: "cap_reached", status: 429, error: message };
    case "rate_limit":
      return { ok: false, code: "rate_limited", status: 429, error: message };
    case "disabled":
      return { ok: false, code: "unavailable", status: 503, error: message };
    default:
      return { ok: false, code: "other", status: 502, error: message };
  }
}

/** One post on X, metered. The connection's token is fetched (and refreshed) first. */
async function meteredPost(
  params: { admin: SupabaseClient; userId: string; businessId: string; text: string; inReplyToId?: string | null } & PostDeps
): Promise<{ ok: true; result: XPostResult; account: XPostingAccount } | Refusal> {
  const token = await xAccessTokenFor({
    admin: params.admin,
    userId: params.userId,
    businessId: params.businessId,
    oauthClient: params.oauthClient,
    fetchImpl: params.fetchImpl,
    now: params.now,
  });
  if (!token.ok) {
    switch (token.reason) {
      case "unavailable":
        return { ok: false, code: "unavailable", status: 503, error: token.message };
      case "not_connected":
        return { ok: false, code: "not_connected", status: 409, error: token.message };
      case "auth_expired":
        return { ok: false, code: "auth_expired", status: 409, error: token.message };
      default:
        return { ok: false, code: "other", status: 500, error: token.message };
    }
  }

  const metered = await meteredXCall<XPostResult, { accessToken: string }>({
    supabase: params.admin,
    client: { accessToken: token.accessToken },
    worstCaseUsd: X_POST_USD_PER_POST,
    run: (client) =>
      createXPost({ accessToken: client.accessToken, text: params.text, inReplyToId: params.inReplyToId, fetchImpl: params.fetchImpl }),
    capLine: xPostCapLine,
    now: params.now,
  });
  if (!metered.ok) return fromMetered(metered.reason, metered.message);
  const result = metered.result;
  if (!result.ok && result.kind === "auth_expired") {
    await markXConnectionExpired(params.admin, params.userId, params.businessId, params.now);
    return { ok: false, code: "auth_expired", status: 409, error: X_RECONNECT };
  }
  return { ok: true, result, account: token.account };
}

/**
 * Posts the draft as a reply to the target on X, and records it as posted
 * with its real link. `supabase` is the caller's client (RLS for a session,
 * the owner-scoped service role for a key): the target, the draft and the
 * record go through it; `admin` reads the connection's tokens and the
 * platform's ledger, narrowed by `userId` and `businessId`.
 */
export async function postReplyOnX(
  params: {
    supabase: SupabaseClient;
    admin: SupabaseClient;
    userId: string;
    businessId: string;
    targetId: string;
    draftId: string;
  } & PostDeps
): Promise<PostReplyOnXResult> {
  const { supabase, admin, userId, businessId, targetId, draftId } = params;
  const target = await loadTarget(supabase, businessId, targetId);
  if (!target) return { ok: false, code: "not_found", status: 404, error: "This post is no longer in your inbox." };
  const draft = target.drafts.find((d) => d.id === draftId);
  if (!draft) return { ok: false, code: "not_found", status: 404, error: "That draft is not one of this post's." };

  const inReplyToId = target.surface === "x" ? xStatusIdOf(target.url) : null;
  if (!inReplyToId) return { ok: false, code: "invalid_state", status: 409, error: "Only a post on X can be answered on X." };
  if (!OPEN_STATUSES.includes(target.status)) {
    return { ok: false, code: "invalid_state", status: 409, error: "This post can't be marked as posted any more: it was posted, skipped or filtered out." };
  }
  if (draft.auditStatus === "blocked") {
    return {
      ok: false,
      code: "invalid_state",
      status: 409,
      error: "A check stopped this draft. Fix it or edit it first; or open X and post it yourself.",
      intentUrl: xReplyIntentUrl(target.url, draft.body),
    };
  }
  const intentUrl = xReplyIntentUrl(target.url, draft.body);

  const account = await loadConnectedUsername(admin, userId, businessId);
  if (!account) return { ok: false, code: "not_connected", status: 409, error: X_NOT_CONNECTED, intentUrl };
  if (!xReplyAllowance(target, account)) {
    return {
      ok: false,
      code: "not_allowed",
      status: 409,
      error: `This post does not mention or quote @${account}, so X lets only you reply to it: open X and post it yourself.`,
      intentUrl,
    };
  }

  // The claim: posted, by this draft, only while the row is still open. A
  // second press (or a second agent) finds nothing to claim and posts nothing.
  const now = params.now ?? new Date();
  const { data: claimed, error: claimError } = await supabase
    .from("placement_targets")
    .update({
      status: "published_manually",
      published_at: now.toISOString(),
      published_url: null,
      published_note: null,
      selected_placement_id: draftId,
      snoozed_until: null,
      updated_at: now.toISOString(),
    })
    .eq("id", targetId)
    .eq("business_id", businessId)
    .in("status", OPEN_STATUSES)
    .select("id")
    .maybeSingle();
  if (claimError) return { ok: false, code: "other", status: 500, error: claimError.message };
  if (!claimed) return { ok: false, code: "invalid_state", status: 409, error: "This reply is already being posted, or was posted." };

  const giveBack = async () => {
    await supabase
      .from("placement_targets")
      .update({
        status: target.status,
        published_at: target.publishedAt,
        published_note: target.publishedNote,
        selected_placement_id: target.selectedPlacementId,
        snoozed_until: target.snoozedUntil,
        updated_at: new Date().toISOString(),
      })
      .eq("id", targetId)
      .eq("business_id", businessId)
      .eq("status", "published_manually")
      .is("published_url", null);
  };

  const posted = await meteredPost({
    admin,
    userId,
    businessId,
    text: draft.body,
    inReplyToId,
    oauthClient: params.oauthClient,
    fetchImpl: params.fetchImpl,
    now,
  });
  if (!posted.ok) {
    await giveBack();
    return { ...posted, intentUrl };
  }
  const result = posted.result;
  if (!result.ok) {
    await giveBack();
    if (result.kind === "reply_not_allowed") {
      return { ok: false, code: "reply_not_allowed", status: 403, error: REPLY_NOT_ALLOWED_LINE, intentUrl };
    }
    if (result.kind === "rate_limited") return { ok: false, code: "rate_limited", status: 429, error: result.message, resetAt: result.resetAt ?? null, intentUrl };
    return { ok: false, code: "other", status: 502, error: result.message, intentUrl };
  }

  const url = xPostUrl(posted.account.username, result.id);
  const saved = await applyManualAction({ supabase, businessId, targetId, input: { action: "set_published_url", publishedUrl: url }, now });
  if (!saved.ok) {
    // Posted on X all the same: say so, with the link, rather than a failure that invites a second post.
    log("error", { outcome: "posted_not_recorded", target_id: targetId, error: saved.error });
    const fallback = await loadTarget(supabase, businessId, targetId);
    if (!fallback) return { ok: false, code: "other", status: 500, error: `Posted on X (${url}), but the link could not be saved: ${saved.error}` };
    return { ok: true, target: fallback, url, postId: result.id, account: posted.account };
  }
  log("info", { outcome: "reply_posted", target_id: targetId, business_id: businessId });
  return { ok: true, target: saved.target, url, postId: result.id, account: posted.account };
}

/** The connected account's username, or null. Service role, narrowed by user and site. */
async function loadConnectedUsername(admin: SupabaseClient, userId: string, businessId: string): Promise<string | null> {
  const { data } = await admin
    .from("x_posting_connections")
    .select("username")
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .maybeSingle();
  const username = (data as { username?: unknown } | null)?.username;
  return typeof username === "string" && username ? username : null;
}

export type PostStandaloneOnXResult =
  | { ok: true; url: string; postId: string; username: string }
  | Extract<PostReplyOnXResult, { ok: false }>;

/** A post of the account's own on X (`post_on_x` with `text`). Nothing is stored beyond the ledger and the log. */
export async function postStandaloneOnX(
  params: { admin: SupabaseClient; userId: string; businessId: string; text: string } & PostDeps
): Promise<PostStandaloneOnXResult> {
  const text = params.text.trim();
  if (!text) return { ok: false, code: "invalid_state", status: 400, error: "The post has no text." };
  const posted = await meteredPost({ ...params, text, inReplyToId: null });
  if (!posted.ok) return posted;
  const result = posted.result;
  if (!result.ok) {
    if (result.kind === "rate_limited") return { ok: false, code: "rate_limited", status: 429, error: result.message, resetAt: result.resetAt ?? null };
    return { ok: false, code: "other", status: 502, error: result.message };
  }
  log("info", { outcome: "post_made", business_id: params.businessId });
  return { ok: true, url: xPostUrl(posted.account.username, result.id), postId: result.id, username: posted.account.username };
}

function log(level: "info" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event: "x_post", ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
