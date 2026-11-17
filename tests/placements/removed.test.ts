import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ManualActionBody } from "@/lib/placements/actions";
import { countMissingLinks } from "@/lib/placements/read";
import { missingPublishedLink } from "@/lib/placements/published-url";
import {
  REMOVED_REASON_MAX,
  REMOVED_REASON_PRESETS,
  isRemoved,
  removalBySurface,
  removalSummary,
  withRemoval,
} from "@/lib/placements/removed";
import { MANUAL_ACTIONS, TARGET_STATUSES, planManualAction, transition } from "@/lib/placements/workflow";

/**
 * A posted reply the site removed or hid (2026-11-10: Reddit hid every
 * comment of the owner's new account). What is pinned: only a posted row can
 * be marked, once, with a reason of at most 300 characters; the row stays
 * posted; the Undo only on a removed row; a removed reply leaves the
 * "missing their link" count; per surface it is posted and removed, and a
 * surface with nothing posted has no rate, never 0; the migration only adds.
 */

const NOW = new Date("2026-11-10T12:00:00.000Z");
const reddit = { surface: "reddit", url: "https://www.reddit.com/r/seo/comments/abc/title/" };

describe("planManualAction: It was removed", () => {
  it("is accepted by the action route's body and listed among the manual actions", () => {
    expect(MANUAL_ACTIONS).toEqual(expect.arrayContaining(["mark_removed", "unmark_removed"]));
    expect(ManualActionBody.safeParse({ action: "mark_removed", reason: "I deleted it" }).success).toBe(true);
    expect(ManualActionBody.safeParse({ action: "unmark_removed" }).success).toBe(true);
    expect(ManualActionBody.safeParse({ action: "mark_removed", reason: "x".repeat(REMOVED_REASON_MAX + 1) }).success).toBe(false);
  });

  it("marks a posted row, keeps it posted, and stores the moment and the reason", () => {
    const plan = planManualAction(
      { status: "published_manually", ...reddit, removedAt: null },
      { action: "mark_removed", reason: "  Hidden because my account is new " },
      NOW
    );
    expect(plan).toEqual({
      ok: true,
      status: "published_manually",
      patch: {
        status: "published_manually",
        updated_at: NOW.toISOString(),
        removed_at: NOW.toISOString(),
        removed_reason: "Hidden because my account is new",
      },
    });
    // No reason is a reason of null, not an empty string; the link and the text are left alone.
    const bare = planManualAction({ status: "published_manually", ...reddit }, { action: "mark_removed" }, NOW);
    expect(bare.ok && bare.patch).toEqual({
      status: "published_manually",
      updated_at: NOW.toISOString(),
      removed_at: NOW.toISOString(),
      removed_reason: null,
    });
  });

  it("refuses every row that was not posted", () => {
    for (const status of TARGET_STATUSES.filter((s) => s !== "published_manually")) {
      expect(transition(status, "mark_removed")).toBeNull();
      expect(planManualAction({ status, ...reddit }, { action: "mark_removed" }, NOW)).toEqual({
        ok: false,
        httpStatus: 409,
        error: "Only a reply you marked as posted can be marked as removed.",
      });
    }
  });

  it("refuses a second removal and a reason over 300 characters", () => {
    expect(
      planManualAction({ status: "published_manually", ...reddit, removedAt: "2026-11-10T09:00:00Z" }, { action: "mark_removed" }, NOW)
    ).toMatchObject({ ok: false, httpStatus: 409 });
    expect(
      planManualAction(
        { status: "published_manually", ...reddit },
        { action: "mark_removed", reason: "x".repeat(REMOVED_REASON_MAX + 1) },
        NOW
      )
    ).toMatchObject({ ok: false, httpStatus: 400 });
    expect(
      planManualAction({ status: "published_manually", ...reddit }, { action: "mark_removed", reason: "x".repeat(REMOVED_REASON_MAX) }, NOW).ok
    ).toBe(true);
  });

  it("undoes only a removed row, clearing both columns", () => {
    expect(
      planManualAction({ status: "published_manually", ...reddit, removedAt: "2026-11-10T09:00:00Z" }, { action: "unmark_removed" }, NOW)
    ).toEqual({
      ok: true,
      status: "published_manually",
      patch: { status: "published_manually", updated_at: NOW.toISOString(), removed_at: null, removed_reason: null },
    });
    expect(planManualAction({ status: "published_manually", ...reddit, removedAt: null }, { action: "unmark_removed" }, NOW)).toEqual({
      ok: false,
      httpStatus: 409,
      error: "This reply is not marked as removed.",
    });
    expect(planManualAction({ status: "drafted", ...reddit }, { action: "unmark_removed" }, NOW)).toMatchObject({ ok: false, httpStatus: 409 });
  });

  it("offers the three presets the card shows, each within the limit", () => {
    expect(REMOVED_REASON_PRESETS).toEqual([
      "Removed by a moderator or the site",
      "Hidden because my account is new",
      "I deleted it",
    ]);
    for (const preset of REMOVED_REASON_PRESETS) expect(preset.length).toBeLessThanOrEqual(REMOVED_REASON_MAX);
  });
});

describe("the missing-link reminder", () => {
  it("never asks a removed reply for its link", () => {
    expect(missingPublishedLink({ status: "published_manually", publishedUrl: null })).toBe(true);
    expect(missingPublishedLink({ status: "published_manually", publishedUrl: null, removedAt: "2026-11-10T09:00:00Z" })).toBe(false);
  });

  it("leaves removed replies out of the count", () => {
    const rows = [
      { status: "published_manually", published_url: null },
      { status: "published_manually", published_url: null, removed_at: "2026-11-10T09:00:00Z" },
      { status: "published_manually", published_url: null, removed_at: null },
      { status: "published_manually", published_url: "https://www.reddit.com/r/seo/comments/abc/title/def/" },
      { status: "drafted", published_url: null },
    ];
    expect(countMissingLinks(rows)).toBe(2);
  });
});

describe("removals per surface", () => {
  const rows = [
    { id: "r1", surface: "reddit", status: "published_manually" },
    { id: "r2", surface: "reddit", status: "published_manually" },
    { id: "x1", surface: "x", status: "published_manually" },
    { id: "h1", surface: "hackernews", status: "qualified" },
  ];
  const removals = new Map([["r1", { removedAt: "2026-11-10T09:00:00Z", removedReason: "Hidden because my account is new" }]]);

  it("counts posted and removed per surface, with no rate where nothing was posted", () => {
    const merged = rows.map((row) => withRemoval(row, removals));
    expect(removalBySurface(merged)).toEqual({
      reddit: { posted: 2, removed: 1, removalRate: 0.5 },
      x: { posted: 1, removed: 0, removalRate: 0 },
      hackernews: { posted: 0, removed: 0, removalRate: null },
    });
  });

  it("merges a removal onto its row, and leaves the row untouched when nothing could be read", () => {
    expect(withRemoval(rows[0], removals)).toMatchObject({ removed_at: "2026-11-10T09:00:00Z", removed_reason: "Hidden because my account is new" });
    expect(withRemoval(rows[1], removals)).toMatchObject({ removed_at: null, removed_reason: null });
    expect(withRemoval(rows[0], null)).not.toHaveProperty("removed_at");
    expect(isRemoved({ removedAt: "2026-11-10T09:00:00Z" })).toBe(true);
    expect(isRemoved({ removedAt: null })).toBe(false);
    expect(isRemoved({})).toBe(false);
  });

  it("says it in one line under Posted only when something was removed", () => {
    const label = (surface: string) => ({ reddit: "Reddit", x: "X" })[surface] ?? surface;
    const by = removalBySurface(rows.map((row) => withRemoval(row, removals)));
    expect(removalSummary(by, label, ["x", "reddit", "hackernews"])).toBe("Posted replies marked as removed: X 0 of 1, Reddit 1 of 2.");
    expect(removalSummary(removalBySurface(rows.map((row) => withRemoval(row, new Map()))), label)).toBeNull();
    expect(removalSummary(undefined, label)).toBeNull();
  });
});

describe("20261110220000_placement_removed_replies.sql", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sql = readFileSync(path.join(root, "supabase/migrations/20261110220000_placement_removed_replies.sql"), "utf8");
  const code = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("adds the two nullable columns and nothing else", () => {
    expect(code).toContain("alter table public.placement_targets");
    expect(code).toContain("add column if not exists removed_at timestamptz,");
    expect(code).toContain(
      "add column if not exists removed_reason text check (removed_reason is null or char_length(removed_reason) <= 300);"
    );
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/not null/i);
    expect(code).not.toContain("status_check");
  });
});
