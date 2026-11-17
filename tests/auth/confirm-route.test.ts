import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Where a sign-in lands. Since 2026-11-14 a subscriber lands on Today
 * (`/today`), which replaced Replies (`/placements`) and the Overview
 * (`/dashboard`); both redirect there. An explicit `?next=` still wins, but
 * only when it is a path on this site.
 */

const mocks = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  subscribed: true,
  exchangeError: null as { message: string } | null,
  hasActiveSubscription: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: mocks.exchangeError }),
      verifyOtp: async () => ({ error: null }),
      getUser: async () => ({ data: { user: mocks.user } }),
    },
  }),
}));

vi.mock("@/lib/subscription", () => ({
  hasActiveSubscription: mocks.hasActiveSubscription,
}));

import { GET } from "@/app/auth/confirm/route";
import { APP_HOME, landingAfterSignIn, safeNextPath } from "@/lib/app-home";

async function landing(query: string): Promise<string> {
  const request = new Request(`https://gettrafficfa.st/auth/confirm?${query}`) as unknown as NextRequest;
  try {
    await GET(request);
  } catch (error) {
    const url = (error as { url?: string }).url;
    if (url) return url;
    throw error;
  }
  throw new Error("the route did not redirect");
}

beforeEach(() => {
  mocks.user = { id: "user-1" };
  mocks.subscribed = true;
  mocks.exchangeError = null;
  mocks.hasActiveSubscription.mockReset();
  mocks.hasActiveSubscription.mockImplementation(async () => mocks.subscribed);
});

describe("the sign-in landing", () => {
  it("sends a subscriber to Today", async () => {
    expect(APP_HOME).toBe("/today");
    expect(await landing("code=abc")).toBe("/today");
    expect(await landing("token_hash=t&type=magiclink")).toBe("/today");
  });

  it("sends someone without a subscription to pricing", async () => {
    mocks.subscribed = false;
    expect(await landing("code=abc")).toBe("/pricing");
  });

  it("honours a ?next= path on this site, without reading the subscription", async () => {
    expect(await landing(`code=abc&next=${encodeURIComponent("/growth/ai?tab=sources")}`)).toBe(
      "/growth/ai?tab=sources"
    );
    expect(mocks.hasActiveSubscription).not.toHaveBeenCalled();
  });

  it("ignores a ?next= that leaves the site", async () => {
    expect(await landing(`code=abc&next=${encodeURIComponent("https://evil.example")}`)).toBe("/today");
    expect(await landing(`code=abc&next=${encodeURIComponent("//evil.example")}`)).toBe("/today");
  });

  it("lands an already signed-in visitor the same way", async () => {
    expect(await landing("")).toBe("/today");
  });

  it("hands a set-password link answered in the fragment to the set-password page", async () => {
    mocks.user = null;
    expect(await landing(`next=${encodeURIComponent("/auth/set-password")}`)).toBe("/auth/set-password");
    // Any other next, with no session and no code, is still an error.
    expect(await landing(`next=${encodeURIComponent("/today")}`)).toMatch(/^\/auth\/error/);
  });

  it("sends a signed-in visitor with the set-password next there too", async () => {
    expect(await landing(`next=${encodeURIComponent("/auth/set-password")}`)).toBe("/auth/set-password");
  });

  it("reports a failed exchange instead of landing", async () => {
    mocks.exchangeError = { message: "expired" };
    expect(await landing("code=abc")).toBe("/auth/error?error=expired");
  });
});

describe("landingAfterSignIn", () => {
  it("prefers a safe next path, then Replies for a subscriber, then pricing", () => {
    expect(landingAfterSignIn({ next: "/growth/ai", subscribed: false })).toBe("/growth/ai");
    expect(landingAfterSignIn({ next: null, subscribed: true })).toBe("/today");
    expect(landingAfterSignIn({ next: undefined, subscribed: false })).toBe("/pricing");
  });

  it("accepts only same-site paths", () => {
    expect(safeNextPath("/settings/billing")).toBe("/settings/billing");
    expect(safeNextPath("settings")).toBeNull();
    expect(safeNextPath("//evil.example/x")).toBeNull();
    expect(safeNextPath("/\\evil.example")).toBeNull();
    expect(safeNextPath("")).toBeNull();
  });
});
