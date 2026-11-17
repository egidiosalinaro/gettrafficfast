import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The keywords/articles ownership migration, read as text: the four client
 * write policies are altered in place by their exact production names (no
 * drop, so it applies without a confirmation prompt), each `with check`
 * requires the row's business to belong to the user as well as the row, and
 * nothing else is touched.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(
  path.join(root, "supabase/migrations/20261109190000_rls_keywords_articles_business.sql"),
  "utf8"
);
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ")
  .trim();

const ownership = (table: string) =>
  `with check ( (select auth.uid()) = user_id and exists ( select 1 from public.businesses b where b.id = ${table}.business_id and b.user_id = (select auth.uid()) ) );`;

describe("20261109190000_rls_keywords_articles_business.sql", () => {
  it("alters exactly the four insert/update policies, by their production names", () => {
    const altered = [...code.matchAll(/alter policy "([^"]+)" on public\.(\w+)/g)].map((m) => `${m[2]}: ${m[1]}`);
    expect(altered).toEqual([
      "keywords: Users can insert their own keywords",
      "keywords: Users can update their own keywords",
      "articles: Users can insert their own articles",
      "articles: Users can update their own articles",
    ]);
  });

  it("never drops or recreates anything, so it applies without a prompt and runs twice safely", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bcreate\b/i);
    expect(code).not.toMatch(/\b(delete|truncate|update public)\b/i);
  });

  it("requires the business to be the user's on insert", () => {
    expect(code).toContain(`alter policy "Users can insert their own keywords" on public.keywords ${ownership("keywords")}`);
    expect(code).toContain(`alter policy "Users can insert their own articles" on public.articles ${ownership("articles")}`);
  });

  it("keeps the update `using` as it was and adds the same ownership check on what the row becomes", () => {
    for (const table of ["keywords", "articles"]) {
      expect(code).toContain(
        `alter policy "Users can update their own ${table}" on public.${table} using ((select auth.uid()) = user_id) ${ownership(table)}`
      );
    }
  });

  it("leaves the select and delete policies alone", () => {
    expect(code).not.toMatch(/can (view|delete) their own/);
  });
});
