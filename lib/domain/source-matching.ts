/**
 * Whether an answer engine's source or prose points at a given company. Pure:
 * no I/O, no clock, no database. AI Visibility (`lib/visibility/verdict.ts`),
 * Growth and the placements all judge "is this ours?" with these two
 * primitives, so no surface can disagree with another about what a citation
 * or a mention is.
 */

/**
 * Names common enough as ordinary words that a text match may be coincidence.
 *
 * Kept explicit and short rather than inferred: a heuristic that guesses which
 * names are risky would itself need testing, and being wrong about it would
 * quietly inflate the mention count. A name here is still matched, it is just
 * flagged `ambiguous` so a reader can discount it.
 *
 * Only lowercase, single-token entries belong here; a multi-word name is
 * specific enough on its own.
 */
const AMBIGUOUS_NAMES = new Set([
  "linear",
  "notion",
  "framer",
  "bolt",
  "cursor",
  "lovable",
  "replit",
  "arc",
  "brave",
  "canvas",
  "loop",
  "beacon",
  "compass",
  "atlas",
  "orbit",
  "pulse",
  "relay",
  "scale",
  "stack",
  "vault",
  "wave",
]);

/** A one-token name this short is a coincidence waiting to happen. */
const MIN_UNAMBIGUOUS_NAME_LENGTH = 4;

/**
 * Does this source belong to the company's site?
 *
 * Exact host, or a subdomain of it. The subdomain case is deliberate: an
 * engine citing `blog.company.com` or `docs.company.com` is still citing that
 * company, and counting it as a miss would understate every company that puts
 * its content on a subdomain, which is most of them.
 *
 * The check is on a dot boundary, never a bare `endsWith`: without it
 * `notcompany.com` would match `company.com`.
 */
export function isCompanySource(sourceDomain: string, companyDomain: string): boolean {
  const source = sourceDomain.toLowerCase().replace(/^www\./, "");
  const company = companyDomain.toLowerCase().replace(/^www\./, "");
  if (!source || !company) return false;
  return source === company || source.endsWith(`.${company}`);
}

/** The two fields a prose match needs; anything with a name can be matched. */
export interface NamedEntity {
  name: string;
  aliases?: string[];
}

/** Every spelling of the company we are willing to match in prose. */
function namesOf(company: NamedEntity): string[] {
  return [company.name, ...(company.aliases ?? [])]
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

function isAmbiguousName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes(" ")) return false;
  return lower.length < MIN_UNAMBIGUOUS_NAME_LENGTH || AMBIGUOUS_NAMES.has(lower);
}

/** Whole-word, case-insensitive, regex-safe. */
function mentionsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
}

/**
 * Was the company named in the answer's prose?
 *
 * Weaker evidence than a cited source and always reported apart from it: an
 * engine can name a company while citing someone else's page about it, which
 * is a mention but not a citation.
 */
export function findMention(
  answerText: string,
  company: NamedEntity
): { mentioned: boolean; ambiguous: boolean } {
  const matched = namesOf(company).filter((name) => mentionsName(answerText, name));
  if (matched.length === 0) return { mentioned: false, ambiguous: false };

  // Ambiguous only when EVERY spelling that matched is a risky one: if an
  // unambiguous alias also matched, the match is safe.
  return { mentioned: true, ambiguous: matched.every(isAmbiguousName) };
}
