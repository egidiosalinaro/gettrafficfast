import { describe, expect, it } from "vitest";
import { checkPublishedUrl, publishedUrlExample } from "@/lib/placements/published-url";

/**
 * Marking a placement published requires the link to the person's own reply.
 * Production had 21 published rows and not one link, so no reply could ever
 * be measured. The check runs in the card and again in the action route;
 * every refusal is a sentence, never a schema message.
 */

const x = { surface: "x", url: "https://x.com/asker/status/1850000000000000001" };
const reddit = { surface: "reddit", url: "https://www.reddit.com/r/SEO/comments/1abc2d/how_do_i_get_cited/" };

function refusal(raw: unknown, target: { surface: string; url: string }): string {
  const result = checkPublishedUrl(raw, target);
  if (result.ok) throw new Error(`expected a refusal for ${String(raw)}`);
  return result.error;
}

describe("checkPublishedUrl", () => {
  it("accepts a reply on X, trimmed, and keeps the address as pasted", () => {
    expect(checkPublishedUrl("  https://x.com/me/status/1850000000000000999?s=46&t=abc  ", x)).toEqual({
      ok: true,
      url: "https://x.com/me/status/1850000000000000999?s=46&t=abc",
    });
    expect(checkPublishedUrl("https://twitter.com/me/status/1850000000000000999", x).ok).toBe(true);
    expect(checkPublishedUrl("https://mobile.twitter.com/me/status/1850000000000000999", x).ok).toBe(true);
  });

  it("refuses an empty link, and says why the link matters", () => {
    for (const empty of ["", "   ", null, undefined]) {
      expect(refusal(empty, x)).toBe("Paste the link to your reply on X. Without it, nothing can tell which reply brought the visits.");
    }
  });

  it("refuses something that is not an http(s) address", () => {
    expect(refusal("my reply", x)).toMatch(/^That is not a web address/);
    expect(refusal("javascript:alert(1)", x)).toMatch(/^That is not a web address/);
    expect(refusal("ftp://x.com/me/status/1", x)).toMatch(/^That is not a web address/);
    expect(refusal(`https://x.com/me/status/1?q=${"a".repeat(2000)}`, x)).toMatch(/longer than 2000 characters/);
  });

  it("refuses the thread's own link: the reply's is wanted", () => {
    const sentence = "That is the link to the thread you replied to, not to your reply.";
    expect(refusal(x.url, x)).toContain(sentence);
    // The same post copied another way is still the post.
    expect(refusal("https://twitter.com/asker/status/1850000000000000001?s=20", x)).toContain(sentence);
    expect(refusal(reddit.url, reddit)).toContain(sentence);
    expect(refusal("https://old.reddit.com/r/SEO/comments/1abc2d/", reddit)).toContain(sentence);
    expect(refusal("https://www.reddit.com/r/SEO/comments/1abc2d/how_do_i_get_cited/?utm_source=share", reddit)).toContain(sentence);
    expect(
      refusal("https://news.ycombinator.com/item?id=41000000", { surface: "hackernews", url: "https://news.ycombinator.com/item?id=41000000" })
    ).toContain(sentence);
    expect(
      refusal("https://www.linkedin.com/posts/jane-doe_aeo-activity-7250000000000000000-AbCd", {
        surface: "linkedin",
        url: "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000",
      })
    ).toContain(sentence);
  });

  it("refuses a link on the wrong surface, and names the right one", () => {
    expect(refusal("https://www.reddit.com/r/SEO/comments/1abc2d/x/kxyz12/", x)).toBe(
      `That link is not on X, where this thread is. Paste the link to your reply there, like ${publishedUrlExample("x")}`
    );
    expect(refusal("https://x.com/me/status/1850000000000000999", reddit)).toMatch(/^That link is not on Reddit/);
    expect(refusal("https://medium.com/@me/post", { surface: "linkedin", url: "https://www.linkedin.com/posts/a" })).toMatch(/^That link is not on LinkedIn/);
    expect(refusal("https://medium.com/@me/answer", { surface: "quora", url: "https://www.quora.com/How-do-I" })).toMatch(/^That link is not on Quora/);
    expect(refusal("https://gitlab.com/o/r/-/issues/1", { surface: "github", url: "https://github.com/o/r/issues/1" })).toMatch(/^That link is not on GitHub/);
  });

  it("wants /status/<digits> on X", () => {
    expect(refusal("https://x.com/me", x)).toMatch(/has \/status\/ and a number in it/);
    expect(refusal("https://x.com/me/status/abc", x)).toMatch(/has \/status\/ and a number in it/);
  });

  it("wants /comments/ on Reddit, and explains a share link", () => {
    expect(refusal("https://www.reddit.com/user/me", reddit)).toMatch(/has \/comments\/ in it/);
    expect(refusal("https://www.reddit.com/r/SEO/s/AbCdEf123", reddit)).toMatch(/share link \(\/s\/…\) does not say which comment/);
  });

  it("accepts a Reddit comment in both forms Reddit hands out", () => {
    expect(checkPublishedUrl("https://www.reddit.com/r/SEO/comments/1abc2d/how_do_i_get_cited/kxyz12/", reddit).ok).toBe(true);
    expect(checkPublishedUrl("https://www.reddit.com/r/SEO/comments/1abc2d/comment/kxyz12/?utm_source=share", reddit).ok).toBe(true);
  });

  it("accepts a reply named by its query or fragment, where that is all that tells it from the thread", () => {
    expect(
      checkPublishedUrl("https://github.com/o/r/issues/12#issuecomment-2400000000", { surface: "github", url: "https://github.com/o/r/issues/12" }).ok
    ).toBe(true);
    expect(
      checkPublishedUrl("https://news.ycombinator.com/item?id=41000099", { surface: "hackernews", url: "https://news.ycombinator.com/item?id=41000000" }).ok
    ).toBe(true);
    expect(
      checkPublishedUrl(
        "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7250000000000000000%2C7250000000000000111%29",
        { surface: "linkedin", url: "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000" }
      ).ok
    ).toBe(true);
    expect(
      checkPublishedUrl("https://www.quora.com/How-do-I-get-cited/answer/Jane-Doe", { surface: "quora", url: "https://www.quora.com/How-do-I-get-cited" }).ok
    ).toBe(true);
  });

  it("takes LinkedIn's short share link, the one its phone app copies for a comment", () => {
    const thread = { surface: "linkedin", url: "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000" };
    expect(checkPublishedUrl("https://lnkd.in/p/dkWRdFBZ", thread)).toEqual({ ok: true, url: "https://lnkd.in/p/dkWRdFBZ" });
    expect(refusal("https://lnkd.in.example.com/p/dkWRdFBZ", thread)).toMatch(/^That link is not on LinkedIn/);
  });

  it("takes Quora's short share link, the one Share → Copy link gives on the phone", () => {
    const thread = { surface: "quora", url: "https://www.quora.com/How-do-I-get-cited" };
    expect(checkPublishedUrl("https://qr.ae/pF3gUk", thread)).toEqual({ ok: true, url: "https://qr.ae/pF3gUk" });
    expect(refusal("https://qr.ae.example.com/pF3gUk", thread)).toMatch(/^That link is not on Quora/);
  });

  it("takes any http(s) reply on a surface with no host of its own", () => {
    const web = { surface: "web", url: "https://forum.example.com/t/how-to/12" };
    expect(checkPublishedUrl("https://forum.example.com/t/how-to/12/7", web).ok).toBe(true);
    expect(checkPublishedUrl("https://elsewhere.example.org/reply", web).ok).toBe(true);
    expect(refusal("https://forum.example.com/t/how-to/12/", web)).toMatch(/link to the thread/);
    expect(
      checkPublishedUrl("https://ai.stackexchange.com/a/45678", { surface: "stackexchange", url: "https://ai.stackexchange.com/questions/123/slug" }).ok
    ).toBe(true);
  });
});
