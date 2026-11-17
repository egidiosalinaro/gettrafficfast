import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The tool_calls migration, read as text: the columns the runner writes
 * (lib/tools/usage.ts), the two indexes the per-key limits and Settings read
 * on, RLS on with the owner's select and the service role for the rest (no
 * user insert, update or delete: a person cannot erase their own count), the
 * usage function through the caller's own RLS, and no statement that would
 * stop the automatic apply for a confirmation (CLAUDE.md, "Migrations reach
 * production with the commit").
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261109233000_tool_calls.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261109233000_tool_calls.sql", () => {
  it("creates the table with the columns the runner writes", () => {
    expect(code).toContain("create table if not exists public.tool_calls (");
    for (const column of [
      "id uuid primary key default gen_random_uuid()",
      "user_id uuid not null references auth.users(id) on delete cascade",
      "business_id uuid references public.businesses(id) on delete set null",
      "api_key_id uuid references public.api_keys(id) on delete set null",
      "tool text not null",
      "status text not null",
      "cost_usd numeric(10, 6) check (cost_usd is null or cost_usd >= 0)",
      "duration_ms integer",
      "created_at timestamptz not null default timezone('utc', now())",
    ]) {
      expect(code).toContain(column);
    }
    // A cost that was not measured stays null: no default of 0.
    expect(code).not.toMatch(/cost_usd numeric\(10, 6\)[^,]*default/);
  });

  it("indexes what the per-key limits and Settings count on", () => {
    expect(code).toContain("on public.tool_calls (api_key_id, created_at desc)");
    expect(code).toContain("on public.tool_calls (user_id, created_at desc)");
  });

  it("turns RLS on: the owner selects, only the service role writes", () => {
    expect(code).toContain("alter table public.tool_calls enable row level security;");
    expect(code).toMatch(/on public\.tool_calls for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(code).toContain("on public.tool_calls for all to service_role using (true) with check (true)");
    expect(code).not.toMatch(/on public\.tool_calls for (insert|update|delete|all) to authenticated/);
  });

  it("aggregates usage through the caller's own RLS", () => {
    expect(code).toContain("create or replace function public.tool_call_usage(p_since timestamptz)");
    expect(code).toContain("security invoker");
    expect(code).toContain("set search_path = ''");
    expect(code).toContain("where t.user_id = (select auth.uid())");
    expect(code).not.toContain("security definer");
  });

  it("applies without a confirmation: nothing is dropped", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/\brevoke\b/i);
  });
});
