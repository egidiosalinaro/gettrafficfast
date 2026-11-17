import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { F_A, F_B, F_C, SITE_A, SITE_B, USER, apiCaller, seedWrites } from "./write-seed";
import { customerData } from "./support";

/**
 * Settings → Voice and Settings → Integrations as tools. Pinned: the voice
 * takes a partial change without erasing the rest (and refuses one that
 * would replace an unreadable value with the defaults); a correction note
 * of another site is not found; disconnecting acts on the caller's site
 * only; the Search Console link names the caller's site, and a property can
 * only be picked once Search Console is connected.
 */

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  scConfigured: true,
  kick: vi.fn(),
}));

vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/providers/analytics/search-console", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/analytics/search-console")>()),
  isSearchConsoleConfigured: () => mocks.scConfigured,
}));
vi.mock("@/lib/analytics/runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/runs")>()),
  kickFirstSearchConsoleSync: (...args: unknown[]) => mocks.kick(...args),
}));

import { runTool } from "@/lib/tools/runner";

function seed() {
  const db = seedWrites();
  mocks.db = db;
  return db;
}

const call = (db: FakeSupabase, name: string, input: unknown, scopes?: Array<"read" | "write" | "spend">) =>
  runTool(apiCaller(db, scopes ? { scopes } : {}), name, input);

const site = (db: FakeSupabase, id = SITE_A) => db.tables.businesses.find((b) => b.id === id)!;

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  mocks.scConfigured = true;
  mocks.kick.mockReset();
  mocks.kick.mockResolvedValue({ jobId: "job-1", alreadyRunning: false, lastSyncedOn: null, syncing: true });
  quiet = (["info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("update_voice_settings", () => {
  it("changes the fields given and keeps the owner's notes", async () => {
    const db = seed();
    site(db).voice_settings = { preset: "plain", person: "auto", aboutYou: "I run Acme.", instructions: "Lowercase, short lines." };
    const run = await call(db, "update_voice_settings", { preset: "casual", person: "i" });
    expect(run).toEqual({
      ok: true,
      output: { settings: { preset: "casual", person: "i", aboutYou: "I run Acme.", articleFacts: "", instructions: "Lowercase, short lines.", dailyReplyGoal: null, findPostsOnX: false, confirmedFacts: {} } },
    });
    expect(site(db).voice_settings).toMatchObject({ preset: "casual", instructions: "Lowercase, short lines." });
    expect(site(db, SITE_B).voice_settings).not.toMatchObject({ preset: "casual" });
  });

  it("changes the daily goal alone, or clears it, and keeps every other voice field (the Today sheet's write)", async () => {
    const db = seed();
    const stored = { preset: "casual", person: "i", aboutYou: "I run Acme.", articleFacts: "", instructions: "Lowercase, short lines.", dailyReplyGoal: 5, findPostsOnX: true, confirmedFacts: {} };
    site(db).voice_settings = stored;
    expect(await call(db, "update_voice_settings", { dailyReplyGoal: 6 })).toMatchObject({ ok: true, output: { settings: { ...stored, dailyReplyGoal: 6 } } });
    expect(site(db).voice_settings).toEqual({ ...stored, dailyReplyGoal: 6 });
    expect(await call(db, "update_voice_settings", { dailyReplyGoal: null })).toMatchObject({ ok: true });
    expect(site(db).voice_settings).toEqual({ ...stored, dailyReplyGoal: null });
    expect(await call(db, "update_voice_settings", { dailyReplyGoal: 51 })).toMatchObject({ ok: false, status: 400 });
    expect(site(db).voice_settings).toEqual({ ...stored, dailyReplyGoal: null });
  });

  it("refuses a partial change over settings it cannot read, and accepts a whole one", async () => {
    const db = seed();
    site(db).voice_settings = { preset: "shouty", instructions: "Keep my notes." };
    expect(await call(db, "update_voice_settings", { aboutYou: "I run Acme." })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state" },
    });
    expect(site(db).voice_settings).toEqual({ preset: "shouty", instructions: "Keep my notes." });
    expect(
      await call(db, "update_voice_settings", { preset: "plain", person: "we", aboutYou: "We run Acme.", instructions: "Keep my notes." })
    ).toMatchObject({ ok: true });
  });

  it("round-trips Facts for articles without touching About you, and get_voice_settings reads it back", async () => {
    const db = seed();
    site(db).voice_settings = { preset: "plain", person: "auto", aboutYou: "342 impressions, 0 clicks.", instructions: "" };
    expect(await call(db, "update_voice_settings", { articleFacts: "I build GetTrafficFast." })).toMatchObject({
      ok: true,
      output: { settings: { aboutYou: "342 impressions, 0 clicks.", articleFacts: "I build GetTrafficFast." } },
    });
    expect(site(db).voice_settings).toMatchObject({ aboutYou: "342 impressions, 0 clicks.", articleFacts: "I build GetTrafficFast." });
    expect(await call(db, "get_voice_settings", {})).toMatchObject({
      ok: true,
      output: { settings: { aboutYou: "342 impressions, 0 clicks.", articleFacts: "I build GetTrafficFast." } },
    });
    expect(await call(db, "update_voice_settings", { articleFacts: "x".repeat(2_001) })).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses what the screen refuses, and needs the write scope", async () => {
    const db = seed();
    // 2,000 characters fit (since 12 November 2026); one more is refused.
    expect(await call(db, "update_voice_settings", { aboutYou: "x".repeat(2_001) })).toMatchObject({ ok: false, status: 400 });
    expect(await call(db, "update_voice_settings", { aboutYou: "x".repeat(2_000) })).toMatchObject({ ok: true });
    expect(await call(db, "update_voice_settings", { preset: "casual" }, ["read"])).toMatchObject({ ok: false, status: 403 });
  });
});

describe("promote_feedback_to_notes", () => {
  it("adds the note's reason to site A's notes once, and marks it", async () => {
    const db = seed();
    const run = await call(db, "promote_feedback_to_notes", { feedbackId: F_A });
    expect(run).toMatchObject({
      ok: true,
      output: { appended: true, feedback: { id: F_A, promotedToNotes: true }, instructions: "Too long, keep it to two lines" },
    });
    expect(site(db).voice_settings).toMatchObject({ instructions: "Too long, keep it to two lines" });
    expect(await call(db, "promote_feedback_to_notes", { feedbackId: F_A })).toMatchObject({ ok: true, output: { appended: false } });
  });

  it.each([F_B, F_C])("does not find a note of another site (%s)", async (id) => {
    const db = seed();
    const before = customerData(db);
    expect(await call(db, "promote_feedback_to_notes", { feedbackId: id })).toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
    expect(customerData(db)).toBe(before);
  });
});

describe("disconnect_integration", () => {
  it("deletes site A's destination of that type, credentials and all, and leaves site B's", async () => {
    const db = seed();
    expect(await call(db, "disconnect_integration", { type: "wordpress" })).toEqual({
      ok: true,
      output: { type: "wordpress", disconnected: true },
    });
    expect(db.tables.integrations.map((i) => i.business_id)).toEqual([SITE_B]);
    expect(await call(db, "disconnect_integration", { type: "wordpress" })).toMatchObject({ ok: true, output: { disconnected: false } });
  });

  it("refuses a type that is not a destination a person can disconnect", async () => {
    const db = seed();
    expect(await call(db, "disconnect_integration", { type: "self" })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("Search Console", () => {
  it("get_search_console_connect_url hands back the link for site A, and its state", async () => {
    const db = seed();
    expect(await call(db, "get_search_console_connect_url", {}, ["read"])).toEqual({
      ok: true,
      output: {
        url: `https://gettrafficfa.st/api/integrations/search-console/connect?business=${SITE_A}`,
        connected: true,
        siteUrl: null,
      },
    });
    mocks.scConfigured = false;
    expect(await call(db, "get_search_console_connect_url", {}, ["read"])).toMatchObject({ ok: false, status: 503 });
  });

  it("select_search_console_property picks site A's property and starts its first pull", async () => {
    const db = seed();
    const run = await call(db, "select_search_console_property", { siteUrl: "sc-domain:acme.test" });
    expect(run).toEqual({ ok: true, output: { siteUrl: "sc-domain:acme.test", lastSyncedOn: null, syncing: true } });
    const rows = db.tables.analytics_connections;
    expect(rows.find((r) => r.business_id === SITE_A)).toMatchObject({ site_url: "sc-domain:acme.test", last_synced_on: null });
    expect(rows.find((r) => r.business_id === SITE_B)).toMatchObject({ site_url: "sc-domain:bravo.test" });
    expect(mocks.kick).toHaveBeenCalledWith({ supabase: db, userId: USER, businessId: SITE_A, waitMs: 25_000 });
  });

  it("select_search_console_property says to connect first when there is no grant", async () => {
    const db = seed();
    db.tables.analytics_connections = db.tables.analytics_connections.filter((r) => r.business_id !== SITE_A);
    expect(await call(db, "select_search_console_property", { siteUrl: "sc-domain:acme.test" })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "prerequisite_missing", hint: expect.stringMatching(/get_search_console_connect_url/) },
    });
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("sync_search_console starts site A's first pull, as Growth does, and says why when it skipped", async () => {
    const db = seed();
    expect(await call(db, "sync_search_console", {})).toEqual({
      ok: true,
      output: { skipped: null, lastSyncedOn: null, syncing: true, outcome: null },
    });
    expect(mocks.kick).toHaveBeenCalledWith({ supabase: db, userId: USER, businessId: SITE_A, waitMs: 25_000 });
    mocks.kick.mockResolvedValue({ jobId: null, alreadyRunning: false, skipped: "already_synced", lastSyncedOn: "2026-11-12", syncing: false });
    expect(await call(db, "sync_search_console", {})).toEqual({
      ok: true,
      output: { skipped: "already_synced", lastSyncedOn: "2026-11-12", syncing: false, outcome: null },
    });
    expect(await call(db, "sync_search_console", {}, ["read"])).toMatchObject({ ok: false, status: 403 });
  });

  it("disconnect_search_console deletes site A's grant only", async () => {
    const db = seed();
    expect(await call(db, "disconnect_search_console", {})).toEqual({ ok: true, output: { disconnected: true } });
    expect(db.tables.analytics_connections.map((r) => r.business_id)).toEqual([SITE_B]);
    expect(await call(db, "disconnect_search_console", {})).toEqual({ ok: true, output: { disconnected: false } });
  });
});
