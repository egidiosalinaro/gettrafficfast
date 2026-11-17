import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The draft_feedback migration, read as text: the table and its columns, RLS
 * on, the owner reads and inserts their own rows only for a business (and a
 * target of it) they own, no user update or delete, the service role for
 * the rest, and the index the reads use.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261109170000_draft_feedback.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261109170000_draft_feedback.sql", () => {
  it("creates the table with the columns the code writes", () => {
    expect(code).toContain("create table if not exists public.draft_feedback (");
    for (const column of [
      "id uuid primary key default gen_random_uuid()",
      "user_id uuid not null references auth.users(id) on delete cascade",
      "business_id uuid not null references public.businesses(id) on delete cascade",
      "target_id uuid not null references public.placement_targets(id) on delete cascade",
      "placement_id uuid references public.placements(id) on delete set null",
      "reason text not null check (char_length(reason) between 3 and 300)",
      "body_before text,",
      "body_after text,",
      "promoted_to_notes boolean not null default false",
      "created_at timestamptz not null default timezone('utc', now())",
    ]) {
      expect(code).toContain(column);
    }
  });

  it("indexes a site's notes newest first", () => {
    expect(code).toContain("on public.draft_feedback (business_id, created_at desc)");
  });

  it("turns RLS on, with select and insert for the owner and everything for the service role", () => {
    expect(code).toContain("alter table public.draft_feedback enable row level security;");
    expect(code).toMatch(/for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(code).toMatch(/for insert to authenticated with check \( \(select auth\.uid\(\)\) = user_id/);
    expect(code).toContain("for all to service_role using (true) with check (true)");
    expect(code).not.toMatch(/for (update|delete) to authenticated/);
  });

  it("checks in with check that the business, and the target, belong to the user", () => {
    const insert = code.slice(code.indexOf("for insert to authenticated"), code.indexOf("Service role manages draft feedback"));
    expect(insert).toContain(
      "exists ( select 1 from public.businesses b where b.id = draft_feedback.business_id and b.user_id = (select auth.uid()) )"
    );
    expect(insert).toContain("t.business_id = draft_feedback.business_id and t.user_id = (select auth.uid())");
  });

  it("is safe to run twice", () => {
    const creates = code.match(/create policy "([^"]+)"/g) ?? [];
    expect(creates.length).toBe(3);
    for (const create of creates) {
      const name = create.slice('create policy "'.length, -1);
      expect(code).toContain(`drop policy if exists "${name}" on public.draft_feedback;`);
    }
  });
});
