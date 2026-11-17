import { z } from "zod";
import { HINTS } from "@/lib/api-errors";
import { correctionCapacityDenial } from "@/lib/paid-access";
import { PLACEMENT_DISCOVERY } from "@/lib/jobs/workflows/placement-discovery";
import { applyManualAction } from "@/lib/placements/actions";
import { AddXPostBody, addXPost } from "@/lib/placements/add";
import { correctDraft } from "@/lib/placements/correct";
import { EditDraftBody, editDraft } from "@/lib/placements/edit";
import { FeedbackReason } from "@/lib/placements/feedback";
import { requestDraft, type DraftRequest } from "@/lib/placements/generate";
import { xReplyIntentUrl } from "@/lib/placements/intent";
import { loadTarget } from "@/lib/placements/manual";
import { OWN_REPLY_MAX, saveOwnReply } from "@/lib/placements/own-reply";
import { matchPastedReplyLinks } from "@/lib/placements/link-paste";
import { MAX_LINKS_PER_PASTE } from "@/lib/placements/paste";
import { xStatusIdOf } from "@/lib/placements/published-url";
import { REMOVED_REASON_MAX, REMOVED_REASON_PRESETS } from "@/lib/placements/removed";
import { AiCitation } from "@/lib/placements/ai-citation";
import { ReplyMetrics } from "@/lib/placements/reply-metrics";
import { DraftImages, PostMediaItem } from "@/lib/placements/media";
import { ReferencedPost } from "@/lib/placements/referenced";
import { loadReplyMetricsHistory } from "@/lib/placements/reply-metrics-read";
import { ReplyStats } from "@/lib/placements/reply-stats";
import { loadReplyStats } from "@/lib/placements/reply-stats-read";
import { AI_CITED_FILTER, loadInbox, loadToday, type DiscoveryState, type PlacementTargetRecord } from "@/lib/placements/read";
import { withXSearchOff } from "@/lib/placements/discovery-progress";
import { isXApiEnabled } from "@/lib/providers/x/api";
import { LINK_SEARCH_MAX_ATTEMPTS, LINK_SEARCH_OUTCOMES, linkFinding, type LinkFinding } from "@/lib/placements/reply-link";
import { findReplyLinkNow, ownerPaysFor, replyLinkFinderFor, replyLinkFinderOn } from "@/lib/placements/reply-link-search";
import { readXApiStatus } from "@/lib/placements/x-budget";
import { findActiveDraft, findLatestDraft, requestDiscovery } from "@/lib/placements/runs";
import { TARGET_STATUSES, preferredDraft, type ManualActionInput } from "@/lib/placements/workflow";
import { JobView, WaitSeconds, readJob, runJobWithin } from "./jobs";
import { defineTool, ToolError, type ToolContext } from "./tool";
import { reportJobCost } from "./usage";

/**
 * Replies (`/placements`) as tools: every action on the inbox, for an agent.
 *
 * Each handler calls the function the inbox's route calls (lib/placements/)
 * and maps its result; none holds a rule of its own. The runner has already
 * checked the key's scopes, the site, and that every `targetId` / `draftId`
 * is a row of this account and this site (`owns`).
 *
 * The product never posts: there is no tool that publishes a reply.
 * `get_reply_intent_url` gives the X link a person opens to post it
 * themselves, and `mark_reply_posted` records that they did;
 * `mark_reply_removed` records that the site took it down; `find_reply_link`
 * searches X for the link of a reply the person posted (it reads, never
 * writes, on X).
 */

/** As long as the inbox route gives a draft job inline. */
const DRAFT_BUDGET_MS = 105_000;
/**
 * How long a discovery run started here keeps going after the answer: under
 * the API routes' 120 s maxDuration. The tick finishes what is left.
 */
const DISCOVERY_BUDGET_MS = 110_000;
/** Under the route's 60 s, as the correct route does. */
const CORRECTION_DEADLINE_MS = 55_000;

// ── Schemas ──────────────────────────────────────────────────────────────────

const TargetId = z.string().uuid().describe("A reply target's id, from list_reply_inbox.");
const DraftId = z.string().uuid().describe("A draft's id, from a target's drafts.");

/*
 * The output schemas spell out every field, in the shapes lib/placements/read.ts
 * maps: the API's contract is what is declared here, and a field added to
 * the inbox reaches the API when it is added here too.
 */

const Audit = z
  .object({
    status: z.enum(["passed", "warning", "blocked"]),
    checks: z.array(
      // Lenient on purpose: audits stored by older gates are read back as they are.
      z.object({
        id: z.string(),
        label: z.string().optional(),
        status: z.string().describe("pass, warn or fail."),
        detail: z.string().optional(),
        advisory: z.boolean().optional().describe("A note for the reviewer that never counts toward the verdict."),
        confirmable: z
          .array(z.string())
          .optional()
          .describe("On a failed verifiable_claims: the sentences a person can confirm as true with add_about_you_fact (numbers nobody declared, experience with nothing recorded)."),
      })
    ),
    reading: z
      .object({ tone: z.string(), means: z.string() })
      .optional()
      .describe("How the drafter read the post before writing: its tone (sincere, ironic, joke, rant, question) and what the poster means. The model's judgement, not a check; absent when none was kept."),
    images: DraftImages.optional().describe(
      "What the drafter saw of the post's images: how many the post has (null: some, uncounted), how many the model was handed (at most 2), and why the rest were not. Absent on drafts written before images were read (2026-11-11). When seen is below inPost, check the image yourself before posting."
    ),
  })
  .describe("The gate's verdict on the text: only a passed draft is ready to post.");

export const ReplyDraft = z.object({
  id: z.string(),
  variant: z.string().describe("short_comment is the reply under a post."),
  body: z.string(),
  linkUrl: z.string().nullable(),
  claims: z.array(z.unknown()).describe("What the draft claims and on what basis, as the drafter recorded it."),
  audit: Audit,
  auditStatus: z.enum(["passed", "warning", "blocked"]),
  agentVersion: z.number().describe("0 when the person wrote it (write_own_reply)."),
  updatedAt: z.string(),
});

const LinkSearch = z
  .object({
    attempts: z.number().describe("Searches made so far: at most 4 on their own (2 min, 15 min, 2 h, 12 h after I posted it), 6 with find_reply_link."),
    lastAttemptAt: z.string().nullable(),
    outcome: z
      .enum(LINK_SEARCH_OUTCOMES)
      .nullable()
      .describe(
        "How the last search ended: found (saved), not_found (nothing yet: searched again later), other_replies (other replies of the account there, not this one: stopped), ambiguous (more than one could be it: stopped, nothing saved), error, not_saved (found after the link was saved another way), searching (now)."
      ),
    postsSeen: z.number().describe("Posts X returned over every search."),
    foundUrl: z.string().nullable().describe("The link GTF found and saved; kept when the person replaces it."),
    foundAt: z.string().nullable(),
  })
  .describe("GTF's search on X for the link of this posted reply.");

const LinkFindingView = z
  .object({
    state: z
      .enum(["looking", "stopped", "off"])
      .describe("looking: GTF searches X again by itself until stopsBy; stopped: it looked and stopped (outcome says why); off: it does not look for this one (not on X, removed, older than X's 7-day search, Find posts on X off, the site's X account not known yet, or the platform's X API off, paused or at its cap)."),
    stopsBy: z.string().nullable().describe("While looking: when GTF stops looking if it finds nothing."),
    outcome: z.enum(LINK_SEARCH_OUTCOMES).nullable().describe("When stopped: how the last search ended."),
  })
  .describe("For a posted reply with no link: whether GTF is looking for its link on X. Absent on a reply that has its link or is not posted.");

export const ReplyTarget = z.object({
  id: z.string(),
  surface: z.string().describe("The platform: x, reddit, linkedin, github, …"),
  kind: z.string().describe("thread, post, issue, article, repository, … or listicle: a list article that takes no reply, where the move is asking its author to be listed."),
  url: z.string().describe("The post or thread being answered."),
  title: z.string().nullable(),
  excerpt: z.string().nullable(),
  community: z.string().nullable(),
  author: z.string().nullable(),
  postedAt: z.string().nullable(),
  postedAtPrecision: z.enum(["day", "week", "month", "year"]).nullable(),
  score: z.number().nullable(),
  commentCount: z.number().nullable(),
  foundFor: z.string().nullable(),
  foundVia: z.string().nullable().describe("manual when a person added it; ai_visibility when a visibility run's cited source created it."),
  status: z.enum(TARGET_STATUSES),
  qualifyScore: z.number().nullable(),
  qualifyReason: z.string().nullable(),
  qualifyAngle: z.string().nullable(),
  qualifiedBy: z.string().nullable(),
  qualifiedAt: z.string().nullable(),
  topic: z.string().nullable(),
  intent: z.string().nullable(),
  freshUntil: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  reviewNote: z.string().nullable(),
  dismissedReason: z.string().nullable(),
  publishedUrl: z.string().nullable().describe("The link to the person's own posted reply, once given."),
  publishedAt: z.string().nullable(),
  publishedNote: z.string().nullable(),
  publishedText: z.string().nullable().optional().describe("The reply as posted, read back from X."),
  removedAt: z
    .string()
    .nullable()
    .optional()
    .describe("When the person marked the posted reply as removed or hidden by the site; null: still up as far as anyone said. The row stays published_manually."),
  removedReason: z.string().nullable().optional().describe("Why it was removed, in the person's words; null when not said."),
  media: z
    .array(PostMediaItem)
    .nullable()
    .optional()
    .describe(
      "The post's images and videos as the source described them: type (photo, video, animated_gif), the photo's url or a video's still (previewUrl), the poster's alt text, size. Null: never asked (posts added before 2026-11-11, or not on X); []: the post has none."
    ),
  mediaUnread: z
    .boolean()
    .nullable()
    .optional()
    .describe("True when the post has media that could not be read, so its drafts were written without seeing them; false when read; null when not known."),
  quotedPost: ReferencedPost.nullable()
    .optional()
    .describe(
      "The post this post quotes, on X: its id, url, text (null when it exists and could not be read), author (authorName, handle without @), postedAt (postedAtPrecision day when only the day is known), its photos (media) and whether it has media nobody could read (mediaUnread), and why it was not read (note). Null: the post quotes none, or it is not known (see quoteUnread). Drafts read it beside the post since 2026-11-14."
    ),
  quoteUnread: z
    .boolean()
    .nullable()
    .optional()
    .describe("True when the post quotes a post (or ends with a link) that could not be read, so its drafts were written without it; false when the quoted post was read or the post quotes none; null when not known (posts stored before 2026-11-14 until the daily X run reads them, or not on X)."),
  repliedToPost: ReferencedPost.nullable()
    .optional()
    .describe("The post this post replies to, the same shape as quotedPost. Null: not a reply, or not known (see repliedToUnread). Known for posts read through the X API; a post added by hand without it leaves this unknown."),
  repliedToUnread: z
    .boolean()
    .nullable()
    .optional()
    .describe("True when the post replies to a post that could not be read; false when read or the post is not a reply; null when not known."),
  metrics: ReplyMetrics.nullable()
    .optional()
    .describe(
      "A posted reply on X: its public numbers as X reported them on the newest day they were read (once a day, the 14 days after posting, when Find posts on X is on). A null number is one X did not return, never a zero; null: never read."
    ),
  linkSource: z
    .enum(["person", "found_on_x"])
    .nullable()
    .optional()
    .describe("Who gave publishedUrl: found_on_x when it is the link GTF found on X by itself (or with find_reply_link), person otherwise (pasted, typed, matched, set_reply_link, or a replacement of a found one); null with no link."),
  linkSearch: LinkSearch.nullable().optional().describe("GTF's search on X for this reply's link; null when never searched."),
  linkFinding: LinkFindingView.optional(),
  aeoQueryId: z.string().nullable(),
  aiCitation: AiCitation.nullable()
    .optional()
    .describe("The sampled AI answers that cited this page: per prompt, the engines whose answer did. One run's sample, not a promise the engine reads the page. Null: none did."),
  selectedPlacementId: z.string().nullable(),
  lastSeenAt: z.string().nullable().describe("When a search last saw it again."),
  createdAt: z.string(),
  foundAt: z
    .string()
    .optional()
    .describe("When the product first found it (a person's own post: when they added it). The same instant as createdAt, named for what it means."),
  drafts: z.array(ReplyDraft),
});

const SearchRun = z.object({
  running: z.boolean().describe("A run is queued or going now."),
  lastCompletedAt: z.string().nullable().describe("When the newest run that completed ended; null when none has."),
  progress: z.string().nullable().describe("While running: \"Searching…\", \"Judging 23 of 60…\"; null otherwise."),
  nextAt: z.string().nullable().describe("The next scheduled run (UTC instant); a person can also start one with run_reply_discovery."),
});

export const LastDiscovery = z.object({
  web: SearchRun.describe("Web discovery: Reddit, GitHub, LinkedIn, X, Hacker News, Quora, Stack Exchange… through a search engine, Monday, Wednesday and Friday at 10:00 UTC."),
  x: SearchRun.nullable().describe("The daily X search for posts of the last hours; null when this site does not take part (Find posts on X off, or the platform has no X API)."),
});

const TargetOutput = z.object({ target: ReplyTarget });

/** "N of G today" and its list, as the Replies page shows it (lib/placements/today.ts). */
export const TodayReplies = z.object({
  posted: z.number().describe("Replies marked as posted today, in timeZone; replies marked as removed are not counted. What was recorded, never what is on the other site."),
  goal: z.number().nullable().describe("The person's daily goal (Settings → Voice, dailyReplyGoal); null when none is set."),
  timeZone: z.string().describe("The IANA zone \"today\" was read in: the one asked for, or UTC when it was missing or unknown."),
  replies: z
    .array(
      z.object({
        id: z.string().describe("The target's id, for get_reply_target."),
        surface: z.string(),
        author: z.string().nullable().describe("Who was answered; null when the source gave no author."),
        community: z.string().nullable(),
        url: z.string().describe("The post that was answered."),
        text: z.string().nullable().describe("The first line of the reply as posted (read back from X, else the draft marked as posted); null when no text is on record."),
        publishedAt: z.string(),
        publishedUrl: z.string().nullable().describe("The link to the reply itself; null until saved (set_reply_link)."),
        metrics: ReplyMetrics.nullable().describe("X's newest public numbers for the reply; null when none were read."),
        linkSource: z
          .enum(["person", "found_on_x"])
          .nullable()
          .optional()
          .describe("Who gave publishedUrl: found_on_x when GTF found it on X by itself, person otherwise; null with no link. Absent when the searches could not be read."),
      })
    )
    .optional()
    .describe("The replies counted in posted, newest first. Absent when their text could not be read: unknown, not none."),
});

const TodayZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .optional()
  .describe("The IANA time zone \"today\" is read in, e.g. Europe/Berlin. Absent or unknown: UTC, and timeZone says so.");

// ── Mapping a route's refusal to the API's ──────────────────────────────────

/** A lib function's `{ status, error }` refusal as the API's error. */
function refusal(result: { status: number; error: string; settingsHref?: string }): ToolError {
  switch (result.status) {
    case 400:
      return new ToolError("invalid_input", result.error, 400);
    case 404:
      return new ToolError("not_found", result.error, 404);
    case 409:
      return result.settingsHref
        ? new ToolError("prerequisite_missing", result.error, 409, HINTS.aboutYou)
        : new ToolError("invalid_state", result.error, 409);
    case 429:
      return new ToolError("cap_reached", result.error, 429, HINTS.caps);
    case 503:
      return new ToolError("unavailable", result.error, 503);
    default:
      return new ToolError("internal", result.error, 500);
  }
}

function draftRefusal(decided: Extract<DraftRequest, { ok: false }>): ToolError {
  switch (decided.code) {
    case "not_found":
      return new ToolError("not_found", decided.error, 404);
    case "prerequisite_missing":
      return new ToolError("prerequisite_missing", decided.error, 409, HINTS.aboutYou);
    case "cap_reached":
      return new ToolError("cap_reached", decided.error, 429, HINTS.caps);
    default:
      return new ToolError("invalid_state", decided.error, 409);
  }
}

/** A target with `linkFinding` set, for a posted reply with no link: what the reads say about the search. */
export function withLinkFinding<T extends PlacementTargetRecord>(target: T, finderOn: boolean, now: number): T & { linkFinding?: z.infer<typeof LinkFindingView> } {
  const finding: LinkFinding | null = linkFinding(target, { finderOn, now });
  if (!finding) return target;
  return {
    ...target,
    linkFinding: {
      state: finding.state,
      stopsBy: finding.state === "looking" ? finding.stopsBy : null,
      outcome: finding.state === "stopped" ? finding.outcome : null,
    },
  };
}

async function manualAction(ctx: ToolContext, targetId: string, input: ManualActionInput) {
  const result = await applyManualAction({ supabase: ctx.client, businessId: ctx.businessId, targetId, input });
  if (!result.ok) throw refusal(result);
  return { target: result.target };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export const listReplyInbox = defineTool({
  name: "list_reply_inbox",
  title: "List the reply inbox",
  description:
    "The posts and threads worth answering for this site, best first, each with its drafts. Filter by status (open by default: qualified, drafted, needs_review, approved; archive: the Today screen's Archive tab), platform (x, reddit, …), topic, and aiCited (only pages a sampled AI answer cited); page with limit and offset. The inbox reads at most 200 targets per filter.",
  input: z.object({
    status: z
      .enum(["open", "all", "archive", ...TARGET_STATUSES])
      .default("open")
      .describe(
        "open: what a person can still act on. published_manually: replies marked as posted. archive: skipped, filtered out, expired (open but past its window) and removed, as the Archive tab of Today lists them."
      ),
    platform: z.string().trim().min(1).max(40).optional(),
    topic: z.string().trim().min(1).max(200).optional(),
    aiCited: z.boolean().default(false).describe("true: only targets a sampled AI answer cited (aiCitation set)."),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).max(199).default(0),
    timeZone: TodayZone,
  }),
  output: z.object({
    targets: z.array(ReplyTarget),
    today: TodayReplies.describe("\"N of G today\" with the replies it counts, in timeZone, whatever the filter: what get_today_replies answers."),
    total: z.number().describe("Targets matching the filter, up to 200."),
    truncated: z.boolean().describe("True when 200 matched: there may be more."),
    offset: z.number(),
    limit: z.number(),
    nextOffset: z.number().nullable(),
    counts: z.record(z.string(), z.number()).describe("Targets per status, whatever the filter."),
    platforms: z.array(z.string()),
    topics: z.array(z.string()),
    draftingTargetIds: z.array(z.string()).describe("Targets whose draft is queued or being written."),
    missingLinkCount: z.number().describe("Replies marked as posted with no link recorded yet; replies marked as removed are not counted."),
    removalBySurface: z
      .record(
        z.string(),
        z.object({
          posted: z.number().describe("Replies marked as posted on this platform, removed ones included."),
          removed: z.number().describe("Of those, the ones marked as removed."),
          removalRate: z.number().nullable().describe("removed / posted; null when nothing was posted there."),
        })
      )
      .nullable()
      .describe("Per platform, posted replies and how many were marked as removed, as people recorded it. Null when it could not be read."),
    writerUseRecorded: z.boolean().describe("False until Settings → Voice → About you says how the writer uses the product; drafting is refused until then."),
    lastDiscovery: LastDiscovery.describe("When each search last completed, whether one is going, and when the next is scheduled."),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    const inbox = await loadInbox(ctx.client, ctx.businessId, {
      status: input.status,
      surface: input.platform ?? null,
      topic: input.topic ?? null,
      source: input.aiCited ? AI_CITED_FILTER : null,
      timeZone: input.timeZone ?? null,
    });
    const xStatus = inbox.findPostsOnX && isXApiEnabled() ? await readXApiStatus(ctx.admin()) : null;
    const finderOn = replyLinkFinderOn(xStatus, {
      findPostsOnX: Boolean(inbox.findPostsOnX),
      handleKnown: Boolean(inbox.xHandleKnown),
      ownerPays: xStatus && inbox.xHandleKnown ? await ownerPaysFor(ctx.client, ctx.userId) : false,
    });
    const now = Date.now();
    const page = inbox.targets.slice(input.offset, input.offset + input.limit).map((t) => withLinkFinding(t, finderOn, now));
    const next = input.offset + page.length;
    return {
      targets: page,
      // loadInbox always sets it; the fallback only satisfies the optional payload type.
      today: inbox.today ?? { posted: 0, goal: null, timeZone: "UTC" },
      total: inbox.targets.length,
      truncated: inbox.targets.length >= 200,
      offset: input.offset,
      limit: input.limit,
      nextOffset: next < inbox.targets.length ? next : null,
      counts: inbox.counts,
      platforms: inbox.surfaces,
      topics: inbox.topics,
      draftingTargetIds: inbox.draftingTargetIds ?? [],
      missingLinkCount: inbox.missingLinkCount ?? 0,
      removalBySurface: inbox.removalBySurface ?? null,
      writerUseRecorded: inbox.writer.useRecorded,
      lastDiscovery: lastDiscoveryOf(withXSearchOff(inbox.discovery, isXApiEnabled())),
    };
  },
});

/** The inbox's discovery state as the API says it. */
export function lastDiscoveryOf(discovery: DiscoveryState): z.infer<typeof LastDiscovery> {
  return {
    web: {
      running: discovery.running,
      lastCompletedAt: discovery.lastCompletedAt ?? null,
      progress: discovery.progress ?? null,
      nextAt: discovery.nextAt ?? null,
    },
    x: discovery.x ?? null,
  };
}

export const getTodayReplies = defineTool({
  name: "get_today_replies",
  title: "Get today's replies",
  description:
    "\"N of G today\" on the Replies page: how many replies were marked as posted today in the given time zone (replies marked as removed left out), the daily goal (change it with update_voice_settings, dailyReplyGoal), and those replies, newest first: who was answered, the first line of the reply, when, its link when saved, and X's numbers when read. A count of what was recorded, never of what is on the other site. Reads only today's rows; no model is asked.",
  input: z.object({ timeZone: TodayZone }),
  output: TodayReplies,
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    return loadToday(ctx.client, ctx.businessId, { timeZone: input.timeZone ?? null });
  },
});

export const getReplyTarget = defineTool({
  name: "get_reply_target",
  title: "Get a reply target",
  description:
    "One post or thread in the inbox with all its drafts and how its newest draft job stands (queued, running, declined with the reason, failed, completed).",
  input: z.object({ targetId: TargetId }),
  output: z.object({ target: ReplyTarget, draftJob: JobView.nullable() }),
  scope: "read",
  paid: false,
  owns: { targetId: "placement_targets" },
  async handler(ctx, input) {
    const target = await loadTarget(ctx.client, ctx.businessId, input.targetId);
    if (!target) throw new ToolError("not_found", "This post is no longer in your inbox.", 404);
    const latest = await findLatestDraft(ctx.client, ctx.businessId, input.targetId);
    const finderOn = linkFinding(target, { finderOn: true, now: Date.now() })
      ? await replyLinkFinderFor(ctx.admin(), ctx.client, ctx.businessId)
      : false;
    return {
      target: withLinkFinding(target, finderOn, Date.now()),
      draftJob: latest ? await readJob(ctx.client, ctx.businessId, latest.id) : null,
    };
  },
});

export const getReplyIntentUrl = defineTool({
  name: "get_reply_intent_url",
  title: "Get the Reply on X link",
  description:
    "The X web-intent link that opens X's composer as a reply to the post, with the draft already typed in. A person opens it, reads the reply and presses Post on X: the product never posts. Uses the given draft, else the best one. url is null when the post is not on X or the text is too long for a link; then copy body and open threadUrl.",
  input: z.object({ targetId: TargetId, draftId: DraftId.optional() }),
  output: z.object({
    url: z.string().nullable(),
    reason: z.enum(["not_an_x_post", "too_long"]).nullable(),
    threadUrl: z.string(),
    draftId: z.string(),
    body: z.string(),
  }),
  scope: "read",
  paid: false,
  owns: { targetId: "placement_targets", draftId: "placements" },
  async handler(ctx, input) {
    const target = await loadTarget(ctx.client, ctx.businessId, input.targetId);
    if (!target) throw new ToolError("not_found", "This post is no longer in your inbox.", 404);
    const draft = input.draftId ? target.drafts.find((d) => d.id === input.draftId) : preferredDraft(target.drafts);
    if (!draft) {
      if (input.draftId) throw new ToolError("not_found", "That draft is not one of this post's.", 404);
      throw new ToolError("invalid_state", "This post has no draft yet.", 409, "Call draft_reply, or write_own_reply.");
    }
    const url = xReplyIntentUrl(target.url, draft.body);
    const reason = url ? null : xStatusIdOf(target.url) ? ("too_long" as const) : ("not_an_x_post" as const);
    return { url, reason, threadUrl: target.url, draftId: draft.id, body: draft.body };
  },
});

// ── Finding and drafting (paid) ─────────────────────────────────────────────

export const runReplyDiscovery = defineTool({
  name: "run_reply_discovery",
  title: "Run discovery",
  description:
    "Looks for new public conversations worth answering for this site, as the weekly sweep does, and judges them. Answers with the job after waiting up to waitSeconds; it keeps running after that, and get_job says how it ended. Finds and judges only: posts nothing.",
  input: z.object({ waitSeconds: WaitSeconds }),
  output: z.object({
    jobId: z.string().nullable(),
    status: z.string(),
    alreadyRunning: z.boolean(),
    providers: z.array(z.string()),
    job: JobView.nullable(),
  }),
  scope: "write",
  paid: true,
  async handler(ctx, input) {
    const admin = ctx.admin();
    const started = await requestDiscovery({ admin, userId: ctx.userId, businessId: ctx.businessId });
    if (!started.ok) throw new ToolError("unavailable", started.error, 503);

    let jobId = started.jobId;
    if (jobId && !started.alreadyRunning) {
      await runJobWithin(admin, jobId, { budgetMs: DISCOVERY_BUDGET_MS, waitMs: input.waitSeconds * 1000 });
    } else {
      const { data } = await ctx.client
        .from("jobs")
        .select("id")
        .eq("business_id", ctx.businessId)
        .eq("type", PLACEMENT_DISCOVERY)
        .in("status", ["pending", "running"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      jobId = (data?.id as string | undefined) ?? null;
    }
    const job = jobId ? await readJob(ctx.client, ctx.businessId, jobId) : null;
    if (!started.alreadyRunning) await reportJobCost(ctx.reportCost, admin, job);
    return { jobId, status: job?.status ?? "running", alreadyRunning: started.alreadyRunning, providers: started.providers, job };
  },
});

export const addXPostTool = defineTool({
  name: "add_x_post",
  title: "Add a post from X",
  description:
    "Brings one post on X into the inbox by its link (x.com/<name>/status/<id>), qualified by you, and starts its draft. If X will not hand the post over, pass its text too. The draft job is started, not waited for: follow it with draft_reply on the target (which runs it now) or get_job.",
  input: AddXPostBody.extend({
    url: AddXPostBody.shape.url.describe("The post's own link, like https://x.com/name/status/1234567890."),
  }),
  output: z.object({
    outcome: z.enum(["created", "reopened", "already_open", "published"]),
    textFrom: z.enum(["x", "pasted", "stored"]),
    target: ReplyTarget,
    draft: z.object({
      started: z.boolean(),
      jobId: z.string().nullable(),
      error: z.string().nullable(),
      hint: z.string().optional(),
    }),
  }),
  scope: "write",
  paid: true,
  async handler(ctx, input) {
    const added = await addXPost({
      supabase: ctx.client,
      admin: ctx.admin(),
      userId: ctx.userId,
      businessId: ctx.businessId,
      url: input.url,
      pastedText: input.text ?? null,
    });
    if (!added.ok) {
      throw new ToolError(
        "invalid_input",
        added.error,
        400,
        added.code === "text_needed" ? "Pass the post's text as text, and add it again." : undefined
      );
    }
    const { settingsHref, ...draft } = added.draft;
    return {
      outcome: added.outcome,
      textFrom: added.textFrom,
      target: added.target,
      draft: settingsHref ? { ...draft, hint: HINTS.aboutYou } : draft,
    };
  },
});

export const draftReply = defineTool({
  name: "draft_reply",
  title: "Draft a reply",
  description:
    "Writes the reply for one target in the owner's voice, judged by the gate (a model call). If a draft job for it is already queued or running, follows that one instead of starting another. Answers after waiting up to waitSeconds with the job's status, and the target with its drafts once it completed; otherwise poll get_job. anyway: write it even after the drafter declined the post.",
  input: z.object({
    targetId: TargetId,
    anyway: z.boolean().default(false),
    waitSeconds: WaitSeconds,
  }),
  output: z.object({
    jobId: z.string().nullable(),
    status: z.string(),
    alreadyRunning: z.boolean(),
    job: JobView.nullable(),
    target: ReplyTarget.nullable().describe("Set once the job completed: the drafts are on it."),
  }),
  scope: "write",
  paid: true,
  owns: { targetId: "placement_targets" },
  async handler(ctx, input) {
    const admin = ctx.admin();
    const active = await findActiveDraft(admin, ctx.businessId, input.targetId);
    const decided = await requestDraft({
      supabase: ctx.client,
      admin,
      userId: ctx.userId,
      businessId: ctx.businessId,
      targetId: input.targetId,
      mode: active ? "continue" : "start",
      anyway: input.anyway,
    });
    if (!decided.ok) throw draftRefusal(decided);

    const next = decided.next;
    let jobId: string | null = null;
    let alreadyRunning = Boolean(active);
    if (next.kind === "run") {
      jobId = next.jobId;
      await runJobWithin(admin, jobId, { budgetMs: DRAFT_BUDGET_MS, waitMs: input.waitSeconds * 1000 });
    } else if (next.kind === "running") {
      jobId = next.jobId;
      alreadyRunning = true;
    } else if (next.kind === "failed" || next.kind === "completed") {
      jobId = next.jobId;
    }

    const job = jobId ? await readJob(ctx.client, ctx.businessId, jobId) : null;
    // The cost of a job this call ran, once it finished; a job only followed was paid for by its own call.
    if (next.kind === "run") await reportJobCost(ctx.reportCost, admin, job);
    const target = job?.status === "completed" ? await loadTarget(ctx.client, ctx.businessId, input.targetId) : null;
    return { jobId, status: job?.status ?? "running", alreadyRunning, job, target };
  },
});

export const correctReplyDraft = defineTool({
  name: "correct_reply_draft",
  title: "Fix a draft with a note",
  description:
    "Says what is wrong with a draft (\"too long\", \"sounds like AI\", \"use one of my numbers\"); the note is kept, and the draft is rewritten once following it (one model call) and judged again by the gate. Pass body when you edited the text first. Capped daily.",
  input: z.object({
    draftId: DraftId,
    reason: FeedbackReason.describe("What is wrong with the draft, 3 to 300 characters."),
    body: z.string().trim().min(1).max(20_000).optional().describe("The text as you edited it; the stored draft otherwise."),
  }),
  output: z.object({ draft: ReplyDraft, audit: Audit, targetStatus: z.enum(TARGET_STATUSES), feedbackId: z.string() }),
  scope: "write",
  paid: true,
  owns: { draftId: "placements" },
  async handler(ctx, input) {
    const capped = await correctionCapacityDenial(ctx.client, ctx.userId);
    if (capped) throw new ToolError("cap_reached", capped.error, 429, HINTS.caps);
    const result = await correctDraft({
      supabase: ctx.client,
      admin: ctx.admin(),
      userId: ctx.userId,
      businessId: ctx.businessId,
      draftId: input.draftId,
      reason: input.reason,
      body: input.body ?? null,
      signal: AbortSignal.timeout(CORRECTION_DEADLINE_MS),
    });
    if (!result.ok) throw refusal(result);
    return { draft: result.draft, audit: result.audit, targetStatus: result.targetStatus, feedbackId: result.feedbackId };
  },
});

// ── Editing (free) ──────────────────────────────────────────────────────────

const DraftOutput = z.object({ draft: ReplyDraft, targetStatus: z.enum(TARGET_STATUSES) });

export const editReplyDraft = defineTool({
  name: "edit_reply_draft",
  title: "Edit a draft",
  description:
    "Replaces a draft's text. The gate judges it again on every save; a reply never gets a link added, and a URL you paste stays for the gate to refuse. linkUrl only matters for the long variants that carry the site's link.",
  input: EditDraftBody.extend({ draftId: DraftId }),
  output: DraftOutput,
  scope: "write",
  paid: false,
  owns: { draftId: "placements" },
  async handler(ctx, input) {
    const result = await editDraft({
      supabase: ctx.client,
      businessId: ctx.businessId,
      draftId: input.draftId,
      body: input.body,
      linkUrl: input.linkUrl ?? null,
    });
    if (!result.ok) throw refusal(result);
    return { draft: result.draft, targetStatus: result.targetStatus };
  },
});

export const writeOwnReply = defineTool({
  name: "write_own_reply",
  title: "Write your own reply",
  description:
    "Stores a reply you wrote yourself on an open target, judged by the same gate as every draft; no model is called. A second one on the same target replaces the first.",
  input: z.object({ targetId: TargetId, body: z.string().trim().min(1).max(OWN_REPLY_MAX) }),
  output: DraftOutput,
  scope: "write",
  paid: false,
  requiresSubscription: true,
  owns: { targetId: "placement_targets" },
  async handler(ctx, input) {
    const saved = await saveOwnReply({
      supabase: ctx.client,
      admin: ctx.admin(),
      userId: ctx.userId,
      businessId: ctx.businessId,
      targetId: input.targetId,
      body: input.body,
    });
    if (!saved.ok) throw refusal(saved);
    return { draft: saved.draft, targetStatus: saved.targetStatus };
  },
});

// ── The manual workflow ─────────────────────────────────────────────────────

export const markReplyPosted = defineTool({
  name: "mark_reply_posted",
  title: "Mark as posted",
  description:
    "Records that the person posted the reply (\"I posted it\"). Optionally the link to their own posted reply (not the thread's), the draft that went out, and a note. The link can also be added later with set_reply_link. This records; it never posts.",
  input: z.object({
    targetId: TargetId,
    link: z.string().trim().max(2000).optional().describe("The link to the person's own reply, e.g. https://x.com/you/status/…"),
    draftId: DraftId.optional(),
    note: z.string().trim().max(1000).optional(),
  }),
  output: TargetOutput,
  scope: "write",
  paid: false,
  owns: { targetId: "placement_targets", draftId: "placements" },
  handler: (ctx, input) =>
    manualAction(ctx, input.targetId, {
      action: "mark_published",
      publishedUrl: input.link ?? null,
      placementId: input.draftId,
      note: input.note,
    }),
});

export const unmarkReplyPosted = defineTool({
  name: "unmark_reply_posted",
  title: "Undo I posted it",
  description:
    "The Undo of mark_reply_posted, for a reply marked as posted by mistake: the target goes back to the open inbox (drafted) with its drafts untouched, and stops counting toward today's replies. Refused (409) once the reply's link is saved or it is marked as removed: the record is then more than a tap. Changes nothing on X.",
  input: z.object({ targetId: TargetId }),
  output: TargetOutput,
  scope: "write",
  paid: false,
  owns: { targetId: "placement_targets" },
  handler: (ctx, input) => manualAction(ctx, input.targetId, { action: "unmark_published" }),
});

export const setReplyLink = defineTool({
  name: "set_reply_link",
  title: "Add the reply's link",
  description:
    "Saves the link to the person's own posted reply on a target already marked as posted. It must be a reply on the same platform, never the thread's own link; the reply's text is then read back from X.",
  input: z.object({ targetId: TargetId, link: z.string().trim().min(1).max(2000) }),
  output: TargetOutput,
  scope: "write",
  paid: false,
  owns: { targetId: "placement_targets" },
  handler: (ctx, input) => manualAction(ctx, input.targetId, { action: "set_published_url", publishedUrl: input.link }),
});

export const pasteReplyLinks = defineTool({
  name: "paste_reply_links",
  title: "Paste your reply links",
  description: `Today's "Paste your reply links": up to ${MAX_LINKS_PER_PASTE} links to the person's own posted replies at once, each matched to the posted reply still missing its link. On X the reply's text is read back through X's public oEmbed (free, no key) and compared with the draft that was posted; a link is saved only when exactly one reply matches it closely, through set_reply_link's path. Anything less sure is not saved: it comes back in picks with the candidate targets, and the person says which (then set_reply_link). Never guesses; never posts.`,
  input: z.object({
    links: z
      .array(z.string().trim().min(1).max(2000))
      .min(1)
      .max(MAX_LINKS_PER_PASTE)
      .describe("Links to the person's own replies, e.g. https://x.com/you/status/…; never the threads' own links."),
  }),
  output: z.object({
    saved: z.array(z.object({ link: z.string(), targetId: z.string() })).describe("Saved on the reply they belong to."),
    picks: z
      .array(z.object({ link: z.string(), candidateIds: z.array(z.string()), why: z.string() }))
      .describe("Not sure: the targets it could be. Ask the person, then set_reply_link."),
    refused: z.array(z.object({ link: z.string(), error: z.string() })).describe("Not saved, with the reason."),
  }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    const matched = await matchPastedReplyLinks({ supabase: ctx.client, businessId: ctx.businessId, links: input.links });
    if (!matched.ok) throw new ToolError("internal", `Could not read the posted replies: ${matched.error}`, 500);
    const saved: Array<{ link: string; targetId: string }> = [];
    const picks: Array<{ link: string; candidateIds: string[]; why: string }> = [];
    const refused: Array<{ link: string; error: string }> = [];
    for (const match of matched.matches) {
      if (match.kind === "pick") picks.push({ link: match.link, candidateIds: match.candidateIds, why: match.why });
      else if (match.kind === "refused") refused.push({ link: match.link, error: match.error });
      else {
        const result = await applyManualAction({
          supabase: ctx.client,
          businessId: ctx.businessId,
          targetId: match.targetId,
          input: { action: "set_published_url", publishedUrl: match.link },
        });
        if (result.ok) saved.push({ link: match.link, targetId: match.targetId });
        else refused.push({ link: match.link, error: result.error });
      }
    }
    return { saved, picks, refused };
  },
});

export const findReplyLink = defineTool({
  name: "find_reply_link",
  title: "Find the reply's link on X",
  description: `Searches X now for the link of a reply the person marked as posted on X and saves it when it is surely their own reply to that post (by the site's X account, in that thread, made around when it was marked as posted; when several could be it, the one whose words match the draft that was posted, else nothing is saved). GTF also does this by itself 2 min, 15 min, 2 h and 12 h after I posted it; this is the same search, now. One X search, counted against the reply's ${LINK_SEARCH_MAX_ATTEMPTS} searches and the platform's monthly limit on X. Needs Find posts on X on (update_voice_settings findPostsOnX), a reply posted in the last 7 days with no link, and the site's X account known from one reply link saved before. Reads X; never posts there.`,
  input: z.object({ targetId: TargetId }),
  output: z.object({
    outcome: z
      .enum(["found", "not_found", "other_replies", "ambiguous", "not_saved", "error"])
      .describe("found: the link is saved (linkSource found_on_x). Anything else saved nothing."),
    message: z.string(),
    linkUrl: z.string().nullable().describe("The link saved, when found."),
    target: ReplyTarget,
  }),
  scope: "write",
  paid: true,
  owns: { targetId: "placement_targets" },
  async handler(ctx, input) {
    const result = await findReplyLinkNow({
      supabase: ctx.client,
      admin: ctx.admin(),
      businessId: ctx.businessId,
      targetId: input.targetId,
    });
    if (!result.ok) {
      const status = result.code === "not_found" ? 404 : result.code === "unavailable" ? 503 : 409;
      throw new ToolError(result.code, result.error, status);
    }
    if (result.outcome !== "error") ctx.reportCost?.(result.costUsd);
    const target = await loadTarget(ctx.client, ctx.businessId, input.targetId);
    if (!target) throw new ToolError("not_found", "This post is no longer in your inbox.", 404);
    return {
      outcome: result.outcome,
      message: result.message,
      linkUrl: result.url,
      target: withLinkFinding(target, result.finding?.state === "looking", Date.now()),
    };
  },
});

export const markReplyRemoved = defineTool({
  name: "mark_reply_removed",
  title: "It was removed",
  description: `Records that a reply already marked as posted was removed or hidden by the site (a moderator, a new account's comments hidden, deleted by the person). The target stays published_manually, with removedAt and the optional reason; it no longer asks for its link and is not used as a voice example. Only on a posted target not already marked. Typical reasons: ${REMOVED_REASON_PRESETS.map((r) => `"${r}"`).join(", ")}. unmark_reply_removed undoes it.`,
  input: z.object({
    targetId: TargetId,
    reason: z.string().trim().max(REMOVED_REASON_MAX).optional().describe(`Why, up to ${REMOVED_REASON_MAX} characters.`),
  }),
  output: TargetOutput,
  scope: "write",
  paid: false,
  owns: { targetId: "placement_targets" },
  handler: (ctx, input) => manualAction(ctx, input.targetId, { action: "mark_removed", reason: input.reason }),
});

export const unmarkReplyRemoved = defineTool({
  name: "unmark_reply_removed",
  title: "Undo removed",
  description: "Undoes mark_reply_removed on a posted target: the removal and its reason are cleared, and the reply counts as up again.",
  input: z.object({ targetId: TargetId }),
  output: TargetOutput,
  scope: "write",
  paid: false,
  owns: { targetId: "placement_targets" },
  handler: (ctx, input) => manualAction(ctx, input.targetId, { action: "unmark_removed" }),
});

export const snoozeReplyTarget = defineTool({
  name: "snooze_reply_target",
  title: "Snooze",
  description: "Hides an open target from the inbox for some days (7 by default); it keeps its status and drafts.",
  input: z.object({ targetId: TargetId, days: z.number().int().min(1).max(90).default(7) }),
  output: TargetOutput,
  scope: "write",
  paid: false,
  owns: { targetId: "placement_targets" },
  handler: (ctx, input) => manualAction(ctx, input.targetId, { action: "snooze", snoozeDays: input.days }),
});

export const dismissReplyTarget = defineTool({
  name: "dismiss_reply_target",
  title: "Skip",
  description: "Skips a target: it leaves the open inbox, with an optional reason. reopen_reply_target brings it back.",
  input: z.object({ targetId: TargetId, reason: z.string().trim().max(300).optional() }),
  output: TargetOutput,
  scope: "write",
  paid: false,
  owns: { targetId: "placement_targets" },
  handler: (ctx, input) => manualAction(ctx, input.targetId, { action: "dismiss", reason: input.reason }),
});

export const reopenReplyTarget = defineTool({
  name: "reopen_reply_target",
  title: "Bring back",
  description: "Brings a skipped or rejected target back into the open inbox, qualified.",
  input: z.object({ targetId: TargetId }),
  output: TargetOutput,
  scope: "write",
  paid: false,
  owns: { targetId: "placement_targets" },
  handler: (ctx, input) => manualAction(ctx, input.targetId, { action: "reopen" }),
});

export const getReplyMetrics = defineTool({
  name: "get_reply_metrics",
  title: "Get the numbers of posted replies",
  description:
    "The public numbers of the replies posted on X from this site (views, likes, replies, reposts, quotes, bookmarks), as X reported them, one snapshot per day. They are read once a day for the 14 days after a reply is posted, only for replies whose link was saved and only while Find posts on X is on (Settings → Connections). A null number is one X did not return, never a zero; a reply with no snapshot was not read. Snapshots of X's public counters, not a total. Reads stored rows: no call to X.",
  input: z.object({
    targetId: TargetId.optional().describe("One posted reply's target; all recent posted replies on X when left out."),
    days: z.number().int().min(1).max(60).default(14).describe("How many days of snapshots to return."),
  }),
  output: z.object({
    replies: z.array(
      z.object({
        targetId: z.string(),
        url: z.string().describe("The post that was answered."),
        publishedUrl: z.string().nullable().describe("The reply itself."),
        publishedAt: z.string().nullable(),
        latest: ReplyMetrics.nullable().describe("The newest snapshot; null when none was read."),
        history: z.array(ReplyMetrics).describe("Every snapshot in the window, newest first."),
      })
    ),
    measured: z.boolean().describe("False when the stored numbers could not be read at all: unknown, not zero."),
  }),
  scope: "read",
  paid: false,
  owns: { targetId: "placement_targets" },
  async handler(ctx, input) {
    let query = ctx.client
      .from("placement_targets")
      .select("id, url, published_url, published_at")
      .eq("business_id", ctx.businessId)
      .eq("surface", "x")
      .eq("status", "published_manually")
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(100);
    if (input.targetId) query = query.eq("id", input.targetId);
    const { data, error } = await query;
    if (error) throw new ToolError("internal", `Could not read the posted replies: ${error.message}`, 500);
    const rows = (data ?? []) as Array<{ id: string; url: string; published_url: string | null; published_at: string | null }>;
    if (input.targetId && rows.length === 0) {
      throw new ToolError("not_found", "That post has no reply marked as posted on X.", 404);
    }
    const history = await loadReplyMetricsHistory(ctx.client, ctx.businessId, {
      targetIds: rows.map((r) => r.id),
      days: input.days,
    });
    return {
      measured: history !== null,
      replies: rows.map((row) => {
        const list = history?.get(row.id) ?? [];
        return {
          targetId: row.id,
          url: row.url,
          publishedUrl: row.published_url ?? null,
          publishedAt: row.published_at ?? null,
          latest: list[0] ?? null,
          history: list,
        };
      }),
    };
  },
});

export const getReplyStats = defineTool({
  name: "get_reply_stats",
  title: "Get the week on X",
  description:
    "Results → Replies on X: the replies posted on X from this site in the last 7 days against the 7 before, summed. Per week: `posted`, `measured` (link saved and numbers from X), `withoutLink`, and over the measured replies the sums of `views` (impressions), `likes`, `replies` (received) and `reposts`; `change` is this week minus the week before. They are X's running public counters, read once a day: a week's sum is the views so far of the replies posted in it, not views that happened during it, and the week before is read as of its own last day (`asOfDay`) so the two compare like with like. `top`: this week's 3 most viewed replies with their text, link, thread and numbers. `followers`: the site's own X account (the handle its saved reply links name), read once a day, with the change over 7 days when both ends were read. A null is not measured, never 0. `status` says whether the numbers are read at all (Find posts on X, Settings → Connections). Profile visits are not in X's public numbers. Reads stored rows: no call to X.",
  input: z.object({}),
  output: ReplyStats,
  scope: "read",
  paid: false,
  async handler(ctx) {
    try {
      return await loadReplyStats(ctx.client, ctx.businessId, { xApiEnabled: isXApiEnabled() });
    } catch (err) {
      throw new ToolError("internal", `Could not read the posted replies: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
  },
});

export const REPLIES_TOOLS = [
  listReplyInbox,
  getTodayReplies,
  getReplyTarget,
  getReplyMetrics,
  getReplyStats,
  runReplyDiscovery,
  addXPostTool,
  draftReply,
  editReplyDraft,
  writeOwnReply,
  correctReplyDraft,
  getReplyIntentUrl,
  markReplyPosted,
  unmarkReplyPosted,
  setReplyLink,
  pasteReplyLinks,
  findReplyLink,
  markReplyRemoved,
  unmarkReplyRemoved,
  snoozeReplyTarget,
  dismissReplyTarget,
  reopenReplyTarget,
] as const;
