import { describe, expect, it } from "vitest";
import { mentionsHandle, xReplyAllowance } from "@/lib/placements/x-reply-allowed";

/**
 * Where Post on X is offered: only where X lets an app reply from the
 * connected account (its author mentioned or quoted it, or it answers or is
 * the account's own post). Everything else keeps Reply on X. Fictional
 * handles: the site posts as @samrivdev.
 */

const post = (over: Record<string, unknown> = {}) => ({
  surface: "x",
  url: "https://x.com/postwren/status/1850000000000000000",
  author: "postwren",
  title: "Which tool do you use for release notes?",
  excerpt: "Which tool do you use for release notes?",
  quotedPost: null,
  repliedToPost: null,
  ...over,
});

describe("xReplyAllowance", () => {
  it("allows a post that @mentions the account, whatever the case", () => {
    expect(xReplyAllowance(post({ excerpt: "@SamRivDev which tool do you use?" }), "samrivdev")).toBe("mention");
    expect(xReplyAllowance(post({ excerpt: "Asking @samrivdev and others" }), "samrivdev")).toBe("mention");
  });

  it("allows a post that quotes, or answers, one of the account's posts, and the account's own post", () => {
    expect(xReplyAllowance(post({ quotedPost: { handle: "samrivdev" } }), "samrivdev")).toBe("quote");
    expect(xReplyAllowance(post({ repliedToPost: { handle: "SamRivDev" } }), "samrivdev")).toBe("reply_to_you");
    expect(xReplyAllowance(post({ author: "samrivdev" }), "samrivdev")).toBe("own_post");
  });

  it("keeps every other post on today's flow", () => {
    expect(xReplyAllowance(post(), "samrivdev")).toBeNull();
    // Another account's name that starts the same, an email address, a quote of someone else.
    expect(xReplyAllowance(post({ excerpt: "cc @samrivdevteam" }), "samrivdev")).toBeNull();
    expect(xReplyAllowance(post({ excerpt: "mail me at hi@samrivdev.example" }), "samrivdev")).toBeNull();
    expect(xReplyAllowance(post({ quotedPost: { handle: "postwren" } }), "samrivdev")).toBeNull();
  });

  it("needs a connected account, a post on X, and a status in its address", () => {
    expect(xReplyAllowance(post({ excerpt: "@samrivdev hi" }), null)).toBeNull();
    expect(xReplyAllowance(post({ excerpt: "@samrivdev hi", surface: "reddit" }), "samrivdev")).toBeNull();
    expect(xReplyAllowance(post({ excerpt: "@samrivdev hi", url: "https://x.com/postwren" }), "samrivdev")).toBeNull();
  });
});

describe("mentionsHandle", () => {
  it("matches a whole handle only", () => {
    expect(mentionsHandle("@samrivdev", "samrivdev")).toBe(true);
    expect(mentionsHandle("(@samrivdev)", "samrivdev")).toBe(true);
    expect(mentionsHandle("@samrivdev_", "samrivdev")).toBe(false);
    expect(mentionsHandle("samrivdev", "samrivdev")).toBe(false);
    expect(mentionsHandle("@samrivdev", "bad handle!")).toBe(false);
  });
});
