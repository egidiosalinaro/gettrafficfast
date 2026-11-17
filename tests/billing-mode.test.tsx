import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A deployment without billing (BILLING_DISABLED=1, lib/billing-mode.ts,
 * docs/SELF_HOSTING.md). Pinned: it is off unless the value is exactly "1",
 * so production keeps its paywall; when on, both halves of the paywall
 * (`hasActiveSubscription` for the screens and the tools, `hasPaidAccess`
 * for the sweeps) answer yes without reading a row, and the Plan group
 * leaves Settings.
 */

const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    reads.count++;
    throw new Error("billing disabled must not read the subscriptions table");
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/business",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { billingDisabled } from "@/lib/billing-mode";
import { hasActiveSubscription } from "@/lib/subscription";
import { hasPaidAccess } from "@/lib/paid-access";
import { settingsGroupsFor } from "@/components/dashboard/settings-nav";
import { SettingsSubmenu } from "@/components/dashboard/settings-submenu";
import { SettingsOverview } from "@/components/settings/settings-overview";

afterEach(() => {
  vi.unstubAllEnvs();
  reads.count = 0;
});

describe("billingDisabled", () => {
  it("is on only for the exact value 1", () => {
    expect(billingDisabled({ BILLING_DISABLED: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
      expect(billingDisabled({ BILLING_DISABLED: value })).toBe(false);
    }
  });

  it("is off when the variable is absent, as in production", () => {
    expect(billingDisabled({})).toBe(false);
  });
});

describe("with BILLING_DISABLED=1", () => {
  it("hasActiveSubscription is true without reading a row", async () => {
    vi.stubEnv("BILLING_DISABLED", "1");
    await expect(hasActiveSubscription("user-1")).resolves.toBe(true);
    expect(reads.count).toBe(0);
  });

  it("hasPaidAccess is true without reading a row", async () => {
    vi.stubEnv("BILLING_DISABLED", "1");
    const from = vi.fn(() => {
      throw new Error("no read expected");
    });
    const supabase = { from } as unknown as SupabaseClient;
    await expect(hasPaidAccess(supabase, "user-1")).resolves.toBe(true);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("without the flag", () => {
  it("hasPaidAccess still reads the subscription and denies an account without one", async () => {
    const query = {
      select: () => query,
      eq: () => query,
      in: async () => ({ data: [], error: null }),
    };
    const supabase = { from: () => query } as unknown as SupabaseClient;
    await expect(hasPaidAccess(supabase, "user-1")).resolves.toBe(false);
  });
});

describe("Settings without billing", () => {
  it("drops the Plan group and keeps the others in order", () => {
    expect(settingsGroupsFor(false, { billing: false }).map((group) => group.id)).toEqual(["site", "you"]);
    expect(settingsGroupsFor(true, { billing: false }).map((group) => group.id)).toEqual(["site", "you", "owner"]);
  });

  it("keeps the Plan group by default", () => {
    expect(settingsGroupsFor(false).map((group) => group.id)).toEqual(["site", "plan", "you"]);
  });

  it("the desktop column and the phone list show no Billing entry", () => {
    const column = renderToStaticMarkup(<SettingsSubmenu billing={false} />);
    const list = renderToStaticMarkup(<SettingsOverview siteName="Example" plan={null} billing={false} />);
    for (const html of [column, list]) {
      expect(html).not.toContain("/settings/billing");
      expect(html).toContain("/settings/business");
    }
  });
});
