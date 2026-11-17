import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The Overview covers replies as well as articles: how many drafted replies
 * wait for the person, and how many went out this week, counted for the
 * selected site only. And the Measure stage names a rate per engine.
 */

const mocks = vi.hoisted(() => ({
  db: null as unknown as { from: (table: string) => unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => mocks.db.from(table),
  }),
}));
vi.mock("@/lib/tenancy", () => ({ selectedBusinessId: async () => "biz-1" }));

import { describeReplies, type OperatingLoop } from "@/lib/domain/operating-loop";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function target(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, business_id: "biz-1", user_id: "user-1", status, published_at: null, ...extra };
}

beforeEach(() => {
  mocks.db = new FakeSupabase({
    businesses: [{ id: "biz-1", name: "Acme", website_url: "https://acme.test", niche: null }],
    articles: [
      { id: "art-1", business_id: "biz-1", status: "published", scheduled_date: "2026-11-01" },
      { id: "art-2", business_id: "biz-1", status: "published", scheduled_date: "2026-11-03" },
    ],
    keywords: [],
    integrations: [],
    analytics_connections: [],
    content_metrics: [],
    ai_citations: [
      { article_id: "art-1", checked_on: "2026-11-05", engine: "gemini", cited: true },
      { article_id: "art-1", checked_on: "2026-11-05", engine: "perplexity", cited: false },
      { article_id: "art-2", checked_on: "2026-11-06", engine: "gemini", cited: false },
      { article_id: "art-2", checked_on: "2026-11-06", engine: "perplexity", cited: false },
    ],
    placement_targets: [
      target("t-drafted", "drafted"),
      target("t-review", "needs_review"),
      target("t-qualified", "qualified"),
      target("t-posted-recent", "published_manually", { published_at: daysAgo(2) }),
      target("t-posted-old", "published_manually", { published_at: daysAgo(20) }),
      target("t-dismissed", "dismissed"),
      // Another site of another account: never counted here.
      target("t-other", "drafted", { business_id: "biz-2", user_id: "user-2" }),
      target("t-other-posted", "published_manually", {
        business_id: "biz-2",
        user_id: "user-2",
        published_at: daysAgo(1),
      }),
    ],
  });
});

async function home(): Promise<{ loop: OperatingLoop }> {
  const { GET } = await import("@/app/api/home/route");
  const response = await GET();
  expect(response.status).toBe(200);
  return (await response.json()) as { loop: OperatingLoop };
}

describe("GET /api/home", () => {
  it("counts replies waiting (drafted or held) and posted in the last 7 days, for this site", async () => {
    const { loop } = await home();
    expect(loop.replies).toMatchObject({
      href: "/today",
      waiting: 2,
      postedLast7Days: 1,
      metric: "2 waiting",
      status: "blocked",
    });
  });

  it("leaves out of posted in the last 7 days a reply marked as removed from the site", async () => {
    const db = mocks.db as unknown as FakeSupabase;
    db.tables.placement_targets.push(
      target("t-posted-removed", "published_manually", { published_at: daysAgo(1), removed_at: daysAgo(0) })
    );
    const { loop } = await home();
    expect(loop.replies).toMatchObject({ postedLast7Days: 1 });
  });

  it("reports citation rates per engine on the Measure stage, never pooled", async () => {
    const { loop } = await home();
    const measure = loop.stages.find((s) => s.id === "measure");
    // Gemini 1 of 2, Perplexity 0 of 2: under 10 probes, counts, not
    // percents. Pooled would be 25%.
    expect(measure?.metric).toBe("Gemini 1 of 2 · Perplexity 0 of 2");
    expect(measure?.metric).not.toMatch(/%/);
  });
});

describe("the Overview's screen", () => {
  it("is Today since 2026-11-14: /dashboard redirects there, and its page is gone", () => {
    expect(source("app/(app)/dashboard/page.tsx")).toContain("redirect(");
    expect(() => source("components/dashboard/home-view.tsx")).toThrow();
    // The Replies line of the loop is still what get_home answers.
    expect(describeReplies({ repliesWaiting: 3, repliesPostedLast7Days: 2 })).toMatchObject({ metric: "3 waiting" });
  });
});
