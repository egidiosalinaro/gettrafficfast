import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route behind "Write your own": paid access first, the selected site,
 * and the storage itself left to lib/placements/own-reply.ts (tested there).
 */

const routeMocks = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  denied: null as Response | null,
  saved: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: routeMocks.user } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/paid-access", () => ({ requirePaidAccess: async () => routeMocks.denied }));
vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site", code: "no_business" },
  selectedBusinessId: async () => "biz-1",
}));
vi.mock("@/lib/placements/own-reply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/placements/own-reply")>()),
  saveOwnReply: (...args: unknown[]) => routeMocks.saved(...args),
}));

describe("POST /api/placements/:id/drafts", () => {
  const call = async (body: unknown) => {
    const { POST } = await import("@/app/api/placements/[id]/drafts/route");
    const request = new Request("https://gettrafficfa.st/api/placements/t-1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(request as never, { params: Promise.resolve({ id: "t-1" }) });
  };

  beforeEach(() => {
    routeMocks.user = { id: "user-1" };
    routeMocks.denied = null;
    routeMocks.saved.mockReset();
  });

  it("requires paid access before anything is stored", async () => {
    routeMocks.denied = new Response(JSON.stringify({ code: "subscription_required" }), { status: 402 });
    const response = await call({ body: "My reply." });
    expect(response.status).toBe(402);
    expect(routeMocks.saved).not.toHaveBeenCalled();
  });

  it("refuses the signed out and an empty reply", async () => {
    routeMocks.user = null;
    expect((await call({ body: "My reply." })).status).toBe(401);
    routeMocks.user = { id: "user-1" };
    expect((await call({ body: "   " })).status).toBe(400);
    expect(routeMocks.saved).not.toHaveBeenCalled();
  });

  it("saves for the person's selected site and answers with the draft", async () => {
    routeMocks.saved.mockResolvedValue({
      ok: true,
      draft: { id: "own-1", body: "My reply." },
      targetStatus: "drafted",
    });
    const response = await call({ body: "My reply." });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ draft: { id: "own-1", body: "My reply." }, targetStatus: "drafted" });
    expect(routeMocks.saved).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", businessId: "biz-1", targetId: "t-1", body: "My reply." })
    );
  });

  it("passes on the refusal it gets", async () => {
    routeMocks.saved.mockResolvedValue({ ok: false, status: 409, error: "A published_manually post does not take a new reply." });
    const response = await call({ body: "My reply." });
    expect(response.status).toBe(409);
  });
});
