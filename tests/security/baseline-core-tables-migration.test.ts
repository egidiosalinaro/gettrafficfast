import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The baseline migration, read as text: the four core tables that were made by
 * hand in the dashboard (articles, businesses, keywords, subscriptions) are
 * created by the first migration in the folder, with RLS on and the policies a
 * user needs, and in the shape the later migrations expect to find; and every
 * statement is either `if not exists` or guarded by a catalogue check, so on
 * production, where all of it exists, the file changes nothing.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(root, "supabase/migrations");
const file = "20250101000000_baseline_core_tables.sql";
const sql = readFileSync(path.join(dir, file), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ")
  .trim();

const core = ["businesses", "keywords", "articles", "subscriptions"];

describe(file, () => {
  it("runs before every other migration", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files[0]).toBe(file);
  });

  it("is the only migration that creates the four core tables, and creates each with RLS on", () => {
    for (const table of core) {
      expect(code).toContain(`create table if not exists public.${table} (`);
      expect(code).toContain(`alter table public.${table} enable row level security;`);
      for (const other of readdirSync(dir).filter((f) => f.endsWith(".sql") && f !== file)) {
        const text = readFileSync(path.join(dir, other), "utf8");
        expect(text, other).not.toMatch(new RegExp(`create table (if not exists )?public\\.${table} \\(`));
      }
    }
  });

  it("keeps the names the later migrations drop or replace", () => {
    // 20260723150000 drops this one by name without `if exists`.
    expect(code).toContain("constraint articles_user_id_scheduled_date_key unique (user_id, scheduled_date)");
    expect(code).toContain("constraint businesses_website_url_key unique (website_url)");
    expect(code).toContain("constraint keywords_user_id_keyword_key unique (user_id, keyword)");
  });

  it("creates every per-user policy the core tables have, and none a later migration creates unguarded", () => {
    for (const name of [
      "Users can view their own business",
      "Users can insert their own business",
      "Users can update their own business",
      "Users can view their own keywords",
      "Users can insert their own keywords",
      "Users can update their own keywords",
      "Users can delete their own keywords",
      "Users can view their own articles",
      "Users can insert their own articles",
      "Users can update their own articles",
      "Users can delete their own articles",
      "Users can view their own subscriptions",
      "Service role can manage all subscriptions",
    ]) {
      expect(code).toContain(`'${name}'`);
    }
    // 20260531100000 creates these with a bare `create policy`.
    expect(code).not.toContain("Service role manages articles");
    expect(code).not.toContain("Service role reads businesses");
    expect(code).not.toContain("Service role manages keywords");
    // No customer write on subscriptions: the Stripe webhook owns them.
    expect(code).not.toMatch(/'subscriptions', '[^']*', 'for (insert|update|delete|all) to public/);
  });

  it("is a no-op where the objects exist: everything is if-not-exists or guarded, nothing is dropped or replaced", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bor replace\b/i);
    expect(code).not.toMatch(/\b(delete from|truncate|update public|insert into|revoke)\b/i);
    expect(code).not.toMatch(/\balter policy\b/i);
    const unguarded = code
      .replace(/do \$\$.*?end \$\$;/g, "")
      .match(/\bcreate (unique )?(table|index|function|trigger|policy|extension)\b(?! if not exists)/gi);
    expect(unguarded).toBeNull();
  });
});
