import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * One representative paid route, end to end through its handler: without a
 * live subscription "Generate now" answers 402 and enqueues nothing; with one
 * it gets past the guard to its own checks. The article is looked up on the
 * selected site, so an id from another site of the same user is not found.
 */

const state = vi.hoisted(() => ({
  active: false,
  enqueued: 0,
  businessId: "biz-1" as string | null,
  db: null as unknown,
}));

vi.mock("@/lib/subscription", () => ({
  hasActiveSubscription: async () => state.active,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    from: (table: string) => (state.db as FakeSupabase).from(table),
  }),
}));

vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site set up yet. Add your business first.", code: "no_business" },
  selectedBusinessId: async () => state.businessId,
}));

// The account's spend and caps are read with the service role (agent_runs.cost_usd
// is not the customer's to select): those tables come from the same fake.
const GUARD_TABLES = new Set(["agent_runs", "account_limits", "tool_calls", "jobs", "draft_feedback"]);

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (GUARD_TABLES.has(table)) return (state.db as FakeSupabase).from(table);
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { status: "generated" }, error: null }) };
      return query;
    },
  }),
}));

vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: async () => {
    state.enqueued += 1;
    return "job-1";
  },
  hasActiveJob: async () => false,
}));

vi.mock("@/lib/jobs/worker", () => ({ runJobNow: async () => "completed" }));

import { POST } from "@/app/api/generate-now/route";

function request(articleId = "a-1") {
  return new Request("https://gettrafficfa.st/api/generate-now", {
    method: "POST",
    body: JSON.stringify({ articleId }),
    headers: { "content-type": "application/json" },
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  state.active = false;
  state.enqueued = 0;
  state.businessId = "biz-1";
  state.db = new FakeSupabase({
    articles: [
      { id: "a-1", user_id: "u-1", business_id: "biz-1", status: "queued" },
      // The same user's other site.
      { id: "a-2", user_id: "u-1", business_id: "biz-2", status: "queued" },
    ],
  });
});

describe("POST /api/generate-now behind the paywall", () => {
  it("answers 402 and enqueues nothing without a subscription", async () => {
    const res = await POST(request());
    expect(res.status).toBe(402);
    expect(state.enqueued).toBe(0);
  });

  it("lets a subscriber through to the route's own checks", async () => {
    state.active = true;
    const res = await POST(request("a-missing"));
    // Past the guard: the article lookup finds nothing.
    expect(res.status).toBe(404);
  });

  it("produces an article of the selected site", async () => {
    state.active = true;
    const res = await POST(request("a-1"));
    expect(res.status).toBe(200);
    expect(state.enqueued).toBe(1);
  });

  it("does not find an article of another site of the same user, and enqueues nothing", async () => {
    state.active = true;
    const res = await POST(request("a-2"));
    expect(res.status).toBe(404);
    expect(state.enqueued).toBe(0);
  });

  it("answers 409 without a site", async () => {
    state.active = true;
    state.businessId = null;
    expect((await POST(request("a-1"))).status).toBe(409);
    expect(state.enqueued).toBe(0);
  });
});
