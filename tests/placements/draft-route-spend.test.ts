import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * "Generate draft" and the account's daily AI spend limit. A new draft is
 * refused at the limit before anything is asked for, in the card's words
 * (`kind: "paused"`: no "Write it anyway"). The card's follow-up poll is
 * refused only when it would run the job: a draft that finished is still
 * shown, whatever the spend.
 */

const state = vi.hoisted(() => ({
  db: null as unknown,
  requestDraft: vi.fn(),
  ran: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => (state.db as FakeSupabase).from(table),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/paid-access", () => ({ requirePaidAccess: async () => null }));
vi.mock("@/lib/tenancy", () => ({ NO_BUSINESS_RESPONSE: { error: "No site" }, selectedBusinessId: async () => "biz-1" }));
vi.mock("@/lib/placements/generate", () => ({
  requestDraft: (...args: unknown[]) => state.requestDraft(...args),
  draftAuditOf: () => ({ status: "passed", writes: 1, omitted: [] }),
}));
vi.mock("@/lib/jobs/worker", () => ({
  runJobNow: async (_admin: unknown, jobId: string) => {
    state.ran.push(jobId);
    return "completed";
  },
}));

import { POST } from "@/app/api/placements/[id]/draft/route";

/** The customer's terms at the ceiling: when it resets, never an amount. */
const CAP_MESSAGE = /^You've reached today's limit for AI work\. It resets at about \d\d:\d\d UTC on [A-Z][a-z]{2} \d{1,2}\.$/;
const call = (body: unknown = null) =>
  POST(
    new Request("https://gettrafficfa.st/api/placements/t-1/draft", {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }) as never,
    { params: Promise.resolve({ id: "t-1" }) }
  );

function seed(spentUsd: number) {
  state.db = new FakeSupabase({
    account_limits: [],
    agent_runs: [
      { user_id: "user-1", agent: "placement-draft", model: "gemini-2.5-flash", cost_usd: spentUsd, created_at: new Date(Date.now() - 3_600_000).toISOString() },
    ],
  });
}

beforeEach(() => {
  state.requestDraft.mockReset();
  state.ran = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/placements/:id/draft at the spend limit", () => {
  it("refuses a new draft before anything is asked for", async () => {
    seed(5);
    const response = await call();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: expect.stringMatching(CAP_MESSAGE),
      code: "spend_cap_reached",
      href: "/settings/billing",
      kind: "paused",
    });
    expect(state.requestDraft).not.toHaveBeenCalled();
    expect(state.ran).toEqual([]);
  });

  it("still shows a finished draft to the card's poll", async () => {
    seed(5);
    state.requestDraft.mockResolvedValue({
      ok: true,
      next: { kind: "completed", jobId: "job-1", audit: { status: "passed", writes: 1, omitted: [] } },
    });
    const response = await call({ continue: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, outcome: "completed" });
  });

  it("refuses the poll that would run the job, and runs it under the limit", async () => {
    seed(5);
    state.requestDraft.mockResolvedValue({ ok: true, next: { kind: "run", jobId: "job-1" } });
    expect((await call({ continue: true })).status).toBe(429);
    expect(state.ran).toEqual([]);

    seed(1);
    expect((await call({ continue: true })).status).toBe(200);
    expect(state.ran).toEqual(["job-1"]);
  });
});
