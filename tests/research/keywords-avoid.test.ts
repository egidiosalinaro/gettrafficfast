import { describe, expect, it } from "vitest";
import { AVOID_TOPICS_MAX, avoidBlock } from "@/lib/research/keywords";

/**
 * The top-up's one suggestion call lists the topics the site already
 * covers, so a site with a long history is not offered them again (every
 * one of them would be refused for overlapping). Bounded, deduplicated,
 * and absent when there is nothing to avoid.
 */

describe("avoidBlock", () => {
  it("is empty with nothing to avoid", () => {
    expect(avoidBlock({})).toBe("");
    expect(avoidBlock({ avoid: ["  ", ""] })).toBe("");
  });

  it("lists each topic once, whatever its case", () => {
    const block = avoidBlock({ avoid: ["Abandoned cart emails", "abandoned cart emails", "welcome email series"] });
    expect(block).toContain("Suggest only NEW topics");
    expect(block.match(/^- /gm)).toHaveLength(2);
  });

  it("never lists more than the cap", () => {
    const many = Array.from({ length: AVOID_TOPICS_MAX + 40 }, (_, i) => `topic ${i}`);
    expect(avoidBlock({ avoid: many }).match(/^- /gm)).toHaveLength(AVOID_TOPICS_MAX);
  });
});
