import type { SupabaseClient } from "@supabase/supabase-js";
import type { Discussion } from "@/lib/providers/discovery/types";
import { canonicalTarget, contentHash, type CanonicalTarget } from "@/lib/providers/discovery/canonical";
import { freshUntil } from "./rules";

/**
 * Turning a business into search queries, and discussions into stored targets.
 *
 * The queries matter more than they look. Searching for the product category
 * finds threads where competitors are already the answer; searching for the
 * QUESTIONS the customer's articles answer finds threads where they could be.
 * The knowledge graph already knows those, so discovery reads from it rather
 * than inventing topics.
 */

export interface QuerySource {
  /** Keywords the customer targets, best first. */
  keywords: string[];
  /** Entity names the published articles are about. */
  entities: string[];
  niche?: string | null;
}

/**
 * Builds the search queries, most specific first.
 *
 * Specific beats broad here for the same reason it does in AEO: a narrow
 * question has fewer incumbents answering it, so being the answer is
 * achievable. A query for the whole category returns threads we have no chance
 * of winning and burns the run's budget finding them.
 */
export function buildQueries(source: QuerySource, limit = 8): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];

  const push = (value: string) => {
    const query = value.trim().replace(/\s+/g, " ");
    if (query.length < 3) return;
    const key = query.toLowerCase();
    if (seen.has(key) || queries.length >= limit) return;
    seen.add(key);
    queries.push(query);
  };

  // Keywords first: they are what the customer has decided to be found for.
  for (const keyword of source.keywords) push(keyword);
  // Then the entities their articles actually talk about.
  for (const entity of source.entities) push(entity);
  // The niche last, and only to fill the tail: it is the broadest thing we know.
  if (source.niche) push(source.niche);

  return queries;
}

export interface StoredTarget extends Discussion {
  foundFor: string;
  /** The provider that found it. */
  foundVia: string;
  /**
   * When the row stops being worth a reply, when the source knows better
   * than the per-kind window (`freshUntil`): a post found on X in its first
   * hours is answered that day or not at all.
   */
  freshUntil?: string | null;
}

/**
 * Stores what a sweep found, ignoring what is already there.
 *
 * Two layers of identity. The unique key is (business, surface, external id),
 * where the external id is the canonical one whoever found the page, so a
 * thread found by three providers or three queries is one row and a thread
 * found again next week does not become a second one; `ignoreDuplicates`
 * keeps the first sighting, including the query and provider that found it.
 * On top of that, a title already stored for this business (the same question
 * cross-posted elsewhere) is skipped: same opportunity, one row.
 *
 * Rediscovered rows get `last_seen_at` bumped, so "still being found" is
 * distinguishable from "found once in June".
 */
export async function storeTargets(params: {
  supabase: SupabaseClient;
  userId: string;
  /** The site the thread was found for; targets are per site, like keywords. */
  businessId?: string | null;
  targets: StoredTarget[];
  now?: Date;
}): Promise<number> {
  if (params.targets.length === 0) return 0;
  const now = params.now ?? new Date();

  // Dedupe within the batch first: two providers, one thread.
  const byIdentity = new Map<string, StoredTarget>();
  for (const target of params.targets) {
    const key = `${target.surface}:${target.externalId}`;
    if (!byIdentity.has(key)) byIdentity.set(key, target);
  }
  const unique = [...byIdentity.values()];

  const hashes = unique.map((t) => contentHash(t.title, t.excerpt));
  let alreadyStored = new Set<string>();
  if (params.businessId) {
    const { data: existing } = await params.supabase
      .from("placement_targets")
      .select("content_hash, surface, external_id")
      .eq("business_id", params.businessId)
      .in("content_hash", [...new Set(hashes)]);
    alreadyStored = new Set(
      (existing ?? []).map((r) => r.content_hash as string).filter(Boolean)
    );

    // Bump last_seen_at on the ones we are seeing again.
    const seenAgain = [...new Set(hashes.filter((hash) => alreadyStored.has(hash)))];
    if (seenAgain.length > 0) {
      await params.supabase
        .from("placement_targets")
        .update({ last_seen_at: now.toISOString() })
        .eq("business_id", params.businessId)
        .in("content_hash", seenAgain);
    }
  }

  const rows = unique
    .map((target, i) => ({ target, hash: hashes[i] }))
    .filter(({ hash }) => !alreadyStored.has(hash))
    .map(({ target, hash }) => ({
      user_id: params.userId,
      business_id: params.businessId ?? null,
      surface: target.surface,
      kind: target.kind,
      external_id: target.externalId,
      url: target.url,
      title: target.title,
      excerpt: target.excerpt || null,
      community: target.community || null,
      author: target.author,
      found_for: target.foundFor,
      found_via: target.foundVia,
      content_hash: hash,
      posted_at: target.createdAt,
      posted_at_precision: target.createdAt ? (target.createdAtPrecision ?? null) : null,
      score: target.score,
      comment_count: target.commentCount,
      fresh_until: target.freshUntil !== undefined ? target.freshUntil : freshUntil(target.kind, target.createdAt),
      last_seen_at: now.toISOString(),
      status: "discovered",
    }));

  if (rows.length === 0) return 0;

  const { data, error } = await params.supabase
    .from("placement_targets")
    .upsert(rows, { onConflict: "business_id,surface,external_id", ignoreDuplicates: true })
    .select("id");

  if (error) throw new Error(`placement target upsert failed: ${error.message}`);
  return data?.length ?? 0;
}

interface LegacyRow {
  id: string;
  url: string;
  status: string;
  qualified_by: string | null;
  posted_at: string | null;
}

export interface RecanonicalizeResult {
  /** Stored `web` pages looked at. */
  scanned: number;
  /** Rows moved to the identity the canonicaliser gives their URL today. */
  moved: number;
  /** Moved rows whose only rejection was "a page nobody can reply to", judged again. */
  reopened: number;
  /** Legacy rows whose real identity was already stored: merged into it. */
  merged: number;
}

/**
 * The compatibility path for identities the canonicaliser learned later.
 *
 * A host it did not know was stored as a `web` `page` keyed by URL hash — a
 * Hacker News item, a Quora question, a Stack Exchange question, an Indie
 * Hackers post, a DEV article — and an X article was stored as an `x` `page`
 * because only `/status/` counted as a post. Two things followed: the rules
 * rejected it as a page nobody can reply to, and the title dedupe in
 * `storeTargets` would skip the same thread when web search found it again,
 * so it could never come back under its real identity. Rewriting history in SQL would
 * mean a second URL parser; this reads the stored rows and lets the one
 * canonicaliser decide, in code, once per sweep, bounded.
 *
 * The row keeps its id, its history and the query that found it. Only a
 * rejection that was solely "this is a page" is lifted; a row the rules or
 * the agent rejected for another reason keeps that verdict. When the real
 * identity is already stored (found again after the host was learned) the
 * legacy row merges into it by disappearing.
 */
export async function recanonicalizeLegacyTargets(params: {
  supabase: SupabaseClient;
  businessId: string;
  now?: Date;
  limit?: number;
}): Promise<RecanonicalizeResult> {
  const now = params.now ?? new Date();
  const result: RecanonicalizeResult = { scanned: 0, moved: 0, reopened: 0, merged: 0 };

  const { data } = await params.supabase
    .from("placement_targets")
    .select("id, url, status, qualified_by, posted_at")
    .eq("business_id", params.businessId)
    .in("surface", ["web", "x"])
    .eq("kind", "page")
    .order("created_at", { ascending: true })
    .limit(params.limit ?? 500);

  const legacy = (data ?? []) as LegacyRow[];
  result.scanned = legacy.length;

  const moves = legacy
    .map((row) => ({ row, canonical: canonicalTarget(row.url) }))
    .filter(
      (m): m is { row: LegacyRow; canonical: CanonicalTarget } =>
        m.canonical !== null && m.canonical.kind !== "page"
    );
  if (moves.length === 0) return result;

  const { data: existing } = await params.supabase
    .from("placement_targets")
    .select("id, surface, external_id")
    .eq("business_id", params.businessId)
    .in("external_id", [...new Set(moves.map((m) => m.canonical.externalId))]);
  const taken = new Set((existing ?? []).map((r) => `${r.surface}:${r.external_id}`));

  for (const { row, canonical } of moves) {
    const key = `${canonical.surface}:${canonical.externalId}`;
    if (taken.has(key)) {
      const { error } = await params.supabase.from("placement_targets").delete().eq("id", row.id);
      if (error) throw new Error(`placement target merge failed: ${error.message}`);
      result.merged += 1;
      continue;
    }
    taken.add(key);

    const reopen = row.status === "rejected" && row.qualified_by === "rules:not_answerable";
    const { error } = await params.supabase
      .from("placement_targets")
      .update({
        surface: canonical.surface,
        kind: canonical.kind,
        external_id: canonical.externalId,
        url: canonical.url,
        community: canonical.community,
        ...(canonical.author ? { author: canonical.author } : {}),
        fresh_until: freshUntil(canonical.kind, row.posted_at),
        updated_at: now.toISOString(),
        ...(reopen
          ? {
              status: "discovered",
              qualify_score: null,
              qualify_reason: null,
              qualify_angle: null,
              qualified_by: null,
              qualified_at: null,
            }
          : {}),
      })
      .eq("id", row.id);
    if (error) throw new Error(`placement target recanonicalize failed: ${error.message}`);
    result.moved += 1;
    if (reopen) result.reopened += 1;
  }

  return result;
}

/**
 * Drops threads that are not worth a model's attention later.
 *
 * Cheap filtering here is what keeps the expensive step cheap: qualification
 * costs a model call per target, so a thread with no engagement at all, or one
 * whose title is a bare link, is removed before it can cost anything. A thread
 * whose engagement the provider cannot know (a web search result) is kept:
 * "unknown" is not "zero", and the rules step flags it instead.
 */
export function prefilter(discussions: Discussion[], minComments = 1): Discussion[] {
  return discussions.filter(
    (d) =>
      (d.commentCount === null || d.kind === "repository" || d.commentCount >= minComments) &&
      d.title.length >= 15
  );
}
