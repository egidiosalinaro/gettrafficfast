import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The routes behind corrections: paid access and the daily cap before the
 * one model call, the note validated (3 to 300 characters), the selected
 * site handed to the service, and the service's refusal passed on as is.
 * The promote and list routes scope to the selected site. The service
 * itself is tested in correct.test.ts and feedback.test.ts.
 */

const m = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  denied: null as Response | null,
  capped: null as Response | null,
  correct: vi.fn(),
  promote: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/paid-access", () => ({
  requirePaidAccess: async () => m.denied,
  requireCorrectionCapacity: async () => m.capped,
}));
// The account's spend limit is its own test (tests/limits/); here it lets the call through.
vi.mock("@/lib/limits/guard", () => ({ requireAccountCapacity: async () => null }));
vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site", code: "no_business" },
  selectedBusinessId: async () => "biz-1",
}));
vi.mock("@/lib/placements/correct", () => ({ correctDraft: (...args: unknown[]) => m.correct(...args) }));
vi.mock("@/lib/placements/feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/placements/feedback")>()),
  promoteToNotes: (...args: unknown[]) => m.promote(...args),
  listFeedback: (...args: unknown[]) => m.list(...args),
}));

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never;

beforeEach(() => {
  m.user = { id: "user-1" };
  m.denied = null;
  m.capped = null;
  m.correct.mockReset();
  m.promote.mockReset();
  m.list.mockReset();
});

describe("POST /api/placements/drafts/:id/correct", () => {
  const call = async (body: unknown) => {
    const { POST } = await import("@/app/api/placements/drafts/[id]/correct/route");
    return POST(post("https://gettrafficfa.st/api/placements/drafts/d-1/correct", body), {
      params: Promise.resolve({ id: "d-1" }),
    });
  };

  it("refuses the signed out, and a lapsed account before anything is stored or paid", async () => {
    m.user = null;
    expect((await call({ reason: "too generic" })).status).toBe(401);
    m.user = { id: "user-1" };
    m.denied = new Response(JSON.stringify({ code: "subscription_required" }), { status: 402 });
    expect((await call({ reason: "too generic" })).status).toBe(402);
    expect(m.correct).not.toHaveBeenCalled();
  });

  it("takes a note of 3 to 300 characters, and says why otherwise", async () => {
    const short = await call({ reason: " no " });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "Say what is wrong in at least 3 characters." });
    const long = await call({ reason: "x".repeat(301) });
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: "Keep the note under 300 characters." });
    expect((await call({})).status).toBe(400);
    expect((await call({ reason: "too generic", body: "" })).status).toBe(400);
    expect(m.correct).not.toHaveBeenCalled();
  });

  it("stops at the daily correction cap", async () => {
    m.capped = new Response(JSON.stringify({ code: "correction_limit" }), { status: 429 });
    expect((await call({ reason: "too generic" })).status).toBe(429);
    expect(m.correct).not.toHaveBeenCalled();
  });

  it("corrects the draft of the selected site and answers with the draft and its audit", async () => {
    const audit = { status: "passed", checks: [] };
    m.correct.mockResolvedValue({
      ok: true,
      draft: { id: "d-1", body: "Fixed.", audit },
      audit,
      targetStatus: "drafted",
      feedbackId: "fb-1",
    });
    const response = await call({ reason: "  too generic  ", body: "My edit." });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      draft: { id: "d-1", body: "Fixed.", audit },
      audit,
      targetStatus: "drafted",
      feedbackId: "fb-1",
    });
    expect(m.correct).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        businessId: "biz-1",
        draftId: "d-1",
        reason: "too generic",
        body: "My edit.",
        admin: { admin: true },
      })
    );
  });

  it("passes on the service's refusal: a draft not found, a billing pause", async () => {
    m.correct.mockResolvedValue({ ok: false, status: 404, error: "Draft not found" });
    expect((await call({ reason: "too generic" })).status).toBe(404);

    m.correct.mockResolvedValue({ ok: false, status: 503, error: "The AI provider's credits ran out.", feedbackId: "fb-2" });
    const paused = await call({ reason: "too generic" });
    expect(paused.status).toBe(503);
    expect(await paused.json()).toEqual({ error: "The AI provider's credits ran out.", feedbackId: "fb-2" });
  });
});

describe("POST /api/placements/feedback/:id/promote", () => {
  const call = async () => {
    const { POST } = await import("@/app/api/placements/feedback/[id]/promote/route");
    return POST(post("https://gettrafficfa.st/api/placements/feedback/fb-1/promote", {}), {
      params: Promise.resolve({ id: "fb-1" }),
    });
  };

  it("promotes the note of the selected site", async () => {
    m.promote.mockResolvedValue({ ok: true, instructions: "a\nb", appended: true, feedback: { id: "fb-1", promotedToNotes: true } });
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ feedback: { id: "fb-1", promotedToNotes: true }, instructions: "a\nb", appended: true });
    expect(m.promote).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", businessId: "biz-1", feedbackId: "fb-1" }));
  });

  it("passes on a refusal with its sentence", async () => {
    m.promote.mockResolvedValue({ ok: false, status: 409, error: "Your notes are full." });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Your notes are full." });
  });
});

describe("GET /api/placements/feedback", () => {
  it("lists the selected site's notes, and nothing for the signed out", async () => {
    const { GET } = await import("@/app/api/placements/feedback/route");
    m.list.mockResolvedValue({ ok: true, feedback: [{ id: "fb-1", reason: "too generic" }] });
    const response = await GET();
    expect(await response.json()).toEqual({ feedback: [{ id: "fb-1", reason: "too generic" }] });
    expect(m.list).toHaveBeenCalledWith(expect.anything(), "biz-1");

    m.user = null;
    expect((await GET()).status).toBe(401);
  });
});
