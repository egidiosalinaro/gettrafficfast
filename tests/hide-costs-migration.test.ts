import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROBE_COLUMNS, RUN_COLUMNS } from "@/lib/visibility/store";

/**
 * 20261114160000_hide_costs_from_customers.sql, read as text: the customer's
 * role selects every column of agent_runs, aeo_runs, aeo_probes, tool_calls
 * and media_assets except what the platform pays; the per-key usage RPC a
 * customer calls carries no cost; only SELECT moves; nothing is dropped.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const sql = read("supabase/migrations/20261114160000_hide_costs_from_customers.sql");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

/** The columns granted to authenticated on `table`. */
function granted(table: string): string[] {
  const match = code.match(new RegExp(`grant select \\(([^)]*)\\) on public\\.${table} to authenticated;`));
  if (!match) throw new Error(`no column grant on ${table}`);
  return match[1].split(",").map((column) => column.trim());
}

const HIDDEN: Record<string, string[]> = {
  agent_runs: ["cost_usd", "llm_calls"],
  aeo_runs: ["cost_usd"],
  aeo_probes: ["cost_usd"],
  tool_calls: ["cost_usd"],
  media_assets: ["meta"],
};

describe("20261114160000_hide_costs_from_customers.sql", () => {
  it.each(Object.keys(HIDDEN))("takes the table-wide select off %s, then grants the columns back without the costs", (table) => {
    expect(code).toContain(`revoke select on public.${table} from authenticated, anon;`);
    expect(code.indexOf(`revoke select on public.${table}`)).toBeLessThan(code.indexOf(`on public.${table} to authenticated;`));
    const columns = granted(table);
    for (const hidden of HIDDEN[table]) expect(columns).not.toContain(hidden);
    expect(columns).toEqual(expect.arrayContaining(["id", "user_id", "business_id", "created_at"]));
    expect(columns.join(" ")).not.toMatch(/cost|usd|spend|price/);
  });

  it("still grants every column the customer's own reads select", () => {
    for (const column of PROBE_COLUMNS.split(",").map((c) => c.trim())) expect(granted("aeo_probes")).toContain(column);
    for (const column of RUN_COLUMNS.split(",").map((c) => c.trim())) expect(granted("aeo_runs")).toContain(column);
  });

  it("gives anon no select back and moves nothing but select", () => {
    expect(code).not.toMatch(/grant select[^;]* to [^;]*anon/);
    expect(code).not.toMatch(/\b(revoke|grant) (insert|update|delete|all|references|trigger|truncate)\b/i);
  });

  it("answers the customer's key usage with no cost, and keeps the summed cost for the service role", () => {
    expect(code).toContain("create or replace function public.tool_call_counts(p_since timestamptz) returns table (api_key_id uuid, calls bigint)");
    const body = code.slice(code.indexOf("function public.tool_call_counts"), code.indexOf("$$;"));
    expect(body).not.toContain("cost");
    expect(body).toContain("security invoker");
    expect(body).toContain("where t.user_id = (select auth.uid())");
    expect(code).toContain("grant execute on function public.tool_call_counts(timestamptz) to authenticated, service_role;");
    expect(code).toContain("revoke execute on function public.tool_call_usage(timestamptz) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.tool_call_usage(timestamptz) to service_role;");
    expect(read("lib/tools/usage.ts")).toContain('rpc("tool_call_counts"');
    expect(read("lib/tools/usage.ts")).not.toContain('rpc("tool_call_usage"');
  });

  it("deletes nothing: no drop, no truncate, no delete, no security definer", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toContain("security definer");
  });
});

describe("the spend ceiling reads agent_runs.cost_usd through the service role", () => {
  const ROUTES = [
    "app/api/keywords/suggest/route.ts",
    "app/api/business/analyze/route.ts",
    "app/api/visibility/run/route.ts",
    "app/api/visibility/queries/suggest/route.ts",
    "app/api/placements/[id]/draft/route.ts",
    "app/api/placements/add/route.ts",
    "app/api/placements/discover/route.ts",
    "app/api/placements/drafts/[id]/correct/route.ts",
    "app/api/generate-now/route.ts",
  ];

  it.each(ROUTES)("%s asks the guard with the service role, never the session client", (route) => {
    const source = read(route);
    expect(source).toContain("requireAccountCapacity(createAdminClient, user.id");
    expect(source).not.toMatch(/requireAccountCapacity\(supabase\b/);
  });

  it("the plan card counts today's AI work through the service role", () => {
    expect(read("app/(app)/settings/billing/page.tsx")).toContain("loadPlanUsage(createAdminClient(), userId, selected?.id ?? null)");
  });
});
