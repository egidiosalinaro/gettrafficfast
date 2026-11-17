import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LlmError, type LLMProvider, type LlmOptions, type LlmStructuredResult, type LlmTextResult } from "@/lib/providers/llm/types";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import { LLM_CREDITS_RAN_OUT_MESSAGE } from "@/lib/llm-billing";
import { auditDraft } from "@/lib/placements/audit";
import { draftAuditContext } from "@/lib/placements/own-reply";
import { CORRECTION_BUDGET_USD, CORRECTION_FAILED_MESSAGE, correctDraft } from "@/lib/placements/correct";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * "Fix with a note", below the route. What is pinned: the note is stored
 * before anything is paid, with the text it was about; ONE model call, on a
 * $0.05 budget with little thinking, recorded in agent_runs; the gate runs
 * on what came back, with the same context as an edit, and the result is
 * saved as the draft's body and audit; a draft of another site is never
 * read, written or paid for; a billing refusal is recorded and told in one
 * sentence; and a failed rewrite leaves the draft as it was and the note
 * kept.
 */

const billing = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/llm-billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm-billing")>()),
  recordLlmBillingRefusal: billing.record,
}));

const USER = "user-1";
const BUSINESS = "biz-1";
const TARGET = "target-1";
const DRAFT = "draft-1";
const NOW = new Date("2026-11-09T10:00:00.000Z");

const PASSING =
  "ChatGPT never mentions a site whose SEO is fine but whose pages bury the answer: to get cited, put the direct answer first.";

const seed = (over: { status?: string; aboutYou?: string; draftBusiness?: string } = {}) =>
  new FakeSupabase({
    placement_targets: [
      {
        id: TARGET,
        user_id: USER,
        business_id: BUSINESS,
        surface: "x",
        kind: "post",
        title: "How do you get cited by ChatGPT?",
        excerpt: "Our SEO is fine but ChatGPT never mentions us.",
        status: over.status ?? "needs_review",
        qualify_angle: null,
      },
    ],
    placements: [
      {
        id: DRAFT,
        user_id: USER,
        business_id: over.draftBusiness ?? BUSINESS,
        target_id: TARGET,
        variant: "short_comment",
        body: "It's easy to get caught up in SEO. Consider answer engines.",
        link_url: null,
        claims: [],
        audit: { status: "blocked", checks: [] },
        audit_status: "blocked",
        agent_version: 16,
        updated_at: "2026-11-09T09:00:00.000Z",
      },
    ],
    businesses: [
      {
        id: BUSINESS,
        user_id: USER,
        name: "Acme",
        website_url: "https://acme.test",
        aeo_settings: {},
        voice_settings: { aboutYou: over.aboutYou ?? "I run Acme's content.", instructions: "Short lines." },
        content_language: "en",
      },
    ],
    keywords: [{ business_id: BUSINESS, keyword: "ai seo" }],
    entities: [],
    draft_feedback: [],
  });

interface Call {
  prompt: string;
  options?: LlmOptions;
}

function provider(calls: Call[], answer: { body: string; claims?: unknown[]; reading?: unknown } | Error, costUsd = 0.003): LLMProvider {
  return {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      throw new Error("not used");
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>, options?: LlmOptions): Promise<LlmStructuredResult<T>> {
      calls.push({ prompt, options });
      if (answer instanceof Error) throw answer;
      return {
        value: schema.parse({ claims: [], ...answer }),
        usage: { model: "stub", inputTokens: 500, outputTokens: 60, costUsd },
        raw: "",
      };
    },
  };
}

describe("correctDraft", () => {
  let db: FakeSupabase;
  let calls: Call[];
  let adminTables: string[];

  const run = (reason = "too generic, answer the question", body?: string) =>
    correctDraft({
      supabase: db as unknown as SupabaseClient,
      admin: {
        from: (table: string) => {
          adminTables.push(table);
          return db.from(table);
        },
      } as unknown as SupabaseClient,
      userId: USER,
      businessId: BUSINESS,
      draftId: DRAFT,
      reason,
      body,
      now: NOW,
    });

  beforeEach(() => {
    calls = [];
    adminTables = [];
    billing.record.mockReset();
    billing.record.mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => setLlmProvider(null));

  it("stores the note, makes one call on a $0.05 budget with little thinking, and records the run", async () => {
    db = seed();
    setLlmProvider(provider(calls, { body: PASSING }));
    const result = await run();
    expect(result.ok).toBe(true);

    expect(CORRECTION_BUDGET_USD).toBe(0.05);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ tier: "quality", thinking: "low" });
    expect(calls[0].prompt).toContain("too generic, answer the question");
    expect(calls[0].prompt).toContain("It's easy to get caught up in SEO.");
    expect(calls[0].prompt).toContain("I run Acme's content.");
    expect(calls[0].prompt).toContain("Short lines.");

    const [note] = db.tables.draft_feedback;
    expect(note).toMatchObject({
      user_id: USER,
      business_id: BUSINESS,
      target_id: TARGET,
      placement_id: DRAFT,
      reason: "too generic, answer the question",
      body_before: "It's easy to get caught up in SEO. Consider answer engines.",
      body_after: PASSING,
    });
    expect(result.ok && result.feedbackId).toBe(note.id);

    const [agentRun] = db.tables.agent_runs;
    expect(agentRun).toMatchObject({ agent: "draft-correct", status: "completed", user_id: USER, business_id: BUSINESS });
    // The run is recorded by the service role; so is the rewrite on the note.
    expect(adminTables).toEqual(["agent_runs", "draft_feedback"]);
  });

  it("runs the gate on the rewrite and saves it as the draft's body and audit", async () => {
    db = seed();
    setLlmProvider(provider(calls, { body: PASSING, claims: [{ text: "put the direct answer first", basis: "general_knowledge" }] }));
    const result = await run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const target = db.tables.placement_targets[0];
    const expected = auditDraft(
      { variant: "short_comment", body: PASSING, linkUrl: null, claims: [{ text: "put the direct answer first", basis: "general_knowledge" }] },
      // The gate is told the note: a rewrite is also judged against it.
      {
        ...draftAuditContext({ target, business: db.tables.businesses[0], keywords: db.tables.keywords, entities: [] }, NOW),
        correction: "too generic, answer the question",
        // The recent replies, this post's own drafts aside: none here.
        recentFacts: { replies: 0, facts: [] },
      }
    );
    expect(expected.checks.find((check) => check.id === "follows_your_correction")?.status).toBe("pass");
    const row = db.tables.placements[0];
    expect(row).toMatchObject({ body: PASSING, link_url: null, audit_status: expected.status, updated_at: NOW.toISOString() });
    expect(row.audit).toEqual(expected);
    expect(result.audit).toEqual(expected);
    expect(result.draft).toMatchObject({ id: DRAFT, body: PASSING, auditStatus: expected.status });
    // A post waiting for review moves on once its draft is no longer blocked.
    expect(expected.status).not.toBe("blocked");
    expect(result.targetStatus).toBe("drafted");
    expect(target.status).toBe("drafted");
  });

  /**
   * 10 November 2026, in production: @DanaShips's jab at the CEOs who
   * call him a scammer, a draft that read it as a complaint, the owner's
   * note in Italian, and the rewrite that answered the note. All three word
   * for word.
   */
  const DANIEL_POST =
    "Every time one of my LinkedIn posts gets traction, some 50+ year old CEO turns up to call me a scammer. For sharing my own revenue. Is this the price of posting???";
  const OWNER_NOTE = "Quello non è uno struggle of getting traction è un post ironico sta prendendo in giro i ceo boomer over 50";
  const BAD_REWRITE =
    "that's exactly how i interpret these posts too, daniel. it seems like a common way to poke fun at the struggle of getting traction, especially when sharing numbers. i'm still trying to get my blog articles past position 30-40, so i know the grind.";
  const GOOD_REWRITE =
    "the 50+ ceo calling you a scammer for sharing real numbers is basically a rite of passage on linkedin. did he at least ask for a connection after?";
  const danielSeed = () => {
    const seeded = seed({ aboutYou: "An AI pipeline writes and publishes my own blog: articles sit around position 30-40." });
    Object.assign(seeded.tables.placement_targets[0], { title: DANIEL_POST.slice(0, 80), excerpt: DANIEL_POST });
    Object.assign(seeded.tables.placements[0], {
      body: "it's frustrating when that happens, especially after putting your own numbers out there.",
      audit: { status: "passed", checks: [], reading: { tone: "sincere", means: "He is frustrated at being called a scammer." } },
    });
    return seeded;
  };

  it("refuses the rewrite of 10 November: it answers the note and keeps what the note ruled out", async () => {
    db = danielSeed();
    setLlmProvider(provider(calls, { body: BAD_REWRITE }));
    const result = await run(OWNER_NOTE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The rewrite was shown how the draft had read the post, as the reading the note may overrule.
    expect(calls[0].prompt).toContain("How the post was read when that draft was written (sincere: He is frustrated at being called a scammer.)");
    expect(calls[0].prompt).toContain(`written to you, the writer, not to the poster. It may be in any language.`);
    const check = result.audit.checks.find((c) => c.id === "follows_your_correction");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain('you said it is not "struggle of getting traction"');
    expect(check?.detail).toContain("Answers your correction as if the poster had written it");
    // Saved with its refusal, as any rewrite the gate refuses is, so the card says why.
    expect(result.audit.status).toBe("blocked");
    expect(db.tables.placements[0]).toMatchObject({ body: BAD_REWRITE, audit_status: "blocked" });
    // The model gave no new reading, so the stored one stays.
    expect((db.tables.placements[0].audit as { reading?: unknown }).reading).toEqual({ tone: "sincere", means: "He is frustrated at being called a scammer." });
  });

  it("passes a rewrite that plays along with the joke, and the note's reading replaces the stored one", async () => {
    db = danielSeed();
    setLlmProvider(provider(calls, { body: GOOD_REWRITE, reading: { tone: "ironic", means: "He is making fun of the CEOs who call him a scammer." } }));
    const result = await run(OWNER_NOTE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.audit.checks.find((c) => c.id === "follows_your_correction")?.status).toBe("pass");
    expect(result.audit.status).toBe("passed");
    expect(result.audit.reading).toEqual({ tone: "ironic", means: "He is making fun of the CEOs who call him a scammer." });
    expect((db.tables.placements[0].audit as { reading?: unknown }).reading).toEqual({
      tone: "ironic",
      means: "He is making fun of the CEOs who call him a scammer.",
    });
    expect(calls).toHaveLength(1);
  });

  it("saves a rewrite the gate refuses with the refusal, for the person to see", async () => {
    db = seed({ status: "drafted" });
    setLlmProvider(provider(calls, { body: "Check out Acme at https://acme.test, the best tool for this!" }));
    const result = await run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.audit.status).toBe("blocked");
    expect(db.tables.placements[0].audit_status).toBe("blocked");
    expect(result.targetStatus).toBe("needs_review");
  });

  it("rewrites the text the person edited, when they send it", async () => {
    db = seed();
    setLlmProvider(provider(calls, { body: PASSING }));
    await run("never start with It's", "It's my edited version, with ChatGPT in it.");
    expect(calls[0].prompt).toContain("It's my edited version, with ChatGPT in it.");
    expect(db.tables.draft_feedback[0].body_before).toBe("It's my edited version, with ChatGPT in it.");
  });

  it("never reads, writes or pays for a draft of another site", async () => {
    db = seed({ draftBusiness: "biz-2" });
    setLlmProvider(provider(calls, { body: PASSING }));
    const result = await run();
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(calls).toHaveLength(0);
    expect(db.tables.draft_feedback).toHaveLength(0);
    expect(db.tables.placements[0].body).toBe("It's easy to get caught up in SEO. Consider answer engines.");
  });

  it("does not rewrite a reply already posted, nor write with nothing recorded about the writer", async () => {
    db = seed({ status: "published_manually" });
    setLlmProvider(provider(calls, { body: PASSING }));
    expect(await run()).toMatchObject({ ok: false, status: 409 });

    db = seed({ aboutYou: "" });
    const result = await run();
    expect(result).toMatchObject({ ok: false, status: 409, settingsHref: "/settings/voice" });
    expect(calls).toHaveLength(0);
    expect(db.tables.draft_feedback).toHaveLength(0);
  });

  it("records a billing refusal and answers 503 with its sentence; the draft is unchanged, the note kept", async () => {
    db = seed();
    const refused = new LlmError("Gemini credits are depleted.", "gemini", undefined, {
      retryable: false,
      report: false,
      billingRefused: ["gemini"],
    });
    setLlmProvider(provider(calls, refused));
    const result = await run();
    expect(result).toMatchObject({ ok: false, status: 503, error: LLM_CREDITS_RAN_OUT_MESSAGE });
    expect(billing.record).toHaveBeenCalledTimes(1);
    expect(billing.record).toHaveBeenCalledWith(expect.anything(), refused, { source: "api.placements.drafts.correct" });
    expect(db.tables.placements[0].body).toBe("It's easy to get caught up in SEO. Consider answer engines.");
    expect(db.tables.draft_feedback).toHaveLength(1);
    expect(db.tables.draft_feedback[0].body_after).toBeUndefined();
    expect(result.ok === false && result.feedbackId).toBe(db.tables.draft_feedback[0].id);
  });

  it("refuses a call that went over its budget, and saves nothing from it", async () => {
    db = seed();
    setLlmProvider(provider(calls, { body: PASSING }, 0.06));
    const result = await run();
    expect(result).toMatchObject({ ok: false, status: 500, error: CORRECTION_FAILED_MESSAGE });
    expect(calls).toHaveLength(1);
    expect(billing.record).not.toHaveBeenCalled();
    expect(db.tables.placements[0].body).toBe("It's easy to get caught up in SEO. Consider answer engines.");
    expect(db.tables.draft_feedback[0].body_after).toBeUndefined();
  });
});
