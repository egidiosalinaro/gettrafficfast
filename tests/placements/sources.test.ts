import { describe, expect, it } from "vitest";
import {
  describeDiscoverySources,
  DISCOVERY_UNAVAILABLE,
} from "@/lib/placements/sources";

/**
 * A customer cannot set SERPER_API_KEY. The remaining copy — the API error
 * when Run discovery is off — must not name the keys either.
 */

describe("describeDiscoverySources", () => {
  it("does not name env vars when nothing is on", () => {
    const view = describeDiscoverySources([]);
    expect(view.canRun).toBe(false);
    expect(DISCOVERY_UNAVAILABLE).toContain("not searching yet");
    expect(DISCOVERY_UNAVAILABLE).not.toMatch(
      /SERPER_API_KEY|PLACEMENTS_GITHUB|GITHUB_TOKEN|REDDIT_CLIENT/
    );
  });

  it("lets Run discovery go when any provider is configured", () => {
    expect(describeDiscoverySources(["github", "web-search"]).canRun).toBe(true);
    expect(describeDiscoverySources(["web-search"]).canRun).toBe(true);
  });
});
