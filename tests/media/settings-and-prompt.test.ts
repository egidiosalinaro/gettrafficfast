import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEDIA_SETTINGS,
  INLINE_IMAGE_OPTIONS,
  inlineImageAllowance,
  MAX_INLINE_IMAGES,
  imageStyleChosen,
  legacyStyleConfigured,
  maxImagesPerArticle,
  MediaSettings,
  parseMediaSettings,
  withStyleChosen,
} from "@/lib/media/settings";
import { composeImagePrompt, resolveImageLook } from "@/lib/media/prompt";

describe("media settings", () => {
  it("has no images switch since 2026-11-24: a stored or sent imagesEnabled is dropped", () => {
    expect("imagesEnabled" in DEFAULT_MEDIA_SETTINGS).toBe(false);
    expect("imagesEnabled" in parseMediaSettings({ imagesEnabled: false })).toBe(false);
    expect(parseMediaSettings({ imagesEnabled: false })).toEqual(DEFAULT_MEDIA_SETTINGS);
    // The form's strict path accepts it from a page left open, and drops it.
    const sent = MediaSettings.safeParse({ imagesEnabled: true, style: "illustration" });
    expect(sent.success && "imagesEnabled" in sent.data).toBe(false);
  });

  it("keeps videos as an opt-out switch, on by default", () => {
    expect(DEFAULT_MEDIA_SETTINGS.videosEnabled).toBe(true);
    expect(parseMediaSettings({ videosEnabled: false }).videosEnabled).toBe(false);
  });

  it("defaults to the featured image only: no in-article images unless asked for", () => {
    expect(DEFAULT_MEDIA_SETTINGS.inlineImagesPerArticle).toBe(0);
    // A business that turned images on before the cap existed has no stored
    // value for it, and gets the default.
    expect(parseMediaSettings({ style: "photographic" }).inlineImagesPerArticle).toBe(0);
  });

  it("keeps an in-article cap the business stored", () => {
    expect(parseMediaSettings({ inlineImagesPerArticle: 2 }).inlineImagesPerArticle).toBe(2);
    expect(MediaSettings.safeParse({ inlineImagesPerArticle: MAX_INLINE_IMAGES + 1 }).success).toBe(false);
    expect(MediaSettings.safeParse({ inlineImagesPerArticle: -1 }).success).toBe(false);
  });

  it("parses a partial stored object through defaults", () => {
    const settings = parseMediaSettings({ style: "claymation" });
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
      videosEnabled: true,
      inlineImagesPerArticle: 3,
    });
    expect(parseMediaSettings({ inlineCount: 9 }).inlineImagesPerArticle).toBe(MAX_INLINE_IMAGES);
    // The current key wins over the retired one.
    expect(parseMediaSettings({ inlineCount: 3, inlineImagesPerArticle: 1 }).inlineImagesPerArticle).toBe(1);
  });

  it("translates a retired style instead of losing every other setting", () => {
    const settings = parseMediaSettings({ inlineImagesPerArticle: 1, style: "digital_art" });
    expect(settings.style).toBe("render_3d");
    expect(settings.inlineImagesPerArticle).toBe(1);
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

describe("the image style chosen", () => {
  it("is not chosen on a new site: articles wait for it", () => {
    expect(DEFAULT_MEDIA_SETTINGS).toMatchObject({ styleChosen: false, styleChosenAt: null });
    expect(imageStyleChosen(parseMediaSettings({}))).toBe(false);
    expect(imageStyleChosen(parseMediaSettings(null))).toBe(false);
  });

  it("is marked with the moment it was chosen, by the server", () => {
    const now = new Date("2026-11-24T10:00:00.000Z");
    const chosen = withStyleChosen({ ...DEFAULT_MEDIA_SETTINGS, style: "illustration" }, now);
    expect(chosen).toMatchObject({ style: "illustration", styleChosen: true, styleChosenAt: "2026-11-24T10:00:00.000Z" });
    expect(imageStyleChosen(parseMediaSettings(chosen))).toBe(true);
  });

  it("counts a row stored before the field as chosen only when its look was set by the person", () => {
    // A different style, art direction, or brand colours: chosen, the day not recorded.
    for (const row of [
      { style: "claymation" },
      { style: "digital_art" },
      { style: "custom", styleInstructions: "Soft watercolour washes." },
      { style: "photographic", brandPalette: ["#123456"] },
      { imagesEnabled: true, style: "photographic", styleInstructions: "Muted tones." },
    ]) {
      expect(parseMediaSettings(row), JSON.stringify(row)).toMatchObject({ styleChosen: true, styleChosenAt: null });
    }
    // Only the defaults (or the old switch): not chosen.
    for (const row of [
      {},
      { imagesEnabled: true, videosEnabled: true },
      { imagesEnabled: false, videosEnabled: false },
      { style: "photographic", styleInstructions: "   ", brandPalette: [] },
    ]) {
      expect(parseMediaSettings(row).styleChosen, JSON.stringify(row)).toBe(false);
    }
    expect(legacyStyleConfigured({ brandPalette: [] })).toBe(false);
  });

  it("keeps an explicit answer over the rule for old rows", () => {
    expect(parseMediaSettings({ style: "claymation", styleChosen: false }).styleChosen).toBe(false);
    expect(parseMediaSettings({ styleChosen: true, styleChosenAt: "2026-11-24T10:00:00.000Z" }).styleChosen).toBe(true);
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
  it("one image by default, at most four", () => {
    expect(maxImagesPerArticle(DEFAULT_MEDIA_SETTINGS)).toBe(1);
    expect(maxImagesPerArticle({ inlineImagesPerArticle: 0 })).toBe(1);
    expect(maxImagesPerArticle({ inlineImagesPerArticle: 3 })).toBe(4);
    expect(maxImagesPerArticle({ inlineImagesPerArticle: 99 })).toBe(4);
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
