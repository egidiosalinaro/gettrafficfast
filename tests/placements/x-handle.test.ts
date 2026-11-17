import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleOfStatusUrl, mostFrequentHandle, ownXHandle } from "@/lib/placements/x-handle";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Finding the link of a posted reply and reading the account's followers
 * both need the X account a site replies from. It is read off the links to
 * the person's own replies, never asked for and never guessed.
 */

describe("handleOfStatusUrl", () => {
  it("reads the author of a status link, lowercased, from every X host", () => {
    expect(handleOfStatusUrl("https://x.com/SamRivDev/status/1850000000000000999?s=46&t=abc")).toBe("samrivdev");
    expect(handleOfStatusUrl("https://twitter.com/me_2/status/1850000000000000999")).toBe("me_2");
    expect(handleOfStatusUrl("https://mobile.twitter.com/me/status/1850000000000000999")).toBe("me");
    expect(handleOfStatusUrl("  https://www.x.com/me/status/1850000000000000999/photo/1  ")).toBe("me");
  });

  it("names nobody for links that carry no author", () => {
    expect(handleOfStatusUrl("https://x.com/i/web/status/1850000000000000999")).toBeNull();
    expect(handleOfStatusUrl("https://x.com/me")).toBeNull();
    expect(handleOfStatusUrl("https://x.com/me/status/abc")).toBeNull();
    expect(handleOfStatusUrl("https://www.reddit.com/r/SEO/comments/1abc2d/x/kxyz12/")).toBeNull();
    expect(handleOfStatusUrl("https://x.com.example.com/me/status/1")).toBeNull();
    expect(handleOfStatusUrl("not a link")).toBeNull();
    expect(handleOfStatusUrl(null)).toBeNull();
  });
});

describe("mostFrequentHandle", () => {
  it("takes the handle most links carry, and the newest on a tie", () => {
    expect(
      mostFrequentHandle([
        "https://x.com/someone_else/status/3",
        "https://x.com/me/status/2",
        "https://x.com/Me/status/1",
      ])
    ).toBe("me");
    expect(mostFrequentHandle(["https://x.com/newer/status/2", "https://x.com/older/status/1"])).toBe("newer");
  });

  it("is null when no link names a handle", () => {
    expect(mostFrequentHandle([])).toBeNull();
    expect(mostFrequentHandle([null, "https://x.com/i/web/status/1", "https://news.ycombinator.com/item?id=1"])).toBeNull();
  });
});

describe("ownXHandle", () => {
  const row = (id: string, business: string, url: string | null, at: string, extra: Record<string, unknown> = {}) => ({
    id,
    business_id: business,
    surface: "x",
    status: "published_manually",
    published_url: url,
    published_at: at,
    ...extra,
  });

  it("reads the site's own posted X replies, and only that site's", async () => {
    const fake = new FakeSupabase({
      placement_targets: [
        row("a", "biz-1", "https://x.com/me/status/11", "2026-11-12T10:00:00Z"),
        row("b", "biz-1", "https://x.com/me/status/12", "2026-11-11T10:00:00Z"),
        row("c", "biz-1", null, "2026-11-13T10:00:00Z"),
        row("d", "biz-2", "https://x.com/other/status/13", "2026-11-13T10:00:00Z"),
        row("e", "biz-2", "https://x.com/other/status/14", "2026-11-13T11:00:00Z"),
        row("f", "biz-2", "https://x.com/other/status/15", "2026-11-13T12:00:00Z"),
        // A draft that was never posted names nobody.
        row("g", "biz-1", "https://x.com/draftonly/status/16", "2026-11-13T10:00:00Z", { status: "drafted" }),
      ],
    });
    const client = fake as unknown as SupabaseClient;
    expect(await ownXHandle(client, "biz-1")).toBe("me");
    expect(await ownXHandle(client, "biz-2")).toBe("other");
    expect(await ownXHandle(client, "biz-3")).toBeNull();
  });
});
