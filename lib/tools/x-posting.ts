import { z } from "zod";
import { xConnectPath } from "@/lib/integrations/x-connect";
import { disconnectXAccount, loadXPostingAccount, xPostingAvailable } from "@/lib/integrations/x-posting";
import { postReplyOnX, postStandaloneOnX, type PostReplyOnXResult } from "@/lib/placements/x-post";
import { SITE_URL } from "@/lib/site";
import { ReplyTarget } from "./replies";
import { defineTool, ToolError } from "./tool";
import { libRefusal } from "./write-guards";

/**
 * Posting on X from the site's connected account, as tools (docs/API.md,
 * "Posting on X"): the account (`get_x_posting_account`), the post itself
 * (`post_on_x`), and disconnecting it (`disconnect_x_account`).
 *
 * `post_on_x` acts in the owner's name somewhere public, so it takes the
 * `publish` scope, the one `publish_article` already takes for the owner's
 * own site, and `confirm: true`: the person's yes, for that post. It is not
 * `paid` (no AI work): what it costs is the platform's X money, counted in
 * the platform's X ledger and stopped by the monthly X cap.
 *
 * Connecting is left to a person on X's consent screen, on purpose: a token
 * must not pass through an AI chat. `get_x_posting_account` hands back the
 * link that starts it.
 */

const TargetId = z.string().uuid().describe("A reply target's id, from list_reply_inbox, whose post mentions or quotes the site's X account (xPostAllowed true).");
const DraftId = z.string().uuid().describe("The draft to post, one of the target's.");

export const getXPostingAccount = defineTool({
  name: "get_x_posting_account",
  title: "Get the X account GTF posts from",
  description:
    "Whether this site has an X account connected for posting, and its @username. available is false when the platform does not offer posting on X; connectUrl is the link a person opens, signed in, to connect one on X's consent screen (an agent cannot connect it). With an account connected, post_on_x can reply to posts that mention or quote it (xPostAllowed on a reply target), and make a post of the account's own.",
  input: z.object({}),
  output: z.object({
    available: z.boolean().describe("False when this deployment does not offer posting on X."),
    connected: z.boolean(),
    username: z.string().nullable().describe("The connected account, without @; null when none."),
    needsReconnect: z.boolean().describe("True when X no longer accepts the stored connection: the person connects again."),
    connectUrl: z.string().nullable().describe("Where the person connects (or reconnects) it; null when posting is not available."),
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const available = xPostingAvailable();
    const account = await loadXPostingAccount(ctx.client, ctx.userId, ctx.businessId);
    return {
      available,
      connected: Boolean(account),
      username: account?.username ?? null,
      needsReconnect: account?.status === "error",
      connectUrl: available ? `${SITE_URL}${xConnectPath(ctx.businessId)}` : null,
    };
  },
});

function refusal(result: Extract<PostReplyOnXResult, { ok: false }>): ToolError {
  switch (result.code) {
    case "not_found":
      return new ToolError("not_found", result.error, 404);
    case "unavailable":
      return new ToolError("unavailable", result.error, 503);
    case "not_connected":
    case "auth_expired":
      return new ToolError("prerequisite_missing", result.error, 409, "Call get_x_posting_account: its connectUrl is where the person connects the account.");
    case "cap_reached":
      return new ToolError("cap_reached", result.error, 429);
    case "rate_limited":
      return new ToolError("rate_limited", result.error, 429);
    case "invalid_state":
      return new ToolError("invalid_state", result.error, 409);
    default:
      return new ToolError("unavailable", result.error, 503);
  }
}

export const postOnX = defineTool({
  name: "post_on_x",
  title: "Post on X",
  description:
    "Posts on X from the X account the person connected for this site, now: one call, one post, never on a schedule. Two forms. A reply: targetId and draftId, only for a target whose post mentions or quotes the site's account (xPostAllowed true; X refuses other replies); the draft's stored text goes out and the target is recorded as posted with the reply's real link. When X refuses the reply anyway, posted is false, reason is reply_not_allowed and intentUrl opens X with the reply typed in for the person to post (then mark_reply_posted). A post of the account's own: text only. Needs the publish scope and confirm: true, the person's yes to this exact post: ask before every call. Posts nowhere but X, and only from the connected account.",
  input: z.object({
    targetId: TargetId.optional(),
    draftId: DraftId.optional(),
    text: z.string().trim().min(1).max(4000).optional().describe("A post of the account's own (not a reply). Leave out with targetId."),
    confirm: z
      .literal(true, { error: "confirm must be true: this posts on X, in public, from the person's account." })
      .describe("Must be true: the person said yes to this exact post."),
  }),
  output: z.object({
    posted: z.boolean(),
    url: z.string().nullable().describe("The post on X; null when not posted."),
    username: z.string().nullable().describe("The account it was posted from."),
    reason: z.enum(["reply_not_allowed"]).nullable().describe("Why a reply was not posted: X does not allow it. null when posted."),
    message: z.string().nullable(),
    intentUrl: z.string().nullable().describe("When posted is false: X's composer with the reply typed in, for the person to post."),
    target: ReplyTarget.nullable().describe("The reply target after posting (recorded as posted, with its link); null for a post of the account's own."),
  }),
  scope: "publish",
  paid: false,
  requiresSubscription: true,
  owns: { targetId: "placement_targets", draftId: "placements" },
  async handler(ctx, input) {
    const reply = input.targetId !== undefined || input.draftId !== undefined;
    if (reply && input.text !== undefined) {
      throw new ToolError("invalid_input", "Give targetId and draftId for a reply, or text for a post of the account's own, not both.", 400);
    }
    if (reply) {
      if (!input.targetId || !input.draftId) throw new ToolError("invalid_input", "A reply needs both targetId and draftId.", 400);
      const result = await postReplyOnX({
        supabase: ctx.client,
        admin: ctx.admin(),
        userId: ctx.userId,
        businessId: ctx.businessId,
        targetId: input.targetId,
        draftId: input.draftId,
      });
      if (result.ok) {
        return { posted: true, url: result.url, username: result.account.username, reason: null, message: null, intentUrl: null, target: result.target };
      }
      if (result.code === "reply_not_allowed" || result.code === "not_allowed") {
        return {
          posted: false,
          url: null,
          username: null,
          reason: "reply_not_allowed" as const,
          message: result.error,
          intentUrl: result.intentUrl ?? null,
          target: null,
        };
      }
      throw refusal(result);
    }
    if (input.text === undefined) throw new ToolError("invalid_input", "Give text, or targetId and draftId.", 400);
    const result = await postStandaloneOnX({ admin: ctx.admin(), userId: ctx.userId, businessId: ctx.businessId, text: input.text });
    if (!result.ok) throw refusal(result);
    return { posted: true, url: result.url, username: result.username, reason: null, message: null, intentUrl: null, target: null };
  },
});

export const disconnectXAccountTool = defineTool({
  name: "disconnect_x_account",
  title: "Disconnect the X account",
  description:
    "Disconnects the X account this site posts from: its tokens are revoked at X and deleted here at once. Posts already made stay on X; replies stay recorded. Connecting again is done by a person on X's consent screen.",
  input: z.object({}),
  output: z.object({ disconnected: z.boolean().describe("False when none was connected.") }),
  scope: "write",
  paid: false,
  destructive: true,
  async handler(ctx) {
    const result = await disconnectXAccount({ admin: ctx.admin(), userId: ctx.userId, businessId: ctx.businessId });
    if (!result.ok) throw libRefusal(result);
    return { disconnected: result.disconnected };
  },
});

export const X_POSTING_TOOLS = [getXPostingAccount, postOnX, disconnectXAccountTool] as const;
