import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { ART_A, ART_A_FAILED, ART_B, ART_C, K_A, K_A2, K_A3, K_B, K_C, SITE_A, USER, apiCaller, seedWrites, sessionCaller } from "./write-seed";
import { customerData } from "./support";

/**
 * The calendar tools. Pinned: scheduling uses the calendar's own rule (the
 * site's first free days after today) and the paywall like the route;
 * every keyword and article id is checked against the caller's site, one
 * foreign id among many included; a move by an API key goes through the
 * service role naming the key's owner (move_article_for_owner), a session's
 * through its own client (move_article), never through the owner-scoped
 * client, which refuses rpc.
 */

const mocks = vi.hoisted(() => ({ subscribed: true, db: null as unknown }));

vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => mocks.subscribed }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

import { runTool } from "@/lib/tools/runner";

let rpc: ReturnType<typeof vi.fn>;
function seed() {
  const db = seedWrites();
  rpc = vi.fn(async () => ({ data: null, error: null }));
  (db as unknown as { rpc: unknown }).rpc = rpc;
  mocks.db = db;
  return db;
}

const call = (db: FakeSupabase, name: string, input: unknown, scopes?: Array<"read" | "write" | "spend">) =>
  runTool(apiCaller(db, scopes ? { scopes } : {}), name, input);

const article = (db: FakeSupabase, id: string) => db.tables.articles.find((a) => a.id === id);

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-09T10:00:00Z"), toFake: ["Date"] });
  mocks.subscribed = true;
  quiet = (["info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
  vi.useRealTimers();
  quiet.forEach((spy) => spy.mockRestore());
});

describe("an id of another site is refused before anything is written", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["schedule_keywords", { keywordIds: [K_B] }],
    ["schedule_keywords", { keywordIds: [K_A, K_C] }],
    ["reschedule_article", { articleId: ART_B, date: "2026-11-20" }],
    ["unschedule_article", { articleId: ART_C }],
    ["retry_article", { articleId: ART_C }],
    ["dismiss_today_articles", { articleIds: [ART_A_FAILED, ART_C] }],
  ];
  it.each(cases)("%s %j", async (name, input) => {
    const db = seed();
    const before = customerData(db);
    expect(await call(db, name, input)).toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
    expect(customerData(db)).toBe(before);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("schedule_keywords", () => {
  it("puts site A's keywords on its first free days after today and links them", async () => {
    const db = seed();
    const run = await call(db, "schedule_keywords", { keywordIds: [K_A, K_A2, K_A3] });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // 11-10 is taken on site A (ART_A); 11-11 only on site B; 11-12 by A's failed article.
    expect(run.output).toMatchObject({
      added: 2,
      skipped: 1,
      articles: [
        { keywordId: K_A, scheduledDate: "2026-11-11" },
        { keywordId: K_A2, scheduledDate: "2026-11-13" },
      ],
      message: "2 keywords added to your calendar.",
    });
    const articles = run.output.articles as Array<{ articleId: string; keywordId: string }>;
    for (const a of articles) {
      expect(article(db, a.articleId)).toMatchObject({ user_id: USER, business_id: SITE_A, status: "queued" });
      expect(db.tables.keywords.find((k) => k.id === a.keywordId)).toMatchObject({ status: "queued", article_id: a.articleId });
    }
  });

  it("needs a subscription, like the route, and the write scope, but not spend", async () => {
    const db = seed();
    mocks.subscribed = false;
    expect(await call(db, "schedule_keywords", { keywordIds: [K_A] })).toMatchObject({
      ok: false,
      status: 402,
      error: { code: "subscription_required" },
    });
    // The plan comes first: with one, a key without write is refused on its scope.
    mocks.subscribed = true;
    expect(await call(db, "schedule_keywords", { keywordIds: [K_A] }, ["read"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
    mocks.subscribed = true;
    expect(await call(db, "schedule_keywords", { keywordIds: [K_A] }, ["read", "write"])).toMatchObject({ ok: true });
  });

  it("takes at most 200 ids", async () => {
    const db = seed();
    const ids = Array.from({ length: 201 }, () => K_A);
    expect(await call(db, "schedule_keywords", { keywordIds: ids })).toMatchObject({ ok: false, status: 400, error: { code: "invalid_input" } });
  });
});

describe("reschedule_article", () => {
  it("an API key moves through the service role, naming the key's owner", async () => {
    const db = seed();
    const run = await call(db, "reschedule_article", { articleId: ART_A, date: "2026-11-20" });
    expect(run).toEqual({ ok: true, output: { articleId: ART_A, scheduledDate: "2026-11-20" } });
    expect(rpc).toHaveBeenCalledWith("move_article_for_owner", {
      p_owner: USER,
      p_article_id: ART_A,
      p_target_date: "2026-11-20",
    });
  });

  it("a session moves through its own client, as the route does", async () => {
    const db = seed();
    const run = await runTool(sessionCaller(db), "reschedule_article", { articleId: ART_A, date: "2026-11-20" });
    expect(run.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("move_article", { p_article_id: ART_A, p_target_date: "2026-11-20" });
  });

  it("refuses a day in the past or not a day", async () => {
    const db = seed();
    expect(await call(db, "reschedule_article", { articleId: ART_A, date: "2026-11-08" })).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_input", message: "Cannot schedule an article in the past" },
    });
    expect(await call(db, "reschedule_article", { articleId: ART_A, date: "next week" })).toMatchObject({ ok: false, status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("unschedule_article", () => {
  it("deletes site A's article and frees its keyword", async () => {
    const db = seed();
    const run = await call(db, "unschedule_article", { articleId: ART_A });
    expect(run).toEqual({ ok: true, output: { articleId: ART_A, keywordId: K_A3 } });
    expect(article(db, ART_A)).toBeUndefined();
    expect(db.tables.keywords.find((k) => k.id === K_A3)).toMatchObject({ status: "available", article_id: null });
  });
});

describe("retry_article", () => {
  it("queues a failed article of site A again", async () => {
    const db = seed();
    expect(await call(db, "retry_article", { articleId: ART_A_FAILED })).toEqual({
      ok: true,
      output: { articleId: ART_A_FAILED, status: "queued" },
    });
    expect(article(db, ART_A_FAILED)).toMatchObject({ status: "queued", attempt_count: 0, last_error: null });
  });

  it("says why an article that is not failed cannot be retried", async () => {
    const db = seed();
    expect(await call(db, "retry_article", { articleId: ART_A })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state" },
    });
    expect(article(db, ART_A)?.status).toBe("queued");
  });
});

describe("dismiss_today_articles", () => {
  it("takes site A's failed articles off Today and leaves them failed, on the board", async () => {
    const db = seed();
    expect(await call(db, "dismiss_today_articles", { articleIds: [ART_A_FAILED] })).toEqual({
      ok: true,
      output: { dismissed: 1, articleIds: [ART_A_FAILED] },
    });
    expect(article(db, ART_A_FAILED)).toMatchObject({ status: "failed", dismissed_at: "2026-11-09T10:00:00.000Z" });
    // Asked again, nothing more to ignore.
    expect(await call(db, "dismiss_today_articles", {})).toEqual({ ok: true, output: { dismissed: 0, articleIds: [] } });
  });

  it("with no ids, ignores every failed article of the site, and never one that is not failed", async () => {
    const db = seed();
    expect(await call(db, "dismiss_today_articles", {})).toMatchObject({ ok: true, output: { dismissed: 1 } });
    expect(article(db, ART_A)?.dismissed_at ?? null).toBeNull();
    expect(article(db, ART_C)?.dismissed_at ?? null).toBeNull();
  });

  it("ignores a held article too, and leaves it held", async () => {
    const db = seed();
    const failed = article(db, ART_A_FAILED);
    if (!failed) throw new Error("seed");
    failed.status = "needs_review";
    expect(await call(db, "dismiss_today_articles", { articleIds: [ART_A_FAILED] })).toMatchObject({ ok: true, output: { dismissed: 1 } });
    expect(article(db, ART_A_FAILED)).toMatchObject({ status: "needs_review", dismissed_at: "2026-11-09T10:00:00.000Z" });
  });

  it("is undone by a retry, so a new failure shows on Today again", async () => {
    const db = seed();
    await call(db, "dismiss_today_articles", { articleIds: [ART_A_FAILED] });
    await call(db, "retry_article", { articleId: ART_A_FAILED });
    expect(article(db, ART_A_FAILED)).toMatchObject({ status: "queued", dismissed_at: null });
  });
});

describe("schedule_keywords and near-duplicates", () => {
  it("leaves a keyword off the calendar when its near-duplicate is already there, and says why", async () => {
    const db = seed();
    // K_A3 "llm citations" is queued on ART_A; a second phrasing sits in the pool.
    const dup = "11111111-1111-4111-8111-000000000007";
    db.tables.keywords.push({ id: dup, user_id: USER, business_id: SITE_A, keyword: "LLM citation", status: "available", article_id: null });
    const run = await call(db, "schedule_keywords", { keywordIds: [dup, K_A] });
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect(run.output).toMatchObject({
      added: 1,
      skipped: 1,
      articles: [{ keywordId: K_A }],
      overlapping: [{ keywordId: dup, keyword: "LLM citation", duplicateOf: { keywordId: K_A3, keyword: "llm citations", articleId: ART_A } }],
    });
    expect((run.output.overlapping as Array<{ reason: string }>)[0].reason).toContain("already on the calendar");
    expect(db.tables.keywords.find((k) => k.id === dup)).toMatchObject({ status: "available", article_id: null });
  });
});

