import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The checklist's counts are read in one place (lib/onboarding-status.ts):
 * /api/onboarding/status, the Overview (/api/home) and the
 * `get_onboarding_status` tool all go through it. These pin the route's
 * answer, captured before the counts moved, and that the Overview's next
 * step is the checklist's.
 */

const m = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  businessId: "biz-1" as string | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => m.db.from(table),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/tenancy", () => ({ selectedBusinessId: async () => m.businessId }));

import { GET as status } from "@/app/api/onboarding/status/route";
import { GET as home } from "@/app/api/home/route";
import { nextOnboardingStep, type OnboardingStatus } from "@/lib/onboarding";

const owned = { user_id: "user-1", business_id: "biz-1" };
const other = { user_id: "user-1", business_id: "biz-2" };

function seed(over: { aboutYou?: string; manual?: boolean } = {}) {
  return new FakeSupabase({
    businesses: [
      {
        id: "biz-1",
        user_id: "user-1",
        name: "Acme",
        website_url: "https://acme.test",
        niche: null,
        voice_settings: { aboutYou: over.aboutYou ?? "I run Acme." },
        automation_settings: { enabled: false },
        media_settings: {},
      },
    ],
    keywords: [
      { id: "kw-1", ...owned, keyword: "seo", article_id: null, created_at: "2026-10-01T00:00:00.000Z" },
      { id: "kw-9", ...other, keyword: "other", article_id: null, created_at: "2026-10-01T00:00:00.000Z" },
    ],
    articles: [{ id: "art-9", ...other, status: "queued", scheduled_date: "2026-11-20" }],
    integrations: [
      { id: "int-1", ...owned, type: "webhook", status: "disconnected" },
      { id: "int-9", ...other, type: "webhook", status: "connected" },
    ],
    placement_targets: over.manual
      ? [{ id: "t-1", ...owned, status: "qualified", found_via: "manual" }]
      : [{ id: "t-9", ...other, status: "qualified", found_via: "manual" }],
    analytics_connections: [],
    content_metrics: [],
    ai_citations: [],
  });
}

beforeEach(() => {
  m.db = seed();
  m.businessId = "biz-1";
});

describe("GET /api/onboarding/status", () => {
  it("answers exactly what it answered before the counts moved to lib, for the selected site only", async () => {
    const response = await status();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "hasAboutYou": true,
        "hasArticles": false,
        "hasBusiness": true,
        "hasClaude": false,
        "hasIntegration": false,
        "hasKeywords": true,
        "hasManualPost": false,
      }
    `);
  });

  it("answers the empty status with no site", async () => {
    m.businessId = null;
    expect(await (await status()).json()).toMatchInlineSnapshot(`
      {
        "hasAboutYou": false,
        "hasArticles": false,
        "hasBusiness": false,
        "hasClaude": false,
        "hasIntegration": false,
        "hasKeywords": false,
        "hasManualPost": false,
      }
    `);
  });

  it("counts a manual post and an empty About you", async () => {
    m.db = seed({ aboutYou: "  ", manual: true });
    expect(await (await status()).json()).toMatchObject({ hasAboutYou: false, hasManualPost: true });
  });
});

describe("the Overview and the checklist", () => {
  it("name the same next step", async () => {
    const checklist = (await (await status()).json()) as OnboardingStatus;
    const snapshot = (await (await home()).json()) as { loop: { nextAction: { id: string } | null } };
    expect(snapshot.loop.nextAction?.id).toBe(nextOnboardingStep(checklist)?.key);
  });
});
