import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StepIncomplete, type StepContext } from "@/lib/jobs/types";
import { PLACES_MIN_TIME_MS, aeoRunWorkflow } from "@/lib/jobs/workflows/aeo-run";
import { AI_VISIBILITY_SOURCE, parseAiCitation } from "@/lib/placements/ai-citation";
import { requestDraft } from "@/lib/placements/generate";
import { AI_CITED_FILTER, loadInbox } from "@/lib/placements/read";
import { LISTICLE_KIND, NO_REPLY_ON_LISTICLE } from "@/lib/placements/workflow";
import { isSourceRedirect, resolveSourceUrls } from "@/lib/providers/citations/resolve";
import { findPlacesFromRun } from "@/lib/visibility/places";
import { parseAeoSettings } from "@/lib/visibility/settings";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * A run's cited sources as rows of the Replies inbox. Pinned: the same page
 * never becomes two rows, whoever found it first and however often the
 * action runs; a row already there keeps its status and only gains the
 * sighting; the cap holds across the write; a redirect is read back through
 * the provider and what is not read is counted; the run's own step runs by
 * default, does nothing when the site turned the setting off, spends
 * nothing, and waits for a tick with time to read the sources back; a list
 * article takes no draft; and the migration only adds a column.
 */

const NOW = new Date("2026-11-10T12:00:00.000Z");
const owned = { user_id: "user-1", business_id: "biz-1" };

const THREAD = "https://www.reddit.com/r/SEO/comments/1xyz111/what_ai_seo_tool_do_you_use/";
const LISTICLE = "https://toolblog.test/best-ai-seo-tools-2026";
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";

const src = (url: string, title = "") => ({ url, domain: new URL(url).hostname.replace(/^www\./, ""), title });

function probe(id: string, runId: string, query: string, engine: string, status: string, sources: unknown[]) {
  return { id, run_id: runId, ...owned, query_id: `q-${query}`, query, engine, status, sources };
}

function seed(over: { aeoSettings?: Record<string, unknown>; targets?: Record<string, unknown>[] } = {}) {
  return new FakeSupabase({
    businesses: [
      { id: "biz-1", user_id: "user-1", name: "Acme", website_url: "https://acme.test", aeo_settings: over.aeoSettings ?? {}, voice_settings: { aboutYou: "I use Acme daily." } },
      { id: "biz-2", user_id: "user-2", name: "Other", website_url: "https://other.test", aeo_settings: {} },
    ],
    competitors: [{ ...owned, domain: "rival.test", name: "Rival" }],
    aeo_runs: [
      { id: "run-1", ...owned, status: "completed", started_at: "2026-11-09T10:00:00.000Z", finished_at: "2026-11-09T10:05:00.000Z" },
      { id: "run-old", ...owned, status: "completed", started_at: "2026-11-01T10:00:00.000Z", finished_at: "2026-11-01T10:05:00.000Z" },
    ],
    aeo_probes: [
      probe("p1", "run-1", "best ai seo tool", "perplexity", "not_cited", [
        src(THREAD, "What AI SEO tool do you use? : r/SEO"),
        src(LISTICLE, "The 12 Best AI SEO Tools in 2026"),
        src("https://rival.test/pricing"),
        src("https://acme.test/blog/post"),
      ]),
      probe("p2", "run-1", "best ai seo tool", "gemini", "not_cited", [{ url: REDIRECT, domain: "reddit.com", title: "reddit.com" }]),
      probe("p3", "run-1", "what is aeo", "perplexity", "cited", [src("https://news.ycombinator.com/item?id=4242")]),
      // An older run's sources are not this run's.
      probe("p4", "run-old", "old prompt", "perplexity", "not_cited", [src("https://www.quora.com/Which-AI-SEO-tool-is-best")]),
    ],
    placement_targets: over.targets ?? [],
    placements: [],
  });
}

const run = (db: FakeSupabase, over: Partial<Parameters<typeof findPlacesFromRun>[0]> = {}) =>
  findPlacesFromRun({
    supabase: db as unknown as SupabaseClient,
    admin: db as unknown as SupabaseClient,
    userId: "user-1",
    businessId: "biz-1",
    now: NOW,
    // The redirect points at the thread perplexity linked directly.
    resolve: async (url) => (url === REDIRECT ? THREAD : null),
    ...over,
  });

const targets = (db: FakeSupabase) => db.tables.placement_targets;

describe("findPlacesFromRun", () => {
  it("creates one row per place from the latest completed run, own and competitor pages left out", async () => {
    const db = seed();
    const result = await run(db);

    expect(result).toMatchObject({ ok: true, runId: "run-1", candidates: 2, created: 2, linked: 0, deferred: 0 });
    if (!result.ok) throw new Error("unreachable");
    expect(result.dropped).toMatchObject({ competitor: 1, own_site: 1 });

    expect(targets(db)).toHaveLength(2);
    const thread = targets(db).find((t) => t.surface === "reddit");
    expect(thread).toMatchObject({
      ...owned,
      kind: "thread",
      external_id: "1xyz111",
      found_via: AI_VISIBILITY_SOURCE,
      found_for: "best ai seo tool",
      aeo_query_id: "q-best ai seo tool",
      status: "qualified",
      qualified_by: AI_VISIBILITY_SOURCE,
      qualify_score: null,
    });
    // Two engines cited it for the one prompt: the redirect read back to the same thread.
    expect(parseAiCitation(thread?.ai_citation)).toEqual({
      runId: "run-1",
      checkedAt: "2026-11-09T10:05:00.000Z",
      promptCount: 1,
      prompts: [{ queryId: "q-best ai seo tool", query: "best ai seo tool", engines: ["gemini", "perplexity"] }],
    });
    expect(targets(db).find((t) => t.surface === "web")).toMatchObject({ kind: LISTICLE_KIND, url: LISTICLE, status: "qualified" });
    // Nothing was drafted.
    expect(db.tables.placements).toEqual([]);
    expect(db.tables.jobs).toEqual([]);
  });

  it("running it again creates nothing: the same page is never two rows", async () => {
    const db = seed();
    await run(db);
    const again = await run(db);
    expect(again).toMatchObject({ ok: true, created: 0, linked: 2 });
    expect(targets(db)).toHaveLength(2);
  });

  it("reuses a row discovery already stored, under the same canonical identity, and leaves its verdict alone", async () => {
    const db = seed({
      targets: [
        {
          id: "t-existing",
          ...owned,
          surface: "reddit",
          kind: "thread",
          external_id: "1xyz111",
          url: THREAD,
          title: "What AI SEO tool do you use?",
          found_via: "web-search",
          found_for: "ai seo tools",
          status: "dismissed",
          dismissed_reason: "not for us",
          aeo_query_id: null,
        },
      ],
    });
    const result = await run(db);

    expect(result).toMatchObject({ ok: true, created: 1, linked: 1 });
    expect(targets(db).filter((t) => t.surface === "reddit")).toHaveLength(1);
    const row = targets(db).find((t) => t.id === "t-existing");
    // The person's Skip stands, and so does who found it first.
    expect(row).toMatchObject({ status: "dismissed", dismissed_reason: "not for us", found_via: "web-search", found_for: "ai seo tools" });
    // It gains the sighting and the prompt.
    expect(row?.aeo_query_id).toBe("q-best ai seo tool");
    expect(parseAiCitation(row?.ai_citation)?.prompts[0].engines).toEqual(["gemini", "perplexity"]);
  });

  it("does not touch another site's row for the same page", async () => {
    const db = seed({
      targets: [{ id: "t-other", user_id: "user-2", business_id: "biz-2", surface: "reddit", kind: "thread", external_id: "1xyz111", url: THREAD, status: "qualified" }],
    });
    await run(db);
    expect(targets(db).find((t) => t.id === "t-other")?.ai_citation).toBeUndefined();
    expect(targets(db).filter((t) => t.business_id === "biz-1")).toHaveLength(2);
  });

  it("holds the cap, and the next call takes the next page", async () => {
    const db = seed();
    const first = await run(db, { cap: 1 });
    expect(first).toMatchObject({ ok: true, created: 1, deferred: 1 });
    expect(targets(db)).toHaveLength(1);
    // The most cited first: two engines beat one.
    expect(targets(db)[0].surface).toBe("reddit");

    const second = await run(db, { cap: 1 });
    expect(second).toMatchObject({ ok: true, created: 1, linked: 1, deferred: 0 });
    expect(targets(db).map((t) => t.surface)).toEqual(["reddit", "web"]);
  });

  it("counts a redirect that could not be read back, and stores no guess for it", async () => {
    const db = seed();
    db.tables.aeo_probes = [probe("p2", "run-1", "best ai seo tool", "gemini", "not_cited", [{ url: REDIRECT, domain: "reddit.com", title: "reddit.com" }])];
    const result = await run(db, { resolve: async () => null });
    expect(result).toMatchObject({ ok: true, candidates: 0, created: 0 });
    if (!result.ok) throw new Error("unreachable");
    expect(result.dropped.unread).toBe(1);
    expect(targets(db)).toEqual([]);
  });

  it("says so when there is no finished run, and when the site is not the caller's", async () => {
    const db = seed();
    db.tables.aeo_runs = [{ id: "run-x", ...owned, status: "failed", started_at: "2026-11-09T10:00:00.000Z" }];
    expect(await run(db)).toMatchObject({ ok: false, status: 409, code: "no_run" });
    expect(await run(seed(), { userId: "user-2" })).toMatchObject({ ok: false, status: 404, code: "no_business" });
    expect(targets(db)).toEqual([]);
  });
});

describe("reading a source redirect back", () => {
  it("recognises the vendor's redirect and nothing else", () => {
    expect(isSourceRedirect(REDIRECT)).toBe(true);
    expect(isSourceRedirect(THREAD)).toBe(false);
    expect(isSourceRedirect("https://www.google.com/search?q=x")).toBe(false);
    expect(isSourceRedirect("")).toBe(false);
  });

  it("looks each address up once, keeps what resolved, and starts nothing past the deadline", async () => {
    const resolve = vi.fn(async (url: string) => (url.endsWith("a") ? THREAD : null));
    const out = await resolveSourceUrls([`${REDIRECT}a`, `${REDIRECT}a`, `${REDIRECT}b`], { resolve });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect([...out.entries()]).toEqual([[`${REDIRECT}a`, THREAD]]);

    const late = vi.fn(async () => THREAD);
    expect((await resolveSourceUrls([REDIRECT], { resolve: late, deadline: Date.now() })).size).toBe(0);
    expect(late).not.toHaveBeenCalled();
  });
});

describe("the run's own last step", () => {
  const step = aeoRunWorkflow.steps.find((s) => s.name === "places");
  const ctx = (db: FakeSupabase): StepContext => ({
    job: { id: "job-1", user_id: "user-1", article_id: null, type: "aeo-run", input: {}, status: "running", current_step: null, attempts: 1, max_attempts: 3, last_error: null },
    supabase: db as unknown as SupabaseClient,
    input: { runId: "run-1", businessId: "biz-1" },
    outputs: {},
    deadline: Date.now() + 60_000,
  });

  beforeEach(() => {
    // The only request the step could make is the redirect lookup.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: THREAD } }))
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("comes after finish, and is on by default; a stored false is kept", () => {
    expect(aeoRunWorkflow.steps.map((s) => s.name)).toEqual(["plan", "probe", "finish", "places"]);
    // Nothing stored (production's sites on 2026-11-13): the new default.
    expect(parseAeoSettings(null).placesFromSources).toBe(true);
    expect(parseAeoSettings({}).placesFromSources).toBe(true);
    expect(parseAeoSettings({ cadence: "weekly" }).placesFromSources).toBe(true);
    // The owner's own choice is not overridden.
    expect(parseAeoSettings({ placesFromSources: false }).placesFromSources).toBe(false);
    // The weekly run is on by default too since 2026-11-24.
    expect(parseAeoSettings({}).cadence).toBe("weekly");
  });

  it("with the setting off, creates nothing and asks nothing", async () => {
    const db = seed({ aeoSettings: { placesFromSources: false } });
    expect(await step?.run(ctx(db))).toEqual({ skipped: "off" });
    expect(targets(db)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("with nothing stored, creates the places from this run, and nothing that costs", async () => {
    const db = seed();
    expect(await step?.run(ctx(db))).toMatchObject({ created: 2, linked: 0 });
    expect(targets(db).map((t) => t.surface).sort()).toEqual(["reddit", "web"]);
    // Rows to read, with no angle: no draft, no job, no model.
    expect(targets(db).every((t) => t.status === "qualified" && t.qualify_angle === null)).toBe(true);
    expect(db.tables.placements).toEqual([]);
    expect(db.tables.jobs).toEqual([]);
    expect(db.tables.agent_runs).toEqual([]);
    // Re-entered after a crash: nothing is duplicated.
    expect(await step?.run(ctx(db))).toMatchObject({ created: 0, linked: 2 });
    expect(targets(db)).toHaveLength(2);
  });

  it("waits for the next tick rather than start with too little time to read the sources back", async () => {
    const db = seed();
    const late = { ...ctx(db), deadline: Date.now() + PLACES_MIN_TIME_MS - 1_000 };
    await expect(step?.run(late)).rejects.toBeInstanceOf(StepIncomplete);
    expect(targets(db)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    // The next tick has the time, and the redirect is read back.
    expect(await step?.run(ctx(db))).toMatchObject({ created: 2 });
    expect(fetch).toHaveBeenCalled();
  });

  it("with the setting on but a run that did not complete, skips", async () => {
    const db = seed();
    db.tables.aeo_runs[0].status = "failed";
    expect(await step?.run(ctx(db))).toEqual({ skipped: "no_run" });
    expect(targets(db)).toEqual([]);
  });
});

describe("the inbox", () => {
  it("carries the sighting on the card's record and narrows to cited rows on request", async () => {
    const db = seed({
      targets: [{ id: "t-plain", ...owned, surface: "x", kind: "post", external_id: "status:1", url: "https://x.com/a/status/1", title: "A post", status: "qualified", created_at: "2026-11-01" }],
    });
    await run(db);
    const client = db as unknown as SupabaseClient;

    const all = await loadInbox(client, "biz-1", { status: "open", surface: null, topic: null });
    expect(all.targets).toHaveLength(3);
    expect(all.aiCitedOpen).toBe(2);
    expect(all.targets.find((t) => t.id === "t-plain")?.aiCitation).toBeNull();

    const cited = await loadInbox(client, "biz-1", { status: "open", surface: null, topic: null, source: AI_CITED_FILTER });
    expect(cited.targets.map((t) => t.surface).sort()).toEqual(["reddit", "web"]);
    expect(cited.targets.every((t) => t.aiCitation?.prompts[0].query === "best ai seo tool")).toBe(true);
  });

  it("refuses a draft for a list article before anything is spent", async () => {
    const db = seed();
    await run(db);
    const listicle = targets(db).find((t) => t.kind === LISTICLE_KIND);
    const client = db as unknown as SupabaseClient;
    const refused = await requestDraft({ supabase: client, admin: client, userId: "user-1", businessId: "biz-1", targetId: listicle?.id as string, mode: "start" });
    expect(refused).toMatchObject({ ok: false, status: 409, code: "invalid_state", error: NO_REPLY_ON_LISTICLE });
    expect(db.tables.jobs).toEqual([]);
  });
});

describe("20261110180000_placement_ai_citation.sql", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const code = readFileSync(path.join(root, "supabase/migrations/20261110180000_placement_ai_citation.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("adds one nullable column, and has no statement that would wait for a confirmation", () => {
    expect(code).toContain("alter table public.placement_targets add column if not exists ai_citation jsonb;");
    expect(code).not.toMatch(/\b(drop|delete|truncate|update)\b/i);
    expect(code).not.toMatch(/not null|default/i);
  });
});
