import type { SupabaseClient } from "@supabase/supabase-js";
import type { KeywordSuggestion } from "@/lib/research/keywords";
import { settleIntent, tokens, unknownComparedNames, type TopicIntent } from "./intent";

/**
 * The products and platforms a site's own data names, and the only ones a
 * suggestion may name (docs/INTELLIGENCE.md, "Search intent of a topic").
 *
 * Three sources, all rows the platform already stored and paid for:
 *
 *   - the knowledge graph (`entities`, type product, organization or brand),
 *     with how many of the site's articles name each (`article_entities`);
 *   - the domains that rank for the site's keywords (`competitors`, found by
 *     the research step from the stored results pages), and the ones a
 *     person added there (`source` "manual");
 *   - the domains AI answers cited for the site's queries (`aeo_probes.
 *     competitors`).
 *
 * A name qualifies when two sources agree (a product the articles name
 * whose domain also ranks or is cited: "Jasper" and jasper.ai), when the
 * site's articles name it in two or more pieces ("WordPress", "ChatGPT"),
 * or when a person added it as a competitor. A domain alone is not a name:
 * coursera.org ranking for a keyword says nothing about what to call a
 * competitor, and a name is never made up from a domain the graph has not
 * named. The business itself is never on the list.
 *
 * What the list does NOT say is which of them compete with the business
 * and which are platforms its audience works in: rules cannot tell
 * Surfer from Zapier. The suggestion call (one model call that already runs)
 * is given the list and decides; code then holds it to the list
 * (`settleSuggestions`).
 *
 * Cost: three reads of the site's own rows, no model, no provider.
 */

export interface NamedTool {
  name: string;
  /** How many of the site's articles name it (knowledge graph). */
  articles: number;
  /** A domain of the same name ranks for the site's keywords. */
  ranks: boolean;
  /** How many of the site's AI-answer queries cited a domain of the same name. */
  citedIn: number;
  /** A person added it as a competitor. */
  manual: boolean;
}

/** How many names a suggestion call is given, at most. */
export const MAX_NAMED_TOOLS = 20;

/** Host labels that are not the brand: app.gravitywrite.com is gravitywrite. */
const HOST_PREFIXES = new Set(["www", "app", "apps", "blog", "community", "knowledge", "university", "help", "support", "docs", "go", "get", "try", "my", "en"]);

/** The brand label of a domain: "jasper.ai" → "jasper", "app.gravitywrite.com" → "gravitywrite", "foo.co.uk" → "foo". */
export function domainLabel(domain: string): string {
  const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  // A two-part public suffix (co.uk, com.au): the label is one further in.
  const label = parts.length >= 3 && last.length === 2 && second.length <= 3 ? parts[parts.length - 3] : second;
  return HOST_PREFIXES.has(label) ? "" : label.replace(/[^a-z0-9]/g, "");
}

/** The keys a name is matched to a domain by: "Surfer SEO" → surferseo, surfer; "eesel AI" → eeselai, eesel. */
function nameKeys(name: string): string[] {
  const words = tokens(name);
  const whole = words.join("");
  const core = words.filter((w) => !["ai", "seo", "app", "hq", "io", "inc", "the"].includes(w)).join("");
  return [...new Set([whole, core].filter((k) => k.length >= 2))];
}

export interface NamedToolRows {
  entities: Array<{ name: unknown; type?: unknown; articles?: unknown }>;
  competitors: Array<{ domain: unknown; name?: unknown; source?: unknown }>;
  /** Each AI answer's competitors, as `aeo_probes.competitors` stores them, with the query it answered. */
  probes: Array<{ query?: unknown; competitors: unknown }>;
  businessName?: string | null;
  websiteUrl?: string | null;
}

/** The rule, pure: rows in, the qualifying names out, the best-evidenced first, at most `MAX_NAMED_TOOLS`. */
export function namedTools(rows: NamedToolRows, max = MAX_NAMED_TOOLS): NamedTool[] {
  const own = new Set([...nameKeys(rows.businessName ?? ""), domainLabel(rows.websiteUrl ?? "")].filter(Boolean));

  const ranking = new Set<string>();
  const manual = new Map<string, string>();
  for (const row of rows.competitors) {
    const label = typeof row.domain === "string" ? domainLabel(row.domain) : "";
    if (!label) continue;
    ranking.add(label);
    if (row.source === "manual") {
      const given = typeof row.name === "string" && row.name.trim() && !row.name.includes(".") ? row.name.trim() : null;
      if (given) manual.set(label, given);
    }
  }

  const cited = new Map<string, Set<string>>();
  for (const probe of rows.probes) {
    if (!Array.isArray(probe.competitors)) continue;
    const query = typeof probe.query === "string" ? probe.query : "";
    for (const c of probe.competitors as Array<{ domain?: unknown }>) {
      const label = typeof c?.domain === "string" ? domainLabel(c.domain) : "";
      if (!label) continue;
      if (!cited.has(label)) cited.set(label, new Set());
      cited.get(label)?.add(query);
    }
  }

  const byKey = new Map<string, NamedTool>();
  for (const entity of rows.entities) {
    if (typeof entity.name !== "string" || !entity.name.trim()) continue;
    const name = entity.name.trim();
    const keys = nameKeys(name);
    if (keys.length === 0 || keys.some((k) => own.has(k))) continue;
    const articles = Number(entity.articles) || 0;
    const ranks = keys.some((k) => ranking.has(k));
    const citedIn = Math.max(0, ...keys.map((k) => cited.get(k)?.size ?? 0));
    const isManual = keys.some((k) => manual.has(k));
    if (!(isManual || ranks || citedIn > 0 || articles >= 2)) continue;
    // One entry per brand ("Jasper", "Jasper AI"): the most-named spelling wins.
    const key = keys[keys.length - 1];
    const prior = byKey.get(key);
    const merged: NamedTool = {
      name: prior && prior.articles >= articles ? prior.name : name,
      articles: Math.max(articles, prior?.articles ?? 0),
      ranks: ranks || Boolean(prior?.ranks),
      citedIn: Math.max(citedIn, prior?.citedIn ?? 0),
      manual: isManual || Boolean(prior?.manual),
    };
    byKey.set(key, merged);
  }
  // A competitor a person added counts whether or not an article named it.
  for (const [label, name] of manual) {
    if (own.has(label) || [...byKey.keys()].some((k) => nameKeys(byKey.get(k)?.name ?? "").includes(label))) continue;
    byKey.set(label, { name, articles: 0, ranks: true, citedIn: cited.get(label)?.size ?? 0, manual: true });
  }

  // The site's own articles weigh most: what it writes about is what its
  // audience works with. Ranking and AI citations corroborate.
  const weight = (t: NamedTool) => (t.manual ? 100 : 0) + t.articles * 2 + (t.ranks ? 3 : 0) + t.citedIn;
  return [...byKey.values()]
    .sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, max));
}

/**
 * Reads the three sources for one site. A source that cannot be read counts
 * as empty, and this never throws: the list is shorter, never invented, and
 * the suggestion or the sweep that asked goes on without names.
 */
export async function loadNamedTools(
  supabase: SupabaseClient,
  businessId: string,
  own: { businessName?: string | null; websiteUrl?: string | null } = {}
): Promise<NamedTool[]> {
  try {
    return await readNamedTools(supabase, businessId, own);
  } catch (error) {
    console.error("Error reading the site's named tools:", error);
    return [];
  }
}

async function readNamedTools(
  supabase: SupabaseClient,
  businessId: string,
  own: { businessName?: string | null; websiteUrl?: string | null }
): Promise<NamedTool[]> {
  const [entities, competitors, probes] = await Promise.all([
    supabase
      .from("entities")
      .select("name, type, article_entities(count)")
      .eq("business_id", businessId)
      .in("type", ["product", "organization", "brand"])
      .limit(300),
    supabase.from("competitors").select("domain, name, source").eq("business_id", businessId).limit(500),
    supabase
      .from("aeo_probes")
      .select("query, competitors")
      .eq("business_id", businessId)
      .order("checked_at", { ascending: false })
      .limit(300),
  ]);
  for (const read of [entities, competitors, probes]) {
    if (read.error) console.error("Error reading the site's named tools:", read.error);
  }
  const countOf = (row: Record<string, unknown>) => {
    const joined = row.article_entities as Array<{ count?: unknown }> | { count?: unknown } | null | undefined;
    const first = Array.isArray(joined) ? joined[0] : joined;
    return Number(first?.count) || 0;
  };
  return namedTools({
    entities: ((entities.error ? [] : entities.data) ?? []).map((row: Record<string, unknown>) => ({
      name: row.name,
      type: row.type,
      articles: countOf(row),
    })),
    competitors: (competitors.error ? [] : competitors.data) ?? [],
    probes: (probes.error ? [] : probes.data) ?? [],
    businessName: own.businessName,
    websiteUrl: own.websiteUrl,
  });
}

export interface RefusedSuggestion {
  keyword: string;
  /** The names in it nothing in the site's data vouches for. */
  names: string[];
  why: string;
}

export type SettledSuggestion = KeywordSuggestion & { intent: TopicIntent };

/**
 * What a suggestion call returned, held to the site's data:
 *
 *  - each gets its intent (`settleIntent`: the rules, then the model's
 *    label where the rules found nothing and it cannot invent anything);
 *  - a comparison that names a product nothing in the data names (not a
 *    named tool, not the business, not a word of its own profile, not a
 *    plain category) is refused, with the names: never an invented brand;
 *  - a comparison, a platform how-to or a problem piece keeps no search
 *    volume and no CPC: nothing measured them, and a model's figure for a
 *    long-tail question is a guess. The other figures stay the estimates
 *    every suggestion carries.
 */
export function settleSuggestions<T extends KeywordSuggestion>(
  suggestions: readonly T[],
  context: { names: readonly string[]; businessName?: string | null; profile?: string | null }
): { kept: Array<T & { intent: TopicIntent }>; refused: RefusedSuggestion[] } {
  const kept: Array<T & { intent: TopicIntent }> = [];
  const refused: RefusedSuggestion[] = [];
  for (const suggestion of suggestions) {
    const keyword = suggestion.keyword.trim();
    const unknown = unknownComparedNames(keyword, {
      names: context.names,
      businessName: context.businessName,
      profile: context.profile,
    });
    if (unknown.length > 0) {
      refused.push({
        keyword,
        names: unknown,
        why: `Names ${unknown.map((n) => `"${n}"`).join(" and ")}, which nothing in this site's data names: a comparison is only written about products the data has seen.`,
      });
      continue;
    }
    const intent = settleIntent(keyword, suggestion.intent, { names: context.names });
    kept.push({
      ...suggestion,
      intent,
      ...(intent === "product_adjacent" ? {} : { searchVolume: null, cpc: null }),
    });
  }
  return { kept, refused };
}
