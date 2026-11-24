import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { provisionReviewerAccount, REVIEWER_SITE, REVIEWER_SITE_OPT_OUTS, SET_PASSWORD_REDIRECT } from "@/lib/reviewer-account";
import { parseAutomationSettings } from "@/lib/automation/settings";
import { parseMediaSettings } from "@/lib/media/settings";
import { parseAeoSettings } from "@/lib/visibility/settings";
import { describeOutcome } from "@/components/owner/reviewer-account-panel";

/**
 * The MCP directory reviewers' account (lib/reviewer-account.ts). What is
 * pinned: only an address on PASSWORD_LOGIN_EMAILS; idempotent (a user, a
 * live plan, an owner-set ceiling and a site already there are kept); the
 * plan is complimentary with no Stripe ids and no period end; the ceiling
 * is the lowest; the site is gettrafficfa.st; the set-password email goes
 * through the confirm route to the set-password page; no password anywhere.
 */

const EMAIL = "reviewer+gtf@example.com";
const ENV = { PASSWORD_LOGIN_EMAILS: EMAIL };
const NOW = new Date("2026-11-16T12:00:00Z");

interface State {
  users: Array<{ id: string; email: string }>;
  subscriptions: Array<Record<string, unknown>>;
  limits: Array<Record<string, unknown>>;
  businesses: Array<Record<string, unknown>>;
  createUser: ReturnType<typeof vi.fn>;
  resetPasswordForEmail: ReturnType<typeof vi.fn>;
  resetError: { message: string } | null;
}

function fakeAdmin(seed: Partial<State> = {}): { admin: SupabaseClient; state: State } {
  const state: State = {
    users: [],
    subscriptions: [],
    limits: [],
    businesses: [],
    resetError: null,
    ...seed,
    createUser: vi.fn(),
    resetPasswordForEmail: vi.fn(),
  };
  state.createUser.mockImplementation(async (attrs: { email: string }) => {
    const user = { id: `user-${state.users.length + 1}`, email: attrs.email };
    state.users.push(user);
    return { data: { user }, error: null };
  });
  state.resetPasswordForEmail.mockImplementation(async () => ({ data: {}, error: state.resetError }));

  function query(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "insert" | "upsert" | "update" = "select";
    let payload: Record<string, unknown> | null = null;
    const rows = () => (state as unknown as Record<string, Array<Record<string, unknown>>>)[table === "account_limits" ? "limits" : table];
    const matching = () =>
      rows().filter((row) =>
        Object.entries(filters).every(([key, value]) => (Array.isArray(value) ? value.includes(row[key]) : row[key] === value))
      );
    const write = () => {
      if (!payload) return;
      if (op === "update") {
        for (const row of matching()) Object.assign(row, payload);
        return;
      }
      if (op === "upsert") {
        const list = rows();
        const at = list.findIndex((row) => row.user_id === payload!.user_id);
        if (at >= 0) list[at] = { ...list[at], ...payload };
        else list.push(payload);
      } else {
        rows().push({ id: `${table}-${rows().length + 1}`, ...payload });
      }
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (key: string, value: unknown) => ((filters[key] = value), builder),
      in: (key: string, values: unknown[]) => ((filters[key] = values), builder),
      order: () => builder,
      limit: () => builder,
      insert: (row: Record<string, unknown>) => ((op = "insert"), (payload = row), builder),
      upsert: (row: Record<string, unknown>) => ((op = "upsert"), (payload = row), builder),
      update: (row: Record<string, unknown>) => ((op = "update"), (payload = row), builder),
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      single: async () => {
        write();
        return { data: rows()[rows().length - 1], error: null };
      },
      then: (resolve: (value: unknown) => void) => {
        if (op === "select") resolve({ data: matching(), error: null });
        else {
          write();
          resolve({ data: null, error: null });
        }
      },
    };
    return builder;
  }

  const admin = {
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: state.users }, error: null }),
        createUser: state.createUser,
      },
      resetPasswordForEmail: state.resetPasswordForEmail,
    },
    from: query,
  } as unknown as SupabaseClient;
  return { admin, state };
}

describe("provisionReviewerAccount", () => {
  it("refuses an address that is not on PASSWORD_LOGIN_EMAILS, and touches nothing", async () => {
    const { admin, state } = fakeAdmin();
    const result = await provisionReviewerAccount({ admin, input: { email: "someone@example.com" }, env: ENV, now: NOW });
    expect(result).toMatchObject({ ok: false, status: 400, code: "not_listed" });
    expect(state.createUser).not.toHaveBeenCalled();
    expect(state.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(await provisionReviewerAccount({ admin, input: { email: EMAIL }, env: {}, now: NOW })).toMatchObject({ ok: false });
  });

  it("sets up a new account: confirmed user, comp plan, $1 ceiling, the demo site, the set-password email", async () => {
    const { admin, state } = fakeAdmin();
    const result = await provisionReviewerAccount({ admin, input: { email: EMAIL.toUpperCase() }, env: ENV, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(state.createUser).toHaveBeenCalledWith({ email: EMAIL, email_confirm: true });
    // No password is ever chosen here.
    expect(JSON.stringify(state.createUser.mock.calls)).not.toMatch(/password/i);

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      user_id: "user-1",
      status: "active",
      source: "comp",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      current_period_end: null,
    });
    expect(state.limits[0]).toMatchObject({ user_id: "user-1", daily_spend_usd: 1 });
    expect(state.businesses[0]).toMatchObject({
      user_id: "user-1",
      name: REVIEWER_SITE.name,
      website_url: "https://gettrafficfa.st",
      blog_url: "https://gettrafficfa.st/blog",
    });

    expect(state.resetPasswordForEmail).toHaveBeenCalledWith(EMAIL, { redirectTo: SET_PASSWORD_REDIRECT });
    expect(SET_PASSWORD_REDIRECT).toBe("https://gettrafficfa.st/auth/confirm?next=%2Fauth%2Fset-password");

    expect(result.result).toEqual({
      userId: "user-1",
      user: "created",
      plan: "comp_granted",
      ceiling: { usd: 1, set: true },
      site: { id: "businesses-1", created: true },
      passwordEmail: { requested: true, error: null },
    });
  });

  it("is idempotent: keeps the user, a live plan, the owner's ceiling and the site, and sends a fresh email", async () => {
    const { admin, state } = fakeAdmin({
      users: [{ id: "user-9", email: EMAIL }],
      subscriptions: [{ id: "s1", user_id: "user-9", status: "active", source: "comp" }],
      limits: [{ user_id: "user-9", daily_spend_usd: 3 }],
      businesses: [{ id: "site-9", user_id: "user-9", name: "Existing" }],
    });
    const result = await provisionReviewerAccount({ admin, input: { email: EMAIL }, env: ENV, now: NOW });
    expect(result).toEqual({
      ok: true,
      result: {
        userId: "user-9",
        user: "existing",
        plan: "already_live",
        ceiling: { usd: 3, set: false },
        site: { id: "site-9", created: false },
        passwordEmail: { requested: true, error: null },
      },
    });
    expect(state.createUser).not.toHaveBeenCalled();
    expect(state.subscriptions).toHaveLength(1);
    expect(state.businesses).toHaveLength(1);
    expect(state.businesses[0]).toMatchObject(REVIEWER_SITE_OPT_OUTS);
  });

  it("opts the demo site out of what is on by default for customers, keeping its other settings", async () => {
    const { admin, state } = fakeAdmin({
      users: [{ id: "user-9", email: EMAIL }],
      subscriptions: [{ id: "s1", user_id: "user-9", status: "active", source: "comp" }],
      businesses: [{ id: "site-9", user_id: "user-9", name: "Existing", automation_settings: { bufferDays: 7 }, media_settings: {}, aeo_settings: null }],
    });
    await provisionReviewerAccount({ admin, input: { email: EMAIL }, env: ENV, now: NOW });
    const site = state.businesses[0];
    expect(parseAutomationSettings(site.automation_settings)).toMatchObject({ enabled: false, pushPage3: false, bufferDays: 7 });
    expect(parseMediaSettings(site.media_settings)).toMatchObject({ imagesEnabled: false, videosEnabled: false });
    expect(parseAeoSettings(site.aeo_settings).cadence).toBe("off");
    expect(state.resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });

  it("reports a set-password email Supabase refused, without failing the rest", async () => {
    const { admin } = fakeAdmin({ resetError: { message: "rate limited" } });
    const result = await provisionReviewerAccount({ admin, input: { email: EMAIL }, env: ENV, now: NOW });
    expect(result.ok && result.result.passwordEmail).toEqual({ requested: false, error: "rate limited" });
  });
});

describe("describeOutcome (the owner's panel)", () => {
  it("says what was done and where the email went, never a password", () => {
    const text = describeOutcome(EMAIL, {
      user: "created",
      plan: "comp_granted",
      ceiling: { usd: 1, set: true },
      site: { created: true },
      passwordEmail: { requested: true, error: null },
    });
    expect(text).toContain("Account created");
    expect(text).toContain("complimentary plan granted");
    expect(text).toContain("$1/day");
    expect(text).toContain(EMAIL);
  });
});
