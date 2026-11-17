import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The publish-claim migration, read as text: one nullable column on
 * `articles`, additive, and no statement that would stop the automatic apply
 * for a confirmation (CLAUDE.md, "Migrations reach production with the
 * commit").
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261110233000_article_publish_claim.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261110233000_article_publish_claim.sql", () => {
  it("adds the nullable claim column to articles", () => {
    expect(code).toContain("alter table public.articles add column if not exists publish_claimed_at timestamptz;");
  });

  it("is additive: nothing dropped, truncated or deleted", () => {
    expect(code).not.toMatch(/\b(drop|truncate|delete)\b/i);
  });
});
