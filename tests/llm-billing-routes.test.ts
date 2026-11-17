import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "@/lib/providers/llm/types";
import { LLM_CREDITS_RAN_OUT_MESSAGE } from "@/lib/llm-billing";

/**
 * Routes that call a model inside the request (analyse a site, suggest
 * keywords, propose prompts). A billing refusal is recorded the way the
 * worker records it (pause, one alert) and answered with a 503 in words, not
 * the provider's error; any other failure is left as it was.
 */

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  similar: vi.fn(),
  agent: vi.fn(),
  record: vi.fn(),
}));

const fromChain = () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({
    data: { name: "Acme", niche: "seo", description: "d", website_url: "https://acme.test", content_language: "en" },
  });
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [] }).then(resolve);
  return chain;
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => fromChain(),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/paid-access", () => ({ requirePaidAccess: async () => null }));
// The account's limits are their own tests (tests/limits/); here they let the call through.
vi.mock("@/lib/limits/guard", () => ({ requireAccountCapacity: async () => null }));
vi.mock("@/lib/limits/actions", () => ({ recordScreenAction: () => {} }));
vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site" },
  selectedBusinessId: async () => "biz-1",
}));
vi.mock("@/lib/research/website", () => ({ analyzeWebsite: mocks.analyze }));
vi.mock("@/lib/research/keywords", () => ({
  findSimilarKeywords: mocks.similar,
  generateKeywordsFromBusiness: mocks.similar,
}));
vi.mock("@/lib/agents/runner", () => ({ runAgent: mocks.agent, supabaseRecorder: () => ({}) }));
vi.mock("@/lib/llm-billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm-billing")>()),
  recordLlmBillingRefusal: mocks.record,
}));

const billing = () =>
  new LlmError("Gemini credits are depleted.", "gemini", undefined, {
    retryable: false,
    report: false,
    billingRefused: ["gemini"],
  });

const post = (body: unknown) =>
  new Request("https://gettrafficfa.st/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.record.mockResolvedValue({ pausedUntil: new Date(), reported: ["gemini"], emailed: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a billing refusal inside a request", () => {
  it("analyse a site: recorded, and a 503 in words", async () => {
    mocks.analyze.mockRejectedValue(billing());
    const { POST } = await import("@/app/api/business/analyze/route");
    const response = await POST(post({ websiteUrl: "https://acme.test" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: LLM_CREDITS_RAN_OUT_MESSAGE });
    expect(mocks.record).toHaveBeenCalledWith({ admin: true }, expect.any(LlmError), { source: "api.business.analyze" });
  });

  it("suggest keywords: recorded, and a 503 in words", async () => {
    mocks.similar.mockRejectedValue(billing());
    const { POST } = await import("@/app/api/keywords/suggest/route");
    const response = await POST(post({ keywords: ["ai seo"] }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: LLM_CREDITS_RAN_OUT_MESSAGE });
    expect(mocks.record).toHaveBeenCalledWith({ admin: true }, expect.any(LlmError), { source: "api.keywords.suggest" });
  });

  it("propose prompts: recorded, and a 503 in words", async () => {
    mocks.agent.mockRejectedValue(billing());
    const { POST } = await import("@/app/api/visibility/queries/suggest/route");
    const response = await POST();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: LLM_CREDITS_RAN_OUT_MESSAGE });
    expect(mocks.record).toHaveBeenCalledWith({ admin: true }, expect.any(LlmError), {
      source: "api.visibility.queries.suggest",
    });
  });

  it("leaves any other failure as it was, and records nothing", async () => {
    mocks.analyze.mockRejectedValue(new Error("boom"));
    const { POST } = await import("@/app/api/business/analyze/route");
    const response = await POST(post({ websiteUrl: "https://acme.test" }));
    expect(response.status).toBe(500);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
