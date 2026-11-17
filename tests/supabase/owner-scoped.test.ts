import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OWNED_TABLES, TenancyViolation, ownerScopedClient } from "@/lib/supabase/owner-scoped";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The client an API-key caller gets (docs/API.md, "Why the service role,
 * narrowed"): RLS's `auth.uid() = user_id`, added by hand. Every read,
 * update and delete is narrowed to the owner; every write must name the
 * owner and a site the caller may act on; anything not narrowed is refused.
 */

const ME = "user-me";
const THEM = "user-them";
const SITE = "site-mine";
const OTHER_SITE = "site-mine-too";

function seed() {
  return new FakeSupabase({
    placement_targets: [
      { id: "t-mine", user_id: ME, business_id: SITE, status: "qualified" },
      { id: "t-theirs", user_id: THEM, business_id: "site-theirs", status: "qualified" },
    ],
  });
}

const scoped = (db: FakeSupabase) =>
  ownerScopedClient(db as unknown as SupabaseClient, { userId: ME, businessIds: [SITE] });

describe("ownerScopedClient", () => {
  it("reads only the owner's rows, even without a filter of its own", async () => {
    const db = seed();
    const { data } = await scoped(db).from("placement_targets").select("id");
    expect((data as Array<{ id: string }>).map((r) => r.id)).toEqual(["t-mine"]);

    const { data: theirs } = await scoped(db).from("placement_targets").select("id").eq("id", "t-theirs").maybeSingle();
    expect(theirs).toBeNull();
  });

  it("updates and deletes only the owner's rows", async () => {
    const db = seed();
    await scoped(db).from("placement_targets").update({ status: "dismissed" }).in("id", ["t-mine", "t-theirs"]);
    expect(db.tables.placement_targets.map((r) => r.status)).toEqual(["dismissed", "qualified"]);

    await scoped(db).from("placement_targets").delete().eq("id", "t-theirs");
    expect(db.tables.placement_targets).toHaveLength(2);
  });

  it("refuses a write that names another owner or a site the caller may not act on", () => {
    const db = seed();
    const client = scoped(db);
    expect(() => client.from("placements").insert({ user_id: THEM, business_id: SITE })).toThrow(TenancyViolation);
    expect(() => client.from("placements").insert({ business_id: SITE })).toThrow(TenancyViolation);
    expect(() => client.from("placements").insert([{ user_id: ME, business_id: OTHER_SITE }])).toThrow(TenancyViolation);
    expect(() => client.from("placements").upsert({ user_id: ME, business_id: "site-theirs" })).toThrow(TenancyViolation);
    expect(() => client.from("placement_targets").update({ business_id: OTHER_SITE })).toThrow(TenancyViolation);
    expect(() => client.from("placement_targets").update({ user_id: THEM })).toThrow(TenancyViolation);
    expect(db.tables.placements ?? []).toHaveLength(0);
  });

  it("lets through a write that names the owner and the caller's site", async () => {
    const db = seed();
    await scoped(db).from("draft_feedback").insert({ user_id: ME, business_id: SITE, reason: "too long" });
    expect(db.tables.draft_feedback).toHaveLength(1);
  });

  it("refuses tables it does not narrow, and every way around `from`", () => {
    const client = scoped(seed());
    expect(OWNED_TABLES.has("placement_targets")).toBe(true);
    expect(() => client.from("llm_billing_pause")).toThrow(TenancyViolation);
    expect(() => client.rpc("anything")).toThrow(TenancyViolation);
    expect(() => client.storage).toThrow(TenancyViolation);
    expect(() => client.auth).toThrow(TenancyViolation);
  });

  it("needs an owner", () => {
    expect(() => ownerScopedClient(seed() as unknown as SupabaseClient, { userId: "", businessIds: [] })).toThrow(TenancyViolation);
  });

  it("narrows only tables that carry user_id as their owner", () => {
    // A table created in a migration names user_id in its definition; the four
    // created before migrations (businesses, keywords, articles, subscriptions)
    // have an RLS policy on user_id in one. A table without the column would
    // answer every narrowed select with an error, or not be narrowed at all.
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");
    const sql = readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => readFileSync(path.join(dir, file), "utf8"))
      .join("\n");
    for (const table of OWNED_TABLES) {
      const created = new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
      const owned = created
        ? /\buser_id uuid\b/.test(created[1])
        : new RegExp(`on public\\.${table}\\b[^;]*?\\buser_id\\b`).test(sql);
      expect(owned, table).toBe(true);
    }
  });
});
