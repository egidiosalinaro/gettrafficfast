import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Autopilot run record migration, read as text: one additive nullable
 * jsonb column on businesses, nothing dropped, no policy touched.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261124100000_businesses_autopilot_run.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261124100000_businesses_autopilot_run.sql", () => {
  it("adds a nullable jsonb autopilot_run to businesses", () => {
    expect(code).toContain("alter table public.businesses add column if not exists autopilot_run jsonb;");
    expect(code).not.toMatch(/autopilot_run jsonb[^;]*not null/);
  });

  it("is additive: nothing dropped, no policy changed, no row rewritten", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bpolicy\b/i);
    expect(code).not.toMatch(/\bupdate\b|\btruncate\b|\bdelete from\b/i);
  });
});
