import { describe, expect, it } from "vitest";
import { dateFromUrl, linkedinIdPostedAt, postDateRequestFor } from "@/lib/placements/date-from-url";

/**
 * 2026-11-13: "Found for you" showed a flood of "date unknown", and a run
 * surfaced X posts from 5 October as new. On X and LinkedIn the URL is the
 * date; elsewhere it names the free API that knows it.
 */

const NOW = new Date("2026-11-12T12:00:00Z");

describe("X status ids", () => {
  // Made from the snowflake layout: (ms - 1288834974657) << 22, plus low bits.
  const OCT_5 = "2107116094878658617"; // 2026-10-05T14:30:00Z

  it("reads the instant from a /status/ URL, in every host form", () => {
    for (const url of [
      `https://x.com/someone/status/${OCT_5}`,
      `https://twitter.com/someone/status/${OCT_5}?s=20`,
      `https://mobile.twitter.com/someone/status/${OCT_5}/photo/1`,
      `https://x.com/i/web/status/${OCT_5}`,
    ]) {
      expect(dateFromUrl(url, NOW)).toEqual({ at: "2026-10-05T14:30:00.000Z", method: "x_snowflake" });
    }
  });

  it("matches a real post's id to its known day", () => {
    // Post 20 (March 2006) has a counter id from before snowflakes: not read.
    expect(dateFromUrl("https://twitter.com/jack/status/20", NOW)).toBeNull();
    // 1585841080431321088 is "the bird is freed", posted 27 October 2022 at
    // 23:49 New York time, 03:49 UTC on the 28th.
    expect(dateFromUrl("https://twitter.com/example_user/status/1585841080431321088", NOW)?.at.slice(0, 10)).toBe("2022-10-28");
  });

  it("does not date an X article, a profile or a future id", () => {
    expect(dateFromUrl(`https://x.com/someone/article/${OCT_5}`, NOW)).toBeNull();
    expect(dateFromUrl("https://x.com/someone", NOW)).toBeNull();
    const future = ((BigInt(Date.UTC(2026, 10, 20)) - BigInt(1288834974657)) << BigInt(22)).toString();
    expect(dateFromUrl(`https://x.com/someone/status/${future}`, NOW)).toBeNull();
  });
});

describe("LinkedIn ids", () => {
  it("reads the first 41 bits as Unix milliseconds: 7250000000000000000 is October 2024", () => {
    expect(linkedinIdPostedAt("7250000000000000000", NOW)).toBe("2024-10-10T04:31:38.486Z");
  });

  it("reads every URL form that carries the id", () => {
    const id = "7525844700364800777"; // 2026-11-10T09:00:00Z
    const expected = { at: "2026-11-10T09:00:00.000Z", method: "linkedin_id" };
    for (const url of [
      `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
      `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${id}`,
      `https://www.linkedin.com/feed/update/urn:li:ugcPost:${id}`,
      `https://www.linkedin.com/feed/update/urn:li:share:${id}`,
      `https://www.linkedin.com/posts/maya-rossi_aeo-seo-activity-${id}-AbCd`,
      `https://it.linkedin.com/posts/maya-rossi_aeo-ugcPost-${id}-x9Yz`,
      `https://www.linkedin.com/embed/feed/update/urn:li:share:${id}`,
    ]) {
      expect(dateFromUrl(url, NOW)).toEqual(expected);
    }
  });

  it("rejects an id outside 2016 to a day from now", () => {
    expect(linkedinIdPostedAt("6010927526707200000", NOW)).toBeNull(); // June 2015
    expect(linkedinIdPostedAt("7529332683571200000", NOW)).toBeNull(); // 20 November 2026
    expect(linkedinIdPostedAt("12345", NOW)).toBeNull();
    expect(linkedinIdPostedAt("not-a-number", NOW)).toBeNull();
  });

  it("leaves an article and a post slug without an id unknown", () => {
    expect(dateFromUrl("https://www.linkedin.com/pulse/how-we-doubled-ai-citations-maya-rossi-abcde", NOW)).toBeNull();
    expect(dateFromUrl("https://www.linkedin.com/posts/maya-rossi_aeo-seo", NOW)).toBeNull();
  });
});

describe("the platforms whose URL carries no time", () => {
  it("leaves the date to an API, never to the URL", () => {
    for (const url of [
      "https://www.reddit.com/r/SEO/comments/1gq4b1z/how_do_i_get_cited/",
      "https://news.ycombinator.com/item?id=41234567",
      "https://stackoverflow.com/questions/11227809/why-is-processing-faster",
      "https://dev.to/maya/how-answer-engines-pick-sources-3k1a",
      "https://github.com/acme/tool/issues/12",
      "https://www.quora.com/How-do-I-get-cited-by-ChatGPT",
      "https://www.indiehackers.com/post/how-we-got-cited-abc123",
    ]) {
      expect(dateFromUrl(url, NOW)).toBeNull();
    }
  });

  it("names the free API that knows, from the canonical URL", () => {
    expect(postDateRequestFor("https://news.ycombinator.com/item?id=41234567&p=2")).toEqual({ source: "hackernews", id: "41234567" });
    expect(postDateRequestFor("https://stackoverflow.com/questions/11227809/why-is-processing-faster")).toEqual({
      source: "stackexchange",
      site: "stackoverflow.com",
      id: "11227809",
    });
    expect(postDateRequestFor("https://ai.stackexchange.com/q/4567")).toEqual({ source: "stackexchange", site: "ai.stackexchange.com", id: "4567" });
    expect(postDateRequestFor("https://dev.to/maya/how-answer-engines-pick-sources-3k1a")).toEqual({
      source: "devto",
      user: "maya",
      slug: "how-answer-engines-pick-sources-3k1a",
    });
    expect(postDateRequestFor("https://old.reddit.com/r/SEO/comments/1GQ4B1Z/x/")).toEqual({ source: "reddit", id: "1gq4b1z" });
    expect(postDateRequestFor("https://github.com/acme/tool/issues/12")).toEqual({ source: "github", repo: "acme/tool", number: "12" });
  });

  it("names none for what no free source dates", () => {
    expect(postDateRequestFor("https://www.quora.com/How-do-I-get-cited-by-ChatGPT")).toBeNull();
    expect(postDateRequestFor("https://www.indiehackers.com/post/how-we-got-cited-abc123")).toBeNull();
    expect(postDateRequestFor("https://github.com/acme/tool/discussions/7")).toBeNull();
    expect(postDateRequestFor("https://github.com/acme/tool")).toBeNull();
    expect(postDateRequestFor("https://www.reddit.com/r/SEO/")).toBeNull();
    expect(postDateRequestFor("https://example.com/blog/post")).toBeNull();
    expect(postDateRequestFor("not a url")).toBeNull();
  });
});
