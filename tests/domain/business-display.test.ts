import { describe, expect, it } from "vitest";
import { businessHostname, businessLabel } from "@/lib/domain/business-display";

describe("businessLabel", () => {
  it("prefers the name when it is set", () => {
    expect(
      businessLabel({ name: "Postwren", website_url: "https://postwren.com" }),
    ).toBe("Postwren");
  });

  it("falls back to the URL when the name is missing", () => {
    expect(businessLabel({ name: null, website_url: "https://postwren.com" })).toBe(
      "https://postwren.com",
    );
  });

  it("does not invent a name when both fields are empty", () => {
    expect(businessLabel({ name: null, website_url: null })).toBe("Untitled site");
  });
});

describe("businessHostname", () => {
  it("returns the host without www", () => {
    expect(businessHostname("https://www.postwren.com")).toBe("postwren.com");
  });

  it("keeps a non-www host as stored", () => {
    expect(businessHostname("https://gettrafficfa.st/blog")).toBe("gettrafficfa.st");
  });

  it("is null when there is no URL to parse", () => {
    expect(businessHostname(null)).toBeNull();
    expect(businessHostname("")).toBeNull();
    expect(businessHostname("not a url")).toBeNull();
  });

  it("does not guess a domain from a bare hostname", () => {
    // Stored website_url values are real URLs (the save route validates them).
    // A string without a scheme is missing data, not postwren.com.
    expect(businessHostname("postwren.com")).toBeNull();
  });
});
