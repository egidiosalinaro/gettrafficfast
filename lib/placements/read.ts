import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditResult, DraftClaim, PlacementVariant } from "./audit";
import { compareSurfaces } from "./surfaces";
import { OPEN_STATUSES, type TargetStatus } from "./workflow";
import { draftFailureForCard, type DraftFailureKind } from "./draft-progress";
import { missingPublishedLink } from "./published-url";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { parseAiCitation, type AiCitation } from "./ai-citation";
import { loadReplyMetrics } from "./reply-metrics-read";
import type { ReplyMetrics } from "./reply-metrics";
import { loadMedia, parseMedia, withMedia, type PostMediaItem } from "./media";
import { loadReferenced, parseReferenced, referencedView, withReferenced, type ReferencedPost } from "./referenced";
import { loadRemovals, removalBySurface, withRemoval, type SurfaceRemoval } from "./removed";
import { linkSourceOf, loadLinkSearches, withLinkSearch, type LinkSearchRecord, type LinkSource } from "./reply-link";
import { mostFrequentHandle } from "./x-handle";
import { ARCHIVE_STATUS, inView, orderInbox, viewCounts, type InboxViewId, type ViewRow } from "./inbox-view";
import {
  postedTodayRows,
  safeTimeZone,
  todayReplies,
  todayWindowStart,
  type TodayCount,
  type TodayReply,
  type TodayReplyDetail,
} from "./today";
import { businessHostname } from "@/lib/domain/business-display";
import { discoveryProgressText } from "./discovery-progress";
import { WEB_DISCOVERY_SCHEDULE, X_SEARCH_SCHEDULE, nextScheduledRun } from "./schedule";

/**
 * What the Placements inbox reads, assembled once, through the caller's own
 * Supabase client so RLS is the access control and `business_id` the scope.
 */

export interface PlacementDraftRecord {
  id: string;
  variant: PlacementVariant;
  body: string;
  linkUrl: string | null;
  claims: DraftClaim[];
  audit: AuditResult;
  auditStatus: AuditResult["status"];
  agentVersion: number;
  updatedAt: string;
}

export interface PlacementTargetRecord {
  id: string;
  surface: string;
  kind: string;
  url: string;
  title: string;
  excerpt: string | null;
  community: string | null;
  author: string | null;
  /** When it was posted; with a precision, the latest instant the source allows. */
  postedAt: string | null;
  /** Width of the interval before `postedAt` when the source gave a day or a distance; null for an instant or when unknown. */
  postedAtPrecision: "day" | "week" | "month" | "year" | null;
  score: number | null;
  commentCount: number | null;
  foundFor: string | null;
  foundVia: string | null;
  status: TargetStatus;
  qualifyScore: number | null;
  qualifyReason: string | null;
  qualifyAngle: string | null;
  qualifiedBy: string | null;
  qualifiedAt: string | null;
  topic: string | null;
  intent: string | null;
  freshUntil: string | null;
  snoozedUntil: string | null;
  reviewNote: string | null;
  dismissedReason: string | null;
  publishedUrl: string | null;
  publishedAt: string | null;
  publishedNote: string | null;
  /**
   * The reply's text as published, read back from X when its link was saved
   * (`lib/placements/published-text.ts`); null when not read yet or not
   * readable. `TARGET_COLUMNS` reads it (migration 20261109120000 is in
   * production), so the inbox, the action route and Add a post carry it; it
   * stays optional because a row read with another column list has no such
   * key, and absent is not "read and empty".
   */
  publishedText?: string | null;
  aeoQueryId: string | null;
  /**
   * The sampled AI Visibility sighting the row rests on
   * (lib/placements/ai-citation.ts): which prompt, which engines. Null when
   * no sampled answer cited the page. Optional for the same reason as
   * `publishedText`: a row read without the column has no such key.
   */
  aiCitation?: AiCitation | null;
  /**
   * The post's photos, videos and GIFs as X described them
   * (lib/placements/media.ts): null when never asked, [] when none.
   * Optional for the same reason as `aiCitation`: the columns are read
   * apart, and absent is unknown.
   */
  media?: PostMediaItem[] | null;
  /** True when the post has media that could not be read; null when not known. */
  mediaUnread?: boolean | null;
  /**
   * The post this one quotes (lib/placements/referenced.ts), `text` null when
   * it could not be read; null when it quotes none or it is not known.
   * Optional for the same reason as `media`: the column is read apart.
   */
  quotedPost?: ReferencedPost | null;
  /** True when it quotes a post that could not be read; false when read or none; null when not known. */
  quoteUnread?: boolean | null;
  /** The post this one replies to, the same way. */
  repliedToPost?: ReferencedPost | null;
  repliedToUnread?: boolean | null;
  /**
   * When the person marked the posted reply as removed from the site
   * (lib/placements/removed.ts); null when not removed. Optional for the
   * same reason as `aiCitation`: the columns are read apart, and absent is
   * unknown, not "not removed".
   */
  removedAt?: string | null;
  /** Why, in the person's words or one of the presets; null when not said. */
  removedReason?: string | null;
  /**
   * The newest daily snapshot of a posted reply's public numbers on X
   * (lib/placements/x-metrics.ts); null when none was read. Optional for the
   * same reason as `aiCitation`: absent means the numbers were not read
   * with this row, not that there are none.
   */
  metrics?: ReplyMetrics | null;
  /**
   * GTF's search on X for the link of this posted reply
   * (lib/placements/reply-link.ts): attempts made, how the last ended, the
   * link it found. Null when never searched. Optional for the same reason as
   * `aiCitation`: the table is read apart, and absent is unknown.
   */
  linkSearch?: LinkSearchRecord | null;
  /**
   * Who gave the saved link: "found_on_x" when it is the link GTF found on X,
   * "person" otherwise (pasted, typed, matched, or a replacement of a found
   * one); null with no link. Absent when the searches were not read.
   */
  linkSource?: LinkSource | null;
  selectedPlacementId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /**
   * When the product first found it (`created_at`: the first sighting, not
   * the last search that saw it again, which is `lastSeenAt`); for a post
   * the person added, when they added it. The same instant as `createdAt`,
   * named for what it means on screen and in the API. Optional: an older
   * payload has no such key.
   */
  foundAt?: string;
  drafts: PlacementDraftRecord[];
}

export interface DiscoveryState {
  running: boolean;
  /** When the newest web discovery job ended, whatever its outcome; null while none has. */
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastResult: Record<string, unknown> | null;
  /** When the newest web discovery that completed ended; null when none has. Absent on an older payload. */
  lastCompletedAt?: string | null;
  /** "Searching…", "Judging 23 of 60…" while a run is queued or going; null otherwise. Absent on an older payload. */
  progress?: string | null;
  /** The next scheduled web discovery (lib/placements/schedule.ts). Absent on an older payload. */
  nextAt?: string | null;
  /**
   * The daily X search of this site: null when it does not take part (Find
   * posts on X off, or the platform has no X API). Absent on an older payload.
   */
  x?: SearchRunState | null;
}

export interface SearchRunState {
  running: boolean;
  /** When the newest search that completed ended; null when none has. */
  lastCompletedAt: string | null;
  progress: string | null;
  nextAt: string | null;
}

/** The job type of the daily X search (lib/jobs/workflows/x-discovery.ts), said here to keep the page's bundle free of the workflow. */
const X_SEARCH_JOB = "x-post-discovery";
const WEB_DISCOVERY_JOB = "placement-discovery";

/**
 * A search's state from its newest jobs, newest first: going when the newest
 * is queued or running, the last one that completed, and what it is doing.
 */
export function searchRunState(jobs: Row[], nextAt: string | null, progressText: (job: Row) => string | null): SearchRunState {
  const newest = jobs[0] ?? null;
  const running = newest ? ["pending", "running"].includes(newest.status as string) : false;
  const completed = jobs.find((job) => job.status === "completed" && typeof job.finished_at === "string");
  return {
    running,
    lastCompletedAt: (completed?.finished_at as string | undefined) ?? null,
    progress: running && newest ? progressText(newest) : null,
    nextAt,
  };
}

/** Target ids with a draft job queued or running. Order is the jobs' order. */
export function draftingTargetIdsFromJobs(rows: { input?: unknown }[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const id = (row.input as { targetId?: unknown } | null)?.targetId;
    if (typeof id === "string" && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface DraftFailureNote {
  kind: DraftFailureKind;
  text: string;
}

/**
 * How the last draft job of each target ended, when it ended without text:
 * the decline with its reason, the pause, the failure, as the card shows it
 * (`draftFailureForCard`). Rows are the business's draft jobs, newest
 * first; only a target's newest job counts, so a draft written after a
 * failure clears it.
 */
export function lastDraftFailuresFromJobs(
  rows: { input?: unknown; status?: unknown; last_error?: unknown }[]
): Record<string, DraftFailureNote> {
  const seen = new Set<string>();
  const failures: Record<string, DraftFailureNote> = {};
  for (const row of rows) {
    const id = (row.input as { targetId?: unknown } | null)?.targetId;
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    if (row.status === "failed") {
      failures[id] = draftFailureForCard(typeof row.last_error === "string" ? row.last_error : null);
    }
  }
  return failures;
}

/**
 * Replies marked as posted with no link recorded: what the inbox reminds
 * about. A reply marked as removed (`removed_at`) has no link to find and is
 * not counted.
 */
export function countMissingLinks(rows: { status?: unknown; published_url?: unknown; removed_at?: unknown }[]): number {
  return rows.filter((row) =>
    missingPublishedLink({
      status: String(row.status ?? ""),
      publishedUrl: (row.published_url as string | null) ?? null,
      removedAt: typeof row.removed_at === "string" ? row.removed_at : null,
    })
  ).length;
}

export interface PlacementsInbox {
  targets: PlacementTargetRecord[];
  counts: Record<string, number>;
  surfaces: string[];
  topics: string[];
  discovery: DiscoveryState;
  /** Targets whose draft is queued or being written. Absent on an older payload. */
  draftingTargetIds?: string[];
  /**
   * Targets whose newest draft job ended without text, with what the card
   * says about it, so a decline or a failure survives a reload. Absent on an
   * older payload.
   */
  lastDraftFailures?: Record<string, DraftFailureNote>;
  /** Replies marked as posted with no link recorded yet, removed ones aside. Absent on an older payload. */
  missingLinkCount?: number;
  /**
   * Per surface, posted replies and how many were marked as removed, with
   * the rate (null when nothing was posted there). Absent on an older
   * payload, or when the removals could not be read: unknown, not zero.
   */
  removalBySurface?: Record<string, SurfaceRemoval>;
  /**
   * Open rows a sampled AI answer cited (`ai_citation`). Absent on an older
   * payload, or when the column could not be read: unknown, not zero.
   */
  aiCitedOpen?: number;
  /**
   * How many rows each list of the page holds (`INBOX_VIEWS`,
   * inbox-view.ts): "To reply", "Posted, no link", "Expired", … counted by
   * the rule the page shows them with. Absent on an older payload.
   */
  viewCounts?: Record<InboxViewId, number>;
  /**
   * Replies marked as posted today, the person's goal when they set one,
   * and the zone "today" was read in (today.ts). Absent on an older payload.
   */
  today?: TodayCount;
  aeoQueries: Array<{ id: string; query: string }>;
  /**
   * Whether Settings → Voice records how the writer uses the product. Drafts
   * speak as that user; with nothing recorded the inbox says so beside the
   * draft button instead of letting a click fail.
   */
  writer: { useRecorded: boolean };
  /**
   * Who answers, as the item shows it beside the draft: the business's name
   * and the host of its site, for its favicon. Null fields when not on
   * record; absent on an older payload.
   */
  business?: { name: string | null; domain: string | null };
  /**
   * The daily X search for this site, as the menu beside Run discovery says
   * it: null when it is not running (the site has it off, or the platform
   * has no X API), else whether this month's cap has stopped it and the line
   * that says so. Set by the route, which can read the platform's ledger;
   * absent on an older payload.
   */
  xSearch?: XSearchNotice | null;
  /** Whether this site's owner turned "Find posts on X" on. Absent on an older payload. */
  findPostsOnX?: boolean;
  /**
   * Whether the site's X account is known, from the links of its own posted
   * replies (`ownXHandle`'s rule): GTF can look for a reply's link only then.
   * Absent on an older payload.
   */
  xHandleKnown?: boolean;
  /**
   * Whether GTF looks for the links of this site's replies on X right now
   * (`replyLinkFinderOn`: the platform's X API, Find posts on X, the account
   * known, the owner paying, not paused, under the cap). Set by the route, which can read the
   * platform's ledger; absent on an older payload, read as off.
   */
  findsReplyLinks?: boolean;
}

export interface XSearchNotice {
  capReached: boolean;
  /** "Searching X is paused until Dec 1: this month's allowance for X is used up.", or null while it runs. */
  line: string | null;
}

/**
 * What the inbox page holds. The API and the page ship together, but a tab
 * left open across a deploy pairs new page code with a payload it already
 * had, or one an older server produced (GETTRAFFICFAST-7: `writer` was
 * added, and the page read `data.writer.useRecorded` off a payload without
 * it). Fields added after the first release are therefore optional here,
 * and read through `inboxWriterUseRecorded`, never crashed on.
 */
export type InboxPayload = Omit<PlacementsInbox, "writer"> & Partial<Pick<PlacementsInbox, "writer">>;

/**
 * Whether the payload says the business has recorded how it uses its
 * product. Unknown reads as recorded: the hint beside the draft button is
 * a courtesy, and a click still explains itself when the setting is empty.
 */
export function inboxWriterUseRecorded(inbox: Pick<InboxPayload, "writer">): boolean {
  return inbox.writer?.useRecorded ?? true;
}

type Row = Record<string, unknown>;

export const TARGET_COLUMNS =
  "id, surface, kind, url, title, excerpt, community, author, posted_at, posted_at_precision, score, comment_count, found_for, found_via, status, qualify_score, qualify_reason, qualify_angle, qualified_by, qualified_at, topic, intent, fresh_until, snoozed_until, review_note, dismissed_reason, published_url, published_at, published_note, published_text, aeo_query_id, selected_placement_id, last_seen_at, created_at";

export const DRAFT_COLUMNS =
  "id, target_id, variant, body, link_url, claims, audit, audit_status, agent_version, updated_at";

export function mapDraft(row: Row): PlacementDraftRecord {
  return {
    id: row.id as string,
    variant: row.variant as PlacementVariant,
    body: row.body as string,
    linkUrl: (row.link_url as string | null) ?? null,
    claims: Array.isArray(row.claims) ? (row.claims as DraftClaim[]) : [],
    audit: (row.audit as AuditResult) ?? { status: "blocked", checks: [] },
    auditStatus: row.audit_status as AuditResult["status"],
    agentVersion: Number(row.agent_version ?? 1),
    updatedAt: row.updated_at as string,
  };
}

export function mapTarget(row: Row, drafts: PlacementDraftRecord[] = []): PlacementTargetRecord {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const precision = (v: unknown): PlacementTargetRecord["postedAtPrecision"] =>
    v === "day" || v === "week" || v === "month" || v === "year" ? v : null;
  return {
    id: row.id as string,
    surface: row.surface as string,
    kind: (row.kind as string) || "thread",
    url: row.url as string,
    title: row.title as string,
    excerpt: str(row.excerpt),
    community: str(row.community),
    author: str(row.author),
    postedAt: str(row.posted_at),
    postedAtPrecision: precision(row.posted_at_precision),
    score: num(row.score),
    commentCount: num(row.comment_count),
    foundFor: str(row.found_for),
    foundVia: str(row.found_via),
    status: row.status as TargetStatus,
    qualifyScore: num(row.qualify_score),
    qualifyReason: str(row.qualify_reason),
    qualifyAngle: str(row.qualify_angle),
    qualifiedBy: str(row.qualified_by),
    qualifiedAt: str(row.qualified_at),
    topic: str(row.topic),
    intent: str(row.intent),
    freshUntil: str(row.fresh_until),
    snoozedUntil: str(row.snoozed_until),
    reviewNote: str(row.review_note),
    dismissedReason: str(row.dismissed_reason),
    publishedUrl: str(row.published_url),
    publishedAt: str(row.published_at),
    publishedNote: str(row.published_note),
    ...("published_text" in row ? { publishedText: str(row.published_text) } : {}),
    aeoQueryId: str(row.aeo_query_id),
    ...("ai_citation" in row ? { aiCitation: parseAiCitation(row.ai_citation) } : {}),
    ...("media" in row
      ? { media: parseMedia(row.media), mediaUnread: typeof row.media_unread === "boolean" ? row.media_unread : null }
      : {}),
    ...("referenced_posts" in row ? referencedView(parseReferenced(row.referenced_posts)) : {}),
    ...("removed_at" in row ? { removedAt: str(row.removed_at), removedReason: str(row.removed_reason) } : {}),
    ...("reply_metrics" in row ? { metrics: (row.reply_metrics as ReplyMetrics | null) ?? null } : {}),
    ...("link_search" in row
      ? {
          linkSearch: (row.link_search as LinkSearchRecord | null) ?? null,
          linkSource: linkSourceOf(str(row.published_url), (row.link_search as LinkSearchRecord | null) ?? null),
        }
      : {}),
    selectedPlacementId: str(row.selected_placement_id),
    lastSeenAt: str(row.last_seen_at),
    createdAt: row.created_at as string,
    foundAt: row.created_at as string,
    drafts,
  };
}

/** The `source` filter value for rows a sampled AI answer cited. */
export const AI_CITED_FILTER = "ai_visibility";

/**
 * The sightings of a site's rows, by target id; null when the column cannot
 * be read. `ai_citation` is read apart from `TARGET_COLUMNS` on purpose: the
 * column arrives with migration 20261110180000, and a select that names a
 * column the database does not have yet fails whole. Until that migration
 * is known to be in production, a failed read here costs the citation line
 * and nothing else. `ids` narrows the read to those rows.
 */
export async function loadAiCitations(
  supabase: SupabaseClient,
  businessId: string,
  ids?: readonly string[]
): Promise<Map<string, AiCitation> | null> {
  if (ids && ids.length === 0) return new Map();
  let query = supabase.from("placement_targets").select("id, ai_citation").eq("business_id", businessId);
  query = ids ? query.in("id", [...ids]) : query.not("ai_citation", "is", null).limit(500);
  const { data, error } = await query;
  if (error) return null;
  const out = new Map<string, AiCitation>();
  for (const row of (data ?? []) as Row[]) {
    const citation = parseAiCitation(row.ai_citation);
    if (citation) out.set(row.id as string, citation);
  }
  return out;
}

/** A target row with its newest reply numbers on it, when the numbers could be read. */
export function withReplyMetrics(row: Row, metrics: Map<string, ReplyMetrics> | null): Row {
  return metrics ? { ...row, reply_metrics: metrics.get(row.id as string) ?? null } : row;
}

/** A target row with its sighting on it, when the sightings could be read. */
export function withAiCitation(row: Row, citations: Map<string, AiCitation> | null): Row {
  return citations ? { ...row, ai_citation: citations.get(row.id as string) ?? null } : row;
}

export interface InboxFilter {
  /**
   * "open" (default), "all", "archive" (skipped, filtered out, expired and
   * removed: `ARCHIVE_STATUS`), or one status.
   */
  status: string;
  surface: string | null;
  topic: string | null;
  /** AI_CITED_FILTER: only rows a sampled AI answer cited. Anything else: no narrowing. */
  source?: string | null;
  /**
   * Targets to return whatever the filter says: the ones the person just
   * acted on, so a card that changed state stays on screen, marked as moved,
   * instead of vanishing. Same business, same RLS; a foreign id matches
   * nothing. Capped, because it is a courtesy, not a second query API.
   */
  include?: string[];
  /** The caller's IANA time zone, for "posted today". Unknown or absent: UTC. */
  timeZone?: string | null;
  /** The instant the lists and "today" are judged against. Defaults to now. */
  now?: Date;
}

const MAX_INCLUDE = 20;

/**
 * Every row of the business, in the few columns the counts need. Read in
 * pages: a single select stops at the API's row cap (1,000), and on
 * 2026-11-11 a site with 2,313 rows, 1,598 of them filtered out, lost its
 * posted replies past the cap: "Posted" vanished from the filter (a list
 * with no rows is not offered) and "N today" read 0 after two replies.
 * Ordered by id so the pages neither overlap nor skip.
 */
export const COUNT_PAGE = 1000;
const COUNT_COLUMNS =
  "id, status, surface, kind, topic, published_url, published_at, found_via, qualified_by, fresh_until, snoozed_until, posted_at, created_at";

export async function readAllCountRows(
  supabase: SupabaseClient,
  businessId: string,
  maxPages = 50
): Promise<{ data: Row[]; error: unknown }> {
  const rows: Row[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * COUNT_PAGE;
    const { data, error } = await supabase
      .from("placement_targets")
      .select(COUNT_COLUMNS)
      .eq("business_id", businessId)
      .order("id", { ascending: true })
      .range(from, from + COUNT_PAGE - 1);
    if (error) return { data: rows, error };
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < COUNT_PAGE) break;
  }
  return { data: rows, error: null };
}

/**
 * A count row (with its removal on it, `withRemoval`) as the lists' rules
 * read it: what `viewCounts` counts and the Archive picks its rows by.
 */
export function viewRowOf(row: Row, citations: Map<string, AiCitation> | null): ViewRow {
  return {
    status: String(row.status ?? ""),
    foundVia: (row.found_via as string | null) ?? null,
    qualifiedBy: (row.qualified_by as string | null) ?? null,
    freshUntil: (row.fresh_until as string | null) ?? null,
    snoozedUntil: (row.snoozed_until as string | null) ?? null,
    surface: (row.surface as string | null) ?? null,
    kind: (row.kind as string | null) ?? null,
    postedAt: (row.posted_at as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
    publishedUrl: (row.published_url as string | null) ?? null,
    removedAt: typeof row.removed_at === "string" ? row.removed_at : null,
    aiCitation: citations?.get(row.id as string) ?? null,
  };
}

/** Ids per `.in()` read: a list of uuids travels in the URL, kept well under its limit. */
const IDS_PER_READ = 100;

/**
 * The Archive's rows (2026-11-14): skipped, filtered out, expired and
 * removed. No status narrows them in one query (an expired row is open, a
 * removed one is posted, and expiry is a rule on dates and platforms), so
 * they are picked from every count row by the rule the count uses
 * (`inView(…, "archive")`), newest found first, at most `limit`, and read by
 * id. The count and the list are then the same rows, up to the cap.
 */
export function archiveIds(rows: readonly Row[], citations: Map<string, AiCitation> | null, now: number, limit: number): string[] {
  return rows
    .filter((row) => inView(viewRowOf(row, citations), "archive", now))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .slice(0, limit)
    .map((row) => row.id as string);
}

async function readTargetsByIds(
  supabase: SupabaseClient,
  businessId: string,
  ids: readonly string[]
): Promise<{ data: Row[]; error: { message: string } | null }> {
  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += IDS_PER_READ) chunks.push(ids.slice(at, at + IDS_PER_READ));
  const reads = await Promise.all(
    chunks.map((chunk) => supabase.from("placement_targets").select(TARGET_COLUMNS).eq("business_id", businessId).in("id", chunk))
  );
  const failed = reads.find((read) => read.error);
  if (failed?.error) return { data: [], error: failed.error };
  return { data: reads.flatMap((read) => (read.data ?? []) as Row[]), error: null };
}
/** At most this many rows in today's list: a day of replies, never a second inbox. */
export const TODAY_LIST_MAX = 100;

/**
 * Today's list (the popup behind "N of G today"): the count rows carry no
 * text and no author, so the rows the count picked are read once more, in
 * one small query of a few columns, with their drafts for a reply whose
 * text was not read back from X. Null when either read fails: the list is
 * then unknown, and the page says so instead of showing an empty day.
 */
export async function loadTodayReplies(
  supabase: SupabaseClient,
  businessId: string,
  picked: readonly Row[],
  metrics: Map<string, ReplyMetrics> | null
): Promise<TodayReply[] | null> {
  const ids = picked.map((row) => row.id as string).slice(0, TODAY_LIST_MAX);
  if (ids.length === 0) return [];
  // Only a reply posted on X is ever searched for its link (reply-link.ts).
  const onX = picked.filter((row) => ids.includes(row.id as string) && row.surface === "x").map((row) => row.id as string);
  const [{ data: rows, error }, { data: draftRows, error: draftError }, searches] = await Promise.all([
    supabase
      .from("placement_targets")
      .select("id, surface, author, community, url, published_at, published_url, published_text, selected_placement_id")
      .eq("business_id", businessId)
      .in("id", ids),
    supabase.from("placements").select("id, target_id, body").in("target_id", ids).order("created_at", { ascending: true }),
    loadLinkSearches(supabase, onX),
  ]);
  if (error || draftError) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const details = new Map<string, TodayReplyDetail>();
  for (const row of (rows ?? []) as Row[]) {
    details.set(row.id as string, {
      surface: String(row.surface ?? ""),
      author: str(row.author),
      community: str(row.community),
      url: String(row.url ?? ""),
      publishedAt: String(row.published_at ?? ""),
      publishedUrl: str(row.published_url),
      publishedText: str(row.published_text),
      selectedPlacementId: str(row.selected_placement_id),
    });
  }
  const drafts = new Map<string, { id: string; body: string }[]>();
  for (const row of (draftRows ?? []) as Row[]) {
    const list = drafts.get(row.target_id as string) ?? [];
    list.push({ id: row.id as string, body: String(row.body ?? "") });
    drafts.set(row.target_id as string, list);
  }
  return todayReplies(
    picked.filter((row) => ids.includes(row.id as string)),
    details,
    drafts,
    metrics,
    searches
  );
}

/**
 * "N of G today" with its list, without the inbox around it: what
 * `get_today_replies` answers. Only rows posted in the last 27 hours can be
 * today's in any zone (`todayWindowStart`), so the read is narrowed to
 * those, then the count's own rule picks them: the same rule, the same rows
 * as the inbox's count.
 */
export async function loadToday(
  supabase: SupabaseClient,
  businessId: string,
  options: { timeZone?: string | null; now?: Date } = {}
): Promise<TodayCount & { replies: TodayReply[] | undefined }> {
  const now = options.now ?? new Date();
  const timeZone = safeTimeZone(options.timeZone);
  const [{ data, error }, { data: businessRow }] = await Promise.all([
    supabase
      .from("placement_targets")
      .select("id, status, published_at, surface")
      .eq("business_id", businessId)
      .eq("status", "published_manually")
      .gte("published_at", todayWindowStart(now))
      .limit(1000),
    supabase.from("businesses").select("voice_settings").eq("id", businessId).maybeSingle(),
  ]);
  if (error) throw new Error(`placement targets: ${error.message}`);
  const candidates = (data ?? []) as Row[];
  const ids = candidates.map((row) => row.id as string);
  const [removals, metrics] = await Promise.all([loadRemovals(supabase, businessId, ids), loadReplyMetrics(supabase, businessId, ids)]);
  if (!removals) throw new Error("placement targets: the removals could not be read");
  const picked = postedTodayRows(
    candidates.map((row) => withRemoval(row, removals)),
    now,
    timeZone
  );
  const replies = await loadTodayReplies(supabase, businessId, picked, metrics);
  return {
    posted: picked.length,
    goal: parseVoiceSettings(businessRow?.voice_settings).dailyReplyGoal,
    timeZone,
    replies: replies ?? undefined,
  };
}

/**
 * The site's X account, from the count rows the inbox already read: the
 * rule of `ownXHandle` (the handle its own posted replies' links carry most
 * often, newest first on a tie), without another query.
 */
export function xHandleOf(rows: readonly Row[]): string | null {
  const posted = rows
    .filter((row) => row.surface === "x" && row.status === "published_manually" && typeof row.published_url === "string")
    .sort((a, b) => String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")));
  return mostFrequentHandle(posted.map((row) => row.published_url as string));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows the inbox reads per filter, and of them the posts the person chose, read apart so the cap never drops one. */
export const INBOX_LIMIT = 200;
const MINE_LIMIT = 100;

export async function loadInbox(
  supabase: SupabaseClient,
  businessId: string,
  filter: InboxFilter
): Promise<PlacementsInbox> {
  // Newest found first (2026-11-12): a row still inside its "To reply"
  // window was found inside it too, so the cap of 200 keeps the rows a
  // person can still answer and drops the oldest finds. Until then the cap
  // kept the best scores, which on a site with 322 open finds were mostly
  // threads months old. The posts the person chose never expire and are
  // read apart, so the cap is never what drops them. The order the page
  // shows is `orderInbox`, below.
  const narrowed = <Q extends { in: (c: string, v: readonly string[]) => Q; eq: (c: string, v: string) => Q }>(q: Q): Q => {
    let out = q;
    if (filter.status === "open") out = out.in("status", OPEN_STATUSES);
    else if (filter.status !== "all") out = out.eq("status", filter.status);
    if (filter.surface) out = out.eq("surface", filter.surface);
    if (filter.topic) out = out.eq("topic", filter.topic);
    return out;
  };
  let query = narrowed(
    supabase
      .from("placement_targets")
      .select(TARGET_COLUMNS)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(INBOX_LIMIT)
  );
  let mineQuery = narrowed(
    supabase
      .from("placement_targets")
      .select(TARGET_COLUMNS)
      .eq("business_id", businessId)
      .or("found_via.eq.manual,qualified_by.eq.person")
      .order("created_at", { ascending: false })
      .limit(MINE_LIMIT)
  );
  // Read first: the list may be narrowed to the rows that carry a sighting.
  const [citations, removals, replyMetrics] = await Promise.all([
    loadAiCitations(supabase, businessId),
    loadRemovals(supabase, businessId),
    loadReplyMetrics(supabase, businessId),
  ]);
  if (filter.source === AI_CITED_FILTER) {
    query = query.in("id", [...(citations?.keys() ?? [])]);
    mineQuery = mineQuery.in("id", [...(citations?.keys() ?? [])]);
  }
  const now = filter.now ?? new Date();

  // The Archive (2026-11-14) is picked from every row by its rule, then
  // read by id (`archiveIds`): the count rows are read first, and once.
  const archive = filter.status === ARCHIVE_STATUS;
  const counted = archive ? await readAllCountRows(supabase, businessId) : null;
  const archived = counted
    ? archiveIds(
        counted.data
          .map((row) => withRemoval(row, removals))
          .filter(
            (row) =>
              (!filter.surface || row.surface === filter.surface) &&
              (!filter.topic || row.topic === filter.topic) &&
              (filter.source !== AI_CITED_FILTER || Boolean(citations?.has(row.id as string)))
          ),
        citations,
        now.getTime(),
        INBOX_LIMIT
      )
    : null;
  const targetRead = archived ? readTargetsByIds(supabase, businessId, archived) : query;
  const mineRead = archived ? Promise.resolve({ data: [] as Row[] }) : mineQuery;

  const include = [...new Set((filter.include ?? []).filter((id) => UUID.test(id)))].slice(0, MAX_INCLUDE);
  const includeQuery = include.length
    ? supabase.from("placement_targets").select(TARGET_COLUMNS).eq("business_id", businessId).in("id", include)
    : Promise.resolve({ data: [] as Row[] });

  const [
    { data: targetRows, error },
    { data: mineRows },
    { data: countRows },
    { data: jobRows },
    { data: xJobRows },
    { data: queryRows },
    { data: businessRow },
    { data: includedRows },
    { data: draftJobRows },
    { data: draftHistoryRows },
  ] = await Promise.all([
      targetRead,
      mineRead,
      counted ? Promise.resolve(counted) : readAllCountRows(supabase, businessId),
      // The newest few: the one going, if any, and the last that completed.
      supabase
        .from("jobs")
        .select("status, current_step, finished_at, result, created_at")
        .eq("business_id", businessId)
        .eq("type", WEB_DISCOVERY_JOB)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("jobs")
        .select("status, current_step, finished_at, created_at")
        .eq("business_id", businessId)
        .eq("type", X_SEARCH_JOB)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase.from("aeo_queries").select("id, query").eq("business_id", businessId).order("query"),
      supabase.from("businesses").select("voice_settings, name, website_url").eq("id", businessId).maybeSingle(),
      includeQuery,
      supabase
        .from("jobs")
        .select("input")
        .eq("business_id", businessId)
        .eq("type", "placement-draft")
        .in("status", ["pending", "running"])
        .limit(20),
      // How the recent drafts ended, for the decline or failure sentence a
      // reload would otherwise lose. Bounded: an old failure is not news.
      supabase
        .from("jobs")
        .select("input, status, last_error")
        .eq("business_id", businessId)
        .eq("type", "placement-draft")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
  if (error) throw new Error(`placement targets: ${error.message}`);

  // Included rows that the filter did not already return go after the
  // list; the page puts each back where the person last saw it.
  const newest = (targetRows ?? []) as Row[];
  const newestIds = new Set(newest.map((t) => t.id as string));
  const listed = [...newest, ...((mineRows ?? []) as Row[]).filter((t) => !newestIds.has(t.id as string))];
  const listedIds = new Set(listed.map((t) => t.id as string));
  const targets = [...listed, ...((includedRows ?? []) as Row[]).filter((t) => !listedIds.has(t.id as string))];
  const ids = targets.map((t) => t.id as string);
  const countedRows = ((countRows ?? []) as Row[]).map((row) => withRemoval(row, removals));
  const timeZone = safeTimeZone(filter.timeZone);
  const pickedToday = postedTodayRows(countedRows, now, timeZone);
  const [{ data: draftRows }, media, referenced, todayList, linkSearches] = await Promise.all([
    ids.length
      ? supabase.from("placements").select(DRAFT_COLUMNS).in("target_id", ids).order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as Row[] }),
    loadMedia(supabase, businessId, ids),
    // What the posts on X quote and answer, read apart like the media.
    loadReferenced(
      supabase,
      businessId,
      targets.filter((row) => row.surface === "x").map((row) => row.id as string)
    ),
    loadTodayReplies(supabase, businessId, pickedToday, replyMetrics),
    // Only posted replies on X are ever searched for their link.
    loadLinkSearches(
      supabase,
      targets.filter((row) => row.status === "published_manually" && row.surface === "x").map((row) => row.id as string)
    ),
  ]);

  const draftsByTarget = new Map<string, PlacementDraftRecord[]>();
  for (const row of (draftRows ?? []) as Row[]) {
    const list = draftsByTarget.get(row.target_id as string) ?? [];
    list.push(mapDraft(row));
    draftsByTarget.set(row.target_id as string, list);
  }

  const counts: Record<string, number> = {};
  const surfaces = new Set<string>();
  const topics = new Set<string>();
  for (const row of countedRows) {
    counts[row.status as string] = (counts[row.status as string] ?? 0) + 1;
    if (row.surface) surfaces.add(row.surface as string);
    if (row.topic) topics.add(row.topic as string);
  }

  const webJobs = (jobRows ?? []) as Row[];
  const lastJob = webJobs[0] ?? null;
  const web = searchRunState(webJobs, nextScheduledRun(WEB_DISCOVERY_SCHEDULE, now).toISOString(), (job) =>
    discoveryProgressText({ status: job.status as string, currentStep: (job.current_step as string | null) ?? null, result: job.result })
  );
  const voice = parseVoiceSettings(businessRow?.voice_settings);
  return {
    targets: orderInbox(
      targets.map((row) =>
        mapTarget(
          withLinkSearch(
            withReferenced(
              withMedia(withReplyMetrics(withRemoval(withAiCitation(row, citations), removals), replyMetrics), media),
              referenced
            ),
            linkSearches
          ),
          draftsByTarget.get(row.id as string) ?? []
        )
      )
    ),
    viewCounts: viewCounts(
      countedRows.map((row) => viewRowOf(row, citations)),
      now.getTime()
    ),
    today: {
      posted: pickedToday.length,
      goal: voice.dailyReplyGoal,
      timeZone,
      ...(todayList ? { replies: todayList } : {}),
    },
    aiCitedOpen: citations
      ? ((countRows ?? []) as Row[]).filter(
          (row) => citations.has(row.id as string) && (OPEN_STATUSES as readonly string[]).includes(row.status as string)
        ).length
      : undefined,
    counts,
    surfaces: [...surfaces].sort(compareSurfaces),
    topics: [...topics].sort(),
    discovery: {
      running: lastJob ? ["pending", "running"].includes(lastJob.status as string) : false,
      lastFinishedAt: (lastJob?.finished_at as string | null) ?? null,
      lastStatus: (lastJob?.status as string | null) ?? null,
      lastResult: (lastJob?.result as Record<string, unknown> | null) ?? null,
      lastCompletedAt: web.lastCompletedAt,
      progress: web.progress,
      nextAt: web.nextAt,
      // Whether the platform has the X API on is the route's to say (`withXSearchOff`).
      x: voice.findPostsOnX
        ? searchRunState((xJobRows ?? []) as Row[], nextScheduledRun(X_SEARCH_SCHEDULE, now).toISOString(), () => "Searching X…")
        : null,
    },
    aeoQueries: ((queryRows ?? []) as Row[]).map((r) => ({ id: r.id as string, query: r.query as string })),
    writer: { useRecorded: voice.aboutYou.trim().length > 0 },
    findPostsOnX: voice.findPostsOnX,
    xHandleKnown: xHandleOf(countedRows) !== null,
    business: {
      name: typeof businessRow?.name === "string" && businessRow.name.trim() ? businessRow.name.trim() : null,
      domain: businessHostname(typeof businessRow?.website_url === "string" ? businessRow.website_url : null),
    },
    draftingTargetIds: draftingTargetIdsFromJobs((draftJobRows ?? []) as { input?: unknown }[]),
    lastDraftFailures: lastDraftFailuresFromJobs((draftHistoryRows ?? []) as Row[]),
    missingLinkCount: countMissingLinks(countedRows),
    removalBySurface: removals ? removalBySurface(countedRows) : undefined,
  };
}
