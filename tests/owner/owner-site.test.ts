import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyProviderComparison, type ProviderComparisonView } from "@/lib/articles/provider-comparison";

/**
 * The owner's sites (lib/owner.ts, PLATFORM_OWNER_BUSINESS_IDS), on every
 * screen and route that behaves differently for a platform owner. What is
 * pinned, with the variable set to the platform's site:
 *
 * - on the platform's site the owner gets the owner's things: the Platform
 *   group in Settings (list and column), /settings/costs, the spend-limit and
 *   reviewer-account routes, the comparison with its cost per run;
 * - on the owner's other site, every one of them is what a customer gets: no
 *   Platform group, the 404s, the comparison without costs;
 * - unset, the owner gets them on any site, as before;
 * - a customer never gets them, on any site.
 *
 * The site is the selected one, as the browser selects it.
 */

const OWNER = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PLATFORM_SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIDE_SITE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const state = vi.hoisted(() => ({
  userId: "",
  siteId: null as string | null,
  provisioned: 0,
  saved: 0,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/app-access", () => ({
  requireAppAccess: async () => ({
    userId: state.userId,
    user: null,
    businesses: [],
    selected: state.siteId ? { id: state.siteId, name: "Site", website_url: "https://site.test" } : null,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/tenancy", async (original) => ({
  ...(await original<typeof import("@/lib/tenancy")>()),
  selectedBusinessId: async () => state.siteId,
}));
vi.mock("@/lib/limits/platform-costs", () => ({ readPlatformCosts: async () => ({}) }));
vi.mock("@/components/owner/platform-costs-view", () => ({ PlatformCostsView: () => null }));
vi.mock("@/components/owner/reviewer-account-panel", () => ({ ReviewerAccountPanel: () => null }));
vi.mock("@/lib/reviewer-account", () => ({
  provisionReviewerAccount: async () => {
    state.provisioned += 1;
    return { ok: true, result: { userId: "u", user: "existing", plan: "existing", ceiling: { usd: 1 }, site: { created: false }, passwordEmail: { requested: true } } };
  },
}));
vi.mock("@/lib/limits/settings", async (original) => ({
  ...(await original<typeof import("@/lib/limits/settings")>()),
  saveDailySpendLimit: async () => {
    state.saved += 1;
    return { ok: true, ceiling: { usd: 4 }, previousUsd: 5 };
  },
}));
vi.mock("@/lib/articles/provider-comparison", async (original) => {
  const real = await original<typeof import("@/lib/articles/provider-comparison")>();
  return {
    ...real,
    loadProviderComparison: async (): Promise<ProviderComparisonView> => {
      const empty = real.emptyProviderComparison(28);
      return {
        ...empty,
        arms: [{ ...(empty.arms[0] ?? ({} as ProviderComparisonView["arms"][number])), agents: [{ agent: "writing", avgCostUsd: 0.12 } as never] }],
      };
    },
  };
});

import SettingsLayout from "@/app/(app)/settings/layout";
import SettingsPage from "@/app/(app)/settings/page";
import PlatformCostsPage from "@/app/(app)/settings/costs/page";
import { POST as setSpendLimit } from "@/app/api/owner/spend-limit/route";
import { POST as setUpReviewer } from "@/app/api/owner/reviewer-account/route";
import { GET as compareProviders } from "@/app/api/articles/provider-comparison/route";

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never;

type Element = { props: Record<string, unknown> & { children?: unknown } };

async function settingsIsOwner(): Promise<{ list: unknown; column: unknown }> {
  const page = (await SettingsPage()) as unknown as Element;
  const layout = (await SettingsLayout({ children: null })) as unknown as Element;
  const column = (layout.props.children as Element[])[0];
  return { list: page.props.isOwner, column: column.props.isOwner };
}

async function costsPageOpens(): Promise<boolean> {
  try {
    await PlatformCostsPage();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_NOT_FOUND") return false;
    throw error;
  }
}

async function comparisonHasCosts(): Promise<boolean> {
  const res = await compareProviders({ nextUrl: new URL("https://x.test/api/articles/provider-comparison") } as never);
  return JSON.stringify(await res.json()).includes("avgCostUsd");
}

/** Every owner-only behaviour, as seen by `userId` with `siteId` selected. */
async function ownerThings(userId: string, siteId: string) {
  state.userId = userId;
  state.siteId = siteId;
  state.provisioned = 0;
  state.saved = 0;
  const settings = await settingsIsOwner();
  return {
    settingsList: settings.list,
    settingsColumn: settings.column,
    costsPage: await costsPageOpens(),
    spendLimit: (await setSpendLimit(post("https://x.test/api/owner/spend-limit", { userId: CUSTOMER, dailySpendUsd: 4 }))).status,
    reviewer: (await setUpReviewer(post("https://x.test/api/owner/reviewer-account", { email: "review@example.com" }))).status,
    comparisonCosts: await comparisonHasCosts(),
    wrote: state.saved + state.provisioned,
  };
}

const OWNERS = { settingsList: true, settingsColumn: true, costsPage: true, spendLimit: 200, reviewer: 200, comparisonCosts: true, wrote: 2 };
const CUSTOMERS = { settingsList: false, settingsColumn: false, costsPage: false, spendLimit: 404, reviewer: 404, comparisonCosts: false, wrote: 0 };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("PLATFORM_OWNER_USER_IDS", OWNER);
  vi.stubEnv("BILLING_DISABLED", "1");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("the owner's things, per site", () => {
  it("sanity: the stub comparison carries a cost per run, the empty one has nothing to hide", () => {
    expect(JSON.stringify(emptyProviderComparison(28))).not.toContain("avgCostUsd");
  });

  it("with PLATFORM_OWNER_BUSINESS_IDS set, are the owner's on the platform's site", async () => {
    vi.stubEnv("PLATFORM_OWNER_BUSINESS_IDS", PLATFORM_SITE);
    expect(await ownerThings(OWNER, PLATFORM_SITE)).toEqual(OWNERS);
  });

  it("on the owner's other site, are exactly a customer's", async () => {
    vi.stubEnv("PLATFORM_OWNER_BUSINESS_IDS", PLATFORM_SITE);
    expect(await ownerThings(OWNER, SIDE_SITE)).toEqual(CUSTOMERS);
  });

  it("unset, are the owner's on any site, as before", async () => {
    for (const unset of [undefined, ""]) {
      vi.stubEnv("PLATFORM_OWNER_BUSINESS_IDS", unset);
      expect(await ownerThings(OWNER, PLATFORM_SITE)).toEqual(OWNERS);
      expect(await ownerThings(OWNER, SIDE_SITE)).toEqual(OWNERS);
    }
  });

  it("are never a customer's, on any site, set or not", async () => {
    for (const sites of [undefined, PLATFORM_SITE]) {
      vi.stubEnv("PLATFORM_OWNER_BUSINESS_IDS", sites);
      expect(await ownerThings(CUSTOMER, PLATFORM_SITE)).toEqual(CUSTOMERS);
      expect(await ownerThings(CUSTOMER, SIDE_SITE)).toEqual(CUSTOMERS);
    }
  });
});
