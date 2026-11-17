import { beforeEach, describe, expect, it, vi } from "vitest";
import { OG_CARD_SIZE, OG_FALLBACK_TITLE, ogCardTitle, ogTitleFontSize } from "@/lib/blog/og-card";

/**
 * The blog post's social card: drawn in code (no model call), 1200x630 PNG,
 * with the post's title. The route is rendered for real and the size is read
 * from the PNG header.
 */

const posts = vi.hoisted(() => ({
  bySlug: {} as Record<string, { title: string } | null>,
  fail: false,
  asked: [] as string[],
}));
vi.mock("@/lib/blog/posts", () => ({
  getPost: async (slug: string) => {
    posts.asked.push(slug);
    if (posts.fail) throw new Error("blog: database unavailable");
    return posts.bySlug[slug] ?? null;
  },
}));

import OpengraphImage, * as route from "@/app/blog/[slug]/opengraph-image";

/** Width and height from a PNG's IHDR chunk. */
async function pngSize(response: Response): Promise<{ width: number; height: number }> {
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const render = (slug: string) => OpengraphImage({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  posts.bySlug = { "how-to-bake-sourdough": { title: "How to bake sourdough at home without a Dutch oven" } };
  posts.fail = false;
  posts.asked = [];
});

describe("blog post opengraph image", () => {
  it("declares the size and type Next puts in the og:image tags", () => {
    expect(route.size).toEqual({ width: 1200, height: 630 });
    expect(route.contentType).toBe("image/png");
    expect(route.alt).toContain("GetTrafficFast");
    expect(OG_CARD_SIZE).toEqual({ width: 1200, height: 630 });
  });

  it("renders a 1200x630 PNG for a post", async () => {
    const response = await render("how-to-bake-sourdough");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await pngSize(response)).toEqual({ width: 1200, height: 630 });
    expect(posts.asked).toEqual(["how-to-bake-sourdough"]);
  }, 30_000);

  it("still renders a card, with the site's name, for a slug with no post", async () => {
    const response = await render("no-such-post");
    expect(await pngSize(response)).toEqual({ width: 1200, height: 630 });
  }, 30_000);

  it("still renders when the post cannot be read", async () => {
    posts.fail = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await render("how-to-bake-sourdough");
    expect(await pngSize(response)).toEqual({ width: 1200, height: 630 });
    errors.mockRestore();
  }, 30_000);
});

describe("the card's title", () => {
  it("is the post's title, or the site's name when there is none: never an invented one", () => {
    expect(ogCardTitle("  How to bake\n sourdough ")).toBe("How to bake sourdough");
    expect(ogCardTitle("")).toBe(OG_FALLBACK_TITLE);
    expect(ogCardTitle(null)).toBe(OG_FALLBACK_TITLE);
    expect(OG_FALLBACK_TITLE).toBe("The GetTrafficFast blog");
  });

  it("is cut only when even the smallest size would overflow", () => {
    const long = "word ".repeat(60).trim();
    const shown = ogCardTitle(long);
    expect(shown.length).toBeLessThanOrEqual(160);
    expect(shown.endsWith("…")).toBe(true);
    expect(ogCardTitle("x".repeat(160))).toBe("x".repeat(160));
  });

  it("is set smaller as it gets longer", () => {
    const sizes = [20, 60, 100, 150].map((length) => ogTitleFontSize("x".repeat(length)));
    expect(sizes).toEqual([84, 68, 56, 46]);
  });
});
