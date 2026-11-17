import { describe, expect, it } from "vitest";
import { surfaceDomain, surfaceLabel } from "@/lib/placements/surfaces";

/**
 * A reviewer reads a platform's name and sees its icon; the stored key is
 * neither. Nothing here may invent a host: a plain web page with no
 * recognisable community gets no icon rather than a wrong one.
 */

describe("surfaceLabel", () => {
  it("names every canonical surface for a person", () => {
    expect(surfaceLabel("reddit")).toBe("Reddit");
    expect(surfaceLabel("github")).toBe("GitHub");
    expect(surfaceLabel("linkedin")).toBe("LinkedIn");
    expect(surfaceLabel("x")).toBe("X");
    expect(surfaceLabel("hackernews")).toBe("Hacker News");
    expect(surfaceLabel("stackexchange")).toBe("Stack Exchange");
    expect(surfaceLabel("quora")).toBe("Quora");
    expect(surfaceLabel("indiehackers")).toBe("Indie Hackers");
    expect(surfaceLabel("devto")).toBe("DEV");
  });

  it("falls back to the stored key for a surface it has never heard of", () => {
    expect(surfaceLabel("mastodon")).toBe("mastodon");
  });
});

describe("surfaceDomain", () => {
  it("uses the platform's host for the icon", () => {
    expect(surfaceDomain("reddit", "r/SEO")).toBe("reddit.com");
    expect(surfaceDomain("x", "@jane")).toBe("x.com");
    expect(surfaceDomain("hackernews", "Hacker News")).toBe("news.ycombinator.com");
    expect(surfaceDomain("devto", "DEV Community")).toBe("dev.to");
  });

  it("follows the community when the network has one icon per site", () => {
    expect(surfaceDomain("stackexchange", "ai.stackexchange.com")).toBe("ai.stackexchange.com");
    expect(surfaceDomain("stackexchange", null)).toBe("stackexchange.com");
    expect(surfaceDomain("quora", "contenttipsandtricks.quora.com")).toBe("contenttipsandtricks.quora.com");
    expect(surfaceDomain("quora", "Quora")).toBe("quora.com");
  });

  it("shows a web page's own host, and nothing when there is none", () => {
    expect(surfaceDomain("web", "blog.hubspot.com")).toBe("blog.hubspot.com");
    expect(surfaceDomain("web", null)).toBeNull();
    expect(surfaceDomain("web", "some forum")).toBeNull();
  });
});
