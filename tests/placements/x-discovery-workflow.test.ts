import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));

import { X_AUTO_DRAFTS_PER_RUN, xDiscoveryWorkflow } from "@/lib/jobs/workflows/x-discovery";
import { isLlmBoundJob } from "@/lib/jobs/registry";
import { DAILY_DRAFT_CAP } from "@/lib/paid-access";
import type { StepContext } from "@/lib/jobs/types";
import { XApiClient } from "@/lib/providers/x/api";
import { LedgerFake } from "./x-fake";

/**
 * The daily X search job: it runs on every site (no per-site switch since
 * 2026-11-24) and does nothing on a platform without the X API; it drafts the best
 * finds, at most five a run, through the same start a person's "Draft it"
 * uses, so the daily draft cap and the About you prerequisite hold.
 */

const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const FUTURE = "2099-01-01T00:00:00.000Z";

let quiet: Array<ReturnType<typeof vi.spyOn>>;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env };
  quiet = (["log", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
  process.env = env;
  quiet.forEach((spy) => spy.mockRestore());
});

const step = (name: string) => xDiscoveryWorkflow.steps.find((s) => s.name === name)!;

function ctx(db: LedgerFake): StepContext {
  return {
    job: { id: "job-1", user_id: USER, article_id: null, type: "x-post-discovery", input: { businessId: SITE }, status: "running", current_step: null, attempts: 1, max_attempts: 2, last_error: null },
    supabase: db as never,
    input: { businessId: SITE },
    outputs: {},
  };
}

function business(voice: Record<string, unknown>) {
  return { id: SITE, user_id: USER, name: "GetTrafficFast", niche: "SEO", website_url: "https://gettrafficfa.st", content_language: "en", aeo_settings: {}, voice_settings: voice };
}

function found(id: string, score: number, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    business_id: SITE,
    surface: "x",
    kind: "post",
    found_via: "x_search",
    status: "qualified",
    qualify_score: score,
    fresh_until: FUTURE,
    ...over,
  };
}

it("is a model-bound job: it waits out the LLM billing pause like discovery", () => {
  expect(isLlmBoundJob("x-post-discovery")).toBe(true);
});

describe("search", () => {
  it("searches a site whose stored Find posts on X says off: every site takes part since 2026-11-24", async () => {
    process.env.X_API_ENABLED = "1";
    process.env.X_API_BEARER_TOKEN = "t";
    const searchRecent = vi.spyOn(XApiClient.prototype, "searchRecent").mockResolvedValue({ posts: [], missingIds: [], billedPosts: 0, costUsd: 0 });
    const db = new LedgerFake({ businesses: [business({ findPostsOnX: false })], placement_targets: [], keywords: [], entities: [] });
    const out = (await step("search").run(ctx(db))) as Record<string, unknown>;
    expect(typeof out.skipped).not.toBe("string");
    expect(searchRecent).toHaveBeenCalled();
    searchRecent.mockRestore();
  });

  it("does nothing when the platform has only the key, not the opt-in", async () => {
    delete process.env.X_API_ENABLED;
    process.env.X_API_BEARER_TOKEN = "t";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const db = new LedgerFake({ businesses: [business({})] });
    expect(await step("search").run(ctx(db))).toEqual({ skipped: "the X API is not turned on for this deployment" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.tables.provider_spend).toEqual([]);
    fetchSpy.mockRestore();
  });
});

describe("rules", () => {
  it("drops adverts and link shares by rules before any model call, stored as rejections naming the rule", async () => {
    const posted = new Date(Date.now() - 3_600_000).toISOString();
    const row = (id: string, text: string) =>
      found(id, 0, { status: "discovered", qualify_score: null, url: `https://x.com/a/status/${id}`, external_id: `status:${id}`, title: text.slice(0, 200), excerpt: text, posted_at: posted, comment_count: 0, found_for: '"ai content"' });
    const db = new LedgerFake({
      businesses: [business({})],
      placement_targets: [
        row("1", "FREE Early Access to our AI visibility tool! Fill out the form and our team will reach out. https://t.co/a"),
        row("2", "4 Datasets On AI Visibility: ChatGPT Sends 0.62% Of Google's Organic Traffic https://t.co/b"),
        row("3", "How do I get my AI content cited by ChatGPT? Rewrote ten posts with FAQs and nothing changed."),
      ],
    });
    const out = (await step("rules").run(ctx(db))) as { considered: number; rejected: number; byRule: Record<string, number> };
    expect(out).toEqual({ considered: 3, rejected: 2, byRule: { x_promo: 1, x_link_share: 1 } });
    const byId = new Map(db.tables.placement_targets.map((r) => [r.id, r]));
    expect(byId.get("1")).toMatchObject({ status: "rejected", qualified_by: "rules:x_promo", qualify_score: 0 });
    expect(byId.get("2")).toMatchObject({ status: "rejected", qualified_by: "rules:x_link_share" });
    expect(String(byId.get("2")?.qualify_reason)).toContain("link shared");
    // The question is left for the qualifier.
    expect(byId.get("3")).toMatchObject({ status: "discovered" });
  });
});

describe("draft", () => {
  it("starts drafts for the best fresh finds without one, at most five, as scheduled work", async () => {
    const rows = [
      found("f1", 90),
      found("f2", 85),
      found("f3", 80),
      found("f4", 75),
      found("f5", 70),
      found("f6", 65),
      found("f7", 60),
      found("drafted", 95),
      found("stale", 99, { fresh_until: "2020-01-01T00:00:00.000Z" }),
      found("manual", 99, { found_via: "manual" }),
    ];
    const db = new LedgerFake({
      businesses: [business({ aboutYou: "I built it and use it daily." })],
      placement_targets: rows,
      placements: [{ id: "p1", target_id: "drafted" }],
      jobs: [],
    });
    const out = await step("draft").run(ctx(db));
    expect(out).toEqual({ started: X_AUTO_DRAFTS_PER_RUN });
    const drafts = db.tables.jobs.filter((j) => j.type === "placement-draft");
    expect(drafts.map((j) => (j.input as { targetId: string }).targetId)).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    // Not asked for by a person: the crons' priority.
    expect(drafts.every((j) => j.priority === 0)).toBe(true);
  });

  it("drafts the close accounts' finds with the topic search's, under the one ceiling of five", async () => {
    const rows = [
      found("t1", 90),
      found("c1", 95, { found_via: "x_close" }),
      found("t2", 80),
      found("c2", 85, { found_via: "x_close" }),
      found("t3", 70),
      found("c3", 75, { found_via: "x_close" }),
    ];
    const db = new LedgerFake({ businesses: [business({ aboutYou: "I built it." })], placement_targets: rows, placements: [], jobs: [] });
    expect(await step("draft").run(ctx(db))).toEqual({ started: X_AUTO_DRAFTS_PER_RUN });
    const drafted = db.tables.jobs.filter((j) => j.type === "placement-draft").map((j) => (j.input as { targetId: string }).targetId);
    expect(drafted).toEqual(["c1", "t1", "c2", "t2", "c3"]);
  });

  it("stops at the daily draft cap", async () => {
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    const db = new LedgerFake({
      businesses: [business({ aboutYou: "I built it." })],
      placement_targets: [found("f1", 90)],
      placements: [],
      jobs: Array.from({ length: DAILY_DRAFT_CAP }, (_, i) => ({ id: `j${i}`, user_id: USER, type: "placement-draft", status: "completed", created_at: recent, input: {} })),
    });
    expect(await step("draft").run(ctx(db))).toEqual({ started: 0, skipped: "the daily draft limit is reached" });
    expect(db.tables.jobs).toHaveLength(DAILY_DRAFT_CAP);
  });

  it("drafts nothing while About you is empty: drafting would be refused", async () => {
    const db = new LedgerFake({ businesses: [business({})], placement_targets: [found("f1", 90)], placements: [], jobs: [] });
    const out = (await step("draft").run(ctx(db))) as { started: number };
    expect(out.started).toBe(0);
    expect(db.tables.jobs).toEqual([]);
  });
});
