import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { A, ART_A1, ART_A3, ART_B, B, readSeed } from "./read-support";
import { apiCaller, customerData } from "./support";
import { INDEXED, NOINDEX } from "../fixtures/url-inspection";

/**
 * `list_index_status` and `inspect_url`, as an API-key caller on site A.
 * Pinned: A's rows only, never B's; an article id of another site is a 404
 * before anything runs; `inspect_url` needs the write scope, asks Google for
 * one URL of the property, stores the answer and returns it; a URL outside
 * the property and Google's quota are refusals that store nothing.
 */

const m = vi.hoisted(() => ({ db: null as unknown, inspect: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));
vi.mock("@/lib/integrations/crypto", () => ({
  decryptSecret: (value: string) => `plain:${value}`,
  encryptSecret: (value: string) => `enc:${value}`,
}));
vi.mock("@/lib/providers/analytics/search-console", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/analytics/search-console")>();
  return {
    ...actual,
    refreshAccessToken: async () => "ACCESS",
    SearchConsoleProvider: class {
      inspectUrl(siteUrl: string, url: string) {
        return m.inspect(siteUrl, url);
      }
    },
  };
});

import { runTool } from "@/lib/tools/runner";
import { parseUrlInspectionResponse } from "@/lib/providers/analytics/search-console";
import { InspectionError } from "@/lib/providers/analytics/types";
import { TOOLS } from "@/lib/tools/registry";

let db: FakeSupabase;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"));
  db = readSeed();
  db.tables.index_status = [
    {
      ...A,
      url: "https://acme.test/ai-seo",
      article_id: ART_A1,
      checked_at: "2026-11-10T02:10:00.000Z",
      verdict: "NEUTRAL",
      coverage_state: "Page with redirect",
      raw: { inspectionResult: { inspectionResultLink: "https://search.google.com/x" } },
    },
    { ...B, url: "https://bravo.test/x", article_id: ART_B, checked_at: "2026-11-10T02:10:00.000Z", verdict: "PASS", coverage_state: "Submitted and indexed" },
  ];
  db.tables.notification_log = [];
  m.db = db;
  m.inspect.mockReset();
});

const call = (name: string, input: unknown = {}, scopes: Array<"read" | "write"> = ["read", "write"]) =>
  runTool(apiCaller(db, { scopes }), name, input);

describe("the registry", () => {
  it("serves both tools: list as read, inspect as a free write", () => {
    expect(TOOLS.get("list_index_status")).toMatchObject({ scope: "read", paid: false });
    expect(TOOLS.get("inspect_url")).toMatchObject({ scope: "write", paid: false });
  });
});

describe("list_index_status", () => {
  it("answers the site's rows and a summary that counts only checked URLs", async () => {
    const run = await call("list_index_status", {}, ["read"]);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const output = run.output as { connected: boolean; summary: Record<string, unknown>; rows: Array<Record<string, unknown>> };
    expect(output.connected).toBe(true);
    expect(output.rows).toEqual([
      expect.objectContaining({
        url: "https://acme.test/ai-seo",
        articleId: ART_A1,
        state: "not_indexed",
        coverageState: "Page with redirect",
        inspectionResultLink: "https://search.google.com/x",
      }),
    ]);
    // Two published articles on A, one checked: the other is not checked, not "not indexed".
    expect(output.summary).toMatchObject({ total: 2, checked: 1, notIndexed: 1, indexed: 0, caption: "1 of 2 checked" });
    expect(JSON.stringify(run.output)).not.toContain("bravo.test");
  });

  it("filters by state, and refuses an article of another site", async () => {
    const indexed = await call("list_index_status", { state: "indexed" }, ["read"]);
    expect(indexed.ok && (indexed.output as { rows: unknown[] }).rows).toEqual([]);
    const other = await call("list_index_status", { articleId: ART_B }, ["read"]);
    expect(other).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("inspect_url", () => {
  it("needs the write scope", async () => {
    const run = await call("inspect_url", { url: "https://acme.test/legacy" }, ["read"]);
    expect(run).toMatchObject({ ok: false, error: { code: "forbidden_scope" } });
    expect(m.inspect).not.toHaveBeenCalled();
  });

  it("inspects one URL of the property, stores and returns the fresh answer", async () => {
    m.inspect.mockResolvedValue(parseUrlInspectionResponse(NOINDEX));
    const run = await call("inspect_url", { articleId: ART_A3 });
    expect(m.inspect).toHaveBeenCalledWith("sc-domain:acme.test", "https://acme.test/legacy");
    expect(run).toMatchObject({
      ok: true,
      output: { fresh: true, row: { url: "https://acme.test/legacy", articleId: ART_A3, state: "not_indexed", coverageState: "Excluded by 'noindex' tag" } },
    });
    expect(db.tables.index_status.find((r) => r.url === "https://acme.test/legacy")).toMatchObject({
      user_id: A.user_id,
      business_id: A.business_id,
      indexing_state: "BLOCKED_BY_META_TAG",
    });
  });

  it("refuses an article of another site before asking Google", async () => {
    const run = await call("inspect_url", { articleId: ART_B });
    expect(run).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(m.inspect).not.toHaveBeenCalled();
  });

  it("refuses a URL outside the property, and Google's spent quota, storing nothing", async () => {
    const before = customerData(db);
    const outside = await call("inspect_url", { url: "https://bravo.test/x" });
    expect(outside).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    m.inspect.mockRejectedValue(new InspectionError("quota", "search_console", "quota", 429));
    const quota = await call("inspect_url", { url: "https://acme.test/legacy" });
    expect(quota).toMatchObject({ ok: false, error: { code: "cap_reached" } });
    expect(customerData(db)).toBe(before);
  });

  it("answers the stored row for a URL checked in the last ten minutes", async () => {
    m.inspect.mockResolvedValue(parseUrlInspectionResponse(INDEXED));
    await call("inspect_url", { url: "https://acme.test/ai-seo" });
    const again = await call("inspect_url", { url: "https://acme.test/ai-seo" });
    expect(again).toMatchObject({ ok: true, output: { fresh: false, row: { state: "indexed" } } });
    expect(m.inspect).toHaveBeenCalledTimes(1);
  });
});
