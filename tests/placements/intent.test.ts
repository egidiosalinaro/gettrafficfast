import { describe, expect, it } from "vitest";
import { X_INTENT_URL_MAX, xReplyIntentUrl } from "@/lib/placements/intent";
import { xStatusIdOf } from "@/lib/placements/published-url";

/**
 * Reply on X opens X's own composer as a reply, filled in. The platform posts
 * nothing: the person clicks Post on X. The address has to name the right
 * post and carry the text exactly as written, or it is a different reply.
 */

const text = (url: string | null) => (url ? new URL(url).searchParams.get("text") : null);
const replyTo = (url: string | null) => (url ? new URL(url).searchParams.get("in_reply_to") : null);

describe("xReplyIntentUrl", () => {
  it("answers the post the thread address names, on x.com and twitter.com", () => {
    expect(xReplyIntentUrl("https://x.com/asker/status/1850000000000000001", "Short answer")).toBe(
      "https://x.com/intent/tweet?text=Short%20answer&in_reply_to=1850000000000000001"
    );
    expect(replyTo(xReplyIntentUrl("https://twitter.com/asker/status/1850000000000000002?s=20", "a"))).toBe("1850000000000000002");
    expect(replyTo(xReplyIntentUrl("https://mobile.twitter.com/asker/status/1850000000000000003", "a"))).toBe("1850000000000000003");
    expect(replyTo(xReplyIntentUrl("https://www.x.com/asker/status/1850000000000000004/photo/1", "a"))).toBe("1850000000000000004");
  });

  it("reads the /i/web/status form", () => {
    expect(replyTo(xReplyIntentUrl("https://x.com/i/web/status/1850000000000000005", "a"))).toBe("1850000000000000005");
    expect(replyTo(xReplyIntentUrl("https://twitter.com/i/web/status/1850000000000000006", "a"))).toBe("1850000000000000006");
  });

  it("gives null when the address names no post on X: the card falls back to copy and open", () => {
    expect(xReplyIntentUrl("https://x.com/asker", "a")).toBeNull();
    expect(xReplyIntentUrl("https://x.com/search?q=aeo", "a")).toBeNull();
    expect(xReplyIntentUrl("https://x.com/asker/status/abc", "a")).toBeNull();
    expect(xReplyIntentUrl("https://www.reddit.com/r/SEO/comments/1abc2d/x/", "a")).toBeNull();
    expect(xReplyIntentUrl("https://notx.com/asker/status/1850000000000000001", "a")).toBeNull();
    expect(xReplyIntentUrl("not a url", "a")).toBeNull();
    expect(xReplyIntentUrl("", "a")).toBeNull();
  });

  it("encodes the text as written: line breaks, emoji and & survive the trip", () => {
    const body = "Two things & one more 🚀\n\nSecond line?";
    const url = xReplyIntentUrl("https://x.com/asker/status/1850000000000000001", body);
    expect(url).toContain("%0A%0A");
    expect(url).toContain("%26");
    expect(url).toContain("%F0%9F%9A%80");
    // Nothing in the text can start a second parameter.
    expect(url?.match(/&/g)).toHaveLength(1);
    expect(text(url)).toBe(body);
    expect(replyTo(url)).toBe("1850000000000000001");
  });

  it("gives null past the address length a browser keeps, rather than a cut reply", () => {
    const thread = "https://x.com/asker/status/1850000000000000001";
    const fits = "a".repeat(X_INTENT_URL_MAX - 100);
    expect(xReplyIntentUrl(thread, fits)?.length).toBeLessThanOrEqual(X_INTENT_URL_MAX);
    // Emoji take twelve characters each once encoded.
    expect(xReplyIntentUrl(thread, "🚀".repeat(700))).toBeNull();
    expect(xReplyIntentUrl(thread, "a".repeat(X_INTENT_URL_MAX))).toBeNull();
  });
});

describe("xStatusIdOf", () => {
  it("is the one reader of X post addresses", () => {
    expect(xStatusIdOf(" https://x.com/asker/status/1850000000000000001 ")).toBe("1850000000000000001");
    expect(xStatusIdOf("http://twitter.com/i/web/status/42")).toBe("42");
    expect(xStatusIdOf("ftp://x.com/asker/status/1")).toBeNull();
    expect(xStatusIdOf("https://github.com/o/r/status/1")).toBeNull();
  });
});
