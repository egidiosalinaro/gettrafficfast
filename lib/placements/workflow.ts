import type { VoiceSettings } from "@/lib/voice/settings";
import { checkPublishedUrl } from "./published-url";
import { REMOVED_REASON_MAX } from "./removed";

/**
 * The placement lifecycle, as data. One table of allowed moves, so the API,
 * the inbox and the drafting job cannot disagree about what a status means.
 *
 *   discovered → rejected | qualified
 *   qualified  → drafted | needs_review          (the drafting job)
 *   qualified | drafted | needs_review → approved  (older tabs only; nothing reads it)
 *   qualified | drafted | needs_review | approved → published_manually  ("I posted it")
 *   published_manually → published_manually      (the link to the reply, added later)
 *   published_manually → published_manually      (removed from the site, or the Undo)
 *   anything not terminal → dismissed
 *   rejected | dismissed → qualified               (a person overrides)
 *   discovered | rejected | dismissed → qualified  (a person adds the post by hand)
 *
 * `published_manually` is the only "published" there is. It is set by the
 * person who posted the answer, with one tap ("I posted it"). The link to
 * their own reply is asked for afterwards, as a reminder on the card
 * (`set_published_url`), and checked the same way wherever it is given
 * (`checkPublishedUrl`, `published-url.ts`). No code path moves a row there.
 *
 * A posted reply the site removed or hid stays `published_manually`, with
 * `removed_at` and an optional reason beside it (`mark_removed`, since
 * 2026-11-10, `removed.ts`): it was posted, then removed, and both are kept.
 * `unmark_removed` is the Undo.
 */

/** The shapes a proposed answer can take. */
export const PLACEMENT_VARIANTS = [
  "short_comment",
  "detailed_answer",
  "article_draft",
  "github_issue",
  "github_pr_proposal",
] as const;
export type PlacementVariant = (typeof PLACEMENT_VARIANTS)[number];

export const TARGET_STATUSES = [
  "discovered",
  "rejected",
  "qualified",
  "drafted",
  "needs_review",
  "approved",
  "published_manually",
  "dismissed",
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/**
 * `approve` has no button any more: nothing ever read `approved`. It stays
 * accepted so a tab open across the deploy does not get a schema error, and
 * rows already approved keep working as open rows.
 */
export const MANUAL_ACTIONS = [
  "approve",
  "mark_published",
  "unmark_published",
  "set_published_url",
  "mark_removed",
  "unmark_removed",
  "dismiss",
  "snooze",
  "reopen",
] as const;
export type ManualAction = (typeof MANUAL_ACTIONS)[number];

const MOVES: Record<Exclude<ManualAction, "snooze">, { from: TargetStatus[]; to: TargetStatus }> = {
  approve: { from: ["qualified", "drafted", "needs_review"], to: "approved" },
  mark_published: { from: ["qualified", "drafted", "needs_review", "approved"], to: "published_manually" },
  // The Undo of "I posted it": back to an open row, as it was a moment ago.
  unmark_published: { from: ["published_manually"], to: "drafted" },
  // Only the link changes: the row was already posted.
  set_published_url: { from: ["published_manually"], to: "published_manually" },
  // Removed from the site, or the Undo: the row stays posted either way.
  mark_removed: { from: ["published_manually"], to: "published_manually" },
  unmark_removed: { from: ["published_manually"], to: "published_manually" },
  dismiss: { from: ["discovered", "qualified", "drafted", "needs_review", "approved"], to: "dismissed" },
  reopen: { from: ["rejected", "dismissed"], to: "qualified" },
};

/** The status after a manual action, or null when the move is not allowed. */
export function transition(current: TargetStatus, action: ManualAction): TargetStatus | null {
  if (action === "snooze") {
    // Snoozing hides, it does not move: a snoozed row keeps its status.
    return ["qualified", "drafted", "needs_review", "approved"].includes(current) ? current : null;
  }
  const move = MOVES[action];
  return move.from.includes(current) ? move.to : null;
}

/**
 * The status a row takes when a person adds its post by hand ("Add a post
 * from X"), or null when the row is left exactly as it is.
 *
 * Adding is a person's verdict that the post is worth answering, so a row
 * nobody has judged yet, or one a rule, the agent or the person turned
 * down, becomes qualified. A row already open keeps its status and its
 * drafts. A published row is a reply already made: nothing to reopen.
 */
export function statusWhenAddedByHand(current: TargetStatus): TargetStatus | null {
  if (current === "published_manually") return null;
  if (current === "discovered" || current === "rejected" || current === "dismissed") return "qualified";
  return current;
}

export function isTargetStatus(value: unknown): value is TargetStatus {
  return typeof value === "string" && (TARGET_STATUSES as readonly string[]).includes(value);
}

/** Statuses the inbox shows by default: things a person can still act on. */
export const OPEN_STATUSES: TargetStatus[] = ["qualified", "drafted", "needs_review", "approved"];

/**
 * A list article on the open web ("best X tools", "X alternatives"): a page
 * an answer engine cited that names products. There is no reply box on it;
 * the move is asking its author to consider the business for the list, and
 * the person does that themselves. Stored as surface `web`, this kind. Only
 * a visibility run creates one (lib/visibility/sources-to-targets.ts).
 */
export const LISTICLE_KIND = "listicle";

/** Whether a page of this kind has somewhere to post a reply, so a draft can be written for it. */
export function takesReply(kind: string): boolean {
  return kind !== LISTICLE_KIND;
}

/** What the draft route, the tool and the job say when asked to draft for a list article. */
export const NO_REPLY_ON_LISTICLE =
  "This is a list article, not a conversation: there is no reply to draft. Open it and ask its author to consider you for the list.";

/** Which draft shapes make sense for a page of this kind on this surface. */
export function variantsFor(surface: string, kind: string): PlacementVariant[] {
  // A list article takes no reply, so no shape of reply fits it.
  if (!takesReply(kind)) return [];
  if (surface === "github") {
    return kind === "repository" ? ["github_pr_proposal"] : ["github_issue"];
  }
  if (surface === "x") {
    // A reply under the post, and only that. On X the long form is an X
    // Article, a separate post on the owner's own account and not what a
    // person asks for when they paste a post to reply to. Until 9 November
    // 2026 it was drafted too: the owner's first hand-added post took 63 s,
    // two calls, the second only to rewrite an article nobody wanted.
    return ["short_comment"];
  }
  if (surface === "linkedin" || surface === "devto") {
    // A reply under the post, or a piece on the owner's own account.
    return ["short_comment", "article_draft"];
  }
  // Threads and questions: Reddit, Hacker News, Stack Exchange, Quora,
  // Indie Hackers, a forum. A short reply and a full answer.
  return ["short_comment", "detailed_answer"];
}

/**
 * `placements.agent_version` of a reply the person wrote themselves ("Write
 * your own"). The drafting agent's versions start at 1 (the column default),
 * so 0 is never a model's, and the row says who wrote it without a new column.
 */
export const HUMAN_WRITTEN_AGENT_VERSION = 0;

export function isHumanWritten(draft: { agentVersion: number }): boolean {
  return draft.agentVersion === HUMAN_WRITTEN_AGENT_VERSION;
}

/** The best verdict among a target's drafts: one passing draft is enough. */
export function bestAuditStatus(statuses: readonly string[]): "passed" | "warning" | "blocked" {
  if (statuses.includes("passed")) return "passed";
  if (statuses.includes("warning")) return "warning";
  return "blocked";
}

/** What the drafting job sets once the gate has spoken. */
export function statusAfterAudit(audit: "passed" | "warning" | "blocked"): TargetStatus {
  return audit === "blocked" ? "needs_review" : "drafted";
}

/**
 * Why a draft cannot be written yet, or null when it can.
 *
 * The reply speaks as someone who uses the business's product, and the one
 * clause that names the product is about that use. With nothing recorded
 * about it (Settings → Voice → About you) every such clause would be an
 * invention, so the route refuses before the job is enqueued and the job
 * refuses before the model is paid. Same sentence in both places.
 */
export function draftPrerequisite(businessName: string, voice: VoiceSettings): string | null {
  if (voice.aboutYou.trim()) return null;
  return `Drafts are written as someone who uses ${businessName}. Say how you use it in Settings → Voice → About you (one true sentence is enough), then generate.`;
}

/**
 * Which draft to show first. A reply the gate passed is the answer; a
 * blocked one is what is left when nothing passed. Ties keep the order the
 * drafts were written in.
 */
export function preferredDraft<T extends { auditStatus: string }>(drafts: readonly T[]): T | null {
  const rank = (status: string) => (status === "passed" ? 0 : status === "warning" ? 1 : 2);
  return [...drafts].sort((a, b) => rank(a.auditStatus) - rank(b.auditStatus))[0] ?? null;
}

export interface ManualActionInput {
  action: ManualAction;
  note?: string;
  reason?: string;
  publishedUrl?: string | null;
  publishedAt?: string;
  aeoQueryId?: string | null;
  placementId?: string | null;
  snoozeDays?: number;
}

export type ManualActionPlan =
  | { ok: true; status: TargetStatus; patch: Record<string, unknown> }
  | { ok: false; httpStatus: 400 | 409; error: string };

/** What the action route says when a move is not allowed, in the person's words. */
function refusedMove(action: ManualAction): string {
  switch (action) {
    case "mark_published":
      return "This post can't be marked as posted yet.";
    case "unmark_published":
      return "This reply is not marked as posted.";
    case "set_published_url":
      return "A link can only be added to a reply you marked as posted.";
    case "mark_removed":
      return "Only a reply you marked as posted can be marked as removed.";
    case "unmark_removed":
      return "This reply is not marked as removed.";
    case "reopen":
      return "This post is already in your inbox.";
    default:
      return "This post can't be changed that way any more. Reload the page.";
  }
}

/**
 * The row update a manual action makes, or why it is refused. Pure, so the
 * rules the action route applies are tested without a database.
 *
 * "I posted it" (`mark_published`) takes no link: on a phone, finding the
 * reply's own link was five more steps for every reply. A link given anyway
 * is checked and kept. The link comes later through `set_published_url`,
 * only on a posted row, checked by the same `checkPublishedUrl`.
 *
 * "It was removed" (`mark_removed`) is for a posted row only, once, with an
 * optional reason of at most REMOVED_REASON_MAX characters; `unmark_removed`
 * only on a row marked as removed. `current.removedAt` is what the row
 * holds; undefined is read as not removed.
 *
 * `unmark_published` (2026-11-10) is the Undo of "I posted it": a posted
 * row with no link and no removal goes back to `drafted`, its moment
 * cleared and its drafts untouched. A posted reply leaves the queue at
 * once now, so a mistaken tap needs a way back.
 */
export function planManualAction(
  current: { status: TargetStatus; surface: string; url: string; removedAt?: string | null; publishedUrl?: string | null },
  input: ManualActionInput,
  now: Date = new Date()
): ManualActionPlan {
  const next = transition(current.status, input.action);
  if (!next) return { ok: false, httpStatus: 409, error: refusedMove(input.action) };

  const iso = now.toISOString();
  const patch: Record<string, unknown> = { status: next, updated_at: iso };
  const thread = { surface: current.surface, url: current.url };

  switch (input.action) {
    case "approve":
      if (input.note !== undefined) patch.review_note = input.note || null;
      if (input.placementId !== undefined) patch.selected_placement_id = input.placementId;
      patch.snoozed_until = null;
      break;
    case "mark_published": {
      // Optional now. Given, it must be the person's own reply; absent, the
      // card reminds them until it is added.
      let publishedUrl: string | null = null;
      if (typeof input.publishedUrl === "string" && input.publishedUrl.trim()) {
        const check = checkPublishedUrl(input.publishedUrl, thread);
        if (!check.ok) return { ok: false, httpStatus: 400, error: check.error };
        publishedUrl = check.url;
      }
      patch.published_url = publishedUrl;
      patch.published_at = input.publishedAt ?? iso;
      patch.published_note = input.note || null;
      if (input.aeoQueryId !== undefined) patch.aeo_query_id = input.aeoQueryId;
      if (input.placementId !== undefined) patch.selected_placement_id = input.placementId;
      patch.snoozed_until = null;
      break;
    }
    case "unmark_published":
      // The Undo the page offers for a few seconds after "I posted it". Once
      // the reply's link is saved, or it is marked as removed, the record
      // is more than a tap and is not taken back this way.
      if ((current.publishedUrl ?? "").trim() || current.removedAt) {
        return { ok: false, httpStatus: 409, error: "This reply has a link or a removal on record, so it stays posted." };
      }
      patch.published_at = null;
      patch.published_note = null;
      break;
    case "set_published_url": {
      // Required here: it is the whole point of the action. The moment and
      // the draft were recorded by "I posted it" and are left alone.
      const check = checkPublishedUrl(input.publishedUrl, thread);
      if (!check.ok) return { ok: false, httpStatus: 400, error: check.error };
      patch.published_url = check.url;
      break;
    }
    case "mark_removed": {
      if (current.removedAt) return { ok: false, httpStatus: 409, error: "This reply is already marked as removed." };
      const reason = (input.reason ?? "").trim();
      if (reason.length > REMOVED_REASON_MAX) {
        return { ok: false, httpStatus: 400, error: `Keep the reason under ${REMOVED_REASON_MAX} characters.` };
      }
      // Recorded, never deleted: a reply that was posted and then removed is
      // a negative result. The link, the text and the moment stay as they were.
      patch.removed_at = iso;
      patch.removed_reason = reason || null;
      break;
    }
    case "unmark_removed":
      if (!current.removedAt) return { ok: false, httpStatus: 409, error: refusedMove("unmark_removed") };
      patch.removed_at = null;
      patch.removed_reason = null;
      break;
    case "dismiss":
      patch.dismissed_reason = input.reason || null;
      break;
    case "snooze":
      patch.snoozed_until = new Date(now.getTime() + (input.snoozeDays ?? 7) * 86_400_000).toISOString();
      break;
    case "reopen":
      patch.dismissed_reason = null;
      patch.snoozed_until = null;
      break;
  }
  return { ok: true, status: next, patch };
}
