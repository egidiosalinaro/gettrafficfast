import { afterEach, describe, expect, it } from "vitest";
import { videoEnrichmentAvailable } from "@/lib/media/availability";
import { sectionExcerpts } from "@/lib/media/sections";
import { setVideoProvider } from "@/lib/providers/video/registry";
import type { VideoProvider } from "@/lib/providers/video/types";

describe("sectionExcerpts", () => {
  const BODY =
    "<p>Intro before any heading.</p>" +
    '<h2 id="one">Shaping</h2><p>Shape the dough by hand.</p><ul><li>Flour the counter</li></ul>' +
    '<h3 id="one-a">Tension</h3><p>Pull it tight.</p>' +
    '<h2 id="two">Baking</h2><figure><img src="x" alt="y" /><figcaption>An oven</figcaption></figure><p>Bake it hot.</p>';

  it("returns the text under each heading, by id, up to the next heading", () => {
    const sections = sectionExcerpts(BODY);
    expect(sections.one).toBe("Shape the dough by hand. Flour the counter");
    expect(sections["one-a"]).toBe("Pull it tight.");
    expect(Object.keys(sections)).toEqual(["one", "one-a", "two"]);
  });

  it("leaves out the intro and the captions of images already placed", () => {
    const sections = sectionExcerpts(BODY);
    expect(JSON.stringify(sections)).not.toContain("Intro before");
    expect(sections.two).toBe("Bake it hot.");
  });

  it("cuts each excerpt, so a long article does not multiply the prompt", () => {
    const long = `<h2 id="a">A</h2><p>${"word ".repeat(400)}</p>`;
    expect(sectionExcerpts(long, 120).a.length).toBeLessThanOrEqual(120);
  });
});

describe("videoEnrichmentAvailable", () => {
  afterEach(() => setVideoProvider(undefined));

  it("is false when no video provider is configured, true when one is", () => {
    setVideoProvider(null);
    expect(videoEnrichmentAvailable()).toBe(false);
    setVideoProvider({ name: "stub", search: async () => [] } as unknown as VideoProvider);
    expect(videoEnrichmentAvailable()).toBe(true);
  });
});
