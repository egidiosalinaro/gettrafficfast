import { createHash } from "crypto";
import { z } from "zod";
import { AEO_INTENTS } from "./settings";

/**
 * The query set as data: normalising a wording, fingerprinting a set, and the
 * shape the API accepts. Pure, so the rule "two runs are only comparable over
 * the same questions" is testable without a database.
 */

export const MAX_QUERY_LENGTH = 200;
export const MAX_QUERIES_PER_BUSINESS = 200;

/** Collapsed whitespace, trimmed, no trailing question-mark noise doubled. */
export function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * Identity of a query set, independent of order and case.
 *
 * Stored on every run so the dashboard can tell "the rate moved" from "the
 * questions moved". A trend drawn across two different sets is not a trend.
 */
export function queryFingerprint(queries: string[]): string {
  const unique = [...new Set(queries.map((q) => normalizeQuery(q).toLowerCase()).filter(Boolean))];
  unique.sort();
  return createHash("sha256").update(unique.join("\n")).digest("hex").slice(0, 32);
}

export const QueryInput = z.object({
  query: z.string().transform(normalizeQuery).pipe(z.string().min(3).max(MAX_QUERY_LENGTH)),
  cluster: z
    .string()
    .trim()
    .max(60)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
  intent: z.enum(AEO_INTENTS).nullable().optional().transform((v) => v ?? null),
});
export type QueryInput = z.infer<typeof QueryInput>;

export const AddQueriesInput = z.object({
  queries: z.array(QueryInput).min(1).max(MAX_QUERIES_PER_BUSINESS),
  source: z.enum(["manual", "keyword", "suggested"]).default("manual"),
});
export type AddQueriesInput = z.infer<typeof AddQueriesInput>;

export const UpdateQueryInput = z.object({
  id: z.string().uuid(),
  query: QueryInput.shape.query.optional(),
  cluster: QueryInput.shape.cluster,
  intent: QueryInput.shape.intent,
  enabled: z.boolean().optional(),
});
export type UpdateQueryInput = z.infer<typeof UpdateQueryInput>;

/**
 * Deduplicates an incoming batch against itself and against what is already
 * in the set, case-insensitively. Returns what is actually new; the rest is
 * reported so a bulk import can say "12 added, 3 already there".
 */
export function newQueries<T extends { query: string }>(
  incoming: T[],
  existing: string[]
): { fresh: T[]; duplicates: number } {
  const seen = new Set(existing.map((q) => normalizeQuery(q).toLowerCase()));
  const fresh: T[] = [];
  let duplicates = 0;
  for (const item of incoming) {
    const key = normalizeQuery(item.query).toLowerCase();
    if (!key || seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    fresh.push(item);
  }
  return { fresh, duplicates };
}
