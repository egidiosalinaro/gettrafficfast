import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The default-site migration, read as text: an additive nullable column on
 * api_keys and oauth_tokens that sets null when its site is deleted (never
 * cascades to the credential), a trigger that keeps it one of the owner's
 * sites and a one-site credential's own site, and nothing dropped or any
 * policy rewritten.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261123120000_credential_default_site.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261123120000_credential_default_site.sql", () => {
  it("adds a nullable default_business_id that sets null with its site, on keys and grants", () => {
    for (const table of ["api_keys", "oauth_tokens"]) {
      expect(code).toContain(
        `alter table public.${table} add column if not exists default_business_id uuid references public.businesses(id) on delete set null;`
      );
    }
    expect(code).not.toMatch(/default_business_id uuid[^,;]*not null/);
  });

  it("keeps the default one of the owner's sites, and a one-site credential's own site", () => {
    expect(code).toContain("create or replace function public.credential_default_site_guard()");
    expect(code).toContain("set search_path = ''");
    expect(code).toContain("where b.id = new.default_business_id and b.user_id = new.user_id");
    expect(code).toContain("new.business_id is not null and new.business_id <> new.default_business_id");
    expect(code).toContain("before insert or update of default_business_id on public.api_keys");
    expect(code).toContain("before insert or update of default_business_id on public.oauth_tokens");
  });

  it("is additive: nothing dropped, no policy changed", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bpolicy\b/i);
    expect(code).not.toMatch(/\btruncate\b|\bdelete from\b/i);
  });
});
