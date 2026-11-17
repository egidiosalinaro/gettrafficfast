import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The media_assets size migration, read as text: three nullable columns added
 * if missing, and no statement that would stop the automatic apply for a
 * confirmation (CLAUDE.md, "Migrations reach production with the commit").
 */
describe("20261110190000_media_asset_dimensions.sql", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sql = readFileSync(
    path.join(root, "supabase/migrations/20261110190000_media_asset_dimensions.sql"),
    "utf8"
  );
  const code = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("adds width, height and bytes if they are missing, nullable", () => {
    expect(code).toContain("alter table public.media_assets");
    for (const column of ["width", "height", "bytes"]) {
      expect(code).toContain(`add column if not exists ${column} integer`);
    }
    expect(code).not.toMatch(/not null/i);
    expect(code).not.toMatch(/default/i);
  });

  it("drops, deletes and rewrites nothing", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bdelete\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bupdate\b/i);
  });
});
