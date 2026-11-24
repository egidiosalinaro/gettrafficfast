import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * The routes around the reviewer account (docs/API.md "The reviewer
 * account"): the set-password route serves only an account on
 * PASSWORD_LOGIN_EMAILS; the owner's setup route is a 404 to anyone else;
 * and the migration that makes a complimentary plan possible applies
 * without a confirmation.
 */

const REVIEWER = "reviewer+gtf@example.com";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  updateUser: vi.fn(),
  provision: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: mocks.user } }),
      updateUser: mocks.updateUser,
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/reviewer-account", () => ({ provisionReviewerAccount: mocks.provision }));
// The owner's routes decide by the selected site (lib/owner.ts); no
// PLATFORM_OWNER_BUSINESS_IDS here, so any site will do.
vi.mock("@/lib/tenancy", async (original) => ({
  ...(await original<typeof import("@/lib/tenancy")>()),
  selectedBusinessId: async () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}));

import { POST as setPassword } from "@/app/api/auth/set-password/route";
import { POST as setUpReviewer } from "@/app/api/owner/reviewer-account/route";

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as unknown as NextRequest;

beforeEach(() => {
  vi.stubEnv("PASSWORD_LOGIN_EMAILS", REVIEWER);
  vi.stubEnv("PLATFORM_OWNER_USER_IDS", OWNER_ID);
  mocks.user = null;
  mocks.updateUser.mockReset();
  mocks.updateUser.mockResolvedValue({ data: {}, error: null });
  mocks.provision.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/auth/set-password", () => {
  const PASSWORD = "a-long-enough-password";

  it("is a 404 signed out, and for an account not on the list", async () => {
    expect((await setPassword(post("https://x/api/auth/set-password", { password: PASSWORD }))).status).toBe(404);
    mocks.user = { id: "u1", email: "customer@example.com" };
    expect((await setPassword(post("https://x/api/auth/set-password", { password: PASSWORD }))).status).toBe(404);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a short password, and sets a good one for a listed account", async () => {
    mocks.user = { id: "u1", email: REVIEWER.toUpperCase() };
    expect((await setPassword(post("https://x/api/auth/set-password", { password: "short" }))).status).toBe(400);
    const res = await setPassword(post("https://x/api/auth/set-password", { password: PASSWORD }));
    expect(res.status).toBe(200);
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: PASSWORD });
    // The password is not echoed back.
    expect(JSON.stringify(await res.json())).not.toContain(PASSWORD);
  });
});

describe("POST /api/owner/reviewer-account", () => {
  it("is a 404 to anyone who is not a platform owner", async () => {
    expect((await setUpReviewer(post("https://x/api/owner/reviewer-account", { email: REVIEWER }))).status).toBe(404);
    mocks.user = { id: "customer" };
    expect((await setUpReviewer(post("https://x/api/owner/reviewer-account", { email: REVIEWER }))).status).toBe(404);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("sets the account up for an owner and answers what was done", async () => {
    mocks.user = { id: OWNER_ID };
    const result = {
      userId: "u9",
      user: "created",
      plan: "comp_granted",
      ceiling: { usd: 1, set: true },
      site: { id: "s1", created: true },
      passwordEmail: { requested: true, error: null },
    };
    mocks.provision.mockResolvedValue({ ok: true, result });
    const res = await setUpReviewer(post("https://x/api/owner/reviewer-account", { email: REVIEWER }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mocks.provision).toHaveBeenCalledWith(expect.objectContaining({ input: { email: REVIEWER } }));
  });
});

describe("20261116110000_comp_subscriptions.sql", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sql = readFileSync(path.join(root, "supabase/migrations/20261116110000_comp_subscriptions.sql"), "utf8");
  const code = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("adds the source, Stripe by default, and keeps a comp plan free of Stripe ids", () => {
    expect(code).toContain("add column if not exists source text not null default 'stripe'");
    expect(code).toContain("check (source in ('stripe', 'comp'))");
    expect(code).toContain("check (source = 'stripe' or (stripe_subscription_id is null and stripe_customer_id is null))");
  });

  it("applies without a confirmation and leaves RLS alone", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bdelete from\b/i);
    expect(code).not.toMatch(/\bpolicy\b/i);
    expect(code).not.toMatch(/disable row level security/i);
  });
});
