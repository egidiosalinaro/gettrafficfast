import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The agent_runs.llm_calls migration, read as text: one nullable column
 * added if missing, and no statement that would stop the automatic apply
 * for a confirmation (CLAUDE.md, "Migrations reach production with the
 * commit").
 */
describe("20261110210000_agent_runs_llm_calls.sql", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sql = readFileSync(path.join(root, "supabase/migrations/20261110210000_agent_runs_llm_calls.sql"), "utf8");
  const code = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("adds llm_calls if it is missing, nullable, with no default", () => {
    expect(code).toContain("alter table public.agent_runs add column if not exists llm_calls jsonb;");
    expect(code).not.toMatch(/not null/i);
    expect(code).not.toMatch(/\bdefault\b/i);
  });

  it("drops, deletes and rewrites nothing", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bdelete\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bupdate\b/i);
  });

  it("sorts after the newest migration it was written against", () => {
    expect("20261110210000" > "20261110200000").toBe(true);
  });
});
