import type { CitationSource } from "@/lib/providers/citations/types";
import { inWindow, type PeriodWindows } from "./period";

/**
 * Growth → AI answers: did an answer engine cite the site when asked, per
 * engine, over a period against the one before; and the answers themselves,
 * as evidence (`/growth/ai`, `list_ai_answers`). Pure.
 *
 * Two families of asks exist, and the count reads both (docs/CITATIONS.md,
 * "One count of asks"):
 *
 * - **prompt** asks, `aeo_probes`: one of the questions the owner chose,
 *   asked of one engine in a visibility run; every source kept verbatim;
 * - **article** asks, `ai_citations`: the weekly sweep asks each engine the
 *   keyword a published article was written for; the verdict is kept, and
 *   the cited page and an excerpt only when the site was cited.
 *
 * Both ask once and look for one of the site's domains
 * among the sources the engine returned. An ask counts when the engine gave
 * a readable answer (a prompt probe `cited` or `not_cited`; every stored
 * article check, since the sweep stores only answers it read); a prompt
 * probe with no readable answer (`invalid`, `error`) is not an ask that was
 * answered, so it is counted apart (`unreadable`) and never as "not cited".
 *
 * Per engine, never across engines: engines disagree, and a pooled number
 * describes nothing. A count with no ask is null, "not asked", never 0.
 */

export type AskKind = "prompt" | "article";
export type AnswerStatus = "cited" | "not_cited" | "invalid" | "error";

export interface Ask {
  engine: string;
  kind: AskKind;
  /** When it was asked: a UTC day or an ISO timestamp. */
  askedAt: string;
  status: AnswerStatus;
}

export interface AskCount {
  /** Readable answers: cited + not cited. The rate's denominator. */
  asks: number;
  cited: number;
  /** cited / asks; null with no ask (not asked, never 0). */
  rate: number | null;
}

export interface EngineAsks {
  engine: string;
  current: AskCount;
  previous: AskCount;
  /** The current period split by family, so a reader can tell the two apart. */
  byKind: { prompts: AskCount; articles: AskCount };
  /** Prompt asks in the current period that got no readable answer. Not in `current`. */
  unreadable: number;
}

function count(asks: number, cited: number): AskCount {
  return { asks, cited, rate: asks === 0 ? null : cited / asks };
}

function isReadable(status: AnswerStatus): boolean {
  return status === "cited" || status === "not_cited";
}

/**
 * One row per engine that was asked in either period, plus every engine in
 * `engines` (the configured ones), which reads "not asked" when it was not.
 */
export function summarizeAsks(asks: readonly Ask[], windows: PeriodWindows, engines: readonly string[] = []): EngineAsks[] {
  type Bucket = { cur: [number, number]; prev: [number, number]; prompts: [number, number]; articles: [number, number]; unreadable: number };
  const buckets = new Map<string, Bucket>();
  const bucket = (engine: string): Bucket => {
    let b = buckets.get(engine);
    if (!b) {
      b = { cur: [0, 0], prev: [0, 0], prompts: [0, 0], articles: [0, 0], unreadable: 0 };
      buckets.set(engine, b);
    }
    return b;
  };
  for (const engine of engines) bucket(engine);

  for (const ask of asks) {
    const current = inWindow(ask.askedAt, windows.current);
    const previous = !current && inWindow(ask.askedAt, windows.previous);
    if (!current && !previous) continue;
    const b = bucket(ask.engine);
    if (!isReadable(ask.status)) {
      if (current) b.unreadable += 1;
      continue;
    }
    const cited = ask.status === "cited" ? 1 : 0;
    const target = current ? b.cur : b.prev;
    target[0] += 1;
    target[1] += cited;
    if (current) {
      const family = ask.kind === "prompt" ? b.prompts : b.articles;
      family[0] += 1;
      family[1] += cited;
    }
  }

  return [...buckets.entries()]
    .map(([engine, b]) => ({
      engine,
      current: count(...b.cur),
      previous: count(...b.prev),
      byKind: { prompts: count(...b.prompts), articles: count(...b.articles) },
      unreadable: b.unreadable,
    }))
    .sort((a, b) => a.engine.localeCompare(b.engine));
}

// ── The evidence ────────────────────────────────────────────────────────────

export interface AnswerSource {
  /** 1-based, the order the engine gave. */
  position: number;
  /** As the engine returned it, verbatim. */
  url: string;
  domain: string;
  title: string | null;
  /** False when the address is the vendor's redirect, not the page (it expires; the title names the site). */
  opensPage: boolean;
  /** One of the site's own domains. */
  ours: boolean;
  /** This page is an open place to reply in Today. */
  inToday: boolean;
}

export interface AiAnswer {
  /** `prompt:<probe id>` or `article:<check id>`. */
  id: string;
  kind: AskKind;
  question: string;
  engine: string;
  /** ISO timestamp for a prompt ask, the UTC day for an article check. */
  askedAt: string;
  status: AnswerStatus;
  /** Counted in the per-engine asks (a readable answer). */
  counted: boolean;
  /** The site's place among the sources, 1-based; null when not cited or not kept. */
  ourPosition: number | null;
  /** The site's page the engine cited; null when it did not, or it was not kept. */
  citedUrl: string | null;
  /** The brand was named in the answer's words (prompt asks); null when not judged. */
  mentioned: boolean | null;
  /** The start of the engine's answer, as stored; null when none was kept. */
  excerpt: string | null;
  /** Every source the engine returned, numbered. Empty when none was returned or kept. */
  sources: AnswerSource[];
  /** False for an article check: only the cited page is kept, not the source list. */
  sourcesKept: boolean;
  /** Open places in Today that came from this answer's sources. */
  placesInToday: number;
  promptId: string | null;
  articleId: string | null;
  error: string | null;
}

/** An open Replies/Today row, as the source marks need it. */
export interface OpenPlace {
  id: string;
  /** The canonical identity (`surface:externalId`), as the inbox stores it. */
  key: string;
  /** The page's own domain. */
  domain: string;
  /** The visibility sighting it rests on, when a run's answer sent it. */
  sighting: { runId: string | null; prompts: Array<{ query: string; engines: string[] }> } | null;
}

/**
 * Which of an answer's sources are the site's own, and which are open places
 * in Today. A source is "in Today" when its page is the place's page (the
 * canonical identity, `keyOf`), or, for a vendor redirect that names only
 * the site, when exactly one source of this answer is on the domain of a
 * place this very answer sent (same run, prompt and engine). Two sources on
 * that domain cannot be told apart, so neither is marked: the count of
 * places from this answer still says how many there are.
 */
export function markSources(
  answer: { runId: string | null; question: string; engine: string; sources: readonly CitationSource[] },
  ctx: {
    isOurs: (domain: string) => boolean;
    keyOf: (url: string) => string | null;
    isRedirect: (url: string) => boolean;
    places: readonly OpenPlace[];
  }
): { sources: AnswerSource[]; placesInToday: number } {
  const byKey = new Map(ctx.places.map((p) => [p.key, p]));
  const fromThisAnswer = ctx.places.filter(
    (p) =>
      p.sighting !== null &&
      answer.runId !== null &&
      p.sighting.runId === answer.runId &&
      p.sighting.prompts.some((q) => q.query === answer.question && q.engines.includes(answer.engine))
  );
  const counted = new Set(fromThisAnswer.map((p) => p.id));

  const domainCount = new Map<string, number>();
  for (const s of answer.sources) domainCount.set(s.domain, (domainCount.get(s.domain) ?? 0) + 1);

  const sources = answer.sources.map((source, index): AnswerSource => {
    const redirect = ctx.isRedirect(source.url);
    let place: OpenPlace | undefined;
    if (!redirect) {
      const key = ctx.keyOf(source.url);
      place = key ? byKey.get(key) : undefined;
    } else if ((domainCount.get(source.domain) ?? 0) === 1) {
      const sameDomain = fromThisAnswer.filter((p) => p.domain === source.domain);
      if (sameDomain.length === 1) place = sameDomain[0];
    }
    if (place) counted.add(place.id);
    const ours = ctx.isOurs(source.domain);
    return {
      position: index + 1,
      url: source.url,
      domain: source.domain,
      title: source.title?.trim() ? source.title.trim() : null,
      opensPage: !redirect,
      ours,
      inToday: !ours && Boolean(place),
    };
  });
  return { sources, placesInToday: counted.size };
}
