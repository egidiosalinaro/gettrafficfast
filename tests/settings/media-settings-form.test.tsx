import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/onboarding", () => ({ refreshOnboarding: () => {} }));

import { InlineImagesChoice, VideosCard } from "@/components/settings/media-settings-form";

/**
 * Settings → Images & video, rendered. What is pinned: the choice of how
 * many images an article gets names no price and no internal name (images
 * are included in the plan); and when the platform cannot look for videos the card says
 * so instead of offering a switch that does nothing.
 */

const noop = () => {};

describe("images per article", () => {
  it("offers the featured image alone and up to three more, the default first", () => {
    const html = renderToStaticMarkup(<InlineImagesChoice value={0} onChange={noop} />);
    expect(html).toContain("Featured image only");
    expect(html).toContain("Featured image, plus up to 3 in the article");
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    // Only the stored choice is checked.
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html.indexOf('checked=""')).toBeLessThan(html.indexOf("Featured image only"));
  });

  it("states no price: images are included in the plan (owner's decision, 2026-11-14)", () => {
    const html = renderToStaticMarkup(<InlineImagesChoice value={2} onChange={noop} />);
    expect(html).toContain("Images are included in your plan.");
    expect(html).not.toMatch(/\$|usd|cost|price/i);
  });

  it("names no internal setting, model or vendor", () => {
    const html = renderToStaticMarkup(<InlineImagesChoice value={0} onChange={noop} />);
    expect(html).not.toMatch(/inlineImagesPerArticle|IMAGE_|_API_KEY|gemini|imagen|openai/i);
  });
});

describe("videos card", () => {
  it("offers the switch when the platform can look for videos", () => {
    const html = renderToStaticMarkup(<VideosCard available enabled={false} onChange={noop} />);
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("not available");
  });

  it("says videos are unavailable, with no switch, when it cannot", () => {
    const html = renderToStaticMarkup(<VideosCard available={false} enabled={false} onChange={noop} />);
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("Videos are not available right now.");
    expect(html).toContain("there is nothing for you to change");
    expect(html).not.toMatch(/YOUTUBE_API_KEY|API key|env/i);
  });

  it("tells a business that had turned it on that nothing is happening", () => {
    const html = renderToStaticMarkup(<VideosCard available={false} enabled onChange={noop} />);
    expect(html).toContain("even though this was turned on for your site");
  });

  it("offers no switch before the platform has answered", () => {
    const html = renderToStaticMarkup(<VideosCard available={null} enabled onChange={noop} />);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("not available");
  });
});
