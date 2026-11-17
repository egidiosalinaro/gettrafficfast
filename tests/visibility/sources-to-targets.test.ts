import { describe, expect, it } from "vitest";
import { AI_VISIBILITY_SOURCE, aiCitationLine, parseAiCitation } from "@/lib/placements/ai-citation";
import { applyRules, freshnessDays } from "@/lib/placements/rules";
import { LISTICLE_KIND, takesReply, variantsFor } from "@/lib/placements/workflow";
import {
  MAX_NEW_TARGETS_PER_RUN,
  citationOf,
  isListicle,
  passRules,
  planTargets,
  rankSources,
  reasonOf,
  redirectsToResolve,
  targetRowOf,
  titleFromUrl,
  type SelectionContext,
  type SourceProbe,
} from "@/lib/visibility/sources-to-targets";

/**
 * From a run's cited sources to reply targets, without I/O. Pinned: only
 * answers that did not cite the site count; own and competitor pages and
 * pages with nowhere to take part are left out and counted; a list article
 * is its own kind; the order is prompts, then engines, then answers; a page
 * already held is never created again; the cap holds and the next run takes
 * the next pages; and nothing the answer did not say is filled in.
 */

const NOW = new Date("2026-11-10T12:00:00.000Z");

const CTX: SelectionContext = {
  ownDomains: ["acme.test", "blog.acme.test"],
  competitorDomains: ["rival.test"],
};

const REDIRECT = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;

const source = (url: string, title = "") => ({ url, domain: new URL(url).hostname.replace(/^www\./, ""), title });

const probe = (
  query: string,
  engine: string,
  sources: Array<{ url: string; domain: string; title: string }>,
  over: Partial<SourceProbe> = {}
): SourceProbe => ({ queryId: `id:${query}`, query, engine, status: "not_cited", sources, ...over });

const THREAD = "https://www.reddit.com/r/SEO/comments/1xyz111/what_ai_seo_tool_do_you_use/";
const LISTICLE = "https://toolblog.test/best-ai-seo-tools-2026";
const X_POST = "https://x.com/founder/status/1850000000000000000";

/** A fixture run: three prompts, two engines, the mix a real run returns. */
const RUN: SourceProbe[] = [
  probe("best ai seo tool", "gemini", [
    source(THREAD, "What AI SEO tool do you use? : r/SEO"),
    source("https://rival.test/pricing", "Rival pricing"),
    source(LISTICLE, "The 12 Best AI SEO Tools in 2026"),
  ]),
  probe("best ai seo tool", "perplexity", [
    // The same thread, as another engine links it: old.reddit, tracking, a comment anchor.
    source("https://old.reddit.com/r/SEO/comments/1xyz111/what_ai_seo_tool_do_you_use/?utm_source=share#c1"),
    source("https://someblog.test/about", "About us"),
  ]),
  probe("how to get cited by ai", "gemini", [source(THREAD), source(X_POST, "A post on X")]),
  probe("ai seo for startups", "perplexity", [source(THREAD), source(LISTICLE)]),
  // The site was cited here: this answer is not where a place is missing.
  probe("what is aeo", "gemini", [source("https://acme.test/aeo"), source("https://news.ycombinator.com/item?id=4242")], {
    status: "cited",
  }),
  // Not readable: no sources to act on, and never counted.
  probe("broken", "gemini", [source("https://www.quora.com/Which-AI-SEO-tool-is-best")], { status: "error" }),
  probe("empty", "gemini", [], { status: "invalid" }),
];

describe("which cited sources become candidates", () => {
  it("reads only the answers that did not cite the site, and ranks by prompts, then engines", () => {
    const { candidates } = rankSources(RUN, CTX);

    expect(candidates.map((c) => [c.surface, c.kind, c.prompts.length, c.engines])).toEqual([
      // Three prompts, two engines.
      ["reddit", "thread", 3, ["gemini", "perplexity"]],
      // Two prompts, two engines: outranks the post cited once.
      ["web", LISTICLE_KIND, 2, ["gemini", "perplexity"]],
      ["x", "post", 1, ["gemini"]],
    ]);
    // The cited answer's sources and the unreadable probes' are not here.
    expect(candidates.some((c) => c.surface === "hackernews" || c.surface === "quora")).toBe(false);
  });

  it("keeps one candidate per page, whatever form its address took", () => {
    const { candidates } = rankSources(RUN, CTX);
    const thread = candidates[0];
    expect(thread.externalId).toBe("1xyz111");
    expect(thread.url).toBe(THREAD);
    // Engines are kept per prompt, by name: never one merged number.
    expect(thread.prompts[0]).toEqual({
      queryId: "id:best ai seo tool",
      query: "best ai seo tool",
      engines: ["gemini", "perplexity"],
    });
    expect(thread.sightings).toBe(4);
  });

  it("a source cited for 3 prompts on 2 engines outranks one cited once", () => {
    const { candidates } = rankSources(
      [
        probe("p1", "gemini", [source(X_POST), source(THREAD)]),
        probe("p2", "gemini", [source(THREAD)]),
        probe("p3", "perplexity", [source(THREAD)]),
      ],
      CTX
    );
    expect(candidates.map((c) => c.surface)).toEqual(["reddit", "x"]);
  });

  it("with scope all, also reads the answers that cited the site", () => {
    const { candidates } = rankSources(RUN, { ...CTX, scope: "all" });
    expect(candidates.some((c) => c.surface === "hackernews")).toBe(true);
    // Still never the site's own page.
    expect(candidates.some((c) => c.url.includes("acme.test"))).toBe(false);
  });
});

describe("what is left out, and counted", () => {
  it("drops the site's own domains, subdomains included", () => {
    const { candidates, dropped } = rankSources(
      [
        probe("p", "perplexity", [
          source("https://acme.test/best-tools-for-seo"),
          source("https://docs.acme.test/guide"),
          source("https://blog.acme.test/top-10-tools"),
          // A lookalike is not the site.
          source("https://notacme.test/best-tools-for-seo"),
        ]),
      ],
      CTX
    );
    expect(candidates.map((c) => c.url)).toEqual(["https://notacme.test/best-tools-for-seo"]);
    expect(dropped.own_site).toBeGreaterThan(0);
  });

  it("drops a competitor's own pages, even one that reads like a list", () => {
    const { candidates, dropped } = rankSources(
      [
        probe("p", "perplexity", [
          source("https://rival.test/"),
          source("https://rival.test/alternatives/acme", "Best Acme alternatives"),
          source("https://app.rival.test/pricing"),
        ]),
      ],
      CTX
    );
    expect(candidates).toEqual([]);
    expect(dropped.competitor).toBe(3);
  });

  it("drops pages with nowhere to take part: a homepage, a product page, a profile, a project's repository", () => {
    const { candidates, dropped } = rankSources(
      [
        probe("p", "perplexity", [
          source("https://unknownvendor.test/", "The best SEO tool"),
          source("https://unknownvendor.test/features/reporting"),
          source("https://www.reddit.com/r/SEO/"),
          source("https://x.com/founder"),
          source("https://github.com/vendor/product"),
        ]),
      ],
      CTX
    );
    expect(candidates).toEqual([]);
    expect(dropped.not_a_place).toBe(5);
  });

  it("keeps the places a person can take part in or be listed on", () => {
    const { candidates } = rankSources(
      [
        probe("p", "perplexity", [
          source("https://www.reddit.com/r/SaaS/comments/1xyz222/which_tool/"),
          source("https://news.ycombinator.com/item?id=4242"),
          source("https://www.quora.com/Which-AI-SEO-tool-is-best"),
          source("https://stackoverflow.com/questions/123/how-to-track-ai-citations"),
          source("https://www.indiehackers.com/post/how-i-got-cited-abc123"),
          source("https://dev.to/jane/ai-seo-in-practice-4f2a"),
          source("https://x.com/founder/status/1850000000000000001"),
          source("https://www.linkedin.com/posts/jane_ai-seo-activity-7-abcd"),
          source("https://github.com/someone/awesome-seo-tools"),
          source("https://github.com/vendor/product/issues/12"),
          source("https://toolblog.test/acme-vs-rival-compared"),
        ]),
      ],
      CTX
    );
    expect(candidates.map((c) => `${c.surface}:${c.kind}`).sort()).toEqual(
      [
        "reddit:thread",
        "hackernews:thread",
        "quora:thread",
        "stackexchange:thread",
        "indiehackers:thread",
        "devto:article",
        "x:post",
        "linkedin:post",
        "github:repository",
        "github:issue",
        `web:${LISTICLE_KIND}`,
      ].sort()
    );
  });

  it("counts a source redirect nobody read back as unread, and never guesses its page", () => {
    const grounded = { url: REDIRECT("abc"), domain: "reddit.com", title: "reddit.com" };
    const unread = rankSources([probe("p", "gemini", [grounded])], CTX);
    expect(unread.candidates).toEqual([]);
    expect(unread.dropped.unread).toBe(1);

    const read = rankSources([probe("p", "gemini", [grounded])], {
      ...CTX,
      resolved: new Map([[REDIRECT("abc"), THREAD]]),
    });
    expect(read.candidates.map((c) => c.url)).toEqual([THREAD]);
    // The engine's "title" was a hostname: the words come from the address, and say so.
    expect(read.candidates[0]).toMatchObject({ title: "what ai seo tool do you use", titleFrom: "url" });
  });

  it("drops a redirect that resolved to the site's own page", () => {
    const { candidates, dropped } = rankSources(
      [probe("p", "gemini", [{ url: REDIRECT("own"), domain: "", title: "" }])],
      { ...CTX, resolved: new Map([[REDIRECT("own"), "https://acme.test/best-tools-for-seo"]]) }
    );
    expect(candidates).toEqual([]);
    expect(dropped.own_site).toBe(1);
  });
});

describe("list articles", () => {
  it.each([
    ["https://toolblog.test/best-ai-seo-tools", null],
    ["https://toolblog.test/blog/top-10-seo-platforms", null],
    ["https://toolblog.test/acme-alternatives", null],
    ["https://toolblog.test/semrush-vs-ahrefs", null],
    ["https://toolblog.test/tools-for-startups", null],
    ["https://toolblog.test/p/4821", "7 Best Tools for AI Search in 2026"],
    ["https://toolblog.test/i-migliori-strumenti-seo", null],
  ])("%s reads as one", (url, title) => {
    expect(isListicle(url, title)).toBe(true);
  });

  it.each([
    ["https://bestbuy.test/", "Best deals"],
    ["https://toolblog.test/pricing", "Pricing"],
    ["https://toolblog.test/blog/how-we-grew", "How we grew"],
  ])("%s does not", (url, title) => {
    // A front page is never one, whatever its title says.
    expect(isListicle(url, title)).toBe(false);
  });

  it("is its own kind on the web surface, evergreen, with no reply to draft", () => {
    const { candidates } = rankSources([probe("p", "perplexity", [source(LISTICLE, "The 12 Best AI SEO Tools in 2026")])], CTX);
    expect(candidates[0]).toMatchObject({ surface: "web", kind: LISTICLE_KIND, title: "The 12 Best AI SEO Tools in 2026", titleFrom: "source" });
    expect(freshnessDays(LISTICLE_KIND)).toBeNull();
    expect(takesReply(LISTICLE_KIND)).toBe(false);
    expect(variantsFor("web", LISTICLE_KIND)).toEqual([]);
    // A thread still takes one.
    expect(variantsFor("reddit", "thread").length).toBeGreaterThan(0);
  });

  it("passes the inbox rules that reject a plain web page", () => {
    const target = {
      surface: "web",
      url: LISTICLE,
      title: "The 12 Best AI SEO Tools in 2026",
      excerpt: null,
      community: "toolblog.test",
      posted_at: null,
      comment_count: null,
      found_for: "best ai seo tool",
    };
    const ctx = { now: NOW, ownDomains: ["acme.test"], expertise: [] };
    expect(applyRules({ ...target, kind: "page" }, ctx)).toMatchObject({ status: "rejected", rule: "not_answerable" });
    expect(applyRules({ ...target, kind: LISTICLE_KIND }, ctx)).toMatchObject({ status: "pass" });
  });
});

describe("the inbox rules, before anything is stored", () => {
  it("turns down a page behind a login, an archived Reddit thread and a promotional title, by rule name", () => {
    const { candidates } = rankSources(
      [
        probe("p", "perplexity", [
          source(THREAD),
          // Below a thread known to be over 180 days old: archived, nowhere to post.
          source("https://www.reddit.com/r/SEO/comments/1abc234/an_old_question_about_seo/"),
          source("https://www.reddit.com/r/SEO/comments/1xyz333/hiring_seo_freelancer_for_saas/", "We're hiring an SEO freelancer"),
        ]),
      ],
      CTX
    );
    const pass = passRules(candidates, { now: NOW, ownDomains: CTX.ownDomains, redditArchivedBelow: "1sil7jg" });
    expect(pass.kept.map((c) => c.externalId)).toEqual(["1xyz111"]);
    expect(pass.rejected).toEqual({ archived: 1, promotional: 1 });
  });
});

describe("the cap, and the rotation", () => {
  const many: SourceProbe[] = [
    probe(
      "p",
      "perplexity",
      Array.from({ length: 14 }, (_, i) => source(`https://www.reddit.com/r/SEO/comments/1xyz${String(i).padStart(3, "0")}/thread_number_${i}_about_seo/`))
    ),
  ];

  it("creates at most the cap, and counts the rest as waiting", () => {
    const { candidates } = rankSources(many, CTX);
    const plan = planTargets(candidates, new Set());
    expect(MAX_NEW_TARGETS_PER_RUN).toBe(10);
    expect(plan.create).toHaveLength(10);
    expect(plan.deferred).toBe(4);
    expect(plan.link).toEqual([]);
  });

  it("the next run takes the next pages: what was created is held, never created again", () => {
    const { candidates } = rankSources(many, CTX);
    const first = planTargets(candidates, new Set());
    const held = new Set(first.create.map((c) => c.key));
    const second = planTargets(candidates, held);
    expect(second.create).toHaveLength(4);
    expect(second.create.some((c) => held.has(c.key))).toBe(false);
    expect(second.link).toHaveLength(10);
    expect(second.deferred).toBe(0);
    // And a third run has nothing new.
    const third = planTargets(candidates, new Set(candidates.map((c) => c.key)));
    expect(third.create).toEqual([]);
  });

  it("a cap of zero creates nothing", () => {
    const { candidates } = rankSources(many, CTX);
    expect(planTargets(candidates, new Set(), 0).create).toEqual([]);
  });
});

describe("which redirects are worth reading back", () => {
  it("platform hosts first, then the most cited, never own or competitor hosts, under the limit", () => {
    const g = (id: string, domain: string) => ({ url: REDIRECT(id), domain, title: domain });
    const probes = [
      probe("p1", "gemini", [g("blog1", "toolblog.test"), g("red1", "reddit.com"), g("own", "acme.test"), g("riv", "rival.test")]),
      probe("p2", "gemini", [g("blog2", "toolblog.test"), g("hn1", "news.ycombinator.com")]),
      // A real address needs no lookup.
      probe("p3", "perplexity", [source(THREAD)]),
      // The site was cited: not read.
      probe("p4", "gemini", [g("cited", "reddit.com")], { status: "cited" }),
    ];
    expect(redirectsToResolve(probes, CTX)).toEqual([REDIRECT("hn1"), REDIRECT("red1"), REDIRECT("blog1"), REDIRECT("blog2")]);
    expect(redirectsToResolve(probes, CTX, 2)).toHaveLength(2);
  });
});

describe("the row, and the words on it", () => {
  const { candidates } = rankSources(RUN, CTX);
  const [thread, listicle] = candidates;
  const params = { userId: "user-1", businessId: "biz-1", runId: "run-1", checkedAt: "2026-11-10T10:00:00.000Z", now: NOW };

  it("is qualified by the citation, linked to the prompt, and fills in nothing the answer did not say", () => {
    const row = targetRowOf(thread, params);
    expect(row).toMatchObject({
      user_id: "user-1",
      business_id: "biz-1",
      surface: "reddit",
      kind: "thread",
      external_id: "1xyz111",
      url: THREAD,
      found_via: AI_VISIBILITY_SOURCE,
      found_for: "best ai seo tool",
      aeo_query_id: "id:best ai seo tool",
      status: "qualified",
      qualified_by: AI_VISIBILITY_SOURCE,
      // No model and no person scored it; no date, text or engagement was given.
      qualify_score: null,
      qualify_angle: null,
      excerpt: null,
      posted_at: null,
      score: null,
      comment_count: null,
    });
    expect(parseAiCitation(row.ai_citation)).toEqual(citationOf(thread, params));
  });

  it("says sampled, names the engine, and promises nothing about the engine", () => {
    const citation = citationOf(thread, params);
    expect(citation.promptCount).toBe(3);
    expect(aiCitationLine(citation)).toBe(
      "Cited in a sampled AI answer for: “best ai seo tool” (Gemini and Perplexity), and 2 more prompts."
    );
    expect(reasonOf(thread)).toBe(
      "Cited in a sampled Gemini and Perplexity answer to your prompt “best ai seo tool”, which did not cite your site."
    );
    for (const text of [aiCitationLine(citation), reasonOf(thread), reasonOf(listicle)]) {
      expect(text).toMatch(/sampled/);
      expect(text).not.toMatch(/always|reads|ranks|every time/i);
    }
  });

  it("a list article's row says to ask the author, and that nothing is sent", () => {
    const row = targetRowOf(listicle, params);
    expect(row).toMatchObject({ surface: "web", kind: LISTICLE_KIND, status: "qualified", fresh_until: null });
    expect(row.qualify_reason).toMatch(/ask its author/i);
    expect(row.qualify_reason).toMatch(/Nothing is written or sent for you/);
  });

  it("a malformed stored sighting reads as none", () => {
    expect(parseAiCitation(null)).toBeNull();
    expect(parseAiCitation({ prompts: [] })).toBeNull();
    expect(parseAiCitation("gemini")).toBeNull();
  });
});

describe("a title read off the address", () => {
  it.each([
    ["https://www.reddit.com/r/SEO/comments/1xyz111/what_ai_seo_tool_do_you_use/", "what ai seo tool do you use"],
    ["https://www.quora.com/Which-AI-SEO-tool-is-best", "Which AI SEO tool is best"],
    ["https://x.com/founder/status/1850000000000000000", "x.com/founder/status/1850000000000000000"],
    ["https://news.ycombinator.com/item?id=4242", "news.ycombinator.com/item?id=4242"],
  ])("%s → %s", (url, title) => {
    expect(titleFromUrl(url)).toBe(title);
  });
});
