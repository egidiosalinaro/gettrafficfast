import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The api_keys migration, read as text: the table, the hash and never the
 * key, a site key that dies with its site instead of widening, RLS on with
 * the owner's select, insert and update, the service role for the rest, the
 * guard that keeps a key's identity fixed and a revoked key revoked, and no
 * statement that would stop the automatic apply for a confirmation
 * (CLAUDE.md, "Migrations reach production with the commit").
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261109200000_api_keys.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261109200000_api_keys.sql", () => {
  it("creates the table with the columns the code reads and writes", () => {
    expect(code).toContain("create table if not exists public.api_keys (");
    for (const column of [
      "id uuid primary key default gen_random_uuid()",
      "user_id uuid not null references auth.users(id) on delete cascade",
      "business_id uuid references public.businesses(id) on delete cascade",
      "name text not null",
      "prefix text not null check (char_length(prefix) = 8)",
      "key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$')",
      "scopes text[] not null default '{read,write}'",
      "scopes <@ array['read', 'write', 'spend', 'publish']::text[]",
      "last_used_at timestamptz",
      "revoked_at timestamptz",
      "created_at timestamptz not null default timezone('utc', now())",
    ]) {
      expect(code).toContain(column);
    }
    expect(code).not.toMatch(/\bkey text\b/);
  });

  it("turns RLS on: the owner selects, creates for their own site, and revokes; the service role does the rest", () => {
    expect(code).toContain("alter table public.api_keys enable row level security;");
    expect(code).toMatch(/for select to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
    const insert = code.slice(code.indexOf("for insert to authenticated"), code.indexOf("Users can revoke"));
    expect(insert).toContain("revoked_at is null");
    expect(insert).toContain("where b.id = api_keys.business_id and b.user_id = (select auth.uid())");
    expect(code).toMatch(/for update to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(code).toContain("for all to service_role using (true) with check (true)");
    expect(code).not.toMatch(/for delete to authenticated/);
  });

  it("keeps what a key is fixed and a revoked key revoked", () => {
    expect(code).toContain("create or replace function public.api_keys_guard()");
    expect(code).toContain("set search_path = ''");
    expect(code).toContain("new.key_hash is distinct from old.key_hash");
    expect(code).toContain("new.scopes is distinct from old.scopes");
    expect(code).toContain("old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at");
    expect(code).toContain("before update on public.api_keys for each row execute function public.api_keys_guard()");
  });

  it("applies without a confirmation: nothing is dropped", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
  });
});
