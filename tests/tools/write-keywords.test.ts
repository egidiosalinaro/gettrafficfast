import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { K_A, K_A2, K_A3, K_B, K_C, SITE_A, apiCaller, seedWrites } from "./write-seed";
import { customerData } from "./support";

/**
 * The keyword tools, run as an API-key caller on site A through the
 * owner-scoped service role. Pinned: each calls the keywords page's own
 * function (lib/keywords/manage.ts) and answers in its declared shape; an id
 * of site B or of another account is refused before anything is written,
 * including one foreign id among several; suggest_keywords is paid (spend
 * scope, subscription) and saves nothing.
 */

const mocks = vi.hoisted(() => ({
  subscribed: true,
  db: null as unknown,
  similar: vi.fn(),
  fromBusiness: vi.fn(),
}));

vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => mocks.subscribed }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/research/keywords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/research/keywords")>()),
  findSimilarKeywords: (...args: unknown[]) => mocks.similar(...args),
  generateKeywordsFromBusiness: (...args: unknown[]) => mocks.fromBusiness(...args),
}));

import { runTool } from "@/lib/tools/runner";

/** The table's unique (business_id, keyword), which the fake does not enforce on its own. */
function withUniqueKeywords(db: FakeSupabase) {
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const builder = from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
    if (table !== "keywords") return builder;
    const insert = builder.insert;
    builder.insert = (values: unknown) => {
      const rows = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
      const clash = rows.some((r) => db.tables.keywords.some((k) => k.business_id === r.business_id && k.keyword === r.keyword));
      if (clash) return { select: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }) };
      return insert(values);
    };
    return builder;
  }) as never;
  return db;
}

function seed() {
  const db = withUniqueKeywords(seedWrites());
  mocks.db = db;
  return db;
}

const call = (db: FakeSupabase, name: string, input: unknown, scopes?: Array<"read" | "write" | "spend">) =>
  runTool(apiCaller(db, scopes ? { scopes } : {}), name, input);

const kw = (db: FakeSupabase, id: string) => db.tables.keywords.find((k) => k.id === id);

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  mocks.subscribed = true;
  mocks.similar.mockReset();
  mocks.fromBusiness.mockReset();
  quiet = (["info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("an id of another site is refused before anything is written", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["update_keyword", { keywordId: K_B, starred: true }],
    ["update_keyword", { keywordId: K_C, starred: true }],
    ["delete_keywords", { ids: [K_B] }],
    ["delete_keywords", { ids: [K_A, K_C] }],
  ];
  it.each(cases)("%s %j", async (name, input) => {
    const db = seed();
    const before = customerData(db);
    expect(await call(db, name, input)).toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
    expect(customerData(db)).toBe(before);
  });
});

describe("add_keywords", () => {
  it("adds phrases and suggestion objects to site A's pool, available and unstarred", async () => {
    const db = seed();
    const run = await call(db, "add_keywords", {
      keywords: ["geo for saas", { keyword: "ai overviews", searchVolume: 1200, competition: "High" }, "geo for saas"],
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toMatchObject({ added: 2, alreadyInList: 0, message: null });
    const added = db.tables.keywords.filter((k) => ["geo for saas", "ai overviews"].includes(k.keyword as string));
    expect(added).toHaveLength(2);
    for (const row of added) expect(row).toMatchObject({ user_id: apiCaller(db).userId, business_id: SITE_A, status: "available", is_starred: false });
    expect(added.find((k) => k.keyword === "ai overviews")).toMatchObject({ search_volume: 1200, competition: "High" });
  });

  it("skips what the site already has and says so; all of them already there is not an error", async () => {
    const db = seed();
    const some = await call(db, "add_keywords", { keywords: ["ai seo tools", "brand new"] });
    expect(some).toMatchObject({ ok: true, output: { added: 1, alreadyInList: 1 } });
    if (some.ok) expect(some.output.message).toMatch(/1 new keyword added\. 1 keyword was already in your list\./);

    const none = await call(db, "add_keywords", { keywords: ["ai seo tools"] });
    expect(none).toMatchObject({ ok: true, output: { added: 0, alreadyInList: 1, keywords: [] } });
  });

  it("adds a question from list_question_ideas with no figures and its thread; a thread not found for the site is refused", async () => {
    const db = seed();
    const url = "https://www.reddit.com/r/SEO/comments/1abc/";
    db.tables.placement_targets.push(
      { id: "t-q", user_id: apiCaller(db).userId, business_id: SITE_A, url, title: "Is programmatic SEO dead in 2026?", surface: "reddit", status: "qualified" },
      // The same account's other site.
      { id: "t-b", user_id: apiCaller(db).userId, business_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", url: "https://www.reddit.com/r/SEO/comments/2b/", title: "B?", surface: "reddit", status: "qualified" }
    );
    const question = { keyword: "Is programmatic SEO dead in 2026?", source: "question", sourceUrl: url };

    const before = customerData(db);
    for (const sourceUrl of ["https://www.reddit.com/r/SEO/comments/2b/", "https://example.com/never-found"]) {
      expect(await call(db, "add_keywords", { keywords: [{ ...question, sourceUrl }] })).toMatchObject({
        ok: false,
        status: 400,
        error: { code: "invalid_input" },
      });
    }
    expect(await call(db, "add_keywords", { keywords: [{ ...question, source: "guess" }] })).toMatchObject({ ok: false, status: 400 });
    expect(customerData(db)).toBe(before);

    // Figures sent with a question are not kept: nobody measured it.
    const run = await call(db, "add_keywords", { keywords: [{ ...question, searchVolume: 900, difficulty: 20, cpc: 1.5 }] });
    expect(run).toMatchObject({
      ok: true,
      output: {
        added: 1,
        keywords: [
          {
            keyword: "Is programmatic SEO dead in 2026?",
            searchVolume: null,
            competition: null,
            difficulty: null,
            cpc: null,
            opportunity: null,
            source: "question",
            sourceUrl: url,
          },
        ],
      },
    });
    expect(db.tables.keywords.find((k) => k.keyword === question.keyword)).toMatchObject({
      business_id: SITE_A,
      search_volume: null,
      difficulty: null,
      cpc: null,
      competition: null,
      opportunity: null,
      source: "question",
      source_url: url,
    });
  });

  it("needs the write scope", async () => {
    const db = seed();
    expect(await call(db, "add_keywords", { keywords: ["x"] }, ["read"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
  });
});

describe("update_keyword", () => {
  it("stars a keyword of site A and changes nothing else", async () => {
    const db = seed();
    const run = await call(db, "update_keyword", { keywordId: K_A, starred: true });
    expect(run).toMatchObject({ ok: true, output: { keyword: { id: K_A, starred: true, status: "available" } } });
    expect(kw(db, K_A)).toMatchObject({ is_starred: true, business_id: SITE_A, status: "available", article_id: null });
  });

  it("writes the star and nothing else: another field is never written, a missing star is refused", async () => {
    const db = seed();
    const run = await call(db, "update_keyword", { keywordId: K_A, starred: true, status: "queued" });
    expect(run.ok).toBe(true);
    expect(kw(db, K_A)?.status).toBe("available");
    expect(await call(db, "update_keyword", { keywordId: K_A })).toMatchObject({ ok: false, status: 400, error: { code: "invalid_input" } });
  });
});

describe("delete_keywords", () => {
  it("deletes site A's keywords by id", async () => {
    const db = seed();
    const run = await call(db, "delete_keywords", { ids: [K_A, K_A2, K_A] });
    expect(run).toMatchObject({ ok: true, output: { deleted: 2 } });
    expect(kw(db, K_A)).toBeUndefined();
    expect(kw(db, K_A2)).toBeUndefined();
    expect(kw(db, K_A3)).toBeDefined();
    expect(kw(db, K_B)).toBeDefined();
  });
});

describe("suggest_keywords", () => {
  const suggestion = { keyword: "geo audit", searchVolume: 300, competition: "Low", difficulty: 30, cpc: 2.5, opportunity: "High" };

  it("asks for keywords like the seeds, with site A's profile, and saves nothing", async () => {
    const db = seed();
    mocks.similar.mockResolvedValue([suggestion]);
    const before = db.tables.keywords.length;
    const run = await call(db, "suggest_keywords", { seeds: ["ai seo"] });
    expect(run).toMatchObject({ ok: true, output: { suggestions: [suggestion], estimated: true } });
    expect(mocks.similar).toHaveBeenCalledWith(["ai seo"], "SEO software", "Acme helps sites get found.", "en");
    expect(db.tables.keywords).toHaveLength(before);
  });

  it("suggests from the profile with fromBusiness, and needs seeds otherwise", async () => {
    const db = seed();
    mocks.fromBusiness.mockResolvedValue([suggestion]);
    expect(await call(db, "suggest_keywords", { fromBusiness: true })).toMatchObject({ ok: true });
    expect(mocks.fromBusiness).toHaveBeenCalledWith("SEO software", "Acme helps sites get found.", "https://acme.test", "en", {
      businessName: "Acme",
      names: [],
    });
    expect(await call(db, "suggest_keywords", {})).toMatchObject({ ok: false, status: 400, error: { code: "invalid_input" } });
  });

  it("is paid: the spend scope, then the subscription, before any model call", async () => {
    const db = seed();
    expect(await call(db, "suggest_keywords", { seeds: ["x"] }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope", message: "suggest_keywords needs a key with the spend scope." },
    });
    mocks.subscribed = false;
    expect(await call(db, "suggest_keywords", { seeds: ["x"] })).toMatchObject({
      ok: false,
      status: 402,
      error: { code: "subscription_required" },
    });
    expect(mocks.similar).not.toHaveBeenCalled();
  });
});

describe("near-duplicates", () => {
  it("add_keywords leaves out a phrase that overlaps a keyword of the site, says which, and adds it with allowDuplicates", async () => {
    const db = seed();
    const refused = await call(db, "add_keywords", { keywords: ["AI SEO tool", "best llm citations", "push notifications"] });
    if (!refused.ok) throw new Error(JSON.stringify(refused));
    expect(refused.output).toMatchObject({
      added: 1,
      alreadyInList: 0,
      keywords: [{ keyword: "push notifications" }],
      duplicates: [
        { keyword: "AI SEO tool", reason: "same_words", duplicateOf: { keywordId: K_A, keyword: "ai seo tools", status: "available" }, duplicateOfPhrase: null },
        { keyword: "best llm citations", reason: "contained", duplicateOf: { keywordId: K_A3, status: "queued" } },
      ],
    });
    expect(refused.output.message).toContain("2 keywords were not added");
    expect(db.tables.keywords.map((k) => k.keyword)).not.toContain("AI SEO tool");

    const forced = await call(db, "add_keywords", { keywords: ["AI SEO tool"], allowDuplicates: true });
    expect(forced).toMatchObject({ ok: true, output: { added: 1, duplicates: [] } });
    expect(db.tables.keywords.map((k) => k.keyword)).toContain("AI SEO tool");
  });

  it("add_keywords never compares with another site's keywords", async () => {
    const db = seed();
    // "bravo keyword" is site B's.
    expect(await call(db, "add_keywords", { keywords: ["bravo keywords"] })).toMatchObject({ ok: true, output: { added: 1, duplicates: [] } });
  });

  it("suggest_keywords leaves overlapping ideas out of the suggestions and lists them apart", async () => {
    const db = seed();
    mocks.similar.mockResolvedValue([
      { keyword: "ai seo tool", searchVolume: 10, competition: "Low", difficulty: 10, cpc: 1, opportunity: "High" },
      { keyword: "schema markup guide", searchVolume: 10, competition: "Low", difficulty: 10, cpc: 1, opportunity: "High" },
    ]);
    const run = await call(db, "suggest_keywords", { seeds: ["seo"] });
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect((run.output.suggestions as Array<{ keyword: string }>).map((s) => s.keyword)).toEqual(["schema markup guide"]);
    expect(run.output.duplicates).toMatchObject([{ keyword: "ai seo tool", duplicateOf: { keywordId: K_A } }]);
  });
});

