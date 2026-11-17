import { describe, expect, it } from "vitest";
import { countMissingLinks, inboxWriterUseRecorded } from "@/lib/placements/read";
import { missingPublishedLink } from "@/lib/placements/published-url";

/**
 * GETTRAFFICFAST-7: the inbox crashed on `data.writer.useRecorded` when a
 * tab open across a deploy held a payload from before the field existed.
 * A field added after the first release is optional on the client, and an
 * informational one never takes the page down.
 */
describe("inboxWriterUseRecorded", () => {
  it("reads the flag when the payload carries it", () => {
    expect(inboxWriterUseRecorded({ writer: { useRecorded: true } })).toBe(true);
    expect(inboxWriterUseRecorded({ writer: { useRecorded: false } })).toBe(false);
  });

  it("treats a payload without the field as recorded, so an old payload neither crashes nor nags", () => {
    expect(inboxWriterUseRecorded({})).toBe(true);
    expect(inboxWriterUseRecorded({ writer: undefined })).toBe(true);
  });
});

describe("posted replies missing their link", () => {
  it("counts posted rows with no link, old ones included, and nothing else", () => {
    expect(
      countMissingLinks([
        { status: "published_manually", published_url: null },
        { status: "published_manually", published_url: "" },
        { status: "published_manually", published_url: "https://x.com/me/status/1" },
        { status: "drafted", published_url: null },
      ])
    ).toBe(2);
    expect(countMissingLinks([])).toBe(0);
    // The card reads the same rule off a record.
    expect(missingPublishedLink({ status: "published_manually", publishedUrl: null })).toBe(true);
    expect(missingPublishedLink({ status: "published_manually", publishedUrl: "  " })).toBe(true);
    expect(missingPublishedLink({ status: "published_manually", publishedUrl: "https://x.com/me/status/1" })).toBe(false);
    expect(missingPublishedLink({ status: "qualified", publishedUrl: null })).toBe(false);
  });
});
