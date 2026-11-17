import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 20261114140000_account_limits_owner_only.sql, read as text: the customer's
 * two write policies on account_limits admit nothing any more, so only the
 * service role (the owner's route, after the owner check) sets a ceiling;
 * the customer's select stays; and nothing in it would stop the automatic
 * apply for a confirmation (alter policy, no drop).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(path.join(root, "supabase/migrations/20261114140000_account_limits_owner_only.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

describe("20261114140000_account_limits_owner_only.sql", () => {
  it("closes the customer's insert and update", () => {
    expect(code).toContain('alter policy "Users can set their own account limits" on public.account_limits with check (false);');
    expect(code).toContain('alter policy "Users can change their own account limits" on public.account_limits using (false) with check (false);');
    expect(code).toContain('rename to "Customers cannot set account limits"');
    expect(code).toContain('rename to "Customers cannot change account limits"');
  });

  it("leaves the customer's read and the service role alone", () => {
    expect(code).not.toContain("Users can view their own account limits");
    expect(code).not.toContain("Service role manages account limits");
  });

  it("applies without a confirmation: nothing is dropped, deleted or revoked", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/\brevoke\b/i);
  });
});
