import { randomUUID } from "crypto";
import { AgentBudgetExceeded, createBudget, type AgentContext } from "@/lib/agents/contract";
import { LlmError } from "@/lib/providers/llm/types";
import { runAgent, supabaseRecorder } from "@/lib/agents/runner";
import { CORRECTIONS_LIMIT, PROBLEM_MAX_CHARS, placementDraftAgent, type DraftVariant } from "@/lib/agents/placement-draft";
import { placementQualifyAgent } from "@/lib/agents/placement-qualify";
import { clampText } from "@/lib/content/text";
import { domainOf } from "@/lib/providers/serp/types";
import { pickApproach } from "@/lib/placements/approach";
import { topicsFor } from "@/lib/placements/expertise";
import {
  asksForOneRewrite,
  asksForRewrite,
  auditDraft,
  withReading,
  countsTowardVerdict,
  isAdvisory,
  tellsIn,
  withoutTells,
  type AuditResult,
  type DraftForAudit,
} from "@/lib/placements/audit";
import { recentFeedback } from "@/lib/placements/feedback";
import { MAX_DRAFT_IMAGES, draftImagePlan, draftImagesRecord, loadMedia, parseDraftImages, withImages } from "@/lib/placements/media";
import { excerptWithReferenced, loadReferenced, quotedImageInputs } from "@/lib/placements/referenced";
import { parseReading, type PostReading } from "@/lib/placements/reading";
import { repairDraft } from "@/lib/placements/repair";
import { pickVoiceExamples, readPostedReplies } from "@/lib/placements/voice-examples";
import { loadRecentReplies, recentFacts } from "@/lib/placements/recent-facts";
import { RecentFacts } from "@/lib/voice/fact-rules";
import { PERSON_VERDICT, angleFromVerdict, angleIsPitch, toThreads, type TargetRow } from "@/lib/placements/qualification";
import { draftPrerequisite, statusAfterAudit, variantsFor } from "@/lib/placements/workflow";
import { declinedByModelMessage, declinedMessage } from "@/lib/placements/draft-progress";
import { parseAeoSettings } from "@/lib/visibility/settings";
import { parseVoiceSettings, voiceForWriter } from "@/lib/voice/settings";
import { staleFacts } from "@/lib/voice/staleness";
import { TerminalStepError, type Workflow } from "@/lib/jobs/types";

/**
 * Drafting one placement, as a durable job.
 *
 *   draft — the agent writes the variants the surface calls for, in the
 *           business's voice (Settings → Voice) and in the approach this
 *           job dealt it (lib/placements/approach.ts). When the stored angle
 *           is a brief to present the product (rows qualified before the
 *           qualifier learned what an angle is) or there is none (a row
 *           reopened after a rejection), the agent that owns angles is
 *           asked for one, in the mode that judges nothing else: the person
 *           who clicked has decided the thread is worth answering. A
 *           knowledge angle replaces the brief; when the model finds
 *           nothing to say, the job stops with the model's own reason
 *           (`declinedByModelMessage`) and the row is left as it was.
 *           A post a person chose (`qualified_by` = person) and a draft
 *           asked for with "Write it anyway" (`anyway`) skip that ask: no
 *           model vetoes a post a person chose, and the drafter takes its
 *           angle from the thread and the writer. Nothing on this path
 *           ever rejects a row. For a short reply it also reads the
 *           replies the owner posted (lib/placements/voice-examples.ts),
 *           the voice the drafter is told to match, and for every draft
 *           the last notes the owner gave when correcting a draft
 *           (lib/placements/feedback.ts), the mistakes not to repeat.
 *           A post with images (`placement_targets.media`) has up to two
 *           handed to the drafter as image inputs (lib/placements/media.ts);
 *           what it saw, and why not the rest, goes to the audit step.
 *   audit — the deterministic gate judges every variant. Only a variant
 *           that passed every check is written. A warning is not a pass,
 *           except a style rule's (`STYLE_CHECKS`, the owner's notes),
 *           which the loop asks a rewrite to fix but the verdict ignores.
 *           The draft step already ran the same gate: a variant that did
 *           not pass was written again with the failing checks named, up
 *           to MAX_WRITES times, and the sentences the voice check refuses
 *           are deleted before it is judged again. When nothing passed,
 *           nothing is saved and the job says which checks stopped it.
 *           The inbox does not show a draft the gate refused.
 *
 * The gate ships in the same job as the writer, never after it. A drafting
 * step without a gate is a spam generator with a delay.
 */

export const PLACEMENT_DRAFT = "placement-draft";

/**
 * Writes per job, the first included. The click that asks for a draft is the
 * consent to spend; the loop stops at the first write that passes every
 * check, at this count, at the budget, or when the job's deadline would not
 * fit another call.
 */
export const MAX_WRITES = 3;

/**
 * Dollars per draft job: MAX_WRITES quality-tier calls with room to spare.
 * The budget throws past this, whatever the loop wants.
 */
const BUDGET_USD = 0.75;

/**
 * What the person reads when the agent that owns angles finds nothing to
 * say about a thread but the product. The row is left as it was.
 */
export const NO_ANGLE_MESSAGE = declinedMessage(
  "every angle the AI found was the product itself, and a reply built on that reads as an advert"
);

/** Room left before the deadline for a write, measured from the last one. */
function timeForAnotherWrite(deadline: number | undefined, lastWriteMs: number): boolean {
  if (deadline === undefined) return true;
  return deadline - Date.now() > lastWriteMs * 1.25 + 3_000;
}

/**
 * The checks a variant did not pass, as sentences the writer can act on.
 * Warnings are included: the loop is what turns "warning" into "passed".
 * The writer's own style rules are too (`STYLE_CHECKS`): the verdict
 * ignores them, the rewrite does not. Advisory checks are not
 * (`ADVISORY_CHECKS`). `removed` names the tells the job deleted before the
 * judgement, which no check can see any more, and goes first: without it a
 * reply that was only tells comes back "too short" and the model writes the
 * same sentences again. Each line is clamped to what the agent's input
 * accepts: the gate quotes what tripped it, and a long quote must not fail
 * the schema and end the job.
 */
export function problemsOf(audit: AuditResult, removed: string | null = null): string[] {
  // A check asked for once ("Repeats a recent fact") is named whenever a
  // rewrite happens: it costs nothing more, and the next text is better for it.
  return [...(removed ? [removed] : []), ...audit.checks.filter((check) => asksForRewrite(check) || asksForOneRewrite(check)).map((check) => check.detail)]
    .map((problem) => clampText(problem, PROBLEM_MAX_CHARS))
    .slice(0, 6);
}

/** What the job deleted from a draft as a model's tells, as a problem for the rewrite; null when nothing. */
export function removedTellsProblem(tells: readonly string[]): string | null {
  return tells.length
    ? `Deleted before judging, as sentences a model writes and a person does not: ${tells.join(", ")}. Write none of them again, in any form.`
    : null;
}

/** What the card says when every variant is still short of a pass. Nothing was saved. */
export function draftsRefusedMessage(audits: Array<{ variant: { variant: string }; audit: AuditResult }>): string {
  const parts = audits.map(({ variant, audit }) => {
    const why = audit.checks
      .filter((check) => check.status !== "pass" && countsTowardVerdict(check))
      .slice(0, 2)
      .map((check) => clampText(check.detail, 160))
      .join(" ");
    return `${variant.variant.replaceAll("_", " ")} — ${why}`;
  });
  return `No draft was saved, because none passed the check. ${parts.join(" ")}`;
}

interface Input {
  businessId: string;
  targetId: string;
  /**
   * "Write it anyway": the person read a decline and asked for the draft.
   * The agent that owns angles is not asked again, and the drafter is told
   * the person decided.
   */
  anyway: boolean;
}

/**
 * Lower is a draft closer to something a person can copy. A style rule's
 * warning counts here, so a rewrite that follows the notes is preferred to
 * one that does not, though neither changes the verdict.
 */
function auditPenalty(audit: AuditResult): number {
  const counted = audit.checks.filter((check) => !isAdvisory(check));
  const fails = counted.filter((check) => check.status === "fail").length;
  const warns = counted.filter((check) => check.status === "warn").length;
  const base = audit.status === "passed" ? 0 : audit.status === "warning" ? 100 : 200;
  // A repeated fact weighs like a warning, so a rewrite that says something
  // new is kept over the first write it was asked to replace.
  const repeats = audit.checks.filter(asksForOneRewrite).length;
  return base + fails * 10 + warns + repeats;
}

/**
 * True while a variant still has something a rewrite is asked to fix. A
 * check asked for once (`REWRITE_ONCE_CHECKS`: a fact repeated from the
 * recent replies) counts only before the first rewrite.
 */
export function unfinished(audit: AuditResult, firstRewrite = false): boolean {
  return audit.status !== "passed" || audit.checks.some((check) => asksForRewrite(check) || (firstRewrite && asksForOneRewrite(check)));
}

interface Judged<T> {
  variant: T;
  audit: AuditResult;
  /** The tells deleted before the judgement, as a problem for the rewrite. */
  removed: string | null;
}

function judgeVariants<T extends DraftForAudit>(
  variants: Array<{ variant: T; removed: string | null }>,
  ctx: Parameters<typeof auditDraft>[1]
): Array<Judged<T>> {
  return variants.map(({ variant, removed }) => ({ variant, audit: auditDraft(variant, ctx), removed }));
}

function readInput(input: Record<string, unknown>): Input {
  const businessId = typeof input.businessId === "string" ? input.businessId : "";
  const targetId = typeof input.targetId === "string" ? input.targetId : "";
  if (!businessId || !targetId) throw new Error("placement-draft needs businessId and targetId");
  return { businessId, targetId, anyway: input.anyway === true };
}

export const placementDraftWorkflow: Workflow = {
  type: PLACEMENT_DRAFT,
  steps: [
    {
      name: "draft",
      async run(ctx) {
        const { businessId, targetId, anyway } = readInput(ctx.input);
        const { supabase } = ctx;

        const [{ data: target }, { data: business }] = await Promise.all([
          supabase
            .from("placement_targets")
            .select(
              "id, user_id, surface, kind, url, community, title, excerpt, author, status, posted_at, score, comment_count, found_for, qualify_angle, qualified_by"
            )
            .eq("id", targetId)
            .eq("business_id", businessId)
            .maybeSingle(),
          supabase
            .from("businesses")
            .select("id, user_id, name, niche, website_url, content_language, voice_settings, aeo_settings")
            .eq("id", businessId)
            .maybeSingle(),
        ]);
        if (!target || !business) throw new Error("Target or business not found");

        // Name, site and niche. The description stays in the database: the
        // writer and the qualifier that read the brochure wrote the brochure.
        const businessInput = {
          name: (business.name as string | null) ?? "the business",
          domain: (business.website_url as string | null) ?? null,
          niche: (business.niche as string | null) ?? null,
        };
        const brandNames = [businessInput.name, ...parseAeoSettings(business.aeo_settings).brandNames];

        const [{ data: keywords }, { data: entities }, referencedByTarget] = await Promise.all([
          supabase.from("keywords").select("keyword").eq("business_id", businessId).limit(20),
          supabase.from("entities").select("name").eq("business_id", businessId).limit(20),
          // What the post quotes and replies to, read apart from the row
          // (referenced.ts): a database without the column costs the
          // context, not the draft.
          loadReferenced(supabase, businessId, [targetId]),
        ]);
        const referenced = referencedByTarget?.get(targetId) ?? null;
        const expertise = topicsFor(
          (keywords ?? []).map((k) => k.keyword as string),
          (entities ?? []).map((e) => e.name as string),
          brandNames
        );
        const language = (business.content_language as string | null) ?? "en";
        const voice = parseVoiceSettings(business.voice_settings);
        // The reply is a user's. With nothing recorded about the writer's
        // use, the clause that names the product cannot be written honestly,
        // and no retry fixes a setting: refused before the model is paid.
        const prerequisite = draftPrerequisite(businessInput.name, voice);
        if (prerequisite) throw new TerminalStepError(prerequisite);
        const agentCtx: AgentContext = {
          userId: business.user_id as string,
          businessId,
          jobId: ctx.job.id,
          language,
          runId: randomUUID(),
          budget: createBudget(Math.max(0, BUDGET_USD - ((await supabase.from("agent_runs").select("cost_usd").eq("job_id", ctx.job.id)).data ?? []).reduce((sum, run) => sum + Number(run.cost_usd ?? 0), 0))),
          signal: ctx.signal,
        };
        const recorder = supabaseRecorder(supabase);

        // The person asked for a draft, so the thread's worth is decided;
        // the only open question is what to say. An angle written as a
        // brief to present the product (rows from before the qualifier
        // learned what an angle is), or no angle at all (a row reopened
        // after a rejection), is asked again of the agent that owns angles,
        // in the mode that judges nothing else. Nothing here ever rejects
        // the row: the first manual draft under the old re-judgement
        // rejected the thread the person had just clicked, for "age
        // unknown", and the row vanished from the inbox.
        //
        // A post a person chose by hand, and a draft asked for with "Write
        // it anyway", are not asked at all. On 8 November 2026 the owner
        // added a inkwell_ivy post about turning his sketches into watercolors with AI; the
        // qualifier, asked only for an angle, answered "rejected, score 0,
        // outside the business's core expertise in AI SEO content", and the
        // job stopped on a sentence about adverts. A reply speaks from the
        // writer (About you), not from the business's keywords, and the
        // drafter reads both the thread and the writer: it takes the angle
        // itself, and no model's verdict stands between a person's choice
        // and a draft. One paid call fewer, too.
        const byPerson = target.qualified_by === PERSON_VERDICT;
        const personDecided = byPerson || anyway;
        let angle = (target.qualify_angle as string | null) ?? null;
        let requalified: "qualified" | null = null;
        if (angle && angleIsPitch(angle, brandNames) && personDecided) {
          // A brief to present the product is no place to start. The
          // drafter picks the angle from the thread and the writer.
          angle = null;
        } else if (!personDecided && (!angle || angleIsPitch(angle, brandNames))) {
          const now = new Date();
          const row: TargetRow = {
            id: target.id as string,
            surface: target.surface as string,
            kind: (target.kind as string) || "thread",
            url: (target.url as string | null) ?? "",
            title: target.title as string,
            // The angle is found in what the post quotes and answers too.
            excerpt: excerptWithReferenced((target.excerpt as string | null) ?? null, referenced),
            community: (target.community as string | null) ?? null,
            posted_at: (target.posted_at as string | null) ?? null,
            score: (target.score as number | null) ?? null,
            comment_count: (target.comment_count as number | null) ?? null,
            found_for: (target.found_for as string | null) ?? null,
          };
          const askAngle = (refusedAngles: string[]) =>
            runAgent(
              placementQualifyAgent,
              {
                business: businessInput,
                expertise,
                aboutWriter: voice.aboutYou,
                writerNotes: voice.instructions,
                // One thread, and the draft is built on what it says: worth
                // the quality tier, which a batch of twenty a week is not.
                tier: "quality",
                mode: "angle",
                refusedAngles,
                language,
                threads: toThreads([row], now),
              },
              agentCtx,
              recorder
            );
          let judged = await askAngle([]);
          let verdict = judged.verdicts.find((v) => v.index === 0);
          let found = angleFromVerdict(verdict, brandNames);
          if (!found && verdict?.angle && verdict.verdict !== "rejected") {
            // The model said something, and the domain rule read it as the
            // product in other words. One more ask, with that answer quoted
            // as refused: a person clicked, and a heuristic's first opinion
            // is not the place to stop them.
            judged = await askAngle([verdict.angle]);
            verdict = judged.verdicts.find((v) => v.index === 0);
            found = angleFromVerdict(verdict, brandNames);
          }
          if (!found) {
            // Nothing to say, in the model's judgement. The row stays
            // exactly as it was; the person reads the true reason and
            // decides (Write it anyway, Open, Reject on the card).
            const pitchOnly = Boolean(verdict?.angle) && verdict?.verdict !== "rejected";
            throw new TerminalStepError(
              pitchOnly
                ? NO_ANGLE_MESSAGE
                : verdict?.verdict === "rejected"
                  ? declinedByModelMessage(verdict.reason)
                  : declinedMessage("the AI found nothing to add that the thread does not already say")
            );
          }
          await supabase
            .from("placement_targets")
            .update({
              qualify_angle: found,
              qualify_reason: verdict?.reason ?? null,
              topic: verdict?.topic ?? null,
              intent: verdict?.intent ?? null,
              qualified_by: "agent",
              qualified_at: now.toISOString(),
              updated_at: now.toISOString(),
            })
            .eq("id", targetId);
          angle = found;
          requalified = "qualified";
        }

        // The shape of this reply is dealt here, not chosen by the model:
        // stable for a resumed step (same job), different for a regenerate
        // (new job), so two drafts of one thread do not come out alike.
        const approach = pickApproach(`${targetId}:${ctx.job.id}`);
        const draftedAt = new Date();
        const settings = parseAeoSettings(business.aeo_settings);
        const site = businessInput.domain ? domainOf(businessInput.domain) : "";
        const auditCtx = {
          thread: {
            surface: target.surface as string,
            kind: (target.kind as string) || "thread",
            title: target.title as string,
            // The checks that compare the reply with the post read what it
            // quotes and answers too: a reply about the quoted post is on topic.
            excerpt: excerptWithReferenced((target.excerpt as string | null) ?? null, referenced),
          },
          business: {
            name: businessInput.name,
            domains: [site, ...settings.domains].filter(Boolean),
            brandNames: settings.brandNames,
          },
          angle,
          expertise,
          writer: { aboutYou: voice.aboutYou, instructions: voice.instructions, confirmedFacts: voice.confirmedFacts },
          // The clock for a dated fact stated as current; the same one
          // decides which facts the drafter is told are dated.
          now: draftedAt,
        };
        const variants = variantsFor(target.surface as string, (target.kind as string) || "thread");
        // The replies the owner posted, as the voice a short reply matches,
        // and the notes he gave when correcting earlier drafts, as mistakes
        // not to repeat. Reads only, together, no model call: none posted,
        // no examples; no notes (or no `draft_feedback` table yet), no
        // block. Neither read ever fails the draft. `supabase` is the job's
        // service-role client; both reads are scoped to this business.
        const shortReply = variants.includes("short_comment");
        const [posted, corrections, mediaByTarget] = await Promise.all([
          // The replies he posted, read once: the voice examples of a short
          // reply, and with the drafts, the recent replies whose facts are
          // not to be used again (lib/placements/recent-facts.ts).
          readPostedReplies(supabase, { businessId, readBack: shortReply }),
          recentFeedback(supabase, businessId, { limit: CORRECTIONS_LIMIT }),
          // The post's images, read apart from the row (media.ts): a
          // database without the columns costs the images, not the draft.
          loadMedia(supabase, businessId, [targetId]),
        ]);
        const voiceExamples = shortReply
          ? pickVoiceExamples(posted.targets, posted.drafts, { surface: target.surface as string, names: brandNames, excludeTargetId: targetId })
          : [];
        // Which About you sentences the last ten replies used. One more
        // indexed read, no model: told to the drafter, and to the gate's
        // advisory check "Repeats a recent fact" (12 November 2026).
        const recent = recentFacts(
          await loadRecentReplies(supabase, { businessId, excludeTargetId: targetId, posted }),
          voice.aboutYou,
          draftedAt
        );
        const judgeCtx = { ...auditCtx, recentFacts: recent };
        const imagePlan = draftImagePlan(mediaByTarget?.get(targetId) ?? { media: null, unread: null });
        const draftInput = {
          business: businessInput,
          expertise,
          thread: {
            surface: target.surface as string,
            kind: (target.kind as string) || "thread",
            community: (target.community as string | null) ?? "",
            title: target.title as string,
            excerpt: (target.excerpt as string | null) ?? "",
            author: (target.author as string | null) ?? null,
          },
          angle,
          // Who decided to answer: the drafter never weighs whether to,
          // and with no angle it finds one from the thread and the writer.
          chosenByPerson: personDecided,
          // The confirmations ("Still true") left out: they decide which
          // facts are stale, above, and the drafter never reads the map.
          voice: voiceForWriter(voice),
          voiceExamples,
          corrections,
          recentFacts: recent,
          // About you sentences dated more than 30 days ago: the drafter
          // states them as of their date, never as current. A pure read of
          // the setting, no model call (lib/voice/staleness.ts).
          staleFacts: staleFacts(voice.aboutYou, draftedAt, { confirmations: voice.confirmedFacts }).map(({ sentence, dateLabel }) => ({ sentence, dateLabel })),
          // Up to two of the post's images, and how many it has that the
          // drafter is not handed: the cass_builds screenshot of 11 November
          // 2026 was the question, and the draft asked for it.
          // The quoted post's photos in the slots the post's own leave free.
          images: [...imagePlan.images, ...quotedImageInputs(referenced, MAX_DRAFT_IMAGES - imagePlan.images.length)],
          unseenImages: imagePlan.unseen,
          // What the post quotes and replies to: @hank_ships's "The subtle art
          // of naming" of 14 November 2026 was a joke only the quoted post told.
          referenced,
          approach,
          language,
          variants,
        };

        // Write, judge, and write again what did not pass, with the failing
        // checks named. The person asked for a draft they can copy. A
        // warning is not that draft. Each round keeps, per variant, the
        // text the gate scored best. Sentences the voice check already
        // refuses (the "I use X for that" line, the tells) are deleted
        // before the judgement, because the model pastes them again once
        // they are named; nothing is put in their place. A reply that still
        // names the product or carries a URL is refused by the gate and
        // written again with that named. What still does not pass is not
        // saved: the audit step writes only a pass. What was deleted as a
        // tell is named to the rewrite (`removed`), since no check sees it.
        const ready = (drafts: DraftVariant[]) =>
          drafts.map((variant) => {
            if (variant.variant === "github_pr_proposal") return { variant, removed: null };
            const repaired = repairDraft(variant.body, brandNames);
            const body = withoutTells(repaired, variant.variant);
            const removed = body === repaired ? null : removedTellsProblem(tellsIn(repaired, variant.variant));
            return { variant: { ...variant, body }, removed };
          });

        let startedAt = Date.now();
        const output = await runAgent(placementDraftAgent, draftInput, agentCtx, recorder);
        let lastWriteMs = Date.now() - startedAt;
        let best = judgeVariants(ready(output.variants), judgeCtx);
        let writes = 1;
        // How the drafter read the post, from the first write that said:
        // the rewrites answer the same post.
        let reading: PostReading | null = output.reading;

        while (writes < MAX_WRITES) {
          // A style rule the notes set (lowercase) is asked for again even
          // on a pass; the best write is kept whatever it scores.
          // A repeated fact asks for the first rewrite only.
          const open = best.filter((item) => unfinished(item.audit, writes === 1));
          if (open.length === 0) break;
          if (!timeForAnotherWrite(ctx.deadline, lastWriteMs)) break;
          try {
            startedAt = Date.now();
            const rewritten = await runAgent(
              placementDraftAgent,
              {
                ...draftInput,
                variants: open.map((item) => item.variant.variant),
                revisions: open.map((item) => ({
                  variant: item.variant.variant,
                  problems: problemsOf(item.audit, item.removed),
                })),
              },
              agentCtx,
              recorder
            );
            lastWriteMs = Date.now() - startedAt;
            reading = reading ?? rewritten.reading;
            const again = judgeVariants(ready(rewritten.variants), judgeCtx);
            best = best.map((current) => {
              const candidate = again.find((item) => item.variant.variant === current.variant.variant);
              return candidate && auditPenalty(candidate.audit) < auditPenalty(current.audit) ? candidate : current;
            });
          } catch (err) {
            // The deadline abort, or a model that will not answer again:
            // keep the best text already judged and let the audit step
            // record it. Throwing here would throw that text away.
            if (ctx.signal?.aborted) break;
            if (!(err instanceof LlmError) && !(err instanceof AgentBudgetExceeded)) throw err;
            break;
          }
          writes += 1;
        }

        return {
          variants: best.map((item) => item.variant),
          expertise,
          // What the first write saw of the post's images; null for a post without.
          images: draftImagesRecord(imagePlan, output.images),
          approach,
          requalified,
          writes,
          voiceExamples: voiceExamples.length,
          corrections: corrections.length,
          // The audit step judges with the same history the loop judged with.
          recentFacts: recent,
          reading,
        };
      },
    },
    {
      name: "audit",
      async run(ctx) {
        const { businessId, targetId } = readInput(ctx.input);
        const { supabase } = ctx;
        const drafted = ctx.outputs.draft as
          | {
              variants: DraftVariant[];
              expertise: string[];
              requalified?: "qualified" | null;
              writes?: number;
              reading?: unknown;
              images?: unknown;
              recentFacts?: unknown;
            }
          | undefined;
        if (!drafted) throw new Error("audit needs the draft step's output");
        if (drafted.variants.length === 0) {
          throw new TerminalStepError("The draft step produced no text to audit; generate again.");
        }

        const [{ data: target }, { data: business }, referencedByTarget] = await Promise.all([
          supabase
            .from("placement_targets")
            .select("id, user_id, surface, kind, title, excerpt, status, qualify_angle")
            .eq("id", targetId)
            .eq("business_id", businessId)
            .maybeSingle(),
          supabase
            .from("businesses")
            .select("name, website_url, aeo_settings, voice_settings")
            .eq("id", businessId)
            .maybeSingle(),
          loadReferenced(supabase, businessId, [targetId]),
        ]);
        if (!target || !business) throw new Error("Target or business not found");

        const site = business.website_url ? domainOf(business.website_url as string) : "";
        const settings = (business.aeo_settings as { domains?: string[]; brandNames?: string[] } | null) ?? {};
        const voice = parseVoiceSettings(business.voice_settings);
        const auditedAt = new Date();
        // Kept beside each saved draft's verdict, so a later correction is
        // shown what the drafter thought the post meant.
        const reading = parseReading(drafted.reading);
        // And what it saw of the post's images, with the advisory check
        // "Image not read" when it did not see one the post has.
        const images = parseDraftImages(drafted.images);
        // The recent facts the loop judged with; a draft step from before
        // them, or an unreadable value, judges without the check.
        const recentParsed = RecentFacts.safeParse(drafted.recentFacts);
        const recentFacts = recentParsed.success ? recentParsed.data : undefined;
        const audits = drafted.variants.map((variant) => ({
          variant,
          audit: auditDraft(variant, {
            thread: {
              surface: target.surface as string,
              kind: (target.kind as string) || "thread",
              title: target.title as string,
              // Judged as the draft loop judged it: with what the post quotes and answers.
              excerpt: excerptWithReferenced((target.excerpt as string | null) ?? null, referencedByTarget?.get(targetId) ?? null),
            },
            business: {
              name: (business.name as string | null) ?? "",
              domains: [site, ...(settings.domains ?? [])].filter(Boolean),
              brandNames: settings.brandNames ?? [],
            },
            angle: (target.qualify_angle as string | null) ?? null,
            expertise: drafted.expertise,
            writer: { aboutYou: voice.aboutYou, instructions: voice.instructions, confirmedFacts: voice.confirmedFacts },
            now: auditedAt,
            recentFacts,
          }),
        }));

        // A pass is every check. A warning is the gate saying the text still
        // reads as a pitch or an essay, and that text is not the answer.
        const passing = audits.filter((item) => item.audit.status === "passed");
        const now = new Date().toISOString();
        const movable = ["qualified", "drafted", "needs_review"].includes(target.status as string);

        if (passing.length === 0) {
          // An approved or published target keeps the draft it already has.
          // Everywhere else the refused text is not left on the card.
          if (movable) {
            await supabase.from("placements").delete().eq("target_id", targetId).eq("business_id", businessId);
            if (target.status !== "qualified") {
              await supabase.from("placement_targets").update({ status: "qualified", updated_at: now }).eq("id", targetId);
            }
          }
          throw new TerminalStepError(draftsRefusedMessage(audits));
        }

        // Idempotent: a resumed audit replaces this job's earlier rows rather
        // than adding a second set. Variants that did not pass are not in it.
        await supabase.from("placements").delete().eq("target_id", targetId).eq("business_id", businessId);

        const { error } = await supabase.from("placements").insert(
          passing.map(({ variant, audit }) => ({
            user_id: target.user_id as string,
            business_id: businessId,
            target_id: targetId,
            variant: variant.variant,
            body: variant.body,
            link_url: variant.linkUrl,
            claims: variant.claims,
            audit: withImages(withReading(audit, reading), images),
            audit_status: audit.status,
            agent_version: placementDraftAgent.version,
            created_at: now,
            updated_at: now,
          }))
        );
        if (error) throw new Error(`placements insert failed: ${error.message}`);

        // A target already approved or published is not demoted by a redraft.
        if (movable) {
          await supabase
            .from("placement_targets")
            .update({ status: statusAfterAudit("passed"), updated_at: now })
            .eq("id", targetId);
        }

        return {
          variants: passing.map((a) => ({ variant: a.variant.variant, audit: a.audit.status })),
          omitted: audits.filter((a) => a.audit.status !== "passed").map((a) => a.variant.variant),
          status: movable ? statusAfterAudit("passed") : target.status,
          requalified: drafted.requalified ?? null,
          writes: drafted.writes ?? 1,
        };
      },
    },
  ],
};
