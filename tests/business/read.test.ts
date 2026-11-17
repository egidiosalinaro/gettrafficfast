import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Settings → Business and Settings → Voice read through lib functions the
 * tools share (lib/business/read.ts, lib/voice/read.ts). Pinned: both
 * routes' answers, captured before the reads moved, for the selected site
 * of the signed-in user only.
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

import { GET as getBusiness } from "@/app/api/business/get/route";
import { GET as getVoice, PATCH as patchVoice } from "@/app/api/business/voice-settings/route";
import type { NextRequest } from "next/server";

const patch = (body: unknown) =>
  patchVoice(new Request("http://test/api/business/voice-settings", { method: "PATCH", body: JSON.stringify(body) }) as unknown as NextRequest);

describe("PATCH /api/business/voice-settings (the Today sheet's goal)", () => {
  it("changes the goal and keeps every other voice field as stored", async () => {
    const response = await patch({ dailyReplyGoal: 6 });
    expect(response.status).toBe(200);
    const stored = m.db.tables.businesses.find((b) => b.id === "biz-1")!.voice_settings;
    expect(stored).toMatchObject({ preset: "casual", person: "we", aboutYou: "We build Acme.", instructions: "Never say leverage.", dailyReplyGoal: 6 });
    expect((await patch({ dailyReplyGoal: null })).status).toBe(200);
    expect(m.db.tables.businesses.find((b) => b.id === "biz-1")!.voice_settings).toMatchObject({ aboutYou: "We build Acme.", dailyReplyGoal: null });
    // The other site is not touched.
    expect(m.db.tables.businesses.find((b) => b.id === "biz-2")!.voice_settings).toEqual({ preset: "warm" });
  });

  it("refuses a goal out of bounds and an unknown field, and changes nothing", async () => {
    expect((await patch({ dailyReplyGoal: 0 })).status).toBe(400);
    expect((await patch({ dailyReplyGoal: 51 })).status).toBe(400);
    expect((await patch({ nope: true })).status).toBe(400);
    expect(m.db.tables.businesses.find((b) => b.id === "biz-1")!.voice_settings).toEqual(business.voice_settings);
  });

  it("refuses a goal alone over voice settings it cannot read, rather than resetting them", async () => {
    const unreadable = { preset: "shouty", instructions: "Keep my notes." };
    m.db.tables.businesses.find((b) => b.id === "biz-1")!.voice_settings = unreadable;
    const response = await patch({ dailyReplyGoal: 3 });
    expect(response.status).toBe(409);
    expect(m.db.tables.businesses.find((b) => b.id === "biz-1")!.voice_settings).toEqual(unreadable);
  });
});

const business = {
  id: "biz-1",
  user_id: "user-1",
  name: "Acme",
  website_url: "https://acme.test",
  niche: "SEO tools",
  description: "Acme helps small teams rank.",
  sitemap_url: null,
  blog_url: "https://acme.test/blog",
  content_language: "en",
  is_locked: true,
  voice_settings: { preset: "casual", person: "we", aboutYou: "We build Acme.", instructions: "Never say leverage." },
  automation_settings: { enabled: true },
  media_settings: {},
  aeo_settings: {},
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
};

beforeEach(() => {
  m.businessId = "biz-1";
  m.db = new FakeSupabase({
    businesses: [{ ...business }, { ...business, id: "biz-2", name: "Bravo", voice_settings: { preset: "warm" } }],
  });
});

describe("GET /api/business/get", () => {
  it("answers exactly what it answered before the read moved to lib", async () => {
    const response = await getBusiness();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ business });
  });

  it("answers null with no site, and for a site the user does not own", async () => {
    m.businessId = null;
    expect(await (await getBusiness()).json()).toEqual({ business: null });
    m.businessId = "biz-1";
    m.db.tables.businesses[0].user_id = "user-2";
    expect(await (await getBusiness()).json()).toEqual({ business: null });
  });
});

describe("GET /api/business/voice-settings", () => {
  it("answers exactly what it answered before the read moved to lib", async () => {
    const response = await getVoice();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "hasBusiness": true,
        "settings": {
          "aboutYou": "We build Acme.",
          "articleFacts": "",
          "confirmedFacts": {},
          "dailyReplyGoal": null,
          "findPostsOnX": false,
          "instructions": "Never say leverage.",
          "person": "we",
          "preset": "casual",
        },
        "staleAfterDays": 30,
        "staleFacts": [],
      }
    `);
  });

  it("answers the defaults with no site", async () => {
    m.businessId = null;
    expect(await (await getVoice()).json()).toMatchInlineSnapshot(`
      {
        "hasBusiness": false,
        "settings": {
          "aboutYou": "",
          "articleFacts": "",
          "confirmedFacts": {},
          "dailyReplyGoal": null,
          "findPostsOnX": false,
          "instructions": "",
          "person": "auto",
          "preset": "plain",
        },
        "staleAfterDays": 30,
        "staleFacts": [],
      }
    `);
  });
});
