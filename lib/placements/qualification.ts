import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlacementVerdict, QualifyThread } from "@/lib/agents/placement-qualify";
import {
  REDDIT_ARCHIVE_DAYS,
  REDDIT_SEED_ANCHORS,
  redditArchivedBelow,
  redditIdValue,
  type RedditAnchor,
} from "@/lib/providers/discovery/reddit-ids";
import { applyRules, expiryOf, type RuleContext, type RuleOutcome, type RuleTarget } from "./rules";

/**
 * Turning a model's opinion about a thread into a decision the product stands
 * behind.
 *
 * The agent scores and explains; this module decides. The split is not
 * ceremony: a model asked to be strict drifts generous over a long batch, and
 * the cost of that drift lands on a person who has to read every accepted
 * thread and write an answer under their own name. So the two rules that
 * actually protect the queue live here, in code, where they hold whatever the
 * model returned — and the deterministic rules in ./rules.ts run before the
 * model is even asked.
 */

/**
 * `qualified_by` when a person decided: they added the post by hand. Beside
 * "agent" and "rules:<rule>", it names who stands behind the verdict. A
 * person gives no score, so `qualify_score` stays null; and the draft job
 * never asks the qualifier about such a row, not even for an angle: the
 * drafter takes it from the post and the writer, and no model's verdict
 * stands between the person's choice and a draft (docs/PLACEMENTS.md,
 * 8 November 2026).
 */
export const PERSON_VERDICT = "person";

/** Below this the target is rejected even when the model qualified it. */
export const QUALIFY_SCORE_FLOOR = 60;

export interface TargetRow extends RuleTarget {
  id: string;
  score: number | null;
  /** When discovery last saw this row; the recency an undated row has. */
  last_seen_at?: string | null;
}

function postedMillis(row: { posted_at: string | null }): number | null {
  if (!row.posted_at) return null;
  const at = new Date(row.posted_at).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * Which discovered rows the agent judges this run, when there are more than
 * the run can pay for.
 *
 * Surfaces are not interchangeable, so they are not ranked against each
 * other. A platform API knows a thread's date; a web search result almost
 * never does. Sorting the whole pool newest-first therefore puts every dated
 * GitHub issue ahead of every undated Reddit, LinkedIn and X thread, and a
 * 40-row cap judges GitHub alone, run after run, while the other surfaces sit
 * in `discovered` unseen. That is what this function prevents: one queue per
 * surface, newest first inside it (unknown dates after known ones, in the
 * order given), and the cap dealt round-robin across the queues. A surface
 * with fewer rows than its share leaves the rest to the others.
 */
export function pickFairShare<T extends { surface: string; posted_at: string | null }>(
  rows: T[],
  cap: number
): T[] {
  if (cap <= 0 || rows.length === 0) return [];

  const bySurface = new Map<string, T[]>();
  for (const row of rows) {
    const list = bySurface.get(row.surface) ?? [];
    list.push(row);
    bySurface.set(row.surface, list);
  }

  const queues = [...bySurface.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, list]) =>
      // Stable: undated rows keep the order they arrived in.
      [...list].sort((a, b) => {
        const at = postedMillis(a);
        const bt = postedMillis(b);
        if (at === null && bt === null) return 0;
        if (at === null) return 1;
        if (bt === null) return -1;
        return bt - at;
      })
    );

  const picked: T[] = [];
  let cursor = 0;
  while (picked.length < cap && queues.some((q) => q.length > 0)) {
    const queue = queues[cursor % queues.length];
    cursor += 1;
    const next = queue.shift();
    if (next) picked.push(next);
  }
  return picked;
}

export interface Decision {
  status: "qualified" | "rejected";
  score: number;
  reason: string;
  angle: string | null;
  topic: string | null;
  intent: string | null;
}

/**
 * Age in whole days, or null when the date is unknown. Precomputed for the
 * agent because a model asked to subtract dates gets it wrong often enough to
 * matter, and "how old is this thread" is one of the four things the judgement
 * rests on. Unknown is passed as unknown: a fake zero would read as "today".
 */
export function ageInDays(postedAt: string | null, now: Date): number | null {
  if (!postedAt) return null;
  const posted = new Date(postedAt).getTime();
  if (!Number.isFinite(posted)) return null;
  return Math.max(0, Math.floor((now.getTime() - posted) / 86_400_000));
}

/** Maps stored rows onto the agent's input, position being the only key. */
export function toThreads(rows: TargetRow[], now: Date): QualifyThread[] {
  return rows.map((row, index) => ({
    index,
    surface: row.surface,
    kind: row.kind || "thread",
    community: row.community ?? "",
    title: row.title,
    excerpt: row.excerpt ?? "",
    ageDays: ageInDays(row.posted_at, now),
    score: row.score,
    commentCount: row.comment_count,
  }));
}

// "Explain how…", and the brief's polite form, "You can explain how…".
const PRESENTING_VERB =
  /^(you (can|could|should|might) )?(explain|introduce|highlight|showcase|position|present|detail|articulate|describe|promote|pitch|emphasi[sz]e|demonstrate|discuss|outline|illustrate)\b/i;
const PRODUCT_NOUN = /\b(ai agent|agent|tool|platform|service|solution|product|offering|software)\b/i;
const UNNAMED_PRODUCT =
  /\b(a|an|the) ([a-z-]+ ){0,3}(agent|tool|platform|service|solution|product|system) (that|which) (fully |automatically |completely )?(automates|handles|does|takes care|generates|writes|publishes|manages|helps|runs|orchestrates|covers)\b|\b(autonomous|ai|automated|integrated) (agents|systems|platforms|tools) that (integrate|automate|handle|manage|run|combine|orchestrate|own)\b|\b(a|an|the) (fully |completely |truly )?(automated|autonomous|integrated|centrali[sz]ed|unified|all[- ]in[- ]one|dedicated|single|purpose[- ]built) (ai )?(agent|system|platform|tool|solution|approach) (addresses|solves|handles|centrali[sz]es|removes|eliminates|automates|fixes|tackles|replaces|integrates|orchestrates)\b/i;
/** The category pitch: the product described as the new kind of thing. */
const CATEGORY_PITCH =
  /\b(new|newer|emerging|different|whole new) (category|class|breed|generation|wave|kind) of (ai )?(agents?|tools?|platforms?|services?|solutions?|software)\b/i;
/**
 * The brochure's core claim: everything, end to end, replacing the rest. The
 * subject has to be a product ("an agent that automates the entire
 * workflow"): "the biggest impact comes from automating the entire
 * publishing workflow" is an opinion about the topic, which is what an angle
 * is for, and it stopped a draft in production as a pitch.
 */
const WHOLE_WORKFLOW =
  /\b(agents?|tools?|platforms?|services?|solutions?|products?|systems?|software|offerings?|suites?)\b[^.;:]{0,40}?\b(that |which |to )?(fully |automatically |completely |seamlessly )?(automat(e|es)|handl(e|es)|cover(s)?|manag(e|es)|run(s)?|own(s)?|centrali[sz](e|es)|integrat(e|es)|orchestrat(e|es)|unif(y|ies)|tak(e|es) over) the (entire|whole|full|complete|end[- ]to[- ]end) ([a-z-]+ ){0,5}(lifecycle|workflow|process|pipeline|stack|loop|cycle|journey)\b|\breplac(e|es|ing) (multiple|several|expensive|many) (tools|agencies|steps|vendors)\b|\bend[- ]to[- ]end (solutions?|automation|platforms?|agents?|systems?|offerings?)\b/i;

/**
 * An angle written as a brief to present the product rather than as
 * knowledge a person would add. The angle is what the draft is built on, so a
 * pitch here becomes an advert there whatever the drafter is told; the test
 * is the qualifier's own rule that an angle must make sense with the
 * business's name deleted. Names the brand; opens with "explain how …" about
 * a tool; describes "an agent that automates …", "a fully automated agent
 * addresses this …", "a new category of AI agents", "end-to-end solutions",
 * or something that "automates the entire workflow, replacing multiple
 * tools": a pitch.
 */
export function angleIsPitch(angle: string | null, brandNames: string[]): boolean {
  if (!angle) return false;
  const text = angle.trim();
  const brand = brandNames
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (brand.length && new RegExp(`(^|[^\\p{L}\\p{N}])(${brand.join("|")})([^\\p{L}\\p{N}]|$)`, "iu").test(text)) return true;
  if (PRESENTING_VERB.test(text) && PRODUCT_NOUN.test(text)) return true;
  return UNNAMED_PRODUCT.test(text) || CATEGORY_PITCH.test(text) || WHOLE_WORKFLOW.test(text);
}

/**
 * The angle from a verdict given in "angle" mode, or null.
 *
 * A person has already decided to answer the thread, so nothing here judges
 * its worth: no score floor, no rejection written anywhere. A pitch is still
 * no angle. The caller decides what null means for the row; in the draft
 * job it means the job stops and says so, and the row is left as it was.
 */
export function angleFromVerdict(verdict: PlacementVerdict | undefined, brandNames: string[]): string | null {
  if (!verdict || verdict.verdict === "rejected" || !verdict.angle) return null;
  return angleIsPitch(verdict.angle, brandNames) ? null : verdict.angle;
}

/**
 * The rules the model does not get to overrule.
 *
 * A qualified target with no angle is the failure mode that matters most: it
 * reads like a decision but tells the drafting step nothing, so whatever gets
 * written is a generic answer, which is exactly the output this phase exists
 * to not produce. No angle means no placement. An angle that is a pitch for
 * the product is no angle either: it tells the drafting step to write an
 * advert, which is the other output this phase exists to not produce.
 */
export function decide(verdict: PlacementVerdict, brandNames: string[] = []): Decision {
  const meta = { topic: verdict.topic ?? null, intent: verdict.intent ?? null };
  if (verdict.verdict === "rejected") {
    return { status: "rejected", score: verdict.score, reason: verdict.reason, angle: null, ...meta };
  }
  if (!verdict.angle) {
    return {
      status: "rejected",
      score: verdict.score,
      reason: "Nothing specific to add that the thread does not already have.",
      angle: null,
      ...meta,
    };
  }
  if (angleIsPitch(verdict.angle, brandNames)) {
    return {
      status: "rejected",
      score: verdict.score,
      reason: "The only thing to add was the product itself: that is an advert, not an answer.",
      angle: null,
      ...meta,
    };
  }
  if (verdict.score < QUALIFY_SCORE_FLOOR) {
    return {
      status: "rejected",
      score: verdict.score,
      reason: verdict.reason,
      angle: verdict.angle,
      ...meta,
    };
  }
  return {
    status: "qualified",
    score: verdict.score,
    reason: verdict.reason,
    angle: verdict.angle,
    ...meta,
  };
}

export interface AppliedVerdicts {
  qualified: number;
  rejected: number;
  /** Judged by nobody: left `discovered` so the next sweep sees them again. */
  undecided: number;
}

/**
 * Writes the decisions back.
 *
 * Rows without a verdict are deliberately left alone. Marking them rejected
 * would be recording a judgement nobody made, and they are cheap to see again
 * next week; marking them qualified would be worse.
 */
export async function applyVerdicts(params: {
  supabase: SupabaseClient;
  rows: TargetRow[];
  verdicts: PlacementVerdict[];
  now?: Date;
  /** The business's names, so an angle that pitches it by name is caught. */
  brandNames?: string[];
}): Promise<AppliedVerdicts> {
  const now = params.now ?? new Date();
  const applied: AppliedVerdicts = { qualified: 0, rejected: 0, undecided: 0 };
  const decided = new Set<number>();

  for (const verdict of params.verdicts) {
    const row = params.rows[verdict.index];
    if (!row) continue;
    decided.add(verdict.index);

    const decision = decide(verdict, params.brandNames ?? []);
    const { error } = await params.supabase
      .from("placement_targets")
      .update({
        status: decision.status,
        qualify_score: Math.round(decision.score),
        qualify_reason: decision.reason,
        qualify_angle: decision.angle,
        topic: decision.topic,
        intent: decision.intent,
        qualified_by: "agent",
        qualified_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", row.id);

    if (error) throw new Error(`placement target update failed: ${error.message}`);
    applied[decision.status] += 1;
  }

  applied.undecided = params.rows.length - decided.size;
  return applied;
}

export interface AppliedRules {
  /** Rows the rules rejected, written back with the rule's reason. */
  rejected: number;
  /** Rows the rules let through, in the order given. */
  survivors: TargetRow[];
  /** Rule name → how many it rejected, for the run's report. */
  byRule: Record<string, number>;
}

/**
 * Runs the deterministic rules over discovered rows and writes the rejections.
 *
 * A rules rejection carries the rule's name in `qualified_by` ("rules") and
 * its reason verbatim, so the inbox can show "rejected: stale (412 days)"
 * and a person can disagree with a specific rule rather than a vibe.
 */
export async function applyRuleRejections(params: {
  supabase: SupabaseClient;
  rows: TargetRow[];
  ctx: RuleContext;
  /**
   * A surface's own rules, run on what the shared rules let pass (the X
   * search's pre-filter, lib/placements/x-conversation.ts). Null passes.
   */
  extra?: (row: TargetRow) => RuleOutcome | null;
}): Promise<AppliedRules> {
  return applyOutcomes(params, (row) => {
    const outcome = applyRules(row, params.ctx);
    if (outcome.status !== "pass" || !params.extra) return outcome;
    return params.extra(row) ?? outcome;
  });
}

/**
 * The time-only rules (`expiryOf`) over rows a person could still act on:
 * qualified, drafted, needs_review, approved. A Reddit thread qualified at
 * five months is archived at six, and an inbox that still offers it sends
 * the person to a page that refuses their comment. Nothing else is judged
 * again here — a change in the keywords is not a reason to take back an
 * approval — and the write is the same rules rejection, so the card names
 * the rule.
 */
export async function applyExpiry(params: {
  supabase: SupabaseClient;
  rows: TargetRow[];
  ctx: RuleContext;
}): Promise<AppliedRules> {
  return applyOutcomes(params, (row) => expiryOf(row, params.ctx) ?? { status: "pass", flags: [] });
}

async function applyOutcomes(
  params: { supabase: SupabaseClient; rows: TargetRow[]; ctx: RuleContext },
  judge: (row: TargetRow) => RuleOutcome
): Promise<AppliedRules> {
  const applied: AppliedRules = { rejected: 0, survivors: [], byRule: {} };

  for (const row of params.rows) {
    const outcome = judge(row);
    if (outcome.status === "pass") {
      applied.survivors.push(row);
      continue;
    }
    const { error } = await params.supabase
      .from("placement_targets")
      .update({
        status: "rejected",
        qualify_score: 0,
        qualify_reason: outcome.reason,
        qualify_angle: null,
        qualified_by: `rules:${outcome.rule}`,
        qualified_at: params.ctx.now.toISOString(),
        updated_at: params.ctx.now.toISOString(),
      })
      .eq("id", row.id);
    if (error) throw new Error(`placement target update failed: ${error.message}`);
    applied.rejected += 1;
    applied.byRule[outcome.rule] = (applied.byRule[outcome.rule] ?? 0) + 1;
  }

  return applied;
}

/** Stored Reddit threads whose date is known, read as anchors. */
const ANCHOR_ROWS = 200;

/**
 * The newest Reddit post id known to be older than the archive window: the
 * seed anchors plus what discovery has stored since — every dated Reddit
 * thread in `placement_targets` is an observation "this id, posted no later
 * than this instant", whichever site it was found for; an id and a date
 * carry nothing of the site. Read with the service role in a job, never as
 * a person's query. Null when nothing old enough is known.
 */
export async function loadRedditArchivedBelow(supabase: SupabaseClient, now: Date): Promise<string | null> {
  const cutoff = new Date(now.getTime() - REDDIT_ARCHIVE_DAYS * 86_400_000).toISOString();
  const { data } = await supabase
    .from("placement_targets")
    .select("external_id, posted_at")
    .eq("surface", "reddit")
    .eq("kind", "thread")
    .lte("posted_at", cutoff)
    .order("posted_at", { ascending: false })
    .limit(ANCHOR_ROWS);
  const stored: RedditAnchor[] = ((data ?? []) as Array<{ external_id: string | null; posted_at: string | null }>)
    .filter((r) => r.external_id && r.posted_at && redditIdValue(r.external_id) !== null)
    .map((r) => ({ id: r.external_id as string, postedBefore: r.posted_at as string }));
  return redditArchivedBelow([...REDDIT_SEED_ANCHORS, ...stored], now);
}
