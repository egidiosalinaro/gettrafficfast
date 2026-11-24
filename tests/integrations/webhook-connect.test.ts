import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/integrations/webhook/connect, at the boundary that matters: the
 * product's own blog receiver may be connected by its operator and by nobody
 * else. Supabase, tenancy and the adapter's network test are stubbed; the
 * decision under test is the route's.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";
const OWN = "https://gettrafficfa.st/api/gettrafficfast";

const state = vi.hoisted(() => ({
  userId: "" as string,
  upserts: [] as Record<string, unknown>[],
  testError: null as Error | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }) },
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        state.upserts.push(row);
        return {
          select: () => ({ single: async () => ({ data: { id: "int-1", type: "webhook" }, error: null }) }),
        };
      },
    }),
  }),
}));

vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No business" },
  selectedBusinessId: async () => "biz-1",
}));

vi.mock("@/lib/publishing/adapters/webhook", () => ({
  WebhookAdapter: class {
    async testConnection() {
      if (state.testError) throw state.testError;
    }
  },
}));

import { POST } from "@/app/api/integrations/webhook/connect/route";

function request(body: unknown) {
  return new Request("https://gettrafficfa.st/api/integrations/webhook/connect", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as Parameters<typeof POST>[0];
}

const previous: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ["OWN_BLOG_OWNER_USER_IDS", "BLOG_WEBHOOK_SECRET", "INTEGRATIONS_ENCRYPTION_KEY", "PLATFORM_OWNER_BUSINESS_IDS"]) {
    previous[key] = process.env[key];
  }
  process.env.OWN_BLOG_OWNER_USER_IDS = OWNER;
  process.env.BLOG_WEBHOOK_SECRET = "blog-secret";
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "ab".repeat(32);
  delete process.env.PLATFORM_OWNER_BUSINESS_IDS;
  state.upserts = [];
  state.testError = null;
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("webhook connect: the own blog receiver", () => {
  it("refuses a signed-in customer, and writes nothing", async () => {
    state.userId = STRANGER;
    const res = await POST(request({ url: OWN }));
    expect(res.status).toBe(403);
    expect(state.upserts).toHaveLength(0);
  });

  it("refuses even the operator when OWN_BLOG_OWNER_USER_IDS is unset", async () => {
    delete process.env.OWN_BLOG_OWNER_USER_IDS;
    state.userId = OWNER;
    const res = await POST(request({ url: `${OWN}/` }));
    expect(res.status).toBe(403);
    expect(state.upserts).toHaveLength(0);
  });

  it("connects it for the operator, storing no secret and no env flag", async () => {
    state.userId = OWNER;
    const res = await POST(request({ url: OWN }));
    expect(res.status).toBe(200);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].config).toEqual({ url: OWN });
  });

  it("with PLATFORM_OWNER_BUSINESS_IDS set, connects it only from a listed site (lib/owner.ts)", async () => {
    state.userId = OWNER;
    process.env.PLATFORM_OWNER_BUSINESS_IDS = "biz-other";
    const refused = await POST(request({ url: OWN }));
    expect(refused.status).toBe(403);
    expect(state.upserts).toHaveLength(0);

    process.env.PLATFORM_OWNER_BUSINESS_IDS = "biz-other, BIZ-1";
    const res = await POST(request({ url: OWN }));
    expect(res.status).toBe(200);
    expect(state.upserts).toHaveLength(1);
  });

  it("still connects a customer's own URL with their secret", async () => {
    state.userId = STRANGER;
    const res = await POST(request({ url: "https://customer.example/hook", secret: "s3cret" }));
    expect(res.status).toBe(200);
    const config = state.upserts[0].config as Record<string, unknown>;
    expect(config.url).toBe("https://customer.example/hook");
    expect(config.secret_encrypted).toBeTypeOf("string");
    expect(config).not.toHaveProperty("secret_from_env");
  });

  it("answers a failed test generically, without the network detail", async () => {
    state.userId = STRANGER;
    state.testError = new Error("Cannot reach http://10.0.0.1:6379: connection refused (ECONNREFUSED)");
    const res = await POST(request({ url: "https://customer.example/hook", secret: "s3cret" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^Could not reach that address/);
    expect(body.error).not.toMatch(/ECONNREFUSED|refused|6379/);
  });
});
