import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The last business-ownership migration, read as text: the two update
 * policies that still checked only `user_id` (placements, api_keys) are
 * altered in place by name, `with check` also requires the business to be the
 * user's (null kept only on api_keys, where an account-wide key has none), and
 * nothing is dropped. Then, across every migration, no client insert or update
 * policy on a table with business_id is left without that check.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(root, "supabase/migrations");
const strip = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
const code = strip(readFileSync(path.join(dir, "20261116100000_rls_business_ownership.sql"), "utf8"));

const owned = (table: string) =>
  `exists ( select 1 from public.businesses b where b.id = ${table}.business_id and b.user_id = (select auth.uid()) )`;

describe("20261116100000_rls_business_ownership.sql", () => {
  it("alters exactly the two remaining update policies, by their production names", () => {
    const altered = [...code.matchAll(/alter policy "([^"]+)" on public\.(\w+)/g)].map((m) => `${m[2]}: ${m[1]}`);
    expect(altered).toEqual([
      "placements: Users can edit their own placements",
      "api_keys: Users can revoke their own API keys",
    ]);
  });

  it("keeps `using` and requires an owned business on placements (business_id is not null there)", () => {
    expect(code).toContain(
      `alter policy "Users can edit their own placements" on public.placements using ((select auth.uid()) = user_id) with check ( (select auth.uid()) = user_id and ${owned("placements")} );`
    );
  });

  it("allows an account-wide API key (no business) and otherwise requires an owned one", () => {
    expect(code).toContain(
      `alter policy "Users can revoke their own API keys" on public.api_keys using ((select auth.uid()) = user_id) with check ( (select auth.uid()) = user_id and ( business_id is null or ${owned("api_keys")} ) );`
    );
  });

  it("never drops or recreates anything, so it applies without a prompt and runs twice safely", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bcreate\b/i);
    expect(code).not.toMatch(/\b(delete from|truncate|update public|insert into)\b/i);
  });
});

describe("every client write on a table with business_id checks ownership", () => {
  // The policy each later migration leaves last wins, so read them in order.
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const policies = new Map<string, string>();
  const withBusiness = new Set<string>();
  for (const f of files) {
    const text = strip(readFileSync(path.join(dir, f), "utf8"));
    for (const m of text.matchAll(/create table if not exists public\.(\w+) \(([^;]*?)\);/g)) {
      if (/\bbusiness_id uuid\b/.test(m[2])) withBusiness.add(m[1]);
    }
    if (f.startsWith("20260914120000")) {
      const list = text.match(/site_tables text\[\] := array\[([^\]]+)\]/);
      for (const t of list?.[1].match(/'(\w+)'/g) ?? []) withBusiness.add(t.slice(1, -1));
    }
    for (const m of text.matchAll(
      /(create|alter) policy "([^"]+)" on public\.(\w+) (?:for (\w+) )?(?:to ([\w, ]+?) )?(using .*?|with check .*?);(?= |$)/g
    )) {
      const key = `${m[3]}: ${m[2]}`;
      const prior = policies.get(key) ?? "";
      const cmd = m[4] ?? prior.split("|")[0];
      const role = m[5] ?? prior.split("|")[1];
      policies.set(key, `${cmd}|${role}|${m[6]}`);
    }
  }

  it("finds the site tables", () => {
    for (const t of ["articles", "keywords", "integrations", "placements", "api_keys", "aeo_queries"]) {
      expect(withBusiness.has(t), t).toBe(true);
    }
  });

  it("leaves no customer insert/update/all policy on them that checks only user_id", () => {
    const missing: string[] = [];
    for (const [key, value] of policies) {
      const [table] = key.split(": ");
      const [cmd, role, body] = value.split("|");
      if (!withBusiness.has(table)) continue;
      if (!["insert", "update", "all"].includes(cmd)) continue;
      if (role === "service_role") continue;
      const check = body.includes("with check") ? body.slice(body.indexOf("with check")) : body;
      if (!check.includes("from public.businesses b")) missing.push(key);
    }
    expect(missing).toEqual([]);
  });
});
