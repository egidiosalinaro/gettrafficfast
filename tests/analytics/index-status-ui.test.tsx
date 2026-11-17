import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IndexStatusLineView } from "@/components/dashboard/index-status-line";
import { GoogleBlock } from "@/components/growth/growth-view";
import { indexStatusLine, summarizeIndexing, type IndexStatusView } from "@/lib/analytics/index-status-display";
import type { GoogleGrowth } from "@/lib/growth/schema";

/**
 * What a person reads about indexing. Pinned: the article's one line in
 * Google's words with the day it was checked and Google's report; an
 * unchecked article reads "not checked", never "not on Google"; Growth's
 * "Pages on Google" counts only checked pages, says how many are not checked
 * yet, and lists only checked pages that are not indexed, with Google's
 * reason; no em dash in the copy; and the migration is additive with RLS on.
 */

/** Growth's Google block around an indexing summary, the way lib/growth/read.ts fills it. */
function googleWith(rows: IndexStatusView[], total: number): GoogleGrowth {
  const s = summarizeIndexing(rows, total);
  return {
    connection: { status: "connected", siteUrl: "sc-domain:acme.test", lastSyncedOn: "2026-11-11", stale: false, syncing: false, lastError: null },
    settledThrough: "2026-11-11",
    coveredFrom: "2026-08-01",
    current: { from: "2026-11-05", to: "2026-11-11", impressions: 10, clicks: 0, averagePosition: 12 },
    previous: null,
    change: { impressions: null, clicks: null, averagePosition: null },
    pages: {
      total: s.total,
      checked: s.checked,
      indexed: s.indexed,
      notIndexed: s.notIndexed,
      unknown: s.unknown,
      caption: s.caption,
      notIndexedRows: s.notIndexedRows.map((r) => ({ url: r.url, coverageState: r.coverageState, checkedAt: r.checkedAt, inspectionResultLink: r.inspectionResultLink })),
    },
  };
}

const NOW = new Date("2026-11-12T12:00:00.000Z");
const row = (over: Partial<IndexStatusView>): IndexStatusView => ({
  url: "https://acme.test/blog/a",
  articleId: "a",
  checkedAt: "2026-11-12T02:10:00.000Z",
  verdict: "PASS",
  state: "indexed",
  coverageState: "Submitted and indexed",
  indexingState: null,
  robotsState: null,
  fetchState: null,
  googleCanonical: null,
  userCanonical: null,
  lastCrawlAt: null,
  inspectionResultLink: "https://search.google.com/search-console/inspect?id=a",
  ...over,
});

describe("indexStatusLine", () => {
  it("reads indexed, not indexed in Google's words, no verdict, and not checked", () => {
    expect(indexStatusLine(row({}), NOW)).toEqual({
      text: "On Google · checked Nov 12",
      tone: "ok",
      link: "https://search.google.com/search-console/inspect?id=a",
    });
    expect(
      indexStatusLine(row({ verdict: "NEUTRAL", state: "not_indexed", coverageState: "Crawled - currently not indexed" }), NOW).text
    ).toBe("Not on Google: Crawled - currently not indexed · checked Nov 12");
    expect(indexStatusLine(row({ verdict: "VERDICT_UNSPECIFIED", state: "unknown", coverageState: null }), NOW).text).toBe(
      "Google gave no verdict · checked Nov 12"
    );
    expect(indexStatusLine(null, NOW)).toEqual({ text: "Not checked on Google yet", tone: "muted", link: null });
  });
});

describe("IndexStatusLineView", () => {
  it("renders the line, Google's report and Check now", () => {
    const html = renderToStaticMarkup(
      <IndexStatusLineView
        row={row({ verdict: "NEUTRAL", state: "not_indexed", coverageState: "Page with redirect" })}
        checking={false}
        error={null}
        onCheck={() => undefined}
        now={NOW}
      />
    );
    expect(html).toContain("Not on Google: Page with redirect · checked Nov 12");
    expect(html).toContain('href="https://search.google.com/search-console/inspect?id=a"');
    expect(html).toContain("Check now");
  });

  it("never says 'not on Google' for an article nobody checked", () => {
    const html = renderToStaticMarkup(<IndexStatusLineView row={null} checking={false} error={null} now={NOW} />);
    expect(html).toContain("Not checked on Google yet");
    expect(html).not.toContain("Not on Google");
  });
});

describe("Growth → Google → Pages on Google", () => {
  it("counts from checked pages, says how many are not checked, and lists the ones not indexed with the reason", () => {
    const rows = [
      row({ url: "https://acme.test/a" }),
      row({ url: "https://acme.test/check", verdict: "NEUTRAL", state: "not_indexed", coverageState: "Page with redirect" }),
    ];
    const html = renderToStaticMarkup(<GoogleBlock google={googleWith(rows, 5)} days={7} />);
    expect(html).toContain("1 of 5");
    expect(html).toContain("3 not checked yet");
    expect(html).toContain("Not on Google · 1");
    expect(html).toContain("acme.test/check");
    expect(html).toContain("Page with redirect");
    expect(html).not.toContain("—");
  });

  it("says not checked yet instead of zero when nothing was inspected", () => {
    const html = renderToStaticMarkup(<GoogleBlock google={googleWith([], 4)} days={7} />);
    expect(html).toContain("not checked yet");
    expect(html).not.toContain("0 of 4");
    expect(html).not.toContain("Not on Google");
  });
});

describe("20261112120000_index_status.sql", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sql = readFileSync(path.join(root, "supabase/migrations/20261112120000_index_status.sql"), "utf8");
  const code = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ")
    .toLowerCase();

  it("is additive: a new table with its key, RLS on, the owner's select, no drop", () => {
    expect(code).toContain("create table if not exists public.index_status (");
    expect(code).toContain("primary key (business_id, url)");
    expect(code).toContain("user_id uuid not null references auth.users(id) on delete cascade");
    expect(code).toContain("article_id uuid references public.articles(id) on delete set null");
    expect(code).toContain("alter table public.index_status enable row level security");
    expect(code).toContain("for select to authenticated using ((select auth.uid()) = user_id)");
    expect(code).not.toMatch(/\bdrop\b/);
  });
});
