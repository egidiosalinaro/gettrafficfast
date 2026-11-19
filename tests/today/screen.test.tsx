import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What Today shows (2026-11-14): the progress card and its link line, the
 * Also today cards (and no section when there is nothing), and the old
 * addresses redirecting here with their query.
 */

const redirect = vi.hoisted(() => vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
}));
vi.mock("next/navigation", () => ({ redirect }));

import { ProgressCard } from "@/components/today/progress-card";
import { AlsoToday, articleLabel, scheduledDay } from "@/components/today/also-today";
import { todayLinks, todayLinksLine, todayProgress, todayProgressLine, type TodayReply } from "@/lib/placements/today";
import { articleItems, factItems, replyLinkItems, type AlsoTodayItem } from "@/lib/today/also-today";
import { factKey, staleFacts } from "@/lib/voice/staleness";
import { APP_HOME } from "@/lib/app-home";
import PlacementsPage from "@/app/(app)/placements/page";
import DashboardPage from "@/app/(app)/dashboard/page";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const NOW = Date.parse("2026-11-14T15:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const noop = async () => null;

function reply(over: Partial<TodayReply> = {}): TodayReply {
  return {
    id: "r-1",
    surface: "x",
    author: "maya_builds",
    community: null,
    url: "https://x.com/maya_builds/status/1855000000000000001",
    text: "Same grind, different scoreboard.",
    publishedAt: ago(30),
    publishedUrl: null,
    metrics: null,
    linkSearch: null,
    linkSource: null,
    ...over,
  };
}

describe("the progress card", () => {
  it("says N of G replies with the goal, and plain counts without one", () => {
    expect(todayProgressLine({ posted: 3, goal: 5 })).toBe("3 of 5 replies");
    expect(todayProgressLine({ posted: 1, goal: 1 })).toBe("1 of 1 reply");
    expect(todayProgressLine({ posted: 2, goal: null })).toBe("2 replies today");
    expect(todayProgressLine({ posted: 0, goal: null })).toBe("No replies yet today");
    expect(todayProgress({ posted: 3, goal: 5 })).toBe(0.6);
    expect(todayProgress({ posted: 7, goal: 5 })).toBe(1);
    expect(todayProgress({ posted: 3, goal: null })).toBeNull();
  });

  it("says where today's links stand, by the rule the posted reply uses", () => {
    const found = { publishedUrl: "https://x.com/acme/status/1", linkSource: "found_on_x" as const };
    expect(todayLinks([reply(found), reply(found), reply(found)], { finderOn: true, now: NOW })).toMatchObject({
      linked: 3,
      foundOnX: 3,
      tone: "done",
      line: "Links of all 3 found on X",
    });
    expect(todayLinksLine({ total: 2, linked: 2, foundOnX: 1, looking: 0, toPaste: 0 })).toBe("Links of all 2 saved");
    expect(todayLinksLine({ total: 1, linked: 1, foundOnX: 1, looking: 0, toPaste: 0 })).toBe("Link found on X");
    // Posted 30 minutes ago on X, searched never: GTF is looking while the finder is on, and it is to paste when it is off.
    expect(todayLinks([reply()], { finderOn: true, now: NOW })).toMatchObject({ looking: 1, toPaste: 0, tone: "waiting", line: "GTF is looking for 1 on X" });
    expect(todayLinks([reply()], { finderOn: false, now: NOW })).toMatchObject({ looking: 0, toPaste: 1, tone: "todo", line: "1 link to paste" });
    // Searches not read: unknown, so never "looking".
    const unread = reply();
    delete unread.linkSearch;
    expect(todayLinks([unread], { finderOn: true, now: NOW })?.looking).toBe(0);
    // A reply on Reddit is never looked for.
    expect(todayLinks([reply({ surface: "reddit", url: "https://reddit.com/r/a/comments/1" }), reply()], { finderOn: true, now: NOW })?.line).toBe(
      "GTF is looking for 1 on X · 1 link to paste"
    );
    expect(todayLinks([], { finderOn: true, now: NOW })).toBeNull();
    expect(todayLinks(undefined, { finderOn: true, now: NOW })).toBeNull();
  });

  it("is one button that opens the Today sheet, with the bar only when a goal is set", () => {
    const links = todayLinks([reply({ publishedUrl: "https://x.com/acme/status/1", linkSource: "found_on_x" })], { finderOn: true, now: NOW });
    const html = renderToStaticMarkup(
      <ProgressCard today={{ posted: 3, goal: 5, timeZone: "Europe/Berlin" }} links={links} utcFallback={false} open={false} onOpen={() => {}} />
    );
    expect(html).toMatch(/^<button[^>]*aria-haspopup="dialog"[^>]*aria-label="Today&#x27;s replies: 3 of 5"/);
    expect(html).toContain("3 of 5 replies");
    expect(html).toContain("daily goal");
    expect(html).toContain("width:60%");
    expect(html).toContain("Link found on X");
    const plain = renderToStaticMarkup(<ProgressCard today={{ posted: 0, goal: null, timeZone: "UTC" }} links={null} utcFallback open={false} onOpen={() => {}} />);
    expect(plain).toContain("No replies yet today");
    expect(plain).toContain("Set a goal");
    expect(plain).toContain("(UTC)");
    expect(plain).not.toContain("width:");
  });
});

describe("Also today", () => {
  const items: AlsoTodayItem[] = [
    ...articleItems(
      [
        { id: "a1", status: "needs_review", scheduledDate: "2026-11-14", keyword: "how answer engines pick their sources", lastError: "One number has no source." },
        { id: "a2", status: "failed", scheduledDate: "2026-11-12", keyword: "aeo vs seo" },
        { id: "a3", status: "published", scheduledDate: "2026-11-13", keyword: "live" },
      ],
      "2026-11-14"
    ),
    ...replyLinkItems(
      [
        reply({ id: "stopped", linkSearch: { attempts: 4, lastAttemptAt: ago(10), outcome: "ambiguous", postsSeen: 2, foundUrl: null, foundAt: null }, publishedAt: ago(800) }),
        reply({ id: "looking" }),
        reply({ id: "linked", publishedUrl: "https://x.com/acme/status/2" }),
      ],
      NOW
    ),
    ...factItems([
      {
        sentence: "Co-founded Postwren: 12 paying stores in October 2026.",
        date: "2026-10-01",
        dateLabel: "October 2026",
        precision: "month",
        yearAssumed: false,
        confirmedOn: null,
        ageDays: 44,
        age: "last month",
        line: "Dated October 2026 (last month): still true?",
      },
    ]),
  ];

  it("holds a held or failed article, a reply whose link GTF stopped looking for, and a stale fact, each with what resolves it", () => {
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["article_held", "article:a1"],
      ["article_failed", "article:a2"],
      ["reply_link", "reply:stopped"],
      ["fact_stale", expect.stringMatching(/^fact:/)],
    ]);
    expect(items.every((i) => i.tools.length > 0 && i.href.startsWith("/"))).toBe(true);
  });

  it("renders one card per item, with one primary action each, and no paid action", () => {
    const html = renderToStaticMarkup(<AlsoToday items={items} now={NOW} busyIds={new Set()} onConfirmFact={noop} onSaveLink={noop} onDismissFailed={noop} />);
    expect(html).toContain(">Also today</h2>");
    expect(html.match(/<article/g)).toHaveLength(4);
    expect(html).toContain("Today&#x27;s article is waiting for you");
    expect(html).toContain("One number has no source.");
    expect(html).toContain("The article for Nov 12 failed");
    expect(html.match(/>Open the article</g)).toHaveLength(2);
    // Only the failed article can be ignored, and one failure gets no "Ignore all".
    expect(html.match(/>Ignore</g)).toHaveLength(1);
    expect(html).not.toContain("Ignore all");
    expect(html).toContain('href="/content"');
    expect(html).toContain('href="/content/articles"');
    expect(html).toContain("Paste link");
    expect(html).toContain("GTF found more than one reply of yours there");
    expect(html).toContain("Still true?");
    expect(html).toContain(">Still true</");
    expect(html).toContain('href="/settings/voice"');
    expect(html).toContain("Update it");
    // Nothing on a card writes, publishes or regenerates.
    expect(html).not.toMatch(/Regenerate|Publish|Generate|Draft it/);
    // 44px actions on a phone.
    expect(html.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("says 'confirmed' with the age of the confirmation when a fact confirmed as still true is asked about again", () => {
    const sentence = "Co-founded Postwren: 12 paying stores in October 2026.";
    const [never] = factItems(staleFacts(sentence, new Date("2026-11-14T10:00:00Z")));
    expect(never).toMatchObject({ confirmedOn: null, age: "last month" });
    const confirmations = { [factKey(sentence)]: "2026-11-14" };
    expect(staleFacts(sentence, new Date("2026-12-14T10:00:00Z"), { confirmations })).toEqual([]);
    const [again] = factItems(staleFacts(sentence, new Date("2026-12-16T10:00:00Z"), { confirmations }));
    expect(again).toMatchObject({ sentence, confirmedOn: "2026-11-14", dateLabel: "October 2026", age: "32 days ago" });
    const html = renderToStaticMarkup(<AlsoToday items={[again]} now={NOW} busyIds={new Set()} onConfirmFact={noop} onSaveLink={noop} onDismissFailed={noop} />);
    expect(html.replace(/<!-- -->/g, "")).toContain(", confirmed 32 days ago");
    expect(html).not.toContain("still true on");
  });

  it("offers Ignore all once two articles or more have failed", () => {
    const failed = articleItems(
      [
        { id: "f1", status: "failed", scheduledDate: "2026-11-08", keyword: "abandoned cart emails" },
        { id: "f2", status: "failed", scheduledDate: "2026-11-07", keyword: "welcome series ideas" },
      ],
      "2026-11-14"
    );
    expect(failed.every((i) => i.tools.includes("dismiss_failed_articles"))).toBe(true);
    const html = renderToStaticMarkup(
      <AlsoToday items={failed} now={NOW} busyIds={new Set()} onConfirmFact={noop} onSaveLink={noop} onDismissFailed={noop} />
    );
    expect(html.replace(/<!-- -->/g, "")).toContain("Ignore all 2 failed");
    expect(html.match(/>Ignore</g)).toHaveLength(2);
  });

  it("renders nothing at all when there is nothing: no heading, no empty box", () => {
    expect(renderToStaticMarkup(<AlsoToday items={[]} now={NOW} busyIds={new Set()} onConfirmFact={noop} onSaveLink={noop} onDismissFailed={noop} />)).toBe("");
  });

  it("names the article's day the way the calendar does", () => {
    expect(scheduledDay("2026-11-12")).toBe("Nov 12");
    const failedToday = articleItems([{ id: "a", status: "failed", scheduledDate: "2026-11-14", keyword: "k" }], "2026-11-14")[0];
    if (failedToday.kind !== "article_failed") throw new Error("kind");
    expect(articleLabel(failedToday)).toBe("Today's article failed");
  });
});

describe("the old addresses", () => {
  it("land on Today with their query string", async () => {
    expect(APP_HOME).toBe("/today");
    await expect(PlacementsPage({ searchParams: Promise.resolve({ source: "ai_visibility" }) })).rejects.toThrow("NEXT_REDIRECT /today?source=ai_visibility");
    await expect(PlacementsPage({ searchParams: Promise.resolve({ view: "posted", tag: ["a", "b"], gone: undefined }) })).rejects.toThrow(
      "NEXT_REDIRECT /today?view=posted&tag=a&tag=b"
    );
    await expect(DashboardPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/^NEXT_REDIRECT \/today$/);
  });

  it("keep no page of their own: Replies moved to Today, the Overview's next action is Also today", () => {
    expect(source("app/(app)/placements/page.tsx")).not.toContain("use client");
    expect(source("app/(app)/dashboard/page.tsx")).not.toContain("HomeView");
    expect(source("app/(app)/today/layout.tsx")).toContain("SiteSection");
  });
});
