import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, SITE_B, USER, apiCaller } from "./support";
import { readSeed } from "./read-support";

/**
 * The site and account read tools, as an API-key caller on site A with the
 * read scope only: the sites the key may name, the site's settings, the
 * Overview, the checklist, Settings → Voice and the draft notes. Each is the
 * screen's function; site B's rows never show.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));

import { runTool } from "@/lib/tools/runner";
import { ONBOARDING_STEPS } from "@/lib/onboarding";
import { loadHomeSnapshot } from "@/lib/home-snapshot";

let db: FakeSupabase;
beforeEach(() => {
  db = readSeed();
  m.db = db;
});

const caller = () => apiCaller(db, { scopes: ["read"] });
const call = (name: string, input: unknown = {}) => runTool(caller(), name, input);

describe("list_businesses", () => {
  it("lists the sites the key may act on and the one selected", async () => {
    expect(await call("list_businesses")).toMatchObject({
      ok: true,
      output: { businesses: [{ id: SITE_A, name: "Acme", websiteUrl: "https://acme.test" }], selectedId: SITE_A },
    });
    // A key for every site sees both of the account's, never another account's.
    const wide = { ...caller(), businessIds: [SITE_A, SITE_B] };
    const run = await runTool(wide, "list_businesses", {});
    expect(run.ok && (run.output.businesses as Array<{ id: string }>).map((b) => b.id)).toEqual([SITE_A, SITE_B]);
  });
});

describe("get_business", () => {
  it("answers the site's settings with Autopilot and Images & video parsed", async () => {
    const run = await call("get_business");
    expect(run).toMatchObject({
      ok: true,
      output: {
        business: {
          id: SITE_A,
          name: "Acme",
          websiteUrl: "https://acme.test",
          niche: "SEO tools",
          description: "Acme helps small teams rank.",
          blogUrl: "https://acme.test/blog",
          contentLanguage: "en",
          isLocked: true,
          automation: { enabled: true, bufferDays: 7, keywordFloor: 10 },
          // No images switch any more: a stored imagesEnabled is dropped. Videos not stored: on by default.
          media: { styleChosen: true, styleChosenAt: "2026-11-01T09:00:00.000Z", videosEnabled: true },
        },
      },
    });
    expect(JSON.stringify(run)).not.toContain("voice_settings");
    expect(JSON.stringify(run)).not.toContain("imagesEnabled");
  });
});

describe("get_home", () => {
  it("answers the Overview the home route answers, with the next action", async () => {
    const c = caller();
    const run = await runTool(c, "get_home", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const home = await loadHomeSnapshot(c.client, SITE_A);
    if (!home.ok) throw new Error(home.error);
    expect(run.output.loop).toEqual(home.snapshot.loop);
    expect(run.output.business).toEqual({ name: "Acme", websiteUrl: "https://acme.test", niche: "SEO tools" });
    const measure = (run.output.loop as { stages: Array<{ id: string; metric: string }> }).stages.find((s) => s.id === "measure");
    // Per engine, never pooled; under 10 probes a count, not a percent.
    expect(measure?.metric).toBe("Gemini 1 of 2 · Perplexity 0 of 1");
    expect(run.output.unusedKeywords).toEqual([
      expect.objectContaining({ keyword: "enterprise seo" }),
      expect.objectContaining({ keyword: "llm seo checklist" }),
    ]);
  });
});

describe("get_onboarding_status", () => {
  it("answers the checklist in order, with the next step", async () => {
    const run = await call("get_onboarding_status");
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const steps = run.output.steps as Array<{ key: string; done: boolean }>;
    // Connect your X account is a step only where the deployment offers posting on X: not here.
    expect(steps.map((s) => s.key)).toEqual(ONBOARDING_STEPS.map((s) => s.key).filter((key) => key !== "hasXAccount"));
    expect(Object.fromEntries(steps.map((s) => [s.key, s.done]))).toEqual({
      hasBusiness: true,
      hasAboutYou: true,
      hasImageStyle: true,
      hasKeywords: true,
      hasArticles: true,
      hasIntegration: true,
      hasManualPost: true,
    });
    expect(run.output).toMatchObject({ next: null, complete: true });
  });

  it("asks to connect the X account GTF posts from where the deployment offers it, until one is", async () => {
    vi.stubEnv("X_OAUTH_CLIENT_ID", "client-id-for-tests");
    vi.stubEnv("X_OAUTH_CLIENT_SECRET", "client-secret-for-tests");
    try {
      const run = await call("get_onboarding_status");
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      const steps = run.output.steps as Array<{ key: string; done: boolean; href: string }>;
      expect(steps.map((s) => s.key)).toEqual(ONBOARDING_STEPS.map((s) => s.key));
      expect(steps.find((s) => s.key === "hasXAccount")).toMatchObject({ done: false, href: "/api/integrations/x/connect" });
      expect(run.output).toMatchObject({ next: { key: "hasXAccount" }, complete: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("get_voice_settings", () => {
  it("answers the site's voice and the choices", async () => {
    const run = await call("get_voice_settings");
    expect(run).toMatchObject({
      ok: true,
      output: { settings: { preset: "casual", person: "we", aboutYou: "We build Acme.", instructions: "Never say leverage." } },
    });
    const presets = run.ok ? (run.output.presets as Array<Record<string, unknown>>) : [];
    expect(presets.map((p) => p.value)).toContain("plain");
    // The prompt text the drafter is given is not part of the answer.
    expect(presets.every((p) => !("prompt" in p))).toBe(true);
    // Nothing in "We build Acme." is dated: no stale fact, and the threshold is said.
    expect(run).toMatchObject({ ok: true, output: { staleFacts: [], staleAfterDays: 30 } });
  });

  it("lists the facts in About you that are dated more than 30 days ago", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T09:30:00Z") });
    try {
      const site = (db.tables.businesses as Array<Record<string, unknown>>).find((row) => row.id === SITE_A);
      const aboutYou = "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Left Porto on Oct 27 2026.";
      Object.assign(site ?? {}, { voice_settings: { aboutYou } });
      const run = await call("get_voice_settings");
      expect(run).toMatchObject({
        ok: true,
        output: {
          // The owner's text is answered as stored: nothing rewrites it.
          settings: { aboutYou },
          staleAfterDays: 30,
          staleFacts: [
            {
              sentence: "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026.",
              date: "2026-10-01",
              dateLabel: "October 2026",
              precision: "month",
              yearAssumed: false,
              confirmedOn: null,
              ageDays: 40,
              age: "last month",
              line: "Dated October 2026 (last month): still true?",
            },
          ],
        },
      });
      expect(run.ok && (run.output.staleFacts as unknown[]).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("list_draft_feedback", () => {
  it("lists the site's notes newest first, a note not rewritten with bodyAfter null", async () => {
    const run = await call("list_draft_feedback");
    expect(run.ok && run.output.feedback).toEqual([
      expect.objectContaining({ reason: "sounds like AI", bodyAfter: null, promotedToNotes: false }),
      expect.objectContaining({ reason: "too long", bodyAfter: "Short.", promotedToNotes: true }),
    ]);
    expect(caller().userId).toBe(USER);
  });
});
