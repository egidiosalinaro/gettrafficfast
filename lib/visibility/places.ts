import type { SupabaseClient } from "@supabase/supabase-js";
import type { CitationSource } from "@/lib/providers/citations/types";
import { resolveSourceUrls, type SourceResolver } from "@/lib/providers/citations/resolve";
import { loadRedditArchivedBelow } from "@/lib/placements/qualification";
import { businessIdentity, parseAeoSettings } from "./settings";
import {
  MAX_NEW_TARGETS_PER_RUN,
  citationOf,
  passRules,
  planTargets,
  rankSources,
  redirectsToResolve,
  targetRowOf,
  type DropReason,
  type SourceCandidate,
  type SourceProbe,
} from "./sources-to-targets";

/**
 * "Find places from the last run": a visibility run's cited sources become
 * rows of the Replies inbox. The I/O around lib/visibility/sources-to-targets.ts.
 *
 * Called from two places, and they do the same thing: the last step of the
 * `aeo-run` job, unless the site turned the setting off (it is on by
 * default), and by hand (the `find_places_from_last_run` tool, and
 * POST /api/visibility/places for a signed-in session; no button on the
 * screen).
 *
 * What it costs: nothing billed. No model is asked and no engine is probed
 * again; the probes are read from the table. The only requests it makes are
 * the lookups that read a vendor's source redirect back to the page it
 * stands for (lib/providers/citations/resolve.ts), at most
 * MAX_SOURCE_LOOKUPS_PER_RUN, a few at a time, each with its own timeout.
 *
 * What it writes: at most MAX_NEW_TARGETS_PER_RUN new `placement_targets`
 * rows, and the sighting on rows the inbox already holds. A page is one row
 * per site whoever found it, because the identity is the canonicaliser's
 * and the write is an upsert on (business, surface, external id) that keeps
 * the first sighting. Nothing is drafted and nothing is sent.
 */

type Row = Record<string, unknown>;

export interface PlacesTarget {
  id: string;
  surface: string;
  kind: string;
  url: string;
  title: string;
  /** The first prompt whose sampled answer cited the page, and the engines that did. */
  prompt: string;
  engines: string[];
}

export interface PlacesResult {
  ok: true;
  runId: string;
  /** Distinct pages that passed the selection and the rules, before the cap. */
  candidates: number;
  /** New rows in the inbox. */
  created: number;
  /** Rows the inbox already held, now carrying this run's sighting. */
  linked: number;
  /** New pages past the cap: not stored, taken by the next run. */
  deferred: number;
  /** Distinct pages left out by the selection, by why. */
  dropped: Record<DropReason, number>;
  /** Candidates a deterministic inbox rule turned down, by rule. */
  rejected: Record<string, number>;
  targets: PlacesTarget[];
}

export type PlacesFailure = { ok: false; status: 404 | 409; code: "no_business" | "no_run"; error: string };

export const NO_RUN_YET = "No finished visibility run yet. Run a visibility check first: places are read from its answers.";

function probeOf(row: Row): SourceProbe {
  return {
    queryId: (row.query_id as string | null) ?? null,
    query: row.query as string,
    engine: row.engine as string,
    status: row.status as string,
    sources: Array.isArray(row.sources) ? (row.sources as CitationSource[]) : [],
  };
}

function briefOf(candidate: SourceCandidate, id: string): PlacesTarget {
  return {
    id,
    surface: candidate.surface,
    kind: candidate.kind,
    url: candidate.url,
    title: candidate.title,
    prompt: candidate.prompts[0].query,
    engines: candidate.prompts[0].engines,
  };
}

export async function findPlacesFromRun(params: {
  /**
   * Reads the business, the run and its probes. The caller's own client for
   * a person or a key (so RLS and the `user_id` filter are the ownership
   * check); the job's service role inside the worker.
   */
  supabase: SupabaseClient;
  /** The service role: the insert users have no policy for, and the cross-site Reddit anchors. */
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  /** The run to read. Absent: the site's latest completed run. */
  runId?: string;
  now?: Date;
  /** Reads a source redirect back to its page; the provider's unless a test replaces it. */
  resolve?: SourceResolver;
  /** Epoch ms after which no new lookup is started. */
  deadline?: number;
  signal?: AbortSignal;
  cap?: number;
}): Promise<PlacesResult | PlacesFailure> {
  const { supabase, admin, userId, businessId } = params;
  const now = params.now ?? new Date();

  const { data: business } = await supabase
    .from("businesses")
    .select("id, name, website_url, aeo_settings")
    .eq("id", businessId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!business) return { ok: false, status: 404, code: "no_business", error: "Business not found" };

  let runQuery = supabase
    .from("aeo_runs")
    .select("id, status, finished_at, started_at")
    .eq("business_id", businessId)
    .eq("status", "completed");
  if (params.runId) runQuery = runQuery.eq("id", params.runId);
  const { data: runs } = await runQuery.order("started_at", { ascending: false }).limit(1);
  const run = ((runs ?? []) as Row[])[0];
  if (!run) return { ok: false, status: 409, code: "no_run", error: NO_RUN_YET };
  const runId = run.id as string;

  const [{ data: probeRows, error: probeError }, { data: competitorRows }, redditArchivedBelow] = await Promise.all([
    supabase.from("aeo_probes").select("query_id, query, engine, status, sources").eq("run_id", runId),
    supabase.from("competitors").select("domain").eq("business_id", businessId).limit(200),
    loadRedditArchivedBelow(admin, now),
  ]);
  if (probeError) throw new Error(`aeo probes: ${probeError.message}`);

  const probes = ((probeRows ?? []) as Row[]).map(probeOf);
  const identity = businessIdentity(
    { name: business.name as string | null, website_url: business.website_url as string | null },
    parseAeoSettings(business.aeo_settings)
  );
  const ctx = {
    ownDomains: identity.domains,
    competitorDomains: ((competitorRows ?? []) as Row[]).map((c) => String(c.domain ?? "")).filter(Boolean),
  };

  // One engine returns a redirect in place of the page it cited. Read the
  // most promising ones back, bounded; what is not read is counted `unread`.
  const resolved = await resolveSourceUrls(redirectsToResolve(probes, ctx), {
    resolve: params.resolve,
    deadline: params.deadline,
    signal: params.signal,
  });

  const selection = rankSources(probes, { ...ctx, resolved });
  const { kept, rejected } = passRules(selection.candidates, { now, ownDomains: identity.domains, redditArchivedBelow });

  const summary = (over: Partial<PlacesResult>): PlacesResult => ({
    ok: true,
    runId,
    candidates: kept.length,
    created: 0,
    linked: 0,
    deferred: 0,
    dropped: selection.dropped,
    rejected,
    targets: [],
    ...over,
  });
  if (kept.length === 0) return summary({});

  const { data: existingRows, error: existingError } = await admin
    .from("placement_targets")
    .select("id, surface, external_id, aeo_query_id")
    .eq("business_id", businessId)
    .in("external_id", [...new Set(kept.map((c) => c.externalId))]);
  if (existingError) throw new Error(`placement targets: ${existingError.message}`);
  const existing = new Map<string, Row>(
    ((existingRows ?? []) as Row[]).map((r) => [`${r.surface}:${r.external_id}`, r])
  );

  const plan = planTargets(kept, new Set(existing.keys()), params.cap ?? MAX_NEW_TARGETS_PER_RUN);
  const checkedAt = ((run.finished_at as string | null) ?? (run.started_at as string | null)) || null;
  const iso = now.toISOString();

  const targets: PlacesTarget[] = [];
  let created = 0;
  if (plan.create.length > 0) {
    const rows = plan.create.map((candidate) => targetRowOf(candidate, { userId, businessId, runId, checkedAt, now }));
    const { data, error } = await admin
      .from("placement_targets")
      .upsert(rows, { onConflict: "business_id,surface,external_id", ignoreDuplicates: true })
      .select("id, surface, external_id");
    if (error) throw new Error(`placement target insert failed: ${error.message}`);
    const inserted = new Map<string, string>(
      ((data ?? []) as Row[]).map((r) => [`${r.surface}:${r.external_id}`, r.id as string])
    );
    for (const candidate of plan.create) {
      const id = inserted.get(candidate.key);
      // Not returned: another writer stored the page a moment ago. It is
      // that writer's row; the next run links it.
      if (!id) continue;
      created += 1;
      targets.push(briefOf(candidate, id));
    }
  }

  // Rows the inbox already holds keep everything they have (status, the
  // first sighting, drafts): only the sighting is recorded, and the prompt
  // when none was linked.
  let linked = 0;
  for (const candidate of plan.link) {
    const row = existing.get(candidate.key);
    if (!row) continue;
    const patch: Row = {
      ai_citation: citationOf(candidate, { runId, checkedAt }),
      last_seen_at: iso,
      updated_at: iso,
    };
    if (!row.aeo_query_id && candidate.prompts[0].queryId) patch.aeo_query_id = candidate.prompts[0].queryId;
    const { error } = await admin
      .from("placement_targets")
      .update(patch)
      .eq("id", row.id as string)
      .eq("business_id", businessId)
      .eq("user_id", userId);
    if (error) throw new Error(`placement target link failed: ${error.message}`);
    linked += 1;
  }

  return summary({ created, linked, deferred: plan.deferred, targets });
}
