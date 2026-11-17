import { describe, expect, it } from "vitest";
import { canonicalTarget, contentHash, normalizeUrl } from "@/lib/providers/discovery/canonical";

/**
 * One identity per public page, whoever found it. The unique key on
 * placement_targets rests on this: the same Reddit thread from the API and
 * from a web search must produce the same external id, or the inbox shows one
 * opportunity twice and the qualifier pays for it twice.
 */

describe("normalizeUrl", () => {
  it("strips tracking, fragments and trailing slashes, and lowercases the host", () => {
    expect(
      normalizeUrl("HTTPS://Example.com/Path/?utm_source=x&b=2&a=1&fbclid=zzz#section")
    ).toBe("https://example.com/Path?a=1&b=2");
  });

  it("rejects things that are not http(s) URLs", () => {
    expect(normalizeUrl("mailto:someone@example.com")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("canonicalTarget — reddit", () => {
  it("keys a thread by its post id, whatever form the URL took", () => {
    const forms = [
      "https://www.reddit.com/r/SEO/comments/1abc2d/how_do_i_get_cited_by_chatgpt/",
      "https://old.reddit.com/r/SEO/comments/1ABC2D/how_do_i_get_cited_by_chatgpt/k9xyz/?context=3",
      "https://reddit.com/r/SEO/comments/1abc2d?utm_source=share",
    ];
    const ids = forms.map((u) => canonicalTarget(u)?.externalId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe("1abc2d");
    const target = canonicalTarget(forms[0])!;
    expect(target).toMatchObject({ surface: "reddit", kind: "thread", community: "r/SEO" });
    expect(target.url).toBe("https://www.reddit.com/r/SEO/comments/1abc2d/how_do_i_get_cited_by_chatgpt/");
  });

  it("marks a non-thread reddit page as a page, not a thread", () => {
    expect(canonicalTarget("https://www.reddit.com/r/SEO/")?.kind).toBe("page");
  });
});

describe("canonicalTarget — github", () => {
  it("keys issues, discussions and repositories differently", () => {
    expect(canonicalTarget("https://github.com/Owner/Repo/issues/42")).toMatchObject({
      surface: "github",
      kind: "issue",
      externalId: "owner/repo#42",
      community: "Owner/Repo",
      url: "https://github.com/Owner/Repo/issues/42",
    });
    expect(canonicalTarget("https://github.com/owner/repo/discussions/7")).toMatchObject({
      kind: "discussion",
      externalId: "owner/repo#d7",
    });
    expect(canonicalTarget("https://github.com/owner/awesome-seo/blob/main/README.md#tools")).toMatchObject({
      kind: "repository",
      externalId: "owner/awesome-seo",
      url: "https://github.com/owner/awesome-seo",
      author: "owner",
    });
  });

  it("does not mistake a topics or search page for a repository", () => {
    expect(canonicalTarget("https://github.com/topics/seo")?.kind).toBe("page");
  });

  it("keeps a pull request apart from an issue", () => {
    expect(canonicalTarget("https://github.com/owner/repo/pull/9")).toMatchObject({ kind: "page", externalId: "owner/repo#pr9" });
  });
});

describe("canonicalTarget — linkedin and x", () => {
  it("recognises pulse articles and posts", () => {
    expect(canonicalTarget("https://www.linkedin.com/pulse/ai-seo-2026-jane-doe-1a2b/?trackingId=x")).toMatchObject({
      surface: "linkedin",
      kind: "article",
      externalId: "pulse:ai-seo-2026-jane-doe-1a2b",
    });
    expect(canonicalTarget("https://www.linkedin.com/posts/janedoe_seo-activity-123-abcd")).toMatchObject({
      surface: "linkedin",
      kind: "post",
      author: "janedoe",
    });
    expect(canonicalTarget("https://www.linkedin.com/in/janedoe/")?.kind).toBe("page");
  });

  it("keys an X post by its status id across both hosts", () => {
    const a = canonicalTarget("https://twitter.com/jane/status/1234567890?s=20");
    const b = canonicalTarget("https://x.com/jane/status/1234567890");
    expect(a?.externalId).toBe(b?.externalId);
    expect(b).toMatchObject({ surface: "x", kind: "post", community: "@jane", author: "jane", url: "https://x.com/jane/status/1234567890" });
  });

  it("accepts mobile.x.com and mobile.twitter.com, canonical on x.com", () => {
    const mobileX = canonicalTarget("https://mobile.x.com/jane/status/1234567890");
    const mobileTwitter = canonicalTarget("https://mobile.twitter.com/jane/status/1234567890");
    expect(mobileX).toMatchObject({
      surface: "x",
      kind: "post",
      externalId: "status:1234567890",
      url: "https://x.com/jane/status/1234567890",
    });
    expect(mobileTwitter?.externalId).toBe(mobileX?.externalId);
  });

  it("treats an X article as a replyable article, with or without the author in the URL", () => {
    const named = canonicalTarget("https://x.com/SeoGaryTips/article/2104475313543745736?lang=ar-x-fm");
    const bare = canonicalTarget("https://x.com/i/article/2104475313543745736");
    expect(named).toMatchObject({
      surface: "x",
      kind: "article",
      externalId: "article:2104475313543745736",
      url: "https://x.com/SeoGaryTips/article/2104475313543745736",
      community: "@SeoGaryTips",
      author: "SeoGaryTips",
    });
    expect(bare?.externalId).toBe(named?.externalId);
    expect(bare).toMatchObject({ kind: "article", url: "https://x.com/i/article/2104475313543745736", author: null });
    expect(canonicalTarget("https://x.com/SeoWriterBot")?.kind).toBe("page");
  });
});

describe("canonicalTarget — hacker news", () => {
  it("keys an item by its id, whatever else the URL carries", () => {
    const a = canonicalTarget("https://news.ycombinator.com/item?id=40296399&utm_source=x");
    const b = canonicalTarget("https://news.ycombinator.com/item?id=40296399&p=2");
    expect(a).toMatchObject({
      surface: "hackernews",
      kind: "thread",
      externalId: "hn:40296399",
      url: "https://news.ycombinator.com/item?id=40296399",
      community: "Hacker News",
    });
    expect(b?.externalId).toBe(a?.externalId);
  });

  it("keeps the front page and a user page as pages", () => {
    expect(canonicalTarget("https://news.ycombinator.com/news")?.kind).toBe("page");
    expect(canonicalTarget("https://news.ycombinator.com/user?id=pg")).toMatchObject({ surface: "hackernews", kind: "page" });
  });
});

describe("canonicalTarget — stack exchange network", () => {
  it("keys a question by site and id, with the site as the community", () => {
    const long = canonicalTarget("https://ai.stackexchange.com/questions/50654/how-would-i-go-about-creating-an-agent?rq=1");
    const short = canonicalTarget("https://ai.stackexchange.com/q/50654");
    expect(long).toMatchObject({
      surface: "stackexchange",
      kind: "thread",
      externalId: "ai.stackexchange.com:50654",
      community: "ai.stackexchange.com",
      url: "https://ai.stackexchange.com/questions/50654/how-would-i-go-about-creating-an-agent",
    });
    expect(short?.externalId).toBe(long?.externalId);
    expect(canonicalTarget("https://stackoverflow.com/questions/12345/why")).toMatchObject({
      surface: "stackexchange",
      externalId: "stackoverflow.com:12345",
      community: "stackoverflow.com",
    });
  });

  it("does not guess a question from an answer link or a listing", () => {
    expect(canonicalTarget("https://stackoverflow.com/a/999/1")?.kind).toBe("page");
    expect(canonicalTarget("https://agents.stackoverflow.com/all?sort=hot")).toMatchObject({ surface: "stackexchange", kind: "page" });
  });
});

describe("canonicalTarget — quora", () => {
  it("keys a question by its slug, answered or not", () => {
    const a = canonicalTarget("https://www.quora.com/Will-content-writing-be-fully-automated-by-AI?share=1");
    const b = canonicalTarget("https://www.quora.com/unanswered/Will-content-writing-be-fully-automated-by-AI");
    expect(a).toMatchObject({
      surface: "quora",
      kind: "thread",
      externalId: "q:will-content-writing-be-fully-automated-by-ai",
      url: "https://www.quora.com/Will-content-writing-be-fully-automated-by-AI",
      community: "Quora",
    });
    expect(b?.externalId).toBe(a?.externalId);
  });

  it("treats a Space post as a post in that space, and topics or profiles as pages", () => {
    expect(canonicalTarget("https://contenttipsandtricks.quora.com/Is-there-a-difference-between-a-calendar-and-automation")).toMatchObject({
      surface: "quora",
      kind: "post",
      externalId: "space:contenttipsandtricks/is-there-a-difference-between-a-calendar-and-automation",
      community: "contenttipsandtricks.quora.com",
    });
    expect(canonicalTarget("https://www.quora.com/topic/Search-Engine-Optimization")?.kind).toBe("page");
    expect(canonicalTarget("https://www.quora.com/profile/Jane-Doe")?.kind).toBe("page");
  });
});

describe("canonicalTarget — indie hackers and dev", () => {
  it("keys an Indie Hackers post by its slug", () => {
    expect(canonicalTarget("https://www.indiehackers.com/post/5-ai-agent-workflows-ea266790ba?utm_source=x")).toMatchObject({
      surface: "indiehackers",
      kind: "thread",
      externalId: "post:5-ai-agent-workflows-ea266790ba",
      url: "https://www.indiehackers.com/post/5-ai-agent-workflows-ea266790ba",
      community: "Indie Hackers",
    });
    expect(canonicalTarget("https://www.indiehackers.com/products")?.kind).toBe("page");
  });

  it("keys a DEV article by author and slug, and knows a tag listing is not one", () => {
    expect(canonicalTarget("https://dev.to/kai_writes/i-let-ai-agents-run-my-blog-9x2z")).toMatchObject({
      surface: "devto",
      kind: "article",
      externalId: "kai_writes/i-let-ai-agents-run-my-blog-9x2z",
      author: "kai_writes",
      community: "DEV Community",
    });
    expect(canonicalTarget("https://dev.to/t/seo")?.kind).toBe("page");
    expect(canonicalTarget("https://dev.to/kai_writes/some-article/comments")?.kind).toBe("page");
  });
});

describe("canonicalTarget — anything else", () => {
  it("is a web page keyed by its normalised URL, never dropped", () => {
    const a = canonicalTarget("https://blog.hubspot.com/marketing/is-ai-killing-web-traffic?utm_source=x");
    const b = canonicalTarget("https://blog.hubspot.com/marketing/is-ai-killing-web-traffic");
    expect(a?.surface).toBe("web");
    expect(a?.externalId).toBe(b?.externalId);
    expect(a?.community).toBe("blog.hubspot.com");
  });

  it("returns null for an unparsable URL", () => {
    expect(canonicalTarget("nope")).toBeNull();
  });
});

describe("contentHash", () => {
  it("collapses the same question with different punctuation and case", () => {
    expect(contentHash("How do I get cited by ChatGPT?")).toBe(contentHash("how do i get cited by chatgpt"));
  });

  it("keeps different questions apart", () => {
    expect(contentHash("How do I get cited by ChatGPT?")).not.toBe(contentHash("How do I get cited by Perplexity?"));
  });

  it("uses the excerpt to disambiguate a very short title", () => {
    expect(contentHash("Help please", "my cast iron pan")).not.toBe(contentHash("Help please", "my sourdough"));
  });
});
