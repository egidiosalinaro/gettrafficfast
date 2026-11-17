import { describe, expect, it } from "vitest";
import { APPROACHES, pickApproach } from "@/lib/placements/approach";

/**
 * Variety is dealt by code, not asked of the model. A resumed step gets the
 * same shape; a regenerate (new job id) gets a different seed; and over many
 * targets every approach is actually used.
 */
describe("pickApproach", () => {
  it("is stable for the same target and job", () => {
    expect(pickApproach("t-1:job-1")).toBe(pickApproach("t-1:job-1"));
  });

  it("always returns one of the approaches", () => {
    for (let i = 0; i < 50; i++) expect(APPROACHES).toContain(pickApproach(`t-${i}:job-${i * 7}`));
  });

  it("uses every approach across many seeds, so no shape is dead", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(pickApproach(`target-${i}:job-${i}`));
    expect(seen.size).toBe(APPROACHES.length);
  });

  it("changes the shape on a regenerate more often than not", () => {
    let changed = 0;
    for (let i = 0; i < 200; i++) {
      if (pickApproach(`t-${i}:job-a`) !== pickApproach(`t-${i}:job-b`)) changed += 1;
    }
    expect(changed).toBeGreaterThan(120);
  });

  it("describes ways of joining a discussion, none of them a way of selling", () => {
    for (const approach of APPROACHES) {
      expect(approach).not.toMatch(/product|business|brand|recommend|mention/i);
    }
  });
});
