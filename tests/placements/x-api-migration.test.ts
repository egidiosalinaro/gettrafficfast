import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Migration 20261111120000, read as text: the spend ledger with its two
 * functions (the reservation refuses past the cap in one conditional
 * UPDATE), the reply numbers with nullable counters, RLS on both, and no
 * statement that would stop the automatic apply for a confirmation
 * (CLAUDE.md, "Migrations reach production with the commit").
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261111120000_x_api_spend_and_reply_metrics.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261111120000_x_api_spend_and_reply_metrics.sql", () => {
  it("keeps one ledger row per provider and calendar month, service role only", () => {
    expect(code).toContain("create table if not exists public.provider_spend (");
    expect(code).toContain("primary key (provider, month)");
    expect(code).toContain("alter table public.provider_spend enable row level security;");
    expect(code).toContain("on public.provider_spend for all to service_role using (true) with check (true)");
    expect(code).not.toMatch(/on public\.provider_spend for \w+ to authenticated/);
  });

  it("reserves only within the cap, in one conditional update, and settles never below zero", () => {
    expect(code).toContain("create or replace function public.reserve_provider_spend(");
    expect(code).toContain("and cost_usd + p_amount <= p_cap returning cost_usd into v_total;");
    expect(code).toContain("create or replace function public.settle_provider_spend(");
    expect(code).toContain("set cost_usd = greatest(0, cost_usd + p_adjust)");
    // Security invoker (the default): RLS leaves the ledger to the service role.
    expect(code).not.toMatch(/security definer/i);
  });

  it("stores a reply's numbers per day, each nullable, the owner reading their own", () => {
    expect(code).toContain("create table if not exists public.placement_metrics (");
    expect(code).toContain("target_id uuid not null references public.placement_targets(id) on delete cascade");
    expect(code).toContain("primary key (target_id, day)");
    for (const column of ["impressions", "likes", "replies", "reposts", "quotes", "bookmarks"]) {
      expect(code).toContain(`${column} integer check (${column} is null or ${column} >= 0)`);
    }
    expect(code).toContain("alter table public.placement_metrics enable row level security;");
    expect(code).toMatch(/on public\.placement_metrics for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(code).toContain("on public.placement_metrics for all to service_role using (true) with check (true)");
    expect(code).not.toMatch(/on public\.placement_metrics for (insert|update|delete|all) to authenticated/);
  });

  it("applies without a confirmation: nothing is dropped, truncated, deleted or revoked", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/\brevoke\b/i);
  });
});
