import { z } from "zod";
import { BILLING_TEXT_PATTERN, X_API_BASE, X_API_TIMEOUT_MS, XApiError, rateLimitResetAt, roundUsd } from "./api";

/**
 * Posting on X as the account a site connected (`POST /2/tweets`, user
 * context): a standalone post, or a reply to a post.
 *
 * What X allows (its rules for self-serve access since February 2026): a
 * standalone post, and a reply in one's own threads, always; a reply to
 * someone else's post only when that post's author @mentioned the account or
 * quoted one of its posts. Any other reply is refused with a 403, which is
 * `reply_not_allowed` here, so the caller can hand the person X's own
 * composer instead (lib/placements/intent.ts). The product never decides to
 * post: every call here follows one press of Post by a person, or their
 * explicit confirmation to their agent (docs/PLACEMENTS.md).
 *
 * This file only speaks HTTP and classifies what X answered. It reads no
 * table and holds no cap: the platform's monthly X cap and ledger wrap it
 * (`meteredXCall`, lib/placements/x-budget.ts). A refusal for billing (X's
 * credits used up) is thrown as an `XApiError` of kind "billing", so the cap
 * pauses every X call the way it does for reads; every other refusal comes
 * back as a typed result that bills nothing.
 */

/**
 * USD per post created, the worst case reserved and the estimate settled.
 * Source: third-party summaries of X's pay-per-use pricing (2026), "about
 * $0.01 to $0.015 per post created"; the upper end is kept so the ledger
 * never under-counts. Recorded 2026-11-24. Not confirmed by an invoice:
 * correct it when the first one says otherwise (posts carrying a link may
 * be priced apart).
 */
export const X_POST_USD_PER_POST = 0.015;

/** X's limit for a post's text on an account without a paid subscription, in characters as X counts them. */
export const X_POST_MAX_CHARS = 280;

/**
 * Why a post was not made, in the terms the caller acts on:
 *   reply_not_allowed — 403 on a reply: the post's author did not mention or
 *                       quote the account (X's rule); open X's composer instead;
 *   rate_limited      — 429: wait until `resetAt`;
 *   auth_expired      — 401: the connection's token is no longer valid; connect again;
 *   cap_reached       — the platform's monthly X allowance is used up (set by the cap, never by X here);
 *   other             — anything else X answered (a duplicate post, a text too long, a deleted post).
 */
export type XPostErrorKind = "reply_not_allowed" | "rate_limited" | "auth_expired" | "cap_reached" | "other";

export interface XPostFailure {
  ok: false;
  kind: XPostErrorKind;
  message: string;
  status?: number;
  resetAt?: string | null;
}

export interface XPostSuccess {
  ok: true;
  /** The new post's id. */
  id: string;
  /** Its text as X stored it. */
  text: string;
}

/** What a post call returns, with what it is billed on for the ledger (`meteredXCall`). */
export type XPostResult = (XPostSuccess | XPostFailure) & { billedPosts: number; costUsd: number };

const ApiCreated = z.object({ data: z.object({ id: z.string().regex(/^\d{1,20}$/), text: z.string() }).passthrough() }).passthrough();

const REPLY_REFUSAL = /reply|mention|engaged|conversation/i;

/** What a failed post means, from the status and the body X sent. Throws for billing (see the file's note). */
export function classifyXPostFailure(status: number, body: string, resetHeader: string | null, replying: boolean): XPostFailure {
  const excerpt = body.slice(0, 300);
  if (status === 402 || BILLING_TEXT_PATTERN.test(body)) {
    throw new XApiError(`X API billing refused the post (${status}): ${excerpt}`, "billing", { status });
  }
  if (status === 429) {
    const resetAt = rateLimitResetAt(resetHeader);
    return { ok: false, kind: "rate_limited", message: `X rate-limited posting (429)${resetAt ? `, until ${resetAt}` : ""}.`, status, resetAt };
  }
  if (status === 401) return { ok: false, kind: "auth_expired", message: "X no longer accepts this connection. Connect the X account again.", status };
  if (status === 403 && replying && REPLY_REFUSAL.test(body)) {
    return {
      ok: false,
      kind: "reply_not_allowed",
      message: "X does not let an app reply to this post: its author did not mention or quote your account.",
      status,
    };
  }
  return { ok: false, kind: "other", message: `X refused the post (${status}): ${excerpt}`, status };
}

export interface CreateXPostParams {
  accessToken: string;
  text: string;
  /** The status id being answered; absent for a standalone post. */
  inReplyToId?: string | null;
  fetchImpl?: typeof fetch;
}

/** One post on X. Never throws but for billing (an `XApiError` the cap turns into a pause). */
export async function createXPost(params: CreateXPostParams): Promise<XPostResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const replying = Boolean(params.inReplyToId);
  if (params.inReplyToId && !/^\d{1,20}$/.test(params.inReplyToId)) {
    return { ok: false, kind: "other", message: "That is not a post on X.", billedPosts: 0, costUsd: 0 };
  }
  const body = {
    text: params.text,
    ...(params.inReplyToId ? { reply: { in_reply_to_tweet_id: params.inReplyToId } } : {}),
  };
  let response: Response;
  try {
    response = await fetchImpl(`${X_API_BASE}/tweets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${params.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(X_API_TIMEOUT_MS),
    });
  } catch (err) {
    // No answer: X may or may not have made the post. Billed as made, so the ledger never under-counts.
    return {
      ok: false,
      kind: "other",
      message: `X did not answer (${err instanceof Error ? err.message : String(err)}). Check X before trying again: the post may be there.`,
      billedPosts: 1,
      costUsd: X_POST_USD_PER_POST,
    };
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const failure = classifyXPostFailure(response.status, text, response.headers.get("x-rate-limit-reset"), replying);
    return { ...failure, billedPosts: 0, costUsd: 0 };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Falls through to the shape check.
  }
  const parsed = ApiCreated.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "other",
      message: "X answered the post in an unexpected shape. Check X: the post may be there.",
      status: response.status,
      billedPosts: 1,
      costUsd: X_POST_USD_PER_POST,
    };
  }
  return { ok: true, id: parsed.data.data.id, text: parsed.data.data.text, billedPosts: 1, costUsd: roundUsd(X_POST_USD_PER_POST) };
}

/** The canonical address of a post made by `username`. */
export function xPostUrl(username: string, id: string): string {
  return `https://x.com/${username}/status/${id}`;
}
