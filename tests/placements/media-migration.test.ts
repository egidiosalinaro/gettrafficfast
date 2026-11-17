import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Migration 20261111140000, read as text: two nullable columns added if
 * missing, nothing that would stop the automatic apply for a confirmation
 * (CLAUDE.md, "Migrations reach production with the commit").
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261111140000_placement_target_media.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261111140000_placement_target_media.sql", () => {
  it("adds media and media_unread to placement_targets, nullable, if they are missing", () => {
    expect(code).toContain("alter table public.placement_targets add column if not exists media jsonb;");
    expect(code).toContain("alter table public.placement_targets add column if not exists media_unread boolean;");
    expect(code).not.toMatch(/not null/i);
    expect(code).not.toMatch(/\bdefault\b/i);
  });

  it("applies without a confirmation: nothing is dropped, truncated, deleted, revoked or updated", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/\brevoke\b/i);
    expect(code).not.toMatch(/\bupdate\b/i);
  });
});
