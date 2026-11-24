import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AiBlock, GoogleBlock, GrowthView, RepliesBlock, articlesByReach, countDelta, positionDelta } from "@/components/growth/growth-view";
import { AnswerCard, AnswersView, askLine, shownSources } from "@/components/growth/ai-answers";
import { periodWindows } from "@/lib/growth/period";
import { summarizeAsks } from "@/lib/growth/ai";
import type { AiAnswersPage, AiGrowth, GoogleGrowth, GrowthSummary } from "@/lib/growth/schema";
import type { AskSetup } from "@/lib/growth/read";
import { mapReplyMetrics } from "@/lib/placements/reply-metrics";
import { summarizeReplyStats, type PostedXReply, type ReplyStats } from "@/lib/placements/reply-stats";
import { emptyResults } from "@/lib/lifecycle/load-results";

/**
 * Growth as a person reads it, on a phone first. Pinned: every number that
 * nobody measured is words, never a 0; a change with nothing to compare says
 * so, never an arrow from zero; AI answers one line per engine, a count
 * under 10 asks, never a rate across engines, sampled said once; the
 * evidence marks the site's own source and the places in Today; 44px
 * targets; no em dash.
 */

const NOW = new Date("2026-11-13T15:00:00.000Z");

const snap = (day: string, over: Record<string, unknown>) =>
  mapReplyMetrics({ day, fetched_at: `${day}T13:20:00Z`, impressions: null, likes: null, replies: null, reposts: null, quotes: null, bookmarks: null, ...over });

const reply = (id: string, publishedAt: string, snapshots: ReturnType<typeof snap>[], over: Partial<PostedXReply> = {}): PostedXReply => ({
  id,
  publishedAt,
  publishedUrl: `https://x.com/samriv/status/18550000000000000${id}`,
  threadUrl: `https://x.com/janedoe/status/17550000000000000${id}`,
  threadAuthor: "janedoe",
  text: `Reply ${id}: put the answer in the first sentence.`,
  removed: false,
  snapshots,
  ...over,
});

function stats(over: Partial<Parameters<typeof summarizeReplyStats>[0]> = {}): ReplyStats {
  return summarizeReplyStats({
    now: NOW,
    platformEnabled: true,
    replies: [
      reply("11", "2026-11-12T09:00:00Z", [snap("2026-11-13", { impressions: 12_400, likes: 31, replies: 6, reposts: 2 })]),
      reply("12", "2026-11-11T09:00:00Z", [snap("2026-11-13", { impressions: 800, likes: 4, replies: 1, reposts: 0 })]),
      reply("13", "2026-11-10T09:00:00Z", [], { publishedUrl: null }),
      reply("14", "2026-11-03T09:00:00Z", [snap("2026-11-06", { impressions: 9_000, likes: 40, replies: 2, reposts: 2 })]),
    ],
    metricsReadable: true,
    handle: "samriv",
    account: [
      { day: "2026-11-13", handle: "samriv", followers: 2310, following: 300, posts: 5000, listed: 4, fetchedAt: "" },
      { day: "2026-11-06", handle: "samriv", followers: 2274, following: 300, posts: 4900, listed: 4, fetchedAt: "" },
    ],
    ...over,
  });
}

const connected: GoogleGrowth["connection"] = {
  status: "connected",
  siteUrl: "sc-domain:acme.test",
  lastSyncedOn: "2026-11-11",
  stale: false,
  syncing: false,
  lastError: null,
};

const google = (over: Partial<GoogleGrowth> = {}): GoogleGrowth => ({
  connection: connected,
  settledThrough: "2026-11-11",
  coveredFrom: "2026-06-24",
  current: { from: "2026-11-05", to: "2026-11-11", impressions: 12_400, clicks: 23, averagePosition: 24.6 },
  previous: { from: "2026-10-29", to: "2026-11-04", impressions: 11_160, clicks: 18, averagePosition: 27.7 },
  change: { impressions: 1_240, clicks: 5, averagePosition: 3.1 },
  pages: {
    total: 22,
    checked: 22,
    indexed: 18,
    notIndexed: 4,
    unknown: 0,
    caption: "22 of 22 checked",
    notIndexedRows: [{ url: "https://acme.test/blog/a", coverageState: "Discovered - currently not indexed", checkedAt: "2026-11-13T02:00:00Z", inspectionResultLink: null }],
  },
  ...over,
});

const ai = (over: Partial<AiGrowth> = {}): AiGrowth => ({
  window: periodWindows(7, "2026-11-14"),
  engines: summarizeAsks(
    [
      ...Array.from({ length: 7 }, (_, i) => ({ engine: "perplexity", kind: "prompt" as const, askedAt: "2026-11-12", status: i < 2 ? ("cited" as const) : ("not_cited" as const) })),
      ...Array.from({ length: 5 }, () => ({ engine: "gemini", kind: "article" as const, askedAt: "2026-11-10", status: "not_cited" as const })),
    ],
    periodWindows(7, "2026-11-14")
  ),
  lastAskedAt: "2026-11-12",
  prompts: { total: 12, enabled: 12 },
  places: { open: 4 },
  placesFromSources: true,
  sampled: true,
  note: "Sampled.",
  ...over,
});

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("Replies on X", () => {
  it("shows replies posted, views, likes and followers, each with its change, the coverage and the best reply", () => {
    const out = html(<RepliesBlock stats={stats()} days={7} />);
    expect(out).toContain("Replies on X");
    expect(out).toContain("Replies posted");
    expect(out).toContain("13.2K");
    expect(out).toContain("↑ 4,200");
    expect(out).toContain("2,310");
    expect(out).toContain("↑ 36");
    expect(out).toContain("2 of 3 replies measured · 1 without a link");
    expect(out).toContain("Best reply · 12.4K views · 31 likes");
    expect(out).toContain('href="https://x.com/samriv/status/1855000000000000011"');
    expect(out).toContain("min-h-11");
    expect(out).not.toMatch(/profile visit/i);
    expect(out).not.toContain("—");
  });

  it("says not measured, never 0, and that nothing can be compared", () => {
    const out = html(<RepliesBlock stats={stats({ replies: [reply("21", "2026-11-12T09:00:00Z", [])], account: [] })} days={7} />);
    expect(out).toContain("not measured");
    expect(out).toContain("0 of 1 reply measured");
    expect(out).toContain("none before");
    expect(out).not.toMatch(/>0</);
    expect(out).not.toContain("Best reply");
  });

  it("with the platform's X API off, says so and reads nothing; no site has a switch to turn on", () => {
    const off = html(<RepliesBlock stats={stats({ platformEnabled: false })} days={7} />);
    expect(off).toContain("not available yet");
    expect(off).toContain("not read");
    expect(off).not.toContain("13.2K");
    expect(off).not.toContain("Find posts on X");
    expect(off).not.toContain('href="/settings/integrations"');
    expect(html(<RepliesBlock stats={null} days={7} />)).toContain("could not be read");
  });

  it("reads 28 days as 28 days", () => {
    const out = html(<RepliesBlock stats={stats({ days: 28 })} days={28} />);
    expect(out).toContain("posted in these 28 days");
  });
});

describe("Google", () => {
  it("shows impressions, clicks, the average position and pages on Google with their change", () => {
    const out = html(<GoogleBlock google={google()} days={7} />);
    expect(out).toContain("12.4K");
    expect(out).toContain("↑ 1,240");
    expect(out).toContain("↑ 5");
    expect(out).toContain("24.6");
    expect(out).toContain("↑ 3.1 places");
    expect(out).toContain("18 of 22");
    expect(out).toContain("latest check only");
    expect(out).toContain("From Search Console, Nov 5 to Nov 11, against the 7 days before.");
    expect(out).toContain("Not on Google · 4");
    expect(out).toContain("Discovered - currently not indexed");
    expect(out).not.toContain("—");
  });

  it("says no comparison yet when the week before is not covered, and not connected without a connection", () => {
    const fresh = html(<GoogleBlock google={google({ previous: null, change: { impressions: null, clicks: null, averagePosition: null }, coveredFrom: "2026-11-02" })} days={7} />);
    expect(fresh).toContain("no comparison yet");
    expect(fresh).toContain("No comparison yet: the data starts Nov 2.");
    expect(fresh).not.toContain("↑");

    const absent = html(<GoogleBlock google={google({ connection: { ...connected, status: "absent", siteUrl: null }, current: null, previous: null, pages: null })} days={7} />);
    expect(absent).toContain("Connect Search Console");
    expect(absent).not.toMatch(/>0</);

    const empty = html(<GoogleBlock google={google({ current: null, previous: null, pages: { ...google().pages!, checked: 0, indexed: 0, notIndexed: 0, notIndexedRows: [] } })} days={7} />);
    expect(empty).toContain("no data yet");
    expect(empty).toContain("not checked yet");
    expect(empty).not.toMatch(/>0</);
  });

  it("formats changes for people", () => {
    expect(countDelta(null, "no comparison yet")).toEqual({ tone: "none", text: "no comparison yet" });
    expect(countDelta(0, "")).toEqual({ tone: "flat", text: "no change" });
    expect(countDelta(-15_300, "")).toEqual({ tone: "down", text: "↓ 15.3K" });
    expect(positionDelta(15.049999999999997, "").text).toBe("↑ 15 places");
    expect(positionDelta(-1, "").text).toBe("↓ 1 place");
    expect(positionDelta(0.04, "").text).toBe("no change");
  });
});

describe("AI answers", () => {
  it("is one line per engine, a count under 10 asks, sampled, never a rate across engines", () => {
    const out = html(<AiBlock ai={ai()} days={7} />);
    expect(out).toContain("Perplexity");
    expect(out).toContain("2 of 7");
    expect(out).toContain("asks cited you");
    expect(out).toContain("0 of 5");
    expect(out).toContain("not asked the 7 days before");
    expect(out).toContain("Too few asks for a percent yet.");
    // A question the owner chose may name the business: the line claims nothing about it.
    expect(out).toContain("your articles&#x27; keywords and the questions you chose");
    expect(out).not.toMatch(/naming you|without naming/);
    expect(out).toContain("4 pages the answers cited are in Today");
    expect(out).toContain('href="/growth/ai"');
    expect(out).not.toMatch(/\d+%/);
    expect(out).not.toMatch(/all engines|average/i);
  });

  it("gives a percent from 10 asks with the count beside it, and says not asked over nothing", () => {
    const many = summarizeAsks(
      Array.from({ length: 20 }, (_, i) => ({ engine: "gemini", kind: "prompt" as const, askedAt: "2026-11-12", status: i < 4 ? ("cited" as const) : ("not_cited" as const) })),
      periodWindows(7, "2026-11-14")
    );
    const out = html(<AiBlock ai={ai({ engines: many })} days={7} />);
    expect(out).toContain("20%");
    expect(out).toContain("4 of 20 asks");
    expect(out).not.toContain("Too few asks");

    const none = html(<AiBlock ai={ai({ engines: summarizeAsks([], periodWindows(7, "2026-11-14"), ["gemini"]), lastAskedAt: "2026-09-30" })} days={7} />);
    expect(none).toContain("not asked in these 7 days");
    expect(none).toContain("Last asked Sep 30.");
    expect(none).not.toMatch(/>0</);
    expect(html(<AiBlock ai={ai({ engines: [] })} days={28} />)).toContain("No answer engine has been asked about your site yet.");
    expect(html(<AiBlock ai={ai()} days={28} />)).toContain('href="/growth/ai?days=28"');
  });
});

describe("the page", () => {
  const summary: GrowthSummary = { days: 7, generatedAt: NOW.toISOString(), replies: stats(), google: google(), ai: ai() };

  it("has the period switch, the three blocks in order, By article and How we measure", () => {
    const out = html(<GrowthView growth={summary} results={emptyResults()} />);
    expect(out).toContain("This week against the week before.");
    expect(out).toContain('href="/growth?days=28"');
    const order = ["data-block=\"replies\"", "data-block=\"google\"", "data-block=\"ai\"", "id=\"by-article\"", "How we measure"].map((s) => out.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain('href="/docs#how-we-measure"');
    expect(out).toContain("Nothing published yet.");
    expect(out).not.toContain("—");
  });

  it("puts the articles Google shows first above the ones nobody measured", () => {
    const article = (id: string, impressions: number | null, current: number | null) => ({
      articleId: id,
      traffic: { impressions, clicks: impressions === null ? null : 0, windowDays: 28 },
      rank: { current, previous: null, delta: null, measuredOn: null, samples: current === null ? 0 : 1 },
    });
    const sorted = articlesByReach([article("new", null, null), article("ranked", null, 12), article("seen", 40, 30), article("more", 300, 50)]);
    expect(sorted.map((a) => a.articleId)).toEqual(["more", "seen", "ranked", "new"]);
  });
});

describe("the evidence", () => {
  type Answer = AiAnswersPage["answers"][number];
  const source = (position: number, domain: string, over: Partial<Answer["sources"][number]> = {}) => ({
    position,
    url: `https://${domain}/page`,
    domain,
    title: null,
    opensPage: true,
    ours: false,
    inToday: false,
    ...over,
  });
  const answer = (over: Partial<Answer> = {}): Answer => ({
    id: "prompt:1",
    kind: "prompt",
    question: "How do I get my SaaS cited by ChatGPT?",
    engine: "perplexity",
    askedAt: "2026-11-11T09:00:00Z",
    status: "cited",
    counted: true,
    ourPosition: 1,
    citedUrl: "https://acme.test/blog/how",
    mentioned: false,
    excerpt: "Start with the answer.",
    sources: [source(1, "acme.test", { ours: true }), source(2, "reddit.com", { inToday: true }), source(3, "rival.test")],
    sourcesKept: true,
    placesInToday: 1,
    promptId: "q1",
    articleId: null,
    error: null,
    ...over,
  });

  it("shows the question, the engine, the day, the verdict and the numbered sources, marked", () => {
    const out = html(<AnswerCard answer={answer()} />);
    expect(out).toContain("Perplexity · Nov 11");
    expect(out).toContain("Cited you");
    expect(out).toContain("“How do I get my SaaS cited by ChatGPT?”");
    expect(out).toContain("acme.test/page");
    expect(out).toContain(">you<");
    expect(out).toContain(">in Today<");
    expect(out).toContain("1 of these pages is a place to reply in Today.");
    expect(out).toContain("Read the answer");
    expect(out).toContain('href="/growth/ai/queries/q1"');
    expect(out).not.toContain("—");
  });

  it("says what an article check keeps, and that an unreadable answer is not counted", () => {
    const article = html(<AnswerCard answer={answer({ id: "article:1", kind: "article", status: "not_cited", citedUrl: null, excerpt: null, sources: [], sourcesKept: false, placesInToday: 0, promptId: null, articleId: "a1" })} />);
    expect(article).toContain("article check");
    expect(article).toContain("Not cited");
    expect(article).toContain("keeps the verdict, not the sources");
    expect(article).not.toContain("Read the answer");
    const failed = html(<AnswerCard answer={answer({ status: "error", counted: false, sources: [], error: "HTTP 429", placesInToday: 0 })} />);
    expect(failed).toContain("not counted");
    expect(failed).toContain("HTTP 429");
  });

  it("folds long source lists but never the site's own or a place", () => {
    const many = Array.from({ length: 14 }, (_, i) => source(i + 1, `s${i + 1}.test`, { inToday: i === 11 }));
    expect(shownSources(many, false).map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 12]);
    expect(shownSources(many, true)).toHaveLength(14);
    expect(shownSources(many.slice(0, 6), false)).toHaveLength(6);
  });

  it("lists the period with the questions we ask, Run now and Configure under it", () => {
    const setup: AskSetup = {
      prompts: { total: 35, enabled: 35, perRun: 30 },
      configuredEngines: ["gemini"],
      activeEngines: ["gemini"],
      latestRun: null,
    };
    expect(askLine(setup)).toBe("Asks Gemini 30 of your 35 questions once.");
    const page: AiAnswersPage = {
      days: 7,
      window: { from: "2026-11-08", to: "2026-11-14" },
      engine: null,
      engines: ["gemini", "perplexity"],
      total: 1,
      offset: 0,
      nextOffset: null,
      answers: [answer()],
      sampled: true,
      note: "",
    };
    const out = html(<AnswersView page={page} setup={setup} days={7} onRun={() => undefined} />);
    expect(out).toContain("AI answers");
    expect(out).toContain("Each one is a sample, not a verdict.");
    expect(out).toContain("All engines");
    expect(out).toContain('href="/growth/ai?engine=gemini"');
    expect(out).toContain("Questions we ask · 35");
    expect(out).toContain('href="/growth/ai/settings#prompts"');
    expect(out).toContain("Run now");
    expect(out).toContain('href="/growth/ai/settings"');
    expect(out).toContain('href="/growth"');

    const empty = html(<AnswersView page={{ ...page, total: 0, answers: [], engines: [] }} setup={setup} days={7} />);
    expect(empty).toContain("No answers in the last 7 days");
    expect(empty).toContain("not measured, not 0");
    expect(empty).toContain('href="/growth/ai?days=28"');
  });
});
