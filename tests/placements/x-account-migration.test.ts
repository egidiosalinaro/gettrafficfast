import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Migration 20261113110000, read as text: one snapshot per site and day of
 * the site's own X account, every number nullable, RLS on with the owner
 * reading their own rows and only the platform writing, and no statement
 * that would stop the automatic apply for a confirmation (CLAUDE.md,
 * "Migrations reach production with the commit").
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261113110000_x_account_metrics.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261113110000_x_account_metrics.sql", () => {
  it("keeps one row per site and UTC day, owned by the account", () => {
    expect(code).toContain("create table if not exists public.x_account_metrics (");
    expect(code).toContain("business_id uuid not null references public.businesses(id) on delete cascade");
    expect(code).toContain("user_id uuid not null references auth.users(id) on delete cascade");
    expect(code).toContain("primary key (business_id, day)");
    expect(code).toContain("handle text not null");
  });

  it("stores every number nullable: a number X did not return is null, never 0", () => {
    for (const column of ["followers", "following", "posts", "listed"]) {
      expect(code).toContain(`${column} integer check (${column} is null or ${column} >= 0)`);
    }
    expect(code).not.toMatch(/default 0/);
  });

  it("turns RLS on: the owner reads their own rows, only the service role writes", () => {
    expect(code).toContain("alter table public.x_account_metrics enable row level security;");
    expect(code).toMatch(/on public\.x_account_metrics for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(code).toContain("on public.x_account_metrics for all to service_role using (true) with check (true)");
    expect(code).not.toMatch(/on public\.x_account_metrics for (insert|update|delete|all) to authenticated/);
  });

  it("applies without a confirmation: nothing is dropped, truncated, deleted or revoked", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/\brevoke\b/i);
  });
});
