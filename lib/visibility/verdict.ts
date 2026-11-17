import type { CitationAnswer, CitationSource } from "@/lib/providers/citations/types";
import { domainOf } from "@/lib/providers/citations/types";
import { findMention, isCompanySource } from "@/lib/domain/source-matching";
import type { BusinessIdentity } from "./settings";

/**
 * Turning one engine answer into the verdict stored on a probe. Pure: no I/O,
 * no clock. Everything that decides "were we cited" for the dashboard lives
 * here, on the shared primitives of `lib/domain/source-matching.ts`:
 * `isCompanySource` for domains (subdomain-aware, dot-boundary strict) and
 * `findMention` for prose, so no two surfaces can disagree about what a
 * citation is.
 */

/** Bumped when the judgement changes, so old probes can be told apart. */
export const PROBE_VERSION = 1;

/** How much of the answer is kept. An excerpt, and shown as one. */
export const EXCERPT_LENGTH = 600;

export type ProbeStatus = "cited" | "not_cited" | "invalid";

export interface KnownCompetitor {
  domain: string;
  name: string;
}

export interface CompetitorSighting {
  domain: string;
  name: string | null;
  /** Cited as a source, or only named in the prose. */
  via: "source" | "mention";
}

export interface ProbeVerdict {
  status: ProbeStatus;
  /** Null when the answer could not be judged: unmeasured is not "not cited". */
  cited: boolean | null;
  sourceUrl: string | null;
  position: number | null;
  mentioned: boolean | null;
  excerpt: string | null;
  sources: CitationSource[];
  competitors: CompetitorSighting[];
}

function isOurs(domain: string, identity: BusinessIdentity): boolean {
  return identity.domains.some((ours) => isCompanySource(domain, ours));
}

/**
 * An answer we cannot judge.
 *
 * No prose AND no sources means the engine returned nothing usable — a
 * refusal, an empty completion, a payload the parser did not recognise.
 * Recording that as "not cited" would lower the rate with a measurement that
 * never happened, so it is its own status and it is excluded from the rate.
 */
export function isInvalidAnswer(answer: Pick<CitationAnswer, "answer" | "sources">): boolean {
  return answer.answer.trim().length === 0 && answer.sources.length === 0;
}

export function judgeAnswer(
  answer: Pick<CitationAnswer, "answer" | "sources">,
  identity: BusinessIdentity,
  knownCompetitors: KnownCompetitor[] = []
): ProbeVerdict {
  const sources = answer.sources;
  const prose = answer.answer ?? "";

  if (isInvalidAnswer(answer)) {
    return {
      status: "invalid",
      cited: null,
      sourceUrl: null,
      position: null,
      mentioned: null,
      excerpt: null,
      sources,
      competitors: [],
    };
  }

  let hit: { position: number; source: CitationSource } | null = null;
  for (let i = 0; i < sources.length; i += 1) {
    const domain = sources[i].domain || domainOf(sources[i].url);
    if (isOurs(domain, identity)) {
      hit = { position: i + 1, source: sources[i] };
      break;
    }
  }

  const mention =
    identity.brandNames.length > 0
      ? findMention(prose, { name: identity.brandNames[0], aliases: identity.brandNames.slice(1) })
      : { mentioned: false, ambiguous: false };

  return {
    status: hit ? "cited" : "not_cited",
    cited: hit !== null,
    sourceUrl: hit?.source.url ?? null,
    position: hit?.position ?? null,
    // An ambiguous name ("Linear", "Arc") is not counted: a mention we are not
    // sure of is worth less than none.
    mentioned: mention.mentioned && !mention.ambiguous,
    excerpt: excerptOf(prose),
    sources,
    competitors: competitorsIn(sources, prose, identity, knownCompetitors),
  };
}

/**
 * Who else the engine pointed at.
 *
 * Two signals, kept apart because they are not the same evidence. Every
 * non-ours domain among the sources is a competitor for this answer whether
 * we know it or not — the engine chose to cite it. Known competitors are
 * additionally looked for in the prose, because being recommended by name
 * without a link is how a lot of answers work. Unknown names cannot be found
 * in prose without inventing a list, so they are not.
 */
export function competitorsIn(
  sources: CitationSource[],
  prose: string,
  identity: BusinessIdentity,
  known: KnownCompetitor[]
): CompetitorSighting[] {
  const byDomain = new Map<string, CompetitorSighting>();
  const nameOf = (domain: string) =>
    known.find((k) => isCompanySource(domain, k.domain))?.name ?? null;

  for (const source of sources) {
    const domain = source.domain || domainOf(source.url);
    if (!domain || isOurs(domain, identity) || byDomain.has(domain)) continue;
    byDomain.set(domain, { domain, name: nameOf(domain), via: "source" });
  }

  for (const competitor of known) {
    const domain = competitor.domain.toLowerCase().replace(/^www\./, "");
    if (!domain || isOurs(domain, identity)) continue;
    if ([...byDomain.keys()].some((d) => isCompanySource(d, domain))) continue;
    const mention = findMention(prose, { name: competitor.name });
    if (mention.mentioned && !mention.ambiguous) {
      byDomain.set(domain, { domain, name: competitor.name, via: "mention" });
    }
  }

  return [...byDomain.values()];
}

export function excerptOf(prose: string): string | null {
  const clean = prose.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length <= EXCERPT_LENGTH ? clean : `${clean.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`;
}
