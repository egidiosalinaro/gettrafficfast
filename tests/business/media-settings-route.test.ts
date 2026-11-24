import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Settings → Autopilot, Images and video (`/api/business/media-settings`).
 * Images have no switch since 2026-11-24: saving the form is choosing the
 * image style, which the route records (`styleChosen`, `styleChosenAt`),
 * whatever the page sent for it. An `imagesEnabled` from a page left open
 * from before is accepted and dropped.
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

import { GET, POST } from "@/app/api/business/media-settings/route";

const post = (body: unknown) =>
  POST(new Request("http://test/api/business/media-settings", { method: "POST", body: JSON.stringify(body) }) as unknown as NextRequest);

const stored = () => m.db.tables.businesses.find((b) => b.id === "biz-1")!.media_settings as Record<string, unknown>;

beforeEach(() => {
  m.businessId = "biz-1";
  m.db = new FakeSupabase({
    businesses: [
      { id: "biz-1", user_id: "user-1", name: "Crumb", media_settings: {} },
      { id: "biz-2", user_id: "user-1", name: "Other", media_settings: {} },
    ],
  });
});

describe("the images form", () => {
  it("reads a new site as not chosen yet", async () => {
    const body = await (await GET()).json();
    expect(body.settings).toMatchObject({ styleChosen: false, styleChosenAt: null });
    expect(body.settings).not.toHaveProperty("imagesEnabled");
  });

  it("records the style as chosen on save, with the time, ignoring what the page sent for it", async () => {
    const before = Date.now();
    const response = await post({ style: "illustration", brandPalette: ["#2a6f97"], styleChosen: false, styleChosenAt: null });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings).toMatchObject({ style: "illustration", styleChosen: true });
    expect(Date.parse(body.settings.styleChosenAt)).toBeGreaterThanOrEqual(before);
    expect(stored()).toMatchObject({ style: "illustration", styleChosen: true });
    // The other site of the account is not touched.
    expect(m.db.tables.businesses.find((b) => b.id === "biz-2")!.media_settings).toEqual({});
  });

  it("accepts an imagesEnabled from an old page and does not store it", async () => {
    expect((await post({ imagesEnabled: false, style: "photographic" })).status).toBe(200);
    expect(stored()).not.toHaveProperty("imagesEnabled");
    expect(stored()).toMatchObject({ styleChosen: true });
  });
});
