import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEDIA_SETTINGS,
  INLINE_IMAGE_OPTIONS,
  inlineImageAllowance,
  MAX_INLINE_IMAGES,
  maxImagesPerArticle,
  MediaSettings,
  parseMediaSettings,
} from "@/lib/media/settings";
import { composeImagePrompt, resolveImageLook } from "@/lib/media/prompt";

describe("media settings", () => {
  it("defaults to images and videos on since 2026-11-24; a stored false is kept", () => {
    expect(DEFAULT_MEDIA_SETTINGS.imagesEnabled).toBe(true);
    expect(DEFAULT_MEDIA_SETTINGS.videosEnabled).toBe(true);
    expect(parseMediaSettings({})).toMatchObject({ imagesEnabled: true, videosEnabled: true });
    expect(parseMediaSettings({ imagesEnabled: false, videosEnabled: false })).toMatchObject({ imagesEnabled: false, videosEnabled: false });
  });

  it("defaults to the featured image only: no in-article images unless asked for", () => {
    expect(DEFAULT_MEDIA_SETTINGS.inlineImagesPerArticle).toBe(0);
    // A business that turned images on before the cap existed has no stored
    // value for it, and gets the default.
    expect(parseMediaSettings({ imagesEnabled: true }).inlineImagesPerArticle).toBe(0);
  });

  it("keeps an in-article cap the business stored", () => {
    expect(parseMediaSettings({ imagesEnabled: true, inlineImagesPerArticle: 2 }).inlineImagesPerArticle).toBe(2);
    expect(MediaSettings.safeParse({ inlineImagesPerArticle: MAX_INLINE_IMAGES + 1 }).success).toBe(false);
    expect(MediaSettings.safeParse({ inlineImagesPerArticle: -1 }).success).toBe(false);
  });

  it("parses a partial stored object through defaults", () => {
    const settings = parseMediaSettings({ imagesEnabled: true, style: "claymation" });
    expect(settings.imagesEnabled).toBe(true);
    expect(settings.style).toBe("claymation");
    expect(settings.styleInstructions).toBe("");
    expect(settings.brandPalette).toEqual([]);
  });

  it("drops settings the product now decides itself, keeping the rest", () => {
    // Rows written before format and quality stopped being user choices. The
    // in-article count such a row chose explicitly is kept, under the ceiling.
    const settings = parseMediaSettings({
      imagesEnabled: true,
      style: "photographic",
      aspectRatio: "1:1",
      quality: "high",
      inlineCount: 3,
      heroEnabled: false,
      videosEnabled: true,
    });
    expect(settings).toEqual({
      ...DEFAULT_MEDIA_SETTINGS,
      imagesEnabled: true,
      videosEnabled: true,
      inlineImagesPerArticle: 3,
    });
    expect(parseMediaSettings({ inlineCount: 9 }).inlineImagesPerArticle).toBe(MAX_INLINE_IMAGES);
    // The current key wins over the retired one.
    expect(parseMediaSettings({ inlineCount: 3, inlineImagesPerArticle: 1 }).inlineImagesPerArticle).toBe(1);
  });

  it("translates a retired style instead of losing every other setting", () => {
    const settings = parseMediaSettings({ imagesEnabled: true, style: "digital_art" });
    expect(settings.style).toBe("render_3d");
    expect(settings.imagesEnabled).toBe(true);
  });

  it("falls back to defaults on corrupt stored values", () => {
    expect(parseMediaSettings({ style: "watercolour" })).toEqual(DEFAULT_MEDIA_SETTINGS);
    expect(parseMediaSettings(null)).toEqual(DEFAULT_MEDIA_SETTINGS);
    expect(parseMediaSettings("junk")).toEqual(DEFAULT_MEDIA_SETTINGS);
  });

  it("rejects invalid palette colors on the strict path", () => {
    const result = MediaSettings.safeParse({ brandPalette: ["red"] });
    expect(result.success).toBe(false);
  });
});

describe("inlineImageAllowance", () => {
  it("is zero when the business has not asked for in-article images, whatever the article", () => {
    expect(inlineImageAllowance(40, DEFAULT_MEDIA_SETTINGS.inlineImagesPerArticle)).toBe(0);
  });

  it("scales with the article under the business's cap and the platform ceiling", () => {
    expect(inlineImageAllowance(0, 3)).toBe(0);
    expect(inlineImageAllowance(1, 3)).toBe(0);
    expect(inlineImageAllowance(3, 3)).toBe(1);
    expect(inlineImageAllowance(5, 3)).toBe(2);
    expect(inlineImageAllowance(40, 3)).toBe(MAX_INLINE_IMAGES);
    expect(inlineImageAllowance(40, 1)).toBe(1);
    expect(inlineImageAllowance(40, 99)).toBe(MAX_INLINE_IMAGES);
    expect(inlineImageAllowance(40, Number.NaN)).toBe(0);
  });
});

describe("how many images an article gets", () => {
  it("one image by default, at most four, none when off", () => {
    expect(maxImagesPerArticle(DEFAULT_MEDIA_SETTINGS)).toBe(1);
    expect(maxImagesPerArticle({ imagesEnabled: false, inlineImagesPerArticle: 3 })).toBe(0);
    expect(maxImagesPerArticle({ imagesEnabled: true, inlineImagesPerArticle: 0 })).toBe(1);
    expect(maxImagesPerArticle({ imagesEnabled: true, inlineImagesPerArticle: 3 })).toBe(4);
    expect(maxImagesPerArticle({ imagesEnabled: true, inlineImagesPerArticle: 99 })).toBe(4);
  });

  it("the settings screen's options are counts with a label, never a price", () => {
    expect(INLINE_IMAGE_OPTIONS.map((o) => o.count)).toEqual([0, 1, 2, 3]);
    expect(INLINE_IMAGE_OPTIONS[0].label).toBe("Featured image only");
    for (const option of INLINE_IMAGE_OPTIONS) expect(Object.keys(option).sort()).toEqual(["count", "label"]);
  });
});

describe("composeImagePrompt", () => {
  const settings = (overrides: Partial<MediaSettings> = {}): MediaSettings =>
    MediaSettings.parse(overrides);

  it("appends the style directive to the scene", () => {
    const prompt = composeImagePrompt("A conveyor belt sorting parcels", settings());
    expect(prompt).toMatch(/^A conveyor belt sorting parcels/);
    expect(prompt).toContain("photograph");
  });

  it("styles are distinct and exclude their neighbours", () => {
    const scene = "A quiet office at dawn";
    const rendered = (["photographic", "render_3d", "illustration", "claymation"] as const).map(
      (style) => composeImagePrompt(scene, settings({ style }))
    );
    expect(new Set(rendered).size).toBe(4);
    for (const prompt of rendered) expect(prompt).toContain("Do NOT");
  });

  it("a photographic style on a business with nothing physical becomes an editorial illustration", () => {
    const scene = "Two colleagues talking at a desk with notebooks and coffee";
    const physical = composeImagePrompt(scene, settings(), "physical");
    const digital = composeImagePrompt(scene, settings(), "digital");

    expect(resolveImageLook(settings(), "physical")).toBe("photographic");
    expect(resolveImageLook(settings(), "digital")).toBe("editorial");
    expect(physical).toContain("Realistic professional photograph");
    // The contradiction the audit found: a "photograph" of something that
    // cannot be photographed. The digital prompt asks for no photograph.
    expect(digital).not.toContain("Realistic professional photograph");
    expect(digital).toContain("Clean editorial illustration");
    expect(digital).toContain("Do NOT produce photographs");
  });

  it("styles that promise no real subject are applied as chosen, whatever the business", () => {
    for (const style of ["render_3d", "illustration", "claymation"] as const) {
      expect(resolveImageLook(settings({ style }), "digital")).toBe(style);
      // The same look; only the screen constraint differs (2026-11-12).
      const look = (subject: "physical" | "digital") => composeImagePrompt("A scene", settings({ style }), subject).split(" No text")[0];
      expect(look("digital")).toBe(look("physical"));
    }
    const custom = settings({ style: "custom", styleInstructions: "Watercolour painting, soft edges" });
    expect(resolveImageLook(custom, "digital")).toBe("custom");
    // An empty custom style falls back to photography, and follows its rule.
    expect(resolveImageLook(settings({ style: "custom" }), "digital")).toBe("editorial");
  });

  it("a custom style is the business's own words", () => {
    const prompt = composeImagePrompt(
      "A dashboard on a laptop",
      settings({ style: "custom", styleInstructions: "Watercolour painting, soft edges" })
    );
    expect(prompt).toContain("Watercolour painting, soft edges");
  });

  it("an empty custom style still directs the render", () => {
    const prompt = composeImagePrompt("A dashboard", settings({ style: "custom" }));
    expect(prompt).toContain("photograph");
  });

  it("includes the palette when set", () => {
    const prompt = composeImagePrompt(
      "A dashboard on a laptop",
      settings({ brandPalette: ["#112233"] })
    );
    expect(prompt).toContain("#112233");
  });

  it("always carries the no-text constraint, in every look", () => {
    for (const subject of ["physical", "digital"] as const) {
      const prompt = composeImagePrompt("Anything", settings(), subject);
      expect(prompt).toContain("No text");
      expect(prompt).toContain("no user interfaces");
      expect(prompt).toContain("no charts");
    }
    expect(composeImagePrompt("Anything", settings(), "physical")).toContain("no screens");
  });

  it("lets a digital subject's laptop screen in, blurred and with nothing legible (2026-11-12)", () => {
    const prompt = composeImagePrompt("A writer at a desk with a laptop", settings(), "digital");
    expect(prompt).not.toContain("no screens");
    expect(prompt).toContain("Any laptop or monitor screen is out of focus and shows only soft blurred shapes, never legible text.");
  });
});
