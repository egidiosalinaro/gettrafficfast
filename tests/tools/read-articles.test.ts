import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { apiCaller } from "./support";
import { ART_A1, ART_A2, ART_A3, ART_B, ART_C, CANONICAL, QUALITY, readSeed } from "./read-support";

/**
 * The article read tools, as an API-key caller on site A with the read
 * scope only: the calendar without bodies, one article in each format with
 * its quality report, the deliveries; an article of site B or of another
 * account is a 404 before anything is read.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));

import { runTool } from "@/lib/tools/runner";
import { exportArticle } from "@/lib/content/export";

let db: FakeSupabase;
beforeEach(() => {
  db = readSeed();
  m.db = db;
});

const call = (name: string, input: unknown = {}) => runTool(apiCaller(db, { scopes: ["read"] }), name, input);

describe("list_calendar", () => {
  it("lists the site's articles by day, without bodies", async () => {
    const run = await call("list_calendar");
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const items = run.output.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toEqual([ART_A3, ART_A1, ART_A2]);
    expect(items[1]).toEqual({
      id: ART_A1,
      keywordId: expect.any(String),
      keyword: "ai seo",
      searchVolume: 900,
      title: "AI SEO, plainly",
      scheduledDate: "2026-11-01",
      status: "published",
      publishedUrl: "https://acme.test/ai-seo",
      lastError: null,
    });
    for (const item of items) {
      expect(item).not.toHaveProperty("canonical");
      expect(item).not.toHaveProperty("content");
    }
    expect(run.output.total).toBe(3);
  });

  it("filters by day range and status", async () => {
    const ranged = await call("list_calendar", { from: "2026-11-01", to: "2026-11-30" });
    expect(ranged.ok && (ranged.output.items as Array<{ id: string }>).map((i) => i.id)).toEqual([ART_A1, ART_A2]);
    const queued = await call("list_calendar", { status: "queued" });
    expect(queued.ok && (queued.output.items as Array<{ id: string }>).map((i) => i.id)).toEqual([ART_A2]);
    const bad = await call("list_calendar", { from: "1 Nov" });
    expect(bad).toMatchObject({ ok: false, status: 400, error: { code: "invalid_input" } });
  });
});

describe("get_article", () => {
  it("answers the Canonical Article and the quality report by default", async () => {
    const run = await call("get_article", { articleId: ART_A1 });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toMatchObject({
      format: "canonical",
      canonical: CANONICAL,
      body: null,
      qualityReport: { decision: "needs_review", issues: [{ code: "ARTICLE_TOO_SHORT", action: "review" }] },
      article: { id: ART_A1, title: "AI SEO, plainly", status: "published", createdAt: "2026-11-01T08:00:00.000Z" },
    });
    expect(run.output.qualityReport).toEqual(QUALITY);
  });

  it("answers html and markdown as Copy HTML and Copy Markdown give them", async () => {
    const html = await call("get_article", { articleId: ART_A1, format: "html" });
    expect(html.ok && html.output).toMatchObject({
      format: "html",
      canonical: null,
      body: exportArticle({ canonical: CANONICAL }, "html"),
    });
    expect(html.ok && (html.output.body as string)).toContain('<figure class="gtf-hero">');
    const md = await call("get_article", { articleId: ART_A1, format: "markdown" });
    expect(md.ok && md.output.body).toBe(exportArticle({ canonical: CANONICAL }, "markdown"));
    expect(md.ok && (md.output.body as string).startsWith("# AI SEO, plainly")).toBe(true);
  });

  it("answers a legacy article's stored HTML, and no body for one not written yet", async () => {
    const legacy = await call("get_article", { articleId: ART_A3, format: "canonical" });
    expect(legacy.ok && legacy.output).toMatchObject({ canonical: null, body: null, qualityReport: null });
    const legacyHtml = await call("get_article", { articleId: ART_A3, format: "html" });
    expect(legacyHtml.ok && legacyHtml.output.body).toBe("<h1>Legacy</h1><p>Old <strong>body</strong>.</p>");
    const queued = await call("get_article", { articleId: ART_A2, format: "markdown" });
    expect(queued.ok && queued.output).toMatchObject({ body: null, article: { status: "queued", title: null } });
  });

  it("answers 404 for an article of another site or another account", async () => {
    for (const articleId of [ART_B, ART_C]) {
      const run = await call("get_article", { articleId });
      expect(run).toMatchObject({ ok: false, status: 404, error: { code: "not_found", message: "No article with that articleId on this site." } });
    }
  });
});

describe("list_deliveries", () => {
  it("lists the site's publish attempts newest first, failures included, without payloads", async () => {
    const run = await call("list_deliveries");
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const deliveries = run.output.deliveries as Array<Record<string, unknown>>;
    expect(deliveries.map((d) => [d.integrationType, d.ok, d.error])).toEqual([
      ["wordpress", false, "HTTP 401"],
      ["webhook", true, null],
    ]);
    expect(deliveries[1]).toMatchObject({ articleId: ART_A1, publishedUrl: "https://acme.test/ai-seo" });
    expect(JSON.stringify(run.output)).not.toContain("never");
  });

  it("filters by destination type", async () => {
    const run = await call("list_deliveries", { type: "webhook", limit: 5 });
    expect(run.ok && (run.output.deliveries as unknown[]).length).toBe(1);
  });
});
