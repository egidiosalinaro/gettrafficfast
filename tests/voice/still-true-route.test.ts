import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * "Still true" through the screen's route (PATCH
 * /api/business/voice-settings/about-you, docs/VOICE.md). Pinned: the day
 * goes into `confirmedFacts`, About you stays byte for byte as written, the
 * Undo puts that one entry back, a sentence not in About you is refused with
 * nothing written, and the other site is never touched.
 */

const m = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => m.db.from(table),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/tenancy", () => ({
  selectedBusinessId: async () => "biz-1",
  NO_BUSINESS_RESPONSE: { error: "No site set up yet.", code: "no_business" },
}));

import { PATCH } from "@/app/api/business/voice-settings/about-you/route";
import type { NextRequest } from "next/server";

const STALE = "Co-founded Postwren: 12 paying stores in October 2026.";
const OTHER = "Left Porto on Oct 1 2026, working from Taipei.";
const ABOUT = `I run GetTrafficFast.  ${STALE}\n${OTHER}`;
const KEY = "co-founded postwren: 12 paying stores in october 2026";

const patch = (body: unknown) =>
  PATCH(new Request("http://test/api/business/voice-settings/about-you", { method: "PATCH", body: JSON.stringify(body) }) as unknown as NextRequest);
const stored = (id = "biz-1") => m.db.tables.businesses.find((b) => b.id === id)!.voice_settings as Record<string, unknown>;

beforeEach(() => {
  m.db = new FakeSupabase({
    businesses: [
      { id: "biz-1", user_id: "user-1", voice_settings: { preset: "plain", aboutYou: ABOUT, instructions: "Lowercase." } },
      { id: "biz-2", user_id: "user-1", voice_settings: { preset: "warm", aboutYou: STALE } },
    ],
  });
});

describe("PATCH /api/business/voice-settings/about-you (Still true)", () => {
  it("records the day apart from the text and leaves About you as the person wrote it", async () => {
    const response = await patch({ sentence: STALE });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ fact: STALE, confirmedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), previousConfirmedOn: null, changed: true });
    expect(stored().aboutYou).toBe(ABOUT);
    expect(stored().confirmedFacts).toEqual({ [KEY]: body.confirmedOn });
    expect(stored().instructions).toBe("Lowercase.");
    expect(stored("biz-2")).toEqual({ preset: "warm", aboutYou: STALE });
  });

  it("the Undo puts that one entry back, and leaves the other confirmations", async () => {
    const other = (await (await patch({ sentence: OTHER })).json()) as { confirmedOn: string };
    const first = (await (await patch({ sentence: STALE })).json()) as { previousConfirmedOn: string | null };
    const undone = await patch({ sentence: STALE, undo: { previousConfirmedOn: first.previousConfirmedOn } });
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ fact: STALE, confirmedOn: null, changed: true });
    expect(stored().confirmedFacts).toEqual({ [OTHER.replace(/\.$/, "").toLowerCase()]: other.confirmedOn });
    expect(stored().aboutYou).toBe(ABOUT);
  });

  it("refuses a sentence that is not in About you, or not a day, and writes nothing", async () => {
    const before = JSON.stringify(m.db.tables.businesses);
    expect((await patch({ sentence: "Never written." })).status).toBe(409);
    expect((await patch({ sentence: "I run GetTrafficFast." })).status).toBe(409);
    expect((await patch({ sentence: STALE, undo: { previousConfirmedOn: "Nov 14" } })).status).toBe(400);
    expect(JSON.stringify(m.db.tables.businesses)).toBe(before);
  });
});
