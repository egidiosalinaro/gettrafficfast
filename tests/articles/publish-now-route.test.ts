import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * POST /api/publish-now after its logic moved to lib/articles/publish-now.ts
 * (the publish_article tool calls it too): the calendar gets the same
 * answers as before, body for body. Publishing from needs_review needs no
 * flag here: pressing Publish after reading the report is the
 * acknowledgement. An article of another account is not found.
 */

const state = vi.hoisted(() => ({
  db: null as unknown,
  ensureCanonical: vi.fn(),
  publishArticle: vi.fn(),
}));

vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/content/service", () => ({
  ensureCanonical: (...args: unknown[]) => state.ensureCanonical(...args),
  publishArticle: (...args: unknown[]) => state.publishArticle(...args),
}));

import { POST } from "@/app/api/publish-now/route";

const CANONICAL = { bodyHtml: "<p>Answer.</p>" };

function seed(status: string, userId = "u-1") {
  state.db = new FakeSupabase({
    articles: [
      {
        id: "a-1",
        user_id: userId,
        business_id: "biz-1",
        keyword_id: "kw-1",
        status,
        content: "<p>Answer.</p>",
        canonical: CANONICAL,
        scheduled_date: "2026-11-09",
        keywords: { keyword: "aeo" },
      },
    ],
    integrations: [{ id: "int-1", user_id: "u-1", business_id: "biz-1", type: "webhook", status: "connected", created_at: "2026-10-01" }],
    jobs: [],
  });
  return state.db as FakeSupabase;
}

async function publish() {
  const request = new Request("https://gettrafficfa.st/api/publish-now", {
    method: "POST",
    body: JSON.stringify({ articleId: "a-1" }),
    headers: { "content-type": "application/json" },
  });
  const response = await POST(request as never);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  state.ensureCanonical.mockReset();
  state.ensureCanonical.mockResolvedValue({ article: CANONICAL, decision: "publish", issues: [] });
  state.publishArticle.mockReset();
  state.publishArticle.mockResolvedValue({ ok: true, url: "https://acme.test/aeo", externalId: "p-1" });
});

describe("POST /api/publish-now", () => {
  it("publishes and answers the URL", async () => {
    seed("generated");
    expect(await publish()).toEqual({ status: 200, body: { success: true, url: "https://acme.test/aeo", republished: false } });
  });

  it("publishes from needs_review: the click is the acknowledgement", async () => {
    seed("needs_review");
    state.ensureCanonical.mockResolvedValue({ article: CANONICAL, decision: "review", issues: [] });
    expect(await publish()).toMatchObject({ status: 200, body: { success: true } });
  });

  it("parks a generated article that fails the gates, with the same body as before", async () => {
    const db = seed("generated");
    state.ensureCanonical.mockResolvedValue({
      article: CANONICAL,
      decision: "review",
      issues: [
        { code: "answer_first", message: "No answer up front", action: "review" },
        { code: "title", message: "Long title", action: "warn" },
      ],
    });
    expect(await publish()).toEqual({
      status: 409,
      body: {
        error: "This article did not pass the quality checks and needs review.",
        status: "needs_review",
        issues: [{ code: "answer_first", message: "No answer up front" }],
      },
    });
    expect(db.tables.articles[0].status).toBe("needs_review");
  });

  it("points a rejected delivery at Integrations", async () => {
    seed("generated");
    state.publishArticle.mockResolvedValue({ ok: false, error: "HTTP 401" });
    expect(await publish()).toEqual({
      status: 502,
      body: { error: "Your site rejected the article: HTTP 401", hint: "integrations" },
    });
  });

  it("answers 422 with the issues when there is no valid content", async () => {
    seed("generated");
    state.ensureCanonical.mockResolvedValue({ article: null, decision: "block", issues: [{ code: "empty", message: "Empty", action: "block" }] });
    expect(await publish()).toEqual({
      status: 422,
      body: {
        error: "This article has no valid content to publish. Regenerate it before trying again.",
        issues: [{ code: "empty", message: "Empty" }],
      },
    });
  });

  it("does not find another account's article, and refuses one never generated", async () => {
    seed("generated", "someone-else");
    expect(await publish()).toEqual({ status: 404, body: { error: "Article not found" } });
    seed("queued");
    expect(await publish()).toEqual({ status: 409, body: { error: "Article must be generated before it can be published" } });
    expect(state.publishArticle).not.toHaveBeenCalled();
  });
});
