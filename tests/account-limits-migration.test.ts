import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The account_limits migration, read as text: one row per account with the
 * daily AI spend ceiling, bounded $1 to $100 in the table itself (the person
 * writes their own row), RLS on with the owner's select, insert and update
 * and the service role for the rest, no user delete; and no statement that
 * would stop the automatic apply for a confirmation (CLAUDE.md, "Migrations
 * reach production with the commit").
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261110150000_account_limits.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261110150000_account_limits.sql", () => {
  it("creates one row per account, the ceiling bounded $1 to $100 in the table", () => {
    expect(code).toContain("create table if not exists public.account_limits (");
    expect(code).toContain("user_id uuid primary key references auth.users(id) on delete cascade");
    expect(code).toContain("daily_spend_usd numeric(6, 2) not null check (daily_spend_usd >= 1 and daily_spend_usd <= 100)");
    expect(code).toContain("updated_at timestamptz not null default timezone('utc', now())");
  });

  it("turns RLS on: the owner reads, sets and changes their own row; only the service role deletes", () => {
    expect(code).toContain("alter table public.account_limits enable row level security;");
    expect(code).toMatch(/on public\.account_limits for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(code).toMatch(/on public\.account_limits for insert to authenticated with check \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(code).toMatch(
      /on public\.account_limits for update to authenticated using \(\(select auth\.uid\(\)\) = user_id\) with check \(\(select auth\.uid\(\)\) = user_id\)/
    );
    expect(code).toContain("on public.account_limits for all to service_role using (true) with check (true)");
    expect(code).not.toMatch(/on public\.account_limits for (delete|all) to authenticated/);
  });

  it("applies without a confirmation: nothing is dropped or deleted", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/\brevoke\b/i);
  });
});
