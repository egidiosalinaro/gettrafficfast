import { describe, expect, it } from "vitest";
import type { SerpData, SerpProvider, SerpQuery } from "@/lib/providers/serp/types";
import { SerpProviderError } from "@/lib/providers/serp/types";
import {
  DEFAULT_SCOPES,
  REDDIT_ARCHIVE_DAYS,
  discussionsFromResults,
  splitLeadingDate,
  WebSearchDiscoveryProvider,
} from "@/lib/providers/discovery/web-search";
import { parseGitHubIssues, parseGitHubRepos } from "@/lib/providers/discovery/github";
import { DiscoveryProviderError } from "@/lib/providers/discovery/types";

/**
 * The two discovery surfaces that need no platform credential. What is pinned
 * is the contract: what a search result knows is a URL, a title and a
 * snippet, and everything else is derived or honestly null; GitHub's payload
 * maps onto the platform shape with PRs, locked issues, archived lists and
 * forks removed.
 */

describe("splitLeadingDate", () => {
  const now = new Date("2026-09-29T12:00:00Z");

  it("reads and strips the date a snippet opens with", () => {
    const { createdAt, createdAtPrecision, text } = splitLeadingDate("Aug 12, 2026 — I keep losing rankings to AI answers…", now);
    expect(createdAt?.slice(0, 10)).toBe("2026-08-12");
    expect(createdAtPrecision).toBe("day");
    expect(text).toBe("I keep losing rankings to AI answers…");
  });

  it("reads a distance the same way, as the bound it is", () => {
    const { createdAt, createdAtPrecision, text } = splitLeadingDate("4 months ago · Anyone using an AI SEO tool?", now);
    expect(createdAt).toBe("2026-05-29T12:00:00.000Z");
    expect(createdAtPrecision).toBe("month");
    expect(text).toBe("Anyone using an AI SEO tool?");
  });

  it("leaves the date null when there is none, rather than 'today', and the text whole", () => {
    expect(splitLeadingDate("No date here.", now)).toEqual({ createdAt: null, createdAtPrecision: null, text: "No date here." });
    // A dash inside a sentence is not a date separator.
    expect(splitLeadingDate("Best AI tools - what I use daily", now)).toEqual({
      createdAt: null,
      createdAtPrecision: null,
      text: "Best AI tools - what I use daily",
    });
  });
});

describe("discussionsFromResults", () => {
  const results = [
    {
      position: 1,
      title: "How do I get my site cited by ChatGPT? : r/SEO",
      url: "https://www.reddit.com/r/SEO/comments/1abc2d/how_do_i/?utm_source=share",
      domain: "reddit.com",
      snippet: "Aug 12, 2026 — I keep losing to AI answers.",
    },
    {
      position: 2,
      title: "Add GetTrafficFast to the list · Issue #12 · owner/awesome-seo",
      url: "https://github.com/owner/awesome-seo/issues/12",
      domain: "github.com",
      snippet: "It would be nice to list AEO tools.",
    },
    {
      position: 3,
      title: "duplicate of the reddit thread",
      url: "https://old.reddit.com/r/SEO/comments/1abc2d/how_do_i/",
      domain: "reddit.com",
      snippet: "",
    },
    { position: 4, title: "", url: "https://example.com/untitled", domain: "example.com", snippet: "" },
  ];

  it("derives surface, kind, community and identity from the URL, with unknowns null", () => {
    const discussions = discussionsFromResults(results);
    expect(discussions).toHaveLength(2);
    expect(discussions[0]).toMatchObject({
      surface: "reddit",
      kind: "thread",
      externalId: "1abc2d",
      community: "r/SEO",
      title: "How do I get my site cited by ChatGPT?",
      excerpt: "I keep losing to AI answers.",
      score: null,
      commentCount: null,
    });
    expect(discussions[0].createdAt?.slice(0, 10)).toBe("2026-08-12");
    expect(discussions[0].createdAtPrecision).toBe("day");
    expect(discussions[1]).toMatchObject({
      surface: "github",
      kind: "issue",
      externalId: "owner/awesome-seo#12",
      title: "Add GetTrafficFast to the list",
      createdAt: null,
      createdAtPrecision: null,
    });
  });

  it("takes the engine's own date field first, snippet or no snippet", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const [dated, undated] = discussionsFromResults(
      [
        {
          position: 1,
          title: "Old thread : r/SEO",
          url: "https://www.reddit.com/r/SEO/comments/1l4x1q0/old/",
          domain: "reddit.com",
          snippet: "No leading date in the snippet.",
          publishedAt: "2025-06-06T00:00:00.000Z",
          publishedAtPrecision: "day",
        },
        {
          position: 2,
          title: "Newer thread : r/SEO",
          url: "https://www.reddit.com/r/SEO/comments/1wdgutr/new/",
          domain: "reddit.com",
          snippet: "Nothing here either.",
          publishedAt: null,
          publishedAtPrecision: null,
        },
      ],
      now
    );
    expect(dated).toMatchObject({ externalId: "1l4x1q0", createdAt: "2025-06-06T00:00:00.000Z", createdAtPrecision: "day", excerpt: "No leading date in the snippet." });
    expect(undated).toMatchObject({ externalId: "1wdgutr", createdAt: null, createdAtPrecision: null });
  });

  it("maps the community sites onto their own surfaces and strips the site name from the title", () => {
    const discussions = discussionsFromResults([
      { position: 1, title: "Ask HN: How do you get cited by ChatGPT? | Hacker News", url: "https://news.ycombinator.com/item?id=40296399", domain: "news.ycombinator.com", snippet: "" },
      { position: 2, title: "How do I get my content cited by AI answer engines? - Quora", url: "https://www.quora.com/How-do-I-get-my-content-cited-by-AI-answer-engines", domain: "quora.com", snippet: "" },
      { position: 3, title: "seo - How do answer engines pick sources? - Webmasters Stack Exchange", url: "https://webmasters.stackexchange.com/questions/1234/how-do-answer-engines-pick-sources", domain: "webmasters.stackexchange.com", snippet: "" },
      { position: 4, title: "5 AI agent workflows actually making money - Indie Hackers", url: "https://www.indiehackers.com/post/5-ai-agent-workflows-ea266790ba", domain: "indiehackers.com", snippet: "" },
      { position: 5, title: "I let AI agents run my blog for 6 weeks - DEV Community", url: "https://dev.to/kai_writes/i-let-ai-agents-run-my-blog-9x2z", domain: "dev.to", snippet: "" },
    ]);
    expect(discussions.map((d) => [d.surface, d.kind, d.title])).toEqual([
      ["hackernews", "thread", "Ask HN: How do you get cited by ChatGPT?"],
      ["quora", "thread", "How do I get my content cited by AI answer engines?"],
      ["stackexchange", "thread", "How do answer engines pick sources?"],
      ["indiehackers", "thread", "5 AI agent workflows actually making money"],
      ["devto", "article", "I let AI agents run my blog for 6 weeks"],
    ]);
  });
});

function serp(handler: (q: SerpQuery) => SerpData | Promise<SerpData>): SerpProvider {
  return { name: "fake-serp", search: async (q) => handler(q) };
}

const empty = (keyword: string): SerpData => ({ keyword, results: [], peopleAlsoAsk: [], relatedSearches: [], raw: {} });

describe("WebSearchDiscoveryProvider", () => {
  it("runs one scoped search per platform and merges the results by identity", async () => {
    const asked: string[] = [];
    const provider = new WebSearchDiscoveryProvider(
      serp((q) => {
        asked.push(q.keyword);
        if (q.keyword.includes("site:reddit.com")) {
          return {
            ...empty(q.keyword),
            results: [
              { position: 1, title: "A thread : r/SEO", url: "https://www.reddit.com/r/SEO/comments/1abc2d/a/", domain: "reddit.com", snippet: "" },
            ],
          };
        }
        if (q.keyword.includes("communities")) return empty(q.keyword);
        return empty(q.keyword);
      })
    );

    const found = await provider.search({ query: "ai seo tool", language: "en" });
    expect(asked).toHaveLength(DEFAULT_SCOPES.length);
    expect(asked.every((k) => k.startsWith("ai seo tool site:"))).toBe(true);
    expect(found).toHaveLength(1);
    expect(found[0].surface).toBe("reddit");
  });

  it("asks the engine for the archive window on Reddit only: an archived thread is paid for and thrown away", async () => {
    const windows: Array<[string, number | undefined]> = [];
    const provider = new WebSearchDiscoveryProvider(
      serp((q) => {
        windows.push([q.keyword, q.maxAgeDays]);
        return empty(q.keyword);
      })
    );
    await provider.search({ query: "q", language: "en", maxAgeDays: 365 });
    const reddit = windows.find(([k]) => k.includes("site:reddit.com"));
    expect(reddit?.[1]).toBe(REDDIT_ARCHIVE_DAYS);
    for (const [keyword, window] of windows) {
      if (!keyword.includes("site:reddit.com")) expect(window, keyword).toBeUndefined();
    }
  });

  it("loses one failing scope, not the run", async () => {
    const provider = new WebSearchDiscoveryProvider(
      serp((q) => {
        if (q.keyword.includes("site:x.com")) throw new SerpProviderError("boom", "fake-serp", undefined, { status: 500 });
        return {
          ...empty(q.keyword),
          results: [{ position: 1, title: "Some issue · Issue #1 · o/r", url: "https://github.com/o/r/issues/1", domain: "github.com", snippet: "" }],
        };
      })
    );
    const found = await provider.search({ query: "q", language: "en" });
    expect(found).toHaveLength(1);
  });

  it("stops the provider on a rate limit so the run can back off", async () => {
    const provider = new WebSearchDiscoveryProvider(
      serp(() => {
        throw new SerpProviderError("slow down", "fake-serp", undefined, { status: 429 });
      })
    );
    let thrown: unknown;
    try {
      await provider.search({ query: "q", language: "en" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DiscoveryProviderError);
    expect((thrown as DiscoveryProviderError).rateLimited).toBe(true);
  });
});

describe("parseGitHubIssues", () => {
  const issue = (over: Record<string, unknown> = {}) => ({
    number: 12,
    title: "Add support for AEO tools",
    body: "It would be great to list tools that measure AI citations.\r\nThanks!",
    html_url: "https://github.com/owner/awesome-seo/issues/12",
    repository_url: "https://api.github.com/repos/owner/awesome-seo",
    user: { login: "maintainer" },
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
    comments: 3,
    reactions: { total_count: 5 },
    state: "open",
    ...over,
  });

  it("maps an issue onto the platform shape", () => {
    const [d] = parseGitHubIssues({ items: [issue()] });
    expect(d).toMatchObject({
      surface: "github",
      kind: "issue",
      externalId: "owner/awesome-seo#12",
      community: "owner/awesome-seo",
      author: "maintainer",
      score: 5,
      commentCount: 3,
      createdAt: "2026-09-01T00:00:00Z",
    });
    expect(d.excerpt).not.toContain("\r");
  });

  it("drops pull requests and locked issues", () => {
    expect(parseGitHubIssues({ items: [issue({ pull_request: { url: "x" } })] })).toEqual([]);
    expect(parseGitHubIssues({ items: [issue({ locked: true })] })).toEqual([]);
  });
});

describe("parseGitHubRepos", () => {
  const repo = (over: Record<string, unknown> = {}) => ({
    full_name: "owner/awesome-seo",
    html_url: "https://github.com/owner/awesome-seo",
    description: "A curated list of SEO and AEO tools.",
    stargazers_count: 1200,
    pushed_at: "2026-09-15T00:00:00Z",
    owner: { login: "owner" },
    archived: false,
    fork: false,
    ...over,
  });

  it("maps a list repository, with the last push as its freshness date", () => {
    const [d] = parseGitHubRepos({ items: [repo()] });
    expect(d).toMatchObject({
      kind: "repository",
      externalId: "owner/awesome-seo",
      title: "owner/awesome-seo",
      score: 1200,
      commentCount: null,
      createdAt: "2026-09-15T00:00:00Z",
    });
  });

  it("drops archived repositories and forks", () => {
    expect(parseGitHubRepos({ items: [repo({ archived: true })] })).toEqual([]);
    expect(parseGitHubRepos({ items: [repo({ fork: true })] })).toEqual([]);
  });
});
