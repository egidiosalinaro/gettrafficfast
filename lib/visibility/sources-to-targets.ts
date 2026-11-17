import type { CitationSource } from "@/lib/providers/citations/types";
import { isSourceRedirect } from "@/lib/providers/citations/resolve";
import { canonicalTarget, contentHash } from "@/lib/providers/discovery/canonical";
import { domainOf } from "@/lib/providers/serp/types";
import {
  AI_VISIBILITY_SOURCE,
  MAX_CITATION_PROMPTS,
  engineList,
  type AiCitation,
} from "@/lib/placements/ai-citation";
import { applyRules, freshUntil, type RuleTarget } from "@/lib/placements/rules";
import { LISTICLE_KIND } from "@/lib/placements/workflow";
import { isCompanySource } from "@/lib/domain/source-matching";
import { MAX_NEW_TARGETS_PER_RUN } from "./settings";

/**
 * From what a visibility run measured to places a person can act on.
 *
 * A run stores, per prompt and per engine, the sources each answer cited
 * (`aeo_probes.sources`). An answer that cited other pages and not the
 * site's is the product's best lead on where the engine looks for that
 * prompt. This module turns those sources into candidates for the Replies
 * inbox: pages where a person can take part (a thread, a post, an issue, an
 * awesome-list) or ask to be listed (a "best X tools" article).
 *
 * Pure: no I/O, no clock other than the one passed in, and no model. What a
 * page is comes from its address through the one canonicaliser
 * (lib/providers/discovery/canonical.ts), so a page found here and the same
 * page found by discovery are one row. Deciding that a page is worth a reply
 * costs nothing here because nothing is asked: the evidence is the citation.
 *
 * The honest limits, which every caller inherits:
 *   - it is what one sampled run returned. Nothing here says an engine
 *     always reads a page;
 *   - engines are kept per prompt and by name, never merged into a score.
 *     The ranking counts prompts and engines; it is an order, not a rate;
 *   - nothing is filled in. An answer gives an address and sometimes a
 *     title: no date, no text, no comment count. Those stay null.
 */

/** New rows one run may create. The rest waits for the next run (`planTargets`). */
export { MAX_NEW_TARGETS_PER_RUN };

/** Rows already in the inbox one run may point at again. Bounds the updates. */
export const MAX_LINKED_TARGETS_PER_RUN = 25;

/** Source redirects one run reads back to a page. Each is one free HTTP request. */
export const MAX_SOURCE_LOOKUPS_PER_RUN = 40;

/** What the selection reads off a probe row. */
export interface SourceProbe {
  queryId: string | null;
  query: string;
  engine: string;
  /** `cited`, `not_cited`, `invalid`, `error`, `pending`. */
  status: string;
  sources: CitationSource[];
}

export interface SelectionContext {
  /** The site's own domains: a page there is not a place to reply. */
  ownDomains: readonly string[];
  /** Known competitors' domains: their own pages are not a place to reply or be listed. */
  competitorDomains: readonly string[];
  /** Source redirects read back to the page they stand for (lib/providers/citations/resolve.ts). */
  resolved?: ReadonlyMap<string, string>;
  /**
   * Which answers count. `not_cited` (the default): answers that did not
   * cite the site, where a place is most worth having. `all`: every
   * readable answer.
   */
  scope?: "not_cited" | "all";
}

export interface CandidatePrompt {
  queryId: string | null;
  query: string;
  /** The engines whose answer cited the page for this prompt, by name order. */
  engines: string[];
}

export interface SourceCandidate {
  /** `${surface}:${externalId}`: the canonical identity, the inbox's unique key per site. */
  key: string;
  surface: string;
  kind: string;
  externalId: string;
  url: string;
  community: string;
  author: string | null;
  title: string;
  /** Where the title came from: the engine's source list, or the words of the address. */
  titleFrom: "source" | "url";
  /** The prompts whose answer cited the page, most engines first. */
  prompts: CandidatePrompt[];
  /** Distinct engines across those prompts. */
  engines: string[];
  /** Prompt × engine pairs: how many sampled answers cited the page. */
  sightings: number;
}

export type DropReason =
  /** On one of the site's own domains. */
  | "own_site"
  /** A known competitor's own page. */
  | "competitor"
  /** A homepage, a product page, a profile, a plain article: nowhere to take part or be listed. */
  | "not_a_place"
  /** A redirect that was not read back to a page, or an address that is not one. */
  | "unread";

export interface Selection {
  /** Ranked, best first. */
  candidates: SourceCandidate[];
  /** Distinct pages left out, by why. */
  dropped: Record<DropReason, number>;
}

function isOwn(domain: string, ctx: SelectionContext): boolean {
  return Boolean(domain) && ctx.ownDomains.some((own) => isCompanySource(domain, own));
}

function isCompetitor(domain: string, ctx: SelectionContext): boolean {
  return Boolean(domain) && ctx.competitorDomains.some((c) => isCompanySource(domain, c));
}

function counts(probe: SourceProbe, ctx: SelectionContext): boolean {
  return probe.status === "not_cited" || (ctx.scope === "all" && probe.status === "cited");
}

/** A hostname standing where a title should be: what a grounded source carries. */
function isBareHost(text: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(text.trim());
}

/** The engine's own title for the page, when it gave one that is a title. */
function realTitle(title: string): string | null {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean.length >= 3 && !isBareHost(clean) ? clean : null;
}

/** The words of an address: path segments, separators as spaces. */
function pathWords(url: string): string {
  try {
    const { pathname } = new URL(url);
    return decodeURIComponent(pathname)
      .replace(/\.(html?|php|aspx?)$/i, "")
      .replace(/[-_+/.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

/**
 * A title read off the address, for a source the engine gave no title for.
 * The last segment that is words ("best_ai_seo_tools" → "best ai seo
 * tools"); with none, the address itself without its scheme. These are the
 * page's own words in its own address, not a summary: the card links to the
 * page, and `titleFrom` says where the words came from.
 */
export function titleFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    let words = segments[i];
    try {
      words = decodeURIComponent(words);
    } catch {
      // Keep the raw segment.
    }
    words = words.replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
    // Words, not an id: at least two of them, mostly letters.
    if (words.split(" ").length >= 2 && words.replace(/[^\p{L}]/gu, "").length >= 8) return words;
  }
  return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}${parsed.search}`.replace(/\/$/, "");
}

/**
 * The shapes a list article's title or address takes: best, top N,
 * alternatives, vs, tools for, compared. A few other languages' "best" are
 * read too, because a site's prompts are asked in its content language.
 */
const LISTICLE_PATTERNS: RegExp[] = [
  /\b(best|migliori|mejores|meilleurs|meilleures|besten)\b/i,
  /\btop\s?\d+\b/i,
  /\b\d+\s+(best|top)\b/i,
  /\balternativ(e|es|as|en)\b/i,
  /\b(vs\.?|versus)\b/i,
  /\b(tools?|software|apps?|platforms?)\s+(for|to)\b/i,
  /\b(compared|comparison)\b/i,
];

/**
 * Whether a page on the open web reads as a list article. Judged on the
 * engine's title, when it gave one, and on the words of the address; a
 * site's front page is never one, whatever its title says.
 */
export function isListicle(url: string, title: string | null): boolean {
  const words = pathWords(url);
  if (!words) return false;
  const text = `${title ?? ""} ${words}`;
  return LISTICLE_PATTERNS.some((pattern) => pattern.test(text));
}

/** A GitHub repository that is a list people add to, by its name or title. */
function isAwesomeList(slug: string, title: string | null): boolean {
  return /\bawesome\b/i.test(`${slug.replace(/[-_/.]+/g, " ")} ${title ?? ""}`);
}

interface Sighting {
  url: string;
  title: string | null;
  queryId: string | null;
  query: string;
  engine: string;
}

/**
 * The redirects worth reading back to a page, most promising first, at most
 * `limit`. A source on a known platform (a thread, a post) comes before one
 * on any other host (which is a place only when it turns out to be a list
 * article), and within each group the host cited by more answers comes
 * first. Own and competitor hosts are never looked up: whatever the page,
 * it is dropped.
 */
export function redirectsToResolve(
  probes: readonly SourceProbe[],
  ctx: SelectionContext,
  limit = MAX_SOURCE_LOOKUPS_PER_RUN
): string[] {
  const byUrl = new Map<string, { platform: boolean; domain: string }>();
  const byDomain = new Map<string, number>();
  for (const probe of probes) {
    if (!counts(probe, ctx)) continue;
    for (const source of probe.sources) {
      if (!source.url || !isSourceRedirect(source.url)) continue;
      const domain = (source.domain || "").toLowerCase();
      if (!domain || isOwn(domain, ctx) || isCompetitor(domain, ctx)) continue;
      byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
      if (!byUrl.has(source.url)) {
        const surface = canonicalTarget(`https://${domain}/`)?.surface ?? "web";
        byUrl.set(source.url, { platform: surface !== "web", domain });
      }
    }
  }
  return [...byUrl.entries()]
    .sort(([aUrl, a], [bUrl, b]) => {
      if (a.platform !== b.platform) return a.platform ? -1 : 1;
      const delta = (byDomain.get(b.domain) ?? 0) - (byDomain.get(a.domain) ?? 0);
      return delta !== 0 ? delta : aUrl.localeCompare(bUrl);
    })
    .slice(0, Math.max(0, limit))
    .map(([url]) => url);
}

/**
 * The run's cited sources as ranked candidates.
 *
 * Ranking: a page cited for more prompts comes first, then one cited by
 * more engines, then one cited in more answers; ties keep address order, so
 * the same probes always give the same list. A page cited for three prompts
 * on two engines outranks one cited once.
 */
export function rankSources(probes: readonly SourceProbe[], ctx: SelectionContext): Selection {
  const dropped: Record<DropReason, number> = { own_site: 0, competitor: 0, not_a_place: 0, unread: 0 };
  const droppedKeys: Record<DropReason, Set<string>> = {
    own_site: new Set(),
    competitor: new Set(),
    not_a_place: new Set(),
    unread: new Set(),
  };
  const drop = (reason: DropReason, key: string) => droppedKeys[reason].add(key);

  const pages = new Map<
    string,
    { target: NonNullable<ReturnType<typeof canonicalTarget>>; kind: string; sightings: Sighting[] }
  >();

  for (const probe of probes) {
    if (!counts(probe, ctx)) continue;
    for (const source of probe.sources) {
      const stated = (source.domain || "").toLowerCase();
      if (isOwn(stated, ctx)) {
        drop("own_site", stated);
        continue;
      }
      const raw = (source.url ?? "").trim();
      const url = raw && isSourceRedirect(raw) ? ctx.resolved?.get(raw) : raw;
      if (!url) {
        drop("unread", raw || stated);
        continue;
      }
      const target = canonicalTarget(url);
      if (!target) {
        drop("unread", url);
        continue;
      }
      const host = domainOf(target.url);
      const key = `${target.surface}:${target.externalId}`;
      if (isOwn(host, ctx)) {
        drop("own_site", key);
        continue;
      }
      const title = realTitle(source.title ?? "");

      let kind: string = target.kind;
      if (target.surface === "web") {
        // The open web: a competitor's own page is never a place, and any
        // other page is one only when it is a list article.
        if (isCompetitor(host, ctx)) {
          drop("competitor", key);
          continue;
        }
        if (!isListicle(target.url, title)) {
          drop("not_a_place", key);
          continue;
        }
        kind = LISTICLE_KIND;
      } else if (target.kind === "page") {
        // A profile, a tag listing, a front page of a platform.
        drop("not_a_place", key);
        continue;
      } else if (target.kind === "repository" && !isAwesomeList(target.externalId, title)) {
        // A project's repository is its product page; a list is a place.
        drop("not_a_place", key);
        continue;
      }

      const page = pages.get(key) ?? { target, kind, sightings: [] };
      page.sightings.push({ url: target.url, title, queryId: probe.queryId, query: probe.query, engine: probe.engine });
      pages.set(key, page);
    }
  }

  const candidates: SourceCandidate[] = [];
  for (const [key, page] of pages) {
    const byPrompt = new Map<string, CandidatePrompt>();
    for (const sighting of page.sightings) {
      const prompt = byPrompt.get(sighting.query) ?? { queryId: sighting.queryId, query: sighting.query, engines: [] };
      if (!prompt.queryId && sighting.queryId) prompt.queryId = sighting.queryId;
      if (!prompt.engines.includes(sighting.engine)) prompt.engines.push(sighting.engine);
      byPrompt.set(sighting.query, prompt);
    }
    const prompts = [...byPrompt.values()]
      .map((prompt) => ({ ...prompt, engines: [...prompt.engines].sort() }))
      .sort((a, b) => b.engines.length - a.engines.length || a.query.localeCompare(b.query));
    const engines = [...new Set(prompts.flatMap((p) => p.engines))].sort();
    const sourceTitle = page.sightings.map((s) => s.title).find((t): t is string => Boolean(t)) ?? null;
    candidates.push({
      key,
      surface: page.target.surface,
      kind: page.kind,
      externalId: page.target.externalId,
      url: page.target.url,
      community: page.target.community,
      author: page.target.author,
      title: sourceTitle ?? titleFromUrl(page.target.url),
      titleFrom: sourceTitle ? "source" : "url",
      prompts,
      engines,
      sightings: prompts.reduce((sum, p) => sum + p.engines.length, 0),
    });
  }

  candidates.sort(
    (a, b) =>
      b.prompts.length - a.prompts.length ||
      b.engines.length - a.engines.length ||
      b.sightings - a.sightings ||
      a.url.localeCompare(b.url)
  );

  // A page kept under one sighting is not also counted as dropped.
  for (const reason of Object.keys(droppedKeys) as DropReason[]) {
    dropped[reason] = [...droppedKeys[reason]].filter((key) => !pages.has(key)).length;
  }
  return { candidates, dropped };
}

export interface RulesPass {
  kept: SourceCandidate[];
  /** Candidates a deterministic rule turned down, by rule name. */
  rejected: Record<string, number>;
}

/**
 * The inbox's own deterministic rules (lib/placements/rules.ts), applied to
 * the candidates before any becomes a row: a page behind a login, an
 * archived Reddit thread, a promotional title. Free.
 *
 * The topical rule (`no_overlap`) is not asked: it compares a thread's words
 * with what the business can speak to, and here the only words known are a
 * title, sometimes just an address. That an engine cited the page for the
 * site's own prompt is the evidence of the topic, so `expertise` is empty.
 */
export function passRules(
  candidates: readonly SourceCandidate[],
  ctx: { now: Date; ownDomains: readonly string[]; redditArchivedBelow?: string | null }
): RulesPass {
  const kept: SourceCandidate[] = [];
  const rejected: Record<string, number> = {};
  for (const candidate of candidates) {
    const outcome = applyRules(ruleTargetOf(candidate), {
      now: ctx.now,
      ownDomains: [...ctx.ownDomains],
      expertise: [],
      redditArchivedBelow: ctx.redditArchivedBelow ?? null,
    });
    if (outcome.status === "rejected") rejected[outcome.rule] = (rejected[outcome.rule] ?? 0) + 1;
    else kept.push(candidate);
  }
  return { kept, rejected };
}

function ruleTargetOf(candidate: SourceCandidate): RuleTarget {
  return {
    surface: candidate.surface,
    kind: candidate.kind,
    url: candidate.url,
    title: candidate.title,
    excerpt: null,
    community: candidate.community || null,
    posted_at: null,
    comment_count: null,
    found_for: candidate.prompts[0]?.query ?? null,
    external_id: candidate.externalId,
  };
}

export interface TargetPlan {
  /** New rows, best first, at most the cap. */
  create: SourceCandidate[];
  /** Pages the inbox already holds: pointed at again, never duplicated. */
  link: SourceCandidate[];
  /** New pages past the cap. They are not stored; the next run takes them. */
  deferred: number;
}

/**
 * Which candidates become rows this run.
 *
 * A page the inbox already holds (same canonical identity) is never created
 * again, whatever its status: it is linked. Of the rest, the best `cap` are
 * created and the others wait. That is the rotation: what this run created
 * is "already held" for the next, so each run takes the next best pages
 * instead of the same ten.
 */
export function planTargets(
  ranked: readonly SourceCandidate[],
  existingKeys: ReadonlySet<string>,
  cap = MAX_NEW_TARGETS_PER_RUN,
  linkCap = MAX_LINKED_TARGETS_PER_RUN
): TargetPlan {
  const fresh = ranked.filter((c) => !existingKeys.has(c.key));
  const held = ranked.filter((c) => existingKeys.has(c.key));
  const create = fresh.slice(0, Math.max(0, cap));
  return { create, link: held.slice(0, Math.max(0, linkCap)), deferred: fresh.length - create.length };
}

/** The sighting as the row records it (`placement_targets.ai_citation`). */
export function citationOf(candidate: SourceCandidate, run: { runId: string | null; checkedAt: string | null }): AiCitation {
  return {
    runId: run.runId,
    checkedAt: run.checkedAt,
    promptCount: candidate.prompts.length,
    prompts: candidate.prompts.slice(0, MAX_CITATION_PROMPTS).map((p) => ({ queryId: p.queryId, query: p.query, engines: p.engines })),
  };
}

/** Why the row is in the inbox, in the person's words. Sampled, per engine, no promise. */
export function reasonOf(candidate: SourceCandidate, scope: "not_cited" | "all" = "not_cited"): string {
  const first = candidate.prompts[0];
  const where = scope === "not_cited" ? ", which did not cite your site" : "";
  const sampled = `a sampled ${engineList(first.engines)} answer to your prompt “${first.query}”${where}`;
  return candidate.kind === LISTICLE_KIND
    ? `A list article cited in ${sampled}. There is nothing to reply to: ask its author to consider you for the list. Nothing is written or sent for you.`
    : `Cited in ${sampled}.`;
}

/**
 * The row a candidate becomes.
 *
 * Qualified, with no score: the verdict is not a model's and not a
 * person's, it is the citation (`qualified_by` = AI_VISIBILITY_SOURCE), and
 * a citation has no score to give. No angle either: the draft job asks for
 * one when a person asks for a draft. What the answer did not say stays
 * null: the text, the date, the engagement.
 */
export function targetRowOf(
  candidate: SourceCandidate,
  params: {
    userId: string;
    businessId: string;
    runId: string | null;
    checkedAt: string | null;
    now: Date;
    scope?: "not_cited" | "all";
  }
): Record<string, unknown> {
  const iso = params.now.toISOString();
  const first = candidate.prompts[0];
  return {
    user_id: params.userId,
    business_id: params.businessId,
    surface: candidate.surface,
    kind: candidate.kind,
    external_id: candidate.externalId,
    url: candidate.url,
    title: candidate.title,
    excerpt: null,
    community: candidate.community || null,
    author: candidate.author,
    found_for: first.query,
    found_via: AI_VISIBILITY_SOURCE,
    // The address stands in for the excerpt: a short title must not
    // collapse two different pages into one opportunity.
    content_hash: contentHash(candidate.title, candidate.url),
    posted_at: null,
    posted_at_precision: null,
    score: null,
    comment_count: null,
    fresh_until: freshUntil(candidate.kind, null),
    last_seen_at: iso,
    status: "qualified",
    qualify_score: null,
    qualify_reason: reasonOf(candidate, params.scope),
    qualify_angle: null,
    qualified_by: AI_VISIBILITY_SOURCE,
    qualified_at: iso,
    aeo_query_id: first.queryId,
    ai_citation: citationOf(candidate, { runId: params.runId, checkedAt: params.checkedAt }),
    updated_at: iso,
  };
}
