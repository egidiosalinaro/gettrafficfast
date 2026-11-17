import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/integrations/search-console/connect, with the `business` link
 * get_search_console_connect_url hands out. The grant attaches to the
 * selected site on the way back, so a link for site B selects site B first,
 * after checking it is the signed-in person's; a site they do not have is
 * refused with a reason, never a quiet fall-back to the site they had open.
 */

const m = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  owned: [{ id: "biz-1" }, { id: "biz-2" }],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }),
}));
vi.mock("@/lib/tenancy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenancy")>()),
  listBusinesses: async () => m.owned,
}));
vi.mock("@/lib/providers/analytics/search-console", () => ({
  isSearchConsoleConfigured: () => true,
  buildConsentUrl: ({ state }: { state: string }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
}));

import { GET } from "@/app/api/integrations/search-console/connect/route";
import { BUSINESS_COOKIE } from "@/lib/tenancy";

const get = (query = "") => GET(new NextRequest(`https://gettrafficfa.st/api/integrations/search-console/connect${query}`));

beforeEach(() => {
  m.user = { id: "user-1" };
});

describe("the connect link", () => {
  it("without a site, goes to Google and leaves the selection alone", async () => {
    const res = await get();
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(res.cookies.get(BUSINESS_COOKIE)).toBeUndefined();
  });

  it("for one of the person's sites, selects it before going to Google", async () => {
    const res = await get("?business=biz-2");
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(res.cookies.get(BUSINESS_COOKIE)?.value).toBe("biz-2");
  });

  it("for a site the person does not have, goes back to Settings with the reason", async () => {
    const res = await get("?business=biz-9");
    expect(res.headers.get("location")).toBe("https://gettrafficfa.st/settings/integrations/search-console?error=site_not_found");
    expect(res.cookies.get(BUSINESS_COOKIE)).toBeUndefined();
  });

  it("signed out, goes to sign-up", async () => {
    m.user = null;
    const res = await get("?business=biz-2");
    expect(res.headers.get("location")).toBe("https://gettrafficfa.st/auth/sign-up");
  });
});
