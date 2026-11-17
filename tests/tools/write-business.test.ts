import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "@/lib/providers/llm/types";
import { LLM_CREDITS_RAN_OUT_MESSAGE } from "@/lib/llm-billing";
import type { FakeSupabase } from "../support/fake-supabase";
import { KEY_ALL_SITES, SITE_A, SITE_B, USER, apiCaller, seedWrites } from "./write-seed";

/**
 * The site's own settings as tools. Pinned: a site is created and updated
 * through the save route's own function; a locked address is refused with
 * the reason rather than ignored; a key limited to one site cannot add
 * another; analyze_website is paid and saves nothing; and turning autopilot
 * or images on needs the extra scopes and confirm: true, with nothing written
 * until both are there. A partial change keeps the rest of what is stored.
 */

const mocks = vi.hoisted(() => ({
  subscribed: true,
  db: null as unknown,
  analyze: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => mocks.subscribed }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/research/website", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/research/website")>()),
  analyzeWebsite: (...args: unknown[]) => mocks.analyze(...args),
}));
vi.mock("@/lib/llm-billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm-billing")>()),
  recordLlmBillingRefusal: (...args: unknown[]) => mocks.record(...args),
}));

import { runTool } from "@/lib/tools/runner";

type Scope = "read" | "write" | "spend" | "publish";

function seed(over: { lockedA?: boolean } = {}) {
  const db = seedWrites(over);
  mocks.db = db;
  return db;
}

const call = (db: FakeSupabase, name: string, input: unknown, scopes?: Scope[]) =>
  runTool(apiCaller(db, scopes ? { scopes: scopes as never } : {}), name, input);

const site = (db: FakeSupabase, id = SITE_A) => db.tables.businesses.find((b) => b.id === id)!;

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  mocks.subscribed = true;
  mocks.analyze.mockReset();
  mocks.record.mockReset();
  quiet = (["info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("create_business", () => {
  it("adds a locked site to the account with a key for every site, and says how to act on it", async () => {
    const db = seed();
    const caller = { ...apiCaller(db), keyId: KEY_ALL_SITES };
    const run = await runTool(caller, "create_business", {
      name: "Delta",
      websiteUrl: "https://delta.test",
      niche: "Bikes",
      contentLanguage: "it",
    });
    expect(run).toMatchObject({
      ok: true,
      output: { business: { name: "Delta", websiteUrl: "https://delta.test", niche: "Bikes", contentLanguage: "it", locked: true } },
    });
    const created = db.tables.businesses.find((b) => b.name === "Delta");
    expect(created).toMatchObject({ user_id: USER, is_locked: true });
    if (run.ok) expect(run.output.hint).toBe(`Send x-gtf-business: ${created!.id} to act on this site.`);
  });

  it("works for an account with no site yet", async () => {
    const db = seed();
    const caller = { ...apiCaller(db, { businessId: null }), keyId: KEY_ALL_SITES };
    expect(await runTool(caller, "create_business", { name: "First", websiteUrl: "https://first.test" })).toMatchObject({ ok: true });
  });

  it("refuses a key limited to one site, and a URL that is not one", async () => {
    const db = seed();
    const before = db.tables.businesses.length;
    expect(await call(db, "create_business", { name: "Delta", websiteUrl: "https://delta.test" })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_business" },
    });
    const caller = { ...apiCaller(db), keyId: KEY_ALL_SITES };
    expect(await runTool(caller, "create_business", { name: "Delta", websiteUrl: "delta" })).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_input", message: "Invalid Website URL format" },
    });
    expect(db.tables.businesses).toHaveLength(before);
  });

  it("needs the write scope", async () => {
    const db = seed();
    const caller = { ...apiCaller(db, { scopes: ["read"] }), keyId: KEY_ALL_SITES };
    expect(await runTool(caller, "create_business", { name: "Delta", websiteUrl: "https://delta.test" })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
  });
});

describe("update_business", () => {
  it("changes the fields given on site A and keeps the rest", async () => {
    const db = seed({ lockedA: true });
    const run = await call(db, "update_business", { description: "Acme gets sites cited by AI." });
    expect(run).toMatchObject({
      ok: true,
      output: { business: { id: SITE_A, name: "Acme", websiteUrl: "https://acme.test", niche: "SEO software", description: "Acme gets sites cited by AI." } },
    });
    expect(site(db)).toMatchObject({ niche: "SEO software", description: "Acme gets sites cited by AI.", content_language: "en" });
    expect(site(db, SITE_B).description).toBeUndefined();
  });

  it("refuses a new address on a locked site with the reason, and writes nothing", async () => {
    const db = seed({ lockedA: true });
    const before = JSON.stringify(site(db));
    const run = await call(db, "update_business", { websiteUrl: "https://other.test", niche: "Other" });
    expect(run).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state", message: expect.stringMatching(/address is locked/), hint: expect.stringMatching(/create_business/) },
    });
    expect(JSON.stringify(site(db))).toBe(before);
    // The same address, written differently, is not a change.
    expect(await call(db, "update_business", { websiteUrl: "https://ACME.test/" })).toMatchObject({ ok: true });
  });
});

describe("analyze_website", () => {
  const analysis = { niche: "SEO", description: "Acme helps sites get found.", sitemapUrl: null, blogUrl: "https://acme.test/blog" };

  it("analyses site A's own address by default, in its language, and saves nothing", async () => {
    const db = seed();
    mocks.analyze.mockResolvedValue(analysis);
    const before = JSON.stringify(db.tables.businesses);
    const run = await call(db, "analyze_website", {});
    expect(run).toEqual({ ok: true, output: { websiteUrl: "https://acme.test", analysis } });
    expect(mocks.analyze).toHaveBeenCalledWith("https://acme.test", "en");
    expect(JSON.stringify(db.tables.businesses)).toBe(before);
  });

  it("answers a billing refusal with the sentence, recorded", async () => {
    const db = seed();
    mocks.analyze.mockRejectedValue(
      new LlmError("credits are depleted", "gemini", undefined, { retryable: false, report: false, billingRefused: ["gemini"] })
    );
    expect(await call(db, "analyze_website", { websiteUrl: "https://delta.test" })).toMatchObject({
      ok: false,
      status: 503,
      error: { code: "unavailable", message: LLM_CREDITS_RAN_OUT_MESSAGE },
    });
    expect(mocks.record).toHaveBeenCalledWith(db, expect.any(LlmError), { source: "tool.analyze_website" });
  });

  it("is paid: the spend scope and the subscription", async () => {
    const db = seed();
    expect(await call(db, "analyze_website", {}, ["read", "write"])).toMatchObject({ ok: false, status: 403, error: { code: "forbidden_scope" } });
    mocks.subscribed = false;
    expect(await call(db, "analyze_website", {})).toMatchObject({ ok: false, status: 402, error: { code: "subscription_required" } });
    expect(mocks.analyze).not.toHaveBeenCalled();
  });
});

describe("update_automation_settings", () => {
  it("changes a field and keeps the rest; autopilot stays off", async () => {
    const db = seed();
    site(db).automation_settings = { bufferDays: 21 };
    const run = await call(db, "update_automation_settings", { keywordFloor: 5 }, ["read", "write"]);
    expect(run).toMatchObject({ ok: true, output: { settings: { enabled: false, bufferDays: 21, keywordFloor: 5 } } });
    expect(site(db).automation_settings).toMatchObject({ enabled: false, bufferDays: 21, keywordFloor: 5 });
  });

  it("turning it on needs spend and publish, then confirm; nothing is written before", async () => {
    const db = seed();
    expect(await call(db, "update_automation_settings", { enabled: true, confirm: true }, ["read", "write", "spend"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope", message: "Turning autopilot on needs a key with the publish scope." },
    });
    expect(await call(db, "update_automation_settings", { enabled: true, confirm: true }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 403,
      error: { message: "Turning autopilot on needs a key with the spend and publish scopes." },
    });
    const unconfirmed = await call(db, "update_automation_settings", { enabled: true }, ["read", "write", "spend", "publish"]);
    expect(unconfirmed).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "confirmation_required", message: expect.stringMatching(/^Autopilot on: every day it keeps 14 days/) },
    });
    expect(site(db).automation_settings).toBeUndefined();

    const confirmed = await call(db, "update_automation_settings", { enabled: true, confirm: true }, ["read", "write", "spend", "publish"]);
    expect(confirmed).toMatchObject({ ok: true, output: { settings: { enabled: true } } });
    expect(site(db).automation_settings).toMatchObject({ enabled: true });

    // Turning it off needs neither.
    expect(await call(db, "update_automation_settings", { enabled: false }, ["read", "write"])).toMatchObject({ ok: true });
  });

  it("Push page 3 is off by default; turning it on needs spend, then confirm", async () => {
    const db = seed();
    expect(await call(db, "update_automation_settings", { bufferDays: 10 }, ["read", "write"])).toMatchObject({
      ok: true,
      output: { settings: { pushPage3: false } },
    });
    expect(await call(db, "update_automation_settings", { pushPage3: true, confirm: true }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
    expect(await call(db, "update_automation_settings", { pushPage3: true }, ["read", "write", "spend"])).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "confirmation_required", message: expect.stringMatching(/^Push page 3 on: once a week, up to 3 published articles/) },
    });
    expect(await call(db, "update_automation_settings", { pushPage3: true, confirm: true }, ["read", "write", "spend"])).toMatchObject({
      ok: true,
      output: { settings: { pushPage3: true, enabled: false } },
    });
  });
});

describe("update_media_settings", () => {
  it("changes the style without spending anything", async () => {
    const db = seed();
    const run = await call(db, "update_media_settings", { style: "illustration", brandPalette: ["#112233"] }, ["read", "write"]);
    expect(run).toMatchObject({ ok: true, output: { settings: { imagesEnabled: false, style: "illustration", brandPalette: ["#112233"] } } });
  });

  it("turning images on needs spend, then confirm", async () => {
    const db = seed();
    expect(await call(db, "update_media_settings", { imagesEnabled: true, confirm: true }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
    expect(await call(db, "update_media_settings", { imagesEnabled: true })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "confirmation_required", message: expect.stringMatching(/included in the plan/) },
    });
    expect(site(db).media_settings).toBeUndefined();
    expect(await call(db, "update_media_settings", { imagesEnabled: true, confirm: true })).toMatchObject({
      ok: true,
      output: { settings: { imagesEnabled: true, style: "photographic" } },
    });
  });

  it("turns images on with the featured image only, and says how many an article gets, never a price", async () => {
    const db = seed();
    const unconfirmed = await call(db, "update_media_settings", { imagesEnabled: true });
    expect(unconfirmed).toMatchObject({
      ok: false,
      status: 409,
      error: {
        message: expect.stringMatching(
          /^Images on: every article this site generates from now on gets an AI featured image, each one generated for it and included in the plan: at most 1 image\(s\) per article\.$/
        ),
      },
    });
    if (unconfirmed.ok) throw new Error("expected a refusal");
    expect(JSON.stringify(unconfirmed.error)).not.toMatch(/\$|usd|cost|price/i);
    expect(await call(db, "update_media_settings", { imagesEnabled: true, confirm: true })).toMatchObject({
      ok: true,
      output: { settings: { imagesEnabled: true, inlineImagesPerArticle: 0 } },
    });
  });

  it("allowing more images per article on a site that has them on needs spend, then confirm", async () => {
    const db = seed();
    await call(db, "update_media_settings", { imagesEnabled: true, confirm: true });

    expect(await call(db, "update_media_settings", { inlineImagesPerArticle: 2, confirm: true }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
    expect(await call(db, "update_media_settings", { inlineImagesPerArticle: 2 })).toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "confirmation_required",
        message: expect.stringMatching(/^More images per article: .* up to 2 in-article image\(s\), .* at most 3 image\(s\) per article\.$/),
      },
    });
    expect(site(db).media_settings).toMatchObject({ inlineImagesPerArticle: 0 });

    expect(await call(db, "update_media_settings", { inlineImagesPerArticle: 2, confirm: true })).toMatchObject({
      ok: true,
      output: { settings: { inlineImagesPerArticle: 2 } },
    });
    // Lowering it, or setting it while images are off, spends nothing more.
    expect(await call(db, "update_media_settings", { inlineImagesPerArticle: 1 }, ["read", "write"])).toMatchObject({ ok: true });
  });

  it("setting the cap while images stay off needs nothing", async () => {
    const db = seed();
    expect(await call(db, "update_media_settings", { inlineImagesPerArticle: 3 }, ["read", "write"])).toMatchObject({
      ok: true,
      output: { settings: { imagesEnabled: false, inlineImagesPerArticle: 3 } },
    });
  });

  it("refuses a value the screen's schema refuses", async () => {
    const db = seed();
    expect(await call(db, "update_media_settings", { inlineImagesPerArticle: 4 })).toMatchObject({ ok: false, status: 400 });
    expect(await call(db, "update_media_settings", { brandPalette: ["red"] })).toMatchObject({ ok: false, status: 400 });
  });
});
