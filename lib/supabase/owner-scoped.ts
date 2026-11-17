import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The service role, narrowed to one owner: the client an API-key caller gets
 * in place of a session (lib/api-auth.ts, docs/API.md "Why the service role").
 *
 * A browser request carries the user's JWT, and RLS adds
 * `auth.uid() = user_id` to every statement on the tenant tables. An API
 * key carries no JWT, so this wrapper adds the same condition by hand:
 *
 * - every select, update and delete gets `.eq("user_id", owner)`, which is
 *   what RLS's `using` does for a session;
 * - every insert or upsert must name the owner as `user_id`, and a
 *   `business_id`, when the row has one, must be a site the caller may act
 *   on, which is what RLS's `with check` does;
 * - an update may not move a row to another owner or another site;
 * - a table not listed in OWNED_TABLES is refused outright, and so are
 *   `rpc`, `storage`, `auth`, `schema`, `channel` and `functions`: nothing
 *   there is narrowed, so nothing there is reachable.
 *
 * Which SITE a statement is about stays the code's job, exactly as with a
 * session (RLS checks the owner, the code filters `business_id`). The tool
 * layer hands every handler a site picked FROM the owner's own businesses.
 *
 * A violation throws `TenancyViolation`: it is a bug in the calling code,
 * never a condition to recover from.
 */

/**
 * Tables that carry `user_id` as their owner column, and that the tool layer
 * reaches through the caller's client. Add a table here only after checking
 * its migration: a table without `user_id` would answer every narrowed
 * select with an error, and one owned some other way is not narrowed at all.
 */
export const OWNED_TABLES: ReadonlySet<string> = new Set([
  "aeo_probes",
  "aeo_queries",
  "aeo_runs",
  "ai_citations",
  // Holds the Search Console refresh token: the tool layer selects named
  // columns only, never refresh_token_encrypted (lib/lifecycle/load-results.ts).
  "analytics_connections",
  "api_keys",
  // Push page 3: the owner reads, the platform writes (lib/lifecycle/push-store.ts).
  "article_pushes",
  "articles",
  "businesses",
  "competitors",
  "content_metrics",
  // Search Console queries per article, 28 days (lib/analytics/search-console.ts).
  "content_queries",
  "draft_feedback",
  "entities",
  // Google's URL Inspection answers, one row per URL (lib/analytics/index-status.ts).
  "index_status",
  // Credentials live in config.*_encrypted, dropped on every read (lib/integrations/read.ts).
  "integrations",
  "jobs",
  "keywords",
  // GTF's search on X for a posted reply's link; the owner reads, the platform writes (lib/placements/reply-link.ts).
  "placement_link_searches",
  "placement_metrics",
  "placement_targets",
  "placements",
  "publish_attempts",
  // Read for the second near-duplicate signal (lib/keywords/overlap.ts).
  "serp_snapshots",
  "subscriptions",
  // The site's own X account, one row a day (lib/placements/reply-stats-read.ts).
  "x_account_metrics",
]);

const REFUSED = new Set(["rpc", "storage", "auth", "schema", "channel", "functions", "realtime"]);

export class TenancyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenancyViolation";
  }
}

export interface OwnerScope {
  userId: string;
  /** Sites a written row may name. Empty when the account has none. */
  businessIds: readonly string[];
}

type Row = Record<string, unknown>;

function checkRow(table: string, row: Row, scope: OwnerScope, requireOwner: boolean) {
  if (requireOwner || "user_id" in row) {
    if (row.user_id !== scope.userId) {
      throw new TenancyViolation(`A write to ${table} must name the caller as user_id.`);
    }
  }
  if ("business_id" in row && row.business_id !== null && row.business_id !== undefined) {
    if (!scope.businessIds.includes(row.business_id as string)) {
      throw new TenancyViolation(`A write to ${table} names a site the caller may not act on.`);
    }
  }
}

const rowsOf = (values: Row | Row[]): Row[] => (Array.isArray(values) ? values : [values]);

/** A client that answers, for tenancy, like the owner's own session would. */
export function ownerScopedClient(admin: SupabaseClient, scope: OwnerScope): SupabaseClient {
  if (!scope.userId) throw new TenancyViolation("An owner-scoped client needs an owner.");

  const from = (table: string) => {
    if (!OWNED_TABLES.has(table)) {
      throw new TenancyViolation(`${table} is not reachable through an API caller's client (lib/supabase/owner-scoped.ts).`);
    }
    const query = admin.from(table);
    return {
      select: (columns?: string, options?: { head?: boolean; count?: "exact" | "planned" | "estimated" }) =>
        query.select(columns, options).eq("user_id", scope.userId),
      update: (values: Row, options?: { count?: "exact" | "planned" | "estimated" }) => {
        checkRow(table, values, scope, false);
        return query.update(values, options).eq("user_id", scope.userId);
      },
      delete: (options?: { count?: "exact" | "planned" | "estimated" }) =>
        query.delete(options).eq("user_id", scope.userId),
      insert: (values: Row | Row[], options?: Parameters<typeof query.insert>[1]) => {
        for (const row of rowsOf(values)) checkRow(table, row, scope, true);
        return query.insert(values, options);
      },
      upsert: (values: Row | Row[], options?: Parameters<typeof query.upsert>[1]) => {
        for (const row of rowsOf(values)) checkRow(table, row, scope, true);
        return query.upsert(values, options);
      },
    };
  };

  return new Proxy(admin, {
    get(target, property, receiver) {
      if (property === "from") return from;
      if (typeof property === "string" && REFUSED.has(property)) {
        throw new TenancyViolation(`${property} is not available to an API caller's client.`);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as SupabaseClient;
}
