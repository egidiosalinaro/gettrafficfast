import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Run discovery" starts the job in the request (2026-11-12) instead of
 * leaving everything after 50 s to the 5-minute tick: the route answers at
 * once and the worker keeps going after the response, step after step,
 * for DISCOVERY_RUN_NOW_BUDGET_MS.
 */

const mocks = vi.hoisted(() => ({
  runJobNow: vi.fn(),
  after: vi.fn(),
  requestDiscovery: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));
vi.mock("@/lib/jobs/worker", () => ({ runJobNow: mocks.runJobNow }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/tenancy", () => ({ NO_BUSINESS_RESPONSE: { error: "no business" }, selectedBusinessId: async () => "biz-1" }));
vi.mock("@/lib/paid-access", () => ({ requirePaidAccess: async () => null }));
vi.mock("@/lib/limits/guard", () => ({ requireAccountCapacity: async () => null }));
vi.mock("@/lib/placements/runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/placements/runs")>()),
  requestDiscovery: mocks.requestDiscovery,
}));

import { DISCOVERY_RUN_NOW_BUDGET_MS } from "@/lib/placements/runs";
import { POST, maxDuration } from "@/app/api/placements/discover/route";

describe("Run discovery", () => {
  beforeEach(() => {
    mocks.runJobNow.mockReset();
    mocks.after.mockReset();
    mocks.requestDiscovery.mockReset();
  });

  it("starts the job in the request and answers without waiting for it, or for the tick", async () => {
    mocks.requestDiscovery.mockResolvedValue({ ok: true, jobId: "job-9", alreadyRunning: false, providers: ["web-search"] });
    // A run that never ends inside this test: the answer must not wait for it.
    mocks.runJobNow.mockReturnValue(new Promise(() => {}));

    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, jobId: "job-9", outcome: "started" });

    // The worker was handed this job id at once, with the long budget.
    expect(mocks.runJobNow).toHaveBeenCalledTimes(1);
    expect(mocks.runJobNow).toHaveBeenCalledWith({ admin: true }, "job-9", DISCOVERY_RUN_NOW_BUDGET_MS);
    // And kept alive after the response.
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("starts nothing new when a run is already going", async () => {
    mocks.requestDiscovery.mockResolvedValue({ ok: true, jobId: null, alreadyRunning: true, providers: ["web-search"] });
    const response = await POST();
    expect(await response.json()).toMatchObject({ alreadyRunning: true });
    expect(mocks.runJobNow).not.toHaveBeenCalled();
  });

  it("keeps the run inside the function's life", () => {
    expect(maxDuration).toBe(300);
    expect(DISCOVERY_RUN_NOW_BUDGET_MS).toBeLessThan(maxDuration * 1000);
    expect(DISCOVERY_RUN_NOW_BUDGET_MS).toBeGreaterThanOrEqual(240_000);
  });
});
