import { describe, expect, it } from "vitest";
import { ReplyDraft, ReplyTarget } from "@/lib/tools/replies";

/**
 * Regression, 2026-11-12: the inbox read a post's images (2026-11-11) and the
 * drafter recorded what it saw of them, but the tools' output schema did not
 * name those fields, so the API and MCP dropped them on the way out.
 */
const target = {
  id: "t1",
  surface: "x",
  url: "https://x.com/cass_builds/status/1",
  kind: "thread",
  title: "quick sanity check: are these numbers normal for a twelve day old site on a fresh domain? asking for myself",
  excerpt: null,
  community: null,
  author: "cass_builds",
  postedAt: null,
  postedAtPrecision: null,
  score: null,
  commentCount: null,
  foundFor: null,
  foundVia: "manual",
  status: "drafted",
  qualifyScore: null,
  qualifyReason: null,
  qualifyAngle: null,
  qualifiedBy: "person",
  qualifiedAt: null,
  topic: null,
  intent: null,
  freshUntil: null,
  snoozedUntil: null,
  reviewNote: null,
  dismissedReason: null,
  publishedUrl: null,
  publishedAt: null,
  publishedNote: null,
  aeoQueryId: null,
  selectedPlacementId: null,
  lastSeenAt: null,
  createdAt: "2026-11-11T10:00:00Z",
  drafts: [],
  media: [
    {
      type: "photo",
      url: "https://pbs.twimg.com/media/abc.jpg",
      previewUrl: null,
      altText: "Search Console, last 14 days",
      width: 1200,
      height: 675,
    },
  ],
  mediaUnread: false,
};

describe("reply tools carry a post's images", () => {
  it("keeps media and mediaUnread on a target", () => {
    const shape = ReplyTarget.shape;
    expect(shape).toHaveProperty("media");
    expect(shape).toHaveProperty("mediaUnread");
    const parsed = ReplyTarget.safeParse(target);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.media).toEqual(target.media);
    expect(parsed.data.mediaUnread).toBe(false);
  });

  it("keeps what the drafter saw of the images on a draft's audit", () => {
    const parsed = ReplyDraft.shape.audit.safeParse({
      status: "warning",
      checks: [],
      images: { inPost: 1, seen: 0, note: "The image could not be fetched (403)." },
    });
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.images).toEqual({ inPost: 1, seen: 0, note: "The image could not be fetched (403)." });
  });

  it("still reads targets and drafts written before images were read", () => {
    const { media: _media, mediaUnread: _unread, ...old } = target;
    expect(ReplyTarget.safeParse(old).success).toBe(true);
    expect(ReplyDraft.shape.audit.safeParse({ status: "passed", checks: [] }).success).toBe(true);
  });
});
