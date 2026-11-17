import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";
import { OTHER, SITE_A, SITE_B, SITE_C, USER, apiCaller, businesses, customerData, uuid } from "./support";

/**
 * "It's true: add to About you" as tools (docs/API.md, 2026-11-12):
 * `add_about_you_fact` and its undo, `remove_about_you_fact`. Pinned: the
 * fact goes at the end of About you and the rest stays; with a draft, the
 * same text is judged again and the fact check flips; a draft of another
 * site or account is not found and nothing is written; a fact that would
 * not fit is refused with the sentence; the undo takes out exactly the
 * sentence, and refuses when About you changed since.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

import { runTool } from "@/lib/tools/runner";

const ABOUT = "I run Acme's content and use it every day.";
const T_A = uuid("a", 1);
const T_B = uuid("b", 1);
const T_C = uuid("c", 1);
const D_A = uuid("d", 1);
const D_B = uuid("d", 2);
const D_C = uuid("d", 3);

const BODY =
  "ChatGPT cites pages that answer the question in the first sentence. 40% of my signups come from ChatGPT citations now. Put the direct answer first, then the detail.";
const FACT = "As of November 12, 2026: 40% of my signups come from ChatGPT citations now.";

function target(id: string, userId: string, businessId: string) {
  return {
    id,
    user_id: userId,
    business_id: businessId,
    surface: "x",
    kind: "post",
    url: "https://x.com/janedoe/status/1855000000000000000",
    title: "How do you get cited by ChatGPT?",
    excerpt: "Our SEO is fine but ChatGPT never mentions us.",
    status: "needs_review",
    qualify_angle: null,
    created_at: "2026-11-09T09:00:00.000Z",
  };
}

function draft(id: string, targetId: string, userId: string, businessId: string) {
  return {
    id,
    target_id: targetId,
    user_id: userId,
    business_id: businessId,
    variant: "short_comment",
    body: BODY,
    link_url: null,
    claims: [],
    audit: { status: "blocked", checks: [{ id: "verifiable_claims", label: "x", status: "fail", detail: "1 sentence(s) with numbers not declared as claims." }] },
    audit_status: "blocked",
    agent_version: 16,
    created_at: "2026-11-09T09:01:00.000Z",
    updated_at: "2026-11-09T09:01:00.000Z",
  };
}

function seed(aboutYou = ABOUT) {
  const db = new FakeSupabase({
    businesses: businesses({ aboutYou }),
    placement_targets: [target(T_A, USER, SITE_A), target(T_B, USER, SITE_B), target(T_C, OTHER, SITE_C)],
    placements: [draft(D_A, T_A, USER, SITE_A), draft(D_B, T_B, USER, SITE_B), draft(D_C, T_C, OTHER, SITE_C)],
    keywords: [],
    entities: [],
  });
  mocks.db = db;
  return db;
}

const call = (db: FakeSupabase, name: string, input: unknown, scopes?: Array<"read" | "write" | "spend">) =>
  runTool(apiCaller(db, scopes ? { scopes } : {}), name, input);

const voice = (db: FakeSupabase, id = SITE_A) =>
  db.tables.businesses.find((b) => b.id === id)!.voice_settings as { aboutYou: string; confirmedFacts?: Record<string, string> };
const placement = (db: FakeSupabase, id: string) => db.tables.placements.find((p) => p.id === id)!;
const claimsCheck = (audit: unknown) => (audit as { checks: Array<{ id: string; status: string }> }).checks.find((c) => c.id === "verifiable_claims");

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  quiet = (["info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("add_about_you_fact", () => {
  it("appends the fact after About you, keeps the rest, and touches no other site", async () => {
    const db = seed();
    const siteB = JSON.stringify(voice(db, SITE_B));
    const run = await call(db, "add_about_you_fact", { fact: FACT });
    expect(run).toEqual({ ok: true, output: { aboutYou: `${ABOUT} ${FACT}`, fact: FACT, added: true } });
    expect(voice(db).aboutYou).toBe(`${ABOUT} ${FACT}`);
    expect(JSON.stringify(voice(db, SITE_B))).toBe(siteB);
    // Twice is once.
    expect(await call(db, "add_about_you_fact", { fact: FACT })).toMatchObject({ ok: true, output: { added: false } });
    expect(voice(db).aboutYou).toBe(`${ABOUT} ${FACT}`);
  });

  it("with a draft, judges the same text again: the fact check now passes", async () => {
    const db = seed();
    // As the gate judges it today, before the fact.
    expect(await call(db, "edit_reply_draft", { draftId: D_A, body: BODY })).toMatchObject({ ok: true });
    expect(claimsCheck(placement(db, D_A).audit)?.status).toBe("fail");

    const run = await call(db, "add_about_you_fact", { fact: FACT, draftId: D_A });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const output = run.output as { draft: { body: string; audit: unknown } };
    expect(output.draft.body).toBe(BODY);
    expect(claimsCheck(output.draft.audit)?.status).toBe("pass");
    expect(placement(db, D_A).body).toBe(BODY);
    expect(claimsCheck(placement(db, D_A).audit)?.status).toBe("pass");
  });

  it.each([D_B, D_C])("does not find a draft of another site or account (%s), and adds nothing", async (draftId) => {
    const db = seed();
    const before = customerData(db);
    expect(await call(db, "add_about_you_fact", { fact: FACT, draftId })).toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
    expect(customerData(db)).toBe(before);
  });

  it("refuses a fact that would overfill About you, with the sentence, and writes nothing", async () => {
    const full = `${"x".repeat(1_980)}.`;
    const db = seed(full);
    const run = await call(db, "add_about_you_fact", { fact: FACT });
    expect(run).toMatchObject({ ok: false, status: 409, error: { code: "invalid_state" } });
    if (run.ok) return;
    expect(run.error.message).toMatch(/^About you is full; edit it in Settings → Voice\./);
    expect(voice(db).aboutYou).toBe(full);
  });

  it("refuses a fact over 300 characters, and needs the write scope", async () => {
    const db = seed();
    expect(await call(db, "add_about_you_fact", { fact: "y".repeat(301) })).toMatchObject({ ok: false, status: 400 });
    expect(await call(db, "add_about_you_fact", { fact: FACT }, ["read"])).toMatchObject({ ok: false, status: 403 });
    expect(voice(db).aboutYou).toBe(ABOUT);
  });
});

describe("confirm_about_you_fact (Still true, 2026-11-14)", () => {
  const STALE = "Co-founded Postwren: 12 paying stores in October 2026.";

  const KEY = "co-founded postwren: 12 paying stores in october 2026";
  const DAY = /^\d{4}-\d{2}-\d{2}$/;

  it("records the day in confirmedFacts, leaves About you exactly as written, and touches no other site", async () => {
    const db = seed(`${ABOUT} ${STALE}`);
    const siteB = JSON.stringify(voice(db, SITE_B));
    const run = await call(db, "confirm_about_you_fact", { sentence: STALE });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const output = run.output as { fact: string; confirmedOn: string; previousConfirmedOn: string | null; changed: boolean };
    expect(output).toEqual({ fact: STALE, confirmedOn: expect.stringMatching(DAY), previousConfirmedOn: null, changed: true });
    expect(voice(db).aboutYou).toBe(`${ABOUT} ${STALE}`);
    expect(voice(db).confirmedFacts).toEqual({ [KEY]: output.confirmedOn });
    expect(JSON.stringify(voice(db, SITE_B))).toBe(siteB);
    // get_voice_settings no longer lists it as stale.
    const read = await call(db, "get_voice_settings", {});
    expect(read).toMatchObject({ ok: true, output: { staleFacts: [] } });
  });

  it("is undone by the same tool: the entry goes back as it was", async () => {
    const db = seed(`${ABOUT} ${STALE}`);
    const run = await call(db, "confirm_about_you_fact", { sentence: STALE });
    if (!run.ok) throw new Error("not confirmed");
    const { previousConfirmedOn } = run.output as { previousConfirmedOn: string | null };
    const undone = await call(db, "confirm_about_you_fact", { sentence: STALE, undo: { previousConfirmedOn } });
    expect(undone).toMatchObject({ ok: true, output: { fact: STALE, confirmedOn: null, changed: true } });
    expect(voice(db).confirmedFacts).toEqual({});
    expect(voice(db).aboutYou).toBe(`${ABOUT} ${STALE}`);
  });

  it("an edit or a removal of the sentence drops its confirmation", async () => {
    const db = seed(`${ABOUT} ${STALE}`);
    expect(await call(db, "confirm_about_you_fact", { sentence: STALE })).toMatchObject({ ok: true });
    expect(await call(db, "update_voice_settings", { aboutYou: `${ABOUT} Co-founded Postwren: 14 paying stores in October 2026.` })).toMatchObject({
      ok: true,
    });
    expect(voice(db).confirmedFacts).toEqual({});

    const added = await call(db, "add_about_you_fact", { fact: FACT });
    if (!added.ok) throw new Error("not added");
    const { fact } = added.output as { fact: string };
    expect(await call(db, "confirm_about_you_fact", { sentence: fact })).toMatchObject({ ok: true });
    expect(Object.keys(voice(db).confirmedFacts ?? {})).toHaveLength(1);
    expect(await call(db, "remove_about_you_fact", { fact })).toMatchObject({ ok: true, output: { removed: true } });
    expect(voice(db).confirmedFacts).toEqual({});
  });

  it("refuses a sentence that is not in About you, writes nothing, and needs the write scope", async () => {
    const db = seed(`${ABOUT} ${STALE}`);
    const before = customerData(db);
    expect(await call(db, "confirm_about_you_fact", { sentence: "Never written." })).toMatchObject({ ok: false, status: 409, error: { code: "invalid_state" } });
    expect(await call(db, "confirm_about_you_fact", { sentence: STALE }, ["read"])).toMatchObject({ ok: false, status: 403 });
    expect(customerData(db)).toBe(before);
  });
});

describe("remove_about_you_fact", () => {
  it("undoes the add exactly", async () => {
    const db = seed();
    const added = await call(db, "add_about_you_fact", { fact: FACT });
    if (!added.ok) throw new Error("not added");
    const aboutYou = (added.output as { aboutYou: string }).aboutYou;
    expect(await call(db, "remove_about_you_fact", { fact: FACT, ifAboutYouIs: aboutYou })).toEqual({
      ok: true,
      output: { aboutYou: ABOUT, removed: true },
    });
    expect(voice(db).aboutYou).toBe(ABOUT);
    expect(await call(db, "remove_about_you_fact", { fact: FACT })).toEqual({ ok: true, output: { aboutYou: ABOUT, removed: false } });
  });

  it("refuses when About you has changed since the add", async () => {
    const db = seed();
    const added = await call(db, "add_about_you_fact", { fact: FACT });
    if (!added.ok) throw new Error("not added");
    const aboutYou = (added.output as { aboutYou: string }).aboutYou;
    (db.tables.businesses.find((b) => b.id === SITE_A)!.voice_settings as { aboutYou: string }).aboutYou = `${aboutYou} Edited.`;
    expect(await call(db, "remove_about_you_fact", { fact: FACT, ifAboutYouIs: aboutYou })).toMatchObject({ ok: false, status: 409 });
    expect(voice(db).aboutYou).toBe(`${aboutYou} Edited.`);
  });
});
