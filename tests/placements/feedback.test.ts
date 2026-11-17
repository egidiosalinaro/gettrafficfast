import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FeedbackReason,
  PROMPT_REASON_MAX,
  appendNote,
  correctionsToday,
  distinctReasons,
  listFeedback,
  promoteToNotes,
  recentFeedback,
  recordFeedback,
} from "@/lib/placements/feedback";
import { INSTRUCTIONS_MAX } from "@/lib/voice/settings";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The owner's notes on drafts. What is pinned: a note is 3 to 300
 * characters; a prompt gets the newest distinct notes, clamped and deduped
 * whatever their case, never more than asked, and nothing (not an error)
 * when the table cannot be read; promoting a note appends one line to the
 * writer's notes, never twice, never past their limit, and never over
 * settings it could not read.
 */

const USER = "user-1";
const BUSINESS = "biz-1";

const client = (db: FakeSupabase) => db as unknown as SupabaseClient;

describe("FeedbackReason", () => {
  it("takes 3 to 300 characters, trimmed", () => {
    expect(FeedbackReason.safeParse("ok!").success).toBe(true);
    expect(FeedbackReason.parse("  too generic  ")).toBe("too generic");
    expect(FeedbackReason.safeParse("x".repeat(300)).success).toBe(true);
  });

  it("refuses a note too short or too long with a sentence the person can read", () => {
    const short = FeedbackReason.safeParse("  no ");
    expect(short.success).toBe(false);
    expect(short.error?.issues[0].message).toBe("Say what is wrong in at least 3 characters.");
    const long = FeedbackReason.safeParse("x".repeat(301));
    expect(long.success).toBe(false);
    expect(long.error?.issues[0].message).toBe("Keep the note under 300 characters.");
    expect(FeedbackReason.safeParse(undefined).success).toBe(false);
  });

  it("counts characters as the database does, so an emoji is one", () => {
    // "😀a" is three UTF-16 units and two characters: char_length would refuse it.
    expect(FeedbackReason.safeParse("😀a").success).toBe(false);
    expect(FeedbackReason.safeParse("😀".repeat(300)).success).toBe(true);
  });
});

describe("recentFeedback", () => {
  const seed = (reasons: string[], business = BUSINESS) =>
    reasons.map((reason, i) => ({
      id: `fb-${business}-${i}`,
      user_id: USER,
      business_id: business,
      target_id: "t-1",
      reason,
      // Newest last in the seed: created later.
      created_at: new Date(Date.UTC(2026, 10, 9, 10, i)).toISOString(),
    }));

  it("returns the newest distinct reasons, deduped whatever their case and spacing", async () => {
    const db = new FakeSupabase({
      draft_feedback: [
        ...seed(["Sounds like AI", "too generic", "Never start with It's", "TOO   generic", "sounds like ai"]),
        ...seed(["another site's note"], "biz-2"),
      ],
    });
    expect(await recentFeedback(client(db), BUSINESS)).toEqual(["sounds like ai", "TOO generic", "Never start with It's"]);
  });

  it("stops at the limit and clamps each reason to 200 characters", async () => {
    const long = `use my numbers ${"and say it plainly ".repeat(20)}`;
    const db = new FakeSupabase({ draft_feedback: seed(["one", "two", "three", long]) });
    const recent = await recentFeedback(client(db), BUSINESS, { limit: 2 });
    expect(recent).toHaveLength(2);
    expect(recent[0].length).toBeLessThanOrEqual(PROMPT_REASON_MAX);
    expect(recent[0].startsWith("use my numbers")).toBe(true);
    expect(recent[1]).toBe("three");
    expect(await recentFeedback(client(db), BUSINESS, { limit: 0 })).toEqual([]);
  });

  it("defaults to ten", async () => {
    const db = new FakeSupabase({ draft_feedback: seed(Array.from({ length: 14 }, (_, i) => `note ${i}`)) });
    const recent = await recentFeedback(client(db), BUSINESS);
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe("note 13");
  });

  it("gives no notes, and does not throw, when the table cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order"]) chain[m] = () => chain;
        chain.limit = async () => ({ data: null, error: { message: 'relation "draft_feedback" does not exist' } });
        return chain;
      },
    } as unknown as SupabaseClient;
    expect(await recentFeedback(failing, BUSINESS)).toEqual([]);
  });

  it("distinctReasons skips empty reasons", () => {
    expect(distinctReasons(["  ", "fine", "Fine "], 5)).toEqual(["fine"]);
  });
});

describe("recordFeedback, listFeedback and correctionsToday", () => {
  it("stores a note and lists it; counts only this user's last 24 hours", async () => {
    const db = new FakeSupabase({
      draft_feedback: [
        { id: "old", user_id: USER, business_id: BUSINESS, target_id: "t-1", reason: "old", created_at: "2026-11-07T09:00:00.000Z" },
        { id: "other", user_id: "user-2", business_id: "biz-2", target_id: "t-9", reason: "theirs", created_at: "2026-11-09T09:00:00.000Z" },
      ],
    });
    const now = new Date("2026-11-09T10:00:00.000Z");
    const stored = await recordFeedback(client(db), {
      userId: USER,
      businessId: BUSINESS,
      targetId: "t-1",
      placementId: "p-1",
      reason: "too generic",
      bodyBefore: "Before.",
      now,
    });
    expect(stored.ok).toBe(true);
    const row = db.tables.draft_feedback.find((r) => r.reason === "too generic");
    expect(row).toMatchObject({ user_id: USER, business_id: BUSINESS, target_id: "t-1", placement_id: "p-1", body_before: "Before." });
    expect(row?.body_after).toBeUndefined();

    expect(await correctionsToday(client(db), USER, now)).toBe(1);

    const listed = await listFeedback(client(db), BUSINESS);
    expect(listed.ok && listed.feedback.map((f) => f.reason)).toEqual(["too generic", "old"]);
    expect(listed.ok && listed.feedback[0]).toMatchObject({ bodyAfter: null, promotedToNotes: false, placementId: "p-1" });
  });
});

describe("appendNote", () => {
  it("adds the reason as the last line, on one line", () => {
    expect(appendNote("Short lines.", "never start\nwith It's")).toEqual({
      ok: true,
      instructions: "Short lines.\nnever start with It's",
      appended: true,
    });
    expect(appendNote("", "too generic")).toEqual({ ok: true, instructions: "too generic", appended: true });
  });

  it("does not add a line the notes already have, whatever its case or bullet", () => {
    expect(appendNote("Short lines.\n- Too generic", "too  generic")).toEqual({
      ok: true,
      instructions: "Short lines.\n- Too generic",
      appended: false,
    });
  });

  it("refuses with a sentence when the notes would go past their limit", () => {
    const full = "x".repeat(INSTRUCTIONS_MAX - 5);
    const result = appendNote(full, "too generic");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`they hold ${INSTRUCTIONS_MAX}`);
  });
});

describe("promoteToNotes", () => {
  const seed = (voice: unknown, over: { business_id?: string; promoted?: boolean } = {}) =>
    new FakeSupabase({
      draft_feedback: [
        {
          id: "fb-1",
          user_id: USER,
          business_id: over.business_id ?? BUSINESS,
          target_id: "t-1",
          placement_id: "p-1",
          reason: "Never start with It's",
          body_before: "It's fine.",
          body_after: "Fine.",
          promoted_to_notes: over.promoted ?? false,
          created_at: "2026-11-09T10:00:00.000Z",
        },
      ],
      businesses: [{ id: BUSINESS, user_id: USER, voice_settings: voice }],
    });

  const promote = (db: FakeSupabase) =>
    promoteToNotes({ supabase: client(db), admin: client(db), userId: USER, businessId: BUSINESS, feedbackId: "fb-1" });

  it("appends the reason to the writer's notes and marks the note promoted", async () => {
    const db = seed({ preset: "casual", aboutYou: "I run a blog.", instructions: "Lowercase, short lines." });
    const result = await promote(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appended).toBe(true);
    expect(result.instructions).toBe("Lowercase, short lines.\nNever start with It's");
    expect(db.tables.businesses[0].voice_settings).toMatchObject({
      preset: "casual",
      aboutYou: "I run a blog.",
      instructions: "Lowercase, short lines.\nNever start with It's",
    });
    expect(db.tables.draft_feedback[0].promoted_to_notes).toBe(true);
    expect(result.feedback.promotedToNotes).toBe(true);
  });

  it("never writes the same line twice", async () => {
    const db = seed({ instructions: "Never start with It's" }, { promoted: true });
    const result = await promote(db);
    expect(result.ok && result.appended).toBe(false);
    expect((db.tables.businesses[0].voice_settings as { instructions: string }).instructions).toBe("Never start with It's");
  });

  it("refuses when the notes are full, and leaves the settings and the flag as they were", async () => {
    const full = "x".repeat(INSTRUCTIONS_MAX - 10);
    const db = seed({ instructions: full });
    const result = await promote(db);
    expect(result).toMatchObject({ ok: false, status: 409 });
    if (!result.ok) expect(result.error).toContain("Your notes are full");
    expect((db.tables.businesses[0].voice_settings as { instructions: string }).instructions).toBe(full);
    expect(db.tables.draft_feedback[0].promoted_to_notes).toBe(false);
  });

  it("refuses rather than overwrite settings it cannot read", async () => {
    const stored = { preset: "shouting", instructions: "keep me" };
    const db = seed(stored);
    const result = await promote(db);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.businesses[0].voice_settings).toEqual(stored);
  });

  it("finds no note of another site", async () => {
    const db = seed({}, { business_id: "biz-2" });
    expect(await promote(db)).toMatchObject({ ok: false, status: 404 });
  });
});
