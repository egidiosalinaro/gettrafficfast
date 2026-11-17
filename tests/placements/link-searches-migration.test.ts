import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LINK_SEARCH_COLUMNS, LINK_SEARCHES_TABLE } from "@/lib/placements/reply-link";

/**
 * Migration 20261113100000, read as text: one row per posted reply for GTF's
 * search of its link on X, the owner reading their own rows and only the
 * platform writing them (the attempts bound what GTF spends, so a person must
 * not be able to reset them), RLS on, every column the code reads, and no
 * statement that would stop the automatic apply for a confirmation
 * (CLAUDE.md, "Migrations reach production with the commit").
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261113100000_placement_link_searches.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261113100000_placement_link_searches.sql", () => {
  it("keeps one search per posted reply, gone with the reply", () => {
    expect(LINK_SEARCHES_TABLE).toBe("placement_link_searches");
    expect(code).toContain("create table if not exists public.placement_link_searches (");
    expect(code).toContain("target_id uuid primary key references public.placement_targets(id) on delete cascade");
    expect(code).toContain("user_id uuid not null references auth.users(id) on delete cascade");
    expect(code).toContain("attempts smallint not null default 0 check (attempts >= 0)");
    expect(code).toContain("posts_seen integer not null default 0 check (posts_seen >= 0)");
  });

  it("has every column the code reads", () => {
    for (const column of LINK_SEARCH_COLUMNS.split(",").map((c) => c.trim())) {
      expect(code, column).toMatch(new RegExp(`\\b${column} (uuid|smallint|integer|text|timestamptz)\\b`));
    }
  });

  it("is read by its owner and written by the platform only: RLS on, no write policy for a person", () => {
    expect(code).toContain("alter table public.placement_link_searches enable row level security;");
    expect(code).toMatch(/on public\.placement_link_searches for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(code).toContain("on public.placement_link_searches for all to service_role using (true) with check (true)");
    expect(code).not.toMatch(/on public\.placement_link_searches for (insert|update|delete|all) to authenticated/);
  });

  it("indexes the sweep's read: posted replies with no link yet", () => {
    expect(code).toContain(
      "create index if not exists placement_targets_posted_without_link_idx on public.placement_targets (published_at desc) where status = 'published_manually' and published_url is null;"
    );
  });

  it("applies without a confirmation: nothing is dropped, truncated, deleted or revoked", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/\brevoke\b/i);
  });
});
